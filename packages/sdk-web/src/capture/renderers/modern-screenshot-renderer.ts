// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import type { Rect } from '@everframe/sdk-core';
import { FAST_CLONE_STYLE_PROPERTIES, type CaptureProfile } from '../capture-profile.js';
import { paintMaskRectsOnCanvas } from '../mask-paint.js';
import { isCanvasBlank } from '../blank-check.js';

/**
 * Ceiling on modern-screenshot's PRE-CLONE pass, which awaits the load of every
 * `<img>`/`<video>` in the subtree before the `filter` is consulted (so a
 * filtered-out `<video>` is still waited on). Its default is 30_000 — measured
 * as a flat 30s stall on a page with one stalled video source, filter or no
 * filter. Resources the user is currently looking at are already loaded, so this
 * pass is normally instant; the budget only bites on genuinely broken or
 * still-loading ones, where a slightly incomplete shot beats a frozen reporter.
 */
const RESOURCE_WAIT_BUDGET_MS = 3_000;

/**
 * Margin (CSS px) around the viewport kept in a viewport-only clone. Absorbs
 * near-fold cases so a partially visible row is never dropped.
 */
const VIEWPORT_CLONE_MARGIN_PX = 100;

/**
 * Elements the TV profile may drop from the clone: OUT-OF-FLOW subtrees with
 * nothing visible inside them — i.e. the offscreen PARTS of the page (the
 * tiles scrolled past a rail's edge, the rows below the fold), never the
 * containers that hold visible content.
 *
 * Two hard-won constraints, both measured on an LG 43UP77003LB (webOS 6.5):
 *
 *  - Only `position: absolute|fixed` subtrees may go. Removing an in-flow node
 *    reflows its siblings inside the clone, which shifts the rest of the page
 *    out of the cropped viewport — that is what emptied the rails out of
 *    otherwise-successful screenshots (reports "rep111"/"rep1111").
 *  - Visibility must be judged over the WHOLE subtree, never the element's own
 *    rect. Virtualized lists park a container far offscreen and transform its
 *    children back into view: the real one measured at y=-4252 held 1091
 *    visible descendants, so pruning on the container's own rect deleted the
 *    entire content area.
 *
 * Result on that device: 1252 nodes -> 978 dropped, clone 1.89MB -> 1.01MB,
 * capture 20.1s -> 12.6s, output byte-identical to the full-document capture.
 * The pre-pass costs ~115ms there.
 */
function computePrunableNodes(root: HTMLElement): Set<Element> {
  const prunable = new Set<Element>();
  if (typeof window === 'undefined') return prunable;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!vw || !vh) return prunable;
  const m = VIEWPORT_CLONE_MARGIN_PX;

  const intersectsViewport = (el: Element): boolean => {
    try {
      const b = el.getBoundingClientRect();
      // Zero-area boxes paint nothing themselves; their children decide.
      if (b.width === 0 && b.height === 0) return false;
      return !(b.bottom < -m || b.top > vh + m || b.right < -m || b.left > vw + m);
    } catch {
      return true;
    }
  };

  const isOutOfFlow = (el: Element): boolean => {
    try {
      const position = window.getComputedStyle(el).position;
      return position === 'absolute' || position === 'fixed';
    } catch {
      return false;
    }
  };

  const mark = (el: Element): boolean => {
    let anyVisible = intersectsViewport(el);
    for (const child of Array.from(el.children)) {
      if (mark(child)) anyVisible = true;
    }
    if (!anyVisible && isOutOfFlow(el)) prunable.add(el);
    return anyVisible;
  };

  try {
    mark(root);
  } catch {
    // A pruning pre-pass must never cost the screenshot: fall back to cloning
    // everything (slower, but complete).
    return new Set();
  }
  return prunable;
}

/**
 * Transparent 1x1 GIF handed back for an image the crop will discard. Matches
 * modern-screenshot's own `fetch.placeholderImage` default, so a skipped image
 * renders exactly like one whose fetch failed — an empty box, off-screen.
 */
const SKIPPED_IMAGE_DATA_URL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** `url(...)` targets in an inline `background-image`, quotes stripped. */
function extractCssUrls(value: string): string[] {
  const out: string[] = [];
  for (const match of value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)) {
    const url = match[2];
    if (url) out.push(url);
  }
  return out;
}

/**
 * Image URLs referenced ONLY by elements outside the viewport.
 *
 * WHY — modern-screenshot inlines every image in the clone as a data URI,
 * which means RE-REQUESTING it: the SVG it rasterises has no network access,
 * so embedding is the only way to get pixels in. On an image-heavy page that
 * dominates the capture. Measured on a TV app's home screen in a desktop
 * browser: 433 refetches against an image host that sends no `Cache-Control`
 * (so modern-screenshot's `cache: 'force-cache'` default has nothing to serve)
 * cost ~5s of an 8.4s capture — six-at-a-time connection queueing, for images
 * the viewport crop discarded microseconds later.
 *
 * `fetchFn` receives ONLY the URL, never the element, so visibility has to be
 * resolved here and handed over as a lookup set.
 *
 * FAIL-OPEN BY CONSTRUCTION, in two ways that matter:
 *  - A URL is skipped only when EVERY element referencing it is off-screen.
 *    The same poster in an off-screen rail and an on-screen hero is fetched.
 *  - Only URLs actually observed on an element can enter the set. Anything
 *    unseen — webfonts, stylesheet backgrounds, resources modern-screenshot
 *    finds by its own walk — is absent from the set and falls through to the
 *    normal fetch, so it can never be dropped by a gap in this scan.
 *
 * Residual risk, accepted: a URL used by an off-screen `<img>` AND an on-screen
 * background set from a stylesheet (not inline) would be skipped, blanking that
 * background. Detecting it needs `getComputedStyle` per node, whose forced
 * layout costs more than the fetches this saves.
 */
function computeSkippableImageUrls(root: HTMLElement): Set<string> {
  const skippable = new Set<string>();
  if (typeof window === 'undefined') return skippable;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!vw || !vh) return skippable;
  const m = VIEWPORT_CLONE_MARGIN_PX;

  const visible = new Set<string>();
  const offscreen = new Set<string>();

  // Leaf rects, unlike the container rects computePrunableNodes has to reason
  // about, already account for transforms — a virtualized row transformed into
  // view reports its on-screen position here.
  const intersectsViewport = (el: Element): boolean => {
    try {
      const b = el.getBoundingClientRect();
      // Zero-area images paint nothing, so a placeholder is pixel-identical.
      if (b.width === 0 && b.height === 0) return false;
      return !(b.bottom < -m || b.top > vh + m || b.right < -m || b.left > vw + m);
    } catch {
      return true;
    }
  };

  const record = (el: Element, urls: Array<string | null | undefined>): void => {
    const bucket = intersectsViewport(el) ? visible : offscreen;
    for (const url of urls) {
      // `data:` costs no round trip; skipping it would only add work.
      if (url && !url.startsWith('data:')) bucket.add(url);
    }
  };

  try {
    for (const img of Array.from(root.querySelectorAll('img'))) {
      // All three spellings: modern-screenshot may read the resolved property
      // or the raw attribute, and `currentSrc` is what a srcset actually chose.
      record(img, [img.currentSrc, img.src, img.getAttribute('src')]);
    }
    for (const image of Array.from(root.querySelectorAll('image'))) {
      record(image, [image.getAttribute('href'), image.getAttribute('xlink:href')]);
    }
    for (const el of Array.from(
      root.querySelectorAll<HTMLElement>('[style*="background-image"]'),
    )) {
      record(el, extractCssUrls(el.style.backgroundImage));
    }
  } catch {
    // A pre-pass must never cost the screenshot: fetch everything as before.
    return new Set();
  }

  for (const url of offscreen) {
    if (!visible.has(url)) skippable.add(url);
  }
  return skippable;
}

/**
 * UA default margin the CLONE's body picks up inside the SVG foreignObject
 * render (all major engines ship `body { margin: 8px }`). modern-screenshot
 * strips the root's inline margins, and the page's own stylesheet does not
 * exist in the clone, so the UA value resurfaces there.
 */
const UA_BODY_MARGIN_CSS_PX = 8;

/**
 * In-flow drift (CSS px) of a modern-screenshot clone relative to the live
 * page, per axis: the clone renders in-flow content at the UA default body
 * margin while the live page renders it at its computed margin. Only applies
 * when the captured root IS a <body> (custom roots are cloned as their own
 * tag, which carries no UA margin). Live margin 0 (typical app reset) →
 * drift 8; live margin 8 (no reset) → drift 0 — matching measurement:
 * un-reset pages crop pixel-exact today, reset pages show the +8.
 *
 * KNOWN TRADEOFF: absolutely/fixed-positioned elements anchored to the
 * initial containing block do NOT drift in the clone (they resolve against
 * the embedding viewport), so compensating the crop shifts THEM by -drift px
 * in the output. That bounded skew on toasts/FABs is accepted over the
 * alternative (clone-side margin fixes), which makes Chromium's rasterizer
 * drop those elements entirely.
 */
function bodyCloneDriftCssPx(root: Element): { x: number; y: number } {
  if (typeof window === 'undefined') return { x: 0, y: 0 };
  if (root.tagName !== 'BODY') return { x: 0, y: 0 };
  try {
    const cs = window.getComputedStyle(root);
    const mLeft = Number.parseFloat(cs.marginLeft) || 0;
    const mTop = Number.parseFloat(cs.marginTop) || 0;
    return {
      x: Math.max(0, UA_BODY_MARGIN_CSS_PX - mLeft),
      y: Math.max(0, UA_BODY_MARGIN_CSS_PX - mTop),
    };
  } catch {
    return { x: 0, y: 0 };
  }
}

export interface ViewportCropRect {
  /** Source-crop origin/extent within the bitmap (device px). */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Output canvas size (device px) — the full viewport. */
  outW: number;
  outH: number;
  /** True when the bitmap already IS the desired output (skip re-encode). */
  noop: boolean;
}

/**
 * Pure crop geometry for cropBlobToViewport — exported for unit tests.
 * Maps the viewport rect (scroll + drift compensated) onto the bitmap and
 * clamps the source to what actually exists; the output stays viewport-sized
 * (callers white-pad the uncovered remainder), so area-selection math
 * downstream always operates on a full-viewport image.
 */
export function computeViewportCropRect(args: {
  bmWidth: number;
  bmHeight: number;
  scrollX: number;
  scrollY: number;
  innerWidth: number;
  innerHeight: number;
  pixelRatio: number;
  driftX?: number;
  driftY?: number;
}): ViewportCropRect | null {
  const { bmWidth, bmHeight, scrollX, scrollY, innerWidth, innerHeight, pixelRatio } = args;
  const driftX = args.driftX ?? 0;
  const driftY = args.driftY ?? 0;
  const outW = Math.round(innerWidth * pixelRatio);
  const outH = Math.round(innerHeight * pixelRatio);
  if (outW <= 0 || outH <= 0) return null;
  const sx = Math.max(0, Math.round((scrollX + driftX) * pixelRatio));
  const sy = Math.max(0, Math.round((scrollY + driftY) * pixelRatio));
  const sw = Math.min(outW, bmWidth - sx);
  const sh = Math.min(outH, bmHeight - sy);
  if (sw <= 0 || sh <= 0) return null;
  const noop = sx === 0 && sy === 0 && sw === bmWidth && sh === bmHeight && sw === outW && sh === outH;
  return { sx, sy, sw, sh, outW, outH, noop };
}

/**
 * Crop the full-document render down to the current viewport at device-pixel
 * resolution, compensating the capture library's in-flow clone drift (see
 * bodyCloneDriftCssPx). Operates on the CANVAS the capture produced — before
 * any encode — so the crop costs one drawImage instead of the old pipeline's
 * PNG decode + re-encode. Where the drifted crop reaches past the bitmap's
 * right/bottom edge (the clone's last `drift` px of in-flow content were
 * pushed outside the fixed-size render), the output is padded with the
 * capture background white instead of shrinking — downstream area-selection
 * math relies on the shot being exactly viewport-sized. Returns the input
 * canvas untouched in environments without `window` (SSR / jsdom), when the
 * crop is a no-op, or when a 2d context is unavailable.
 */
function cropCanvasToViewport(
  canvas: HTMLCanvasElement,
  pixelRatio: number,
  drift: { x: number; y: number } = { x: 0, y: 0 },
): HTMLCanvasElement {
  if (typeof window === 'undefined') return canvas;
  const rect = computeViewportCropRect({
    bmWidth: canvas.width,
    bmHeight: canvas.height,
    scrollX: window.scrollX || 0,
    scrollY: window.scrollY || 0,
    innerWidth: window.innerWidth || 0,
    innerHeight: window.innerHeight || 0,
    pixelRatio,
    driftX: drift.x,
    driftY: drift.y,
  });
  if (!rect || rect.noop) return canvas;
  const { sx, sy, sw, sh, outW, outH } = rect;
  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext('2d');
  if (!ctx) return canvas;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outW, outH);
  ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return out;
}

export interface ModernScreenshotRenderOptions {
  pixelRatio: number; // effective (capped)
  requestedRatio: number; // what the caller asked for
  filter: (node: Node) => boolean;
  profile: CaptureProfile;
  maskPlan?: Rect[]; // root-relative device px at requestedRatio
}

/** Viewport-cropped fallback canvas plus its PRE-MASK blank verdict. */
export interface ModernScreenshotRenderResult {
  canvas: HTMLCanvasElement;
  /**
   * Whether the raw render was near-uniform, measured on the un-cropped
   * domToCanvas result BEFORE any `maskPlan` painting — black mask boxes on a
   * flat raster must not make it look like a real screenshot. An unavailable
   * check (null) counts as not blank.
   */
  blank: boolean;
}

/**
 * Fallback renderer: modern-screenshot clone + raster, legacy `maskPlan`
 * painted on the full canvas, then cropped to the viewport. Returns the
 * cropped canvas with a blank verdict taken before masking.
 */
export async function renderViewportWithModernScreenshot(
  root: HTMLElement,
  opts: ModernScreenshotRenderOptions,
): Promise<ModernScreenshotRenderResult> {
  const { pixelRatio, requestedRatio, filter, profile } = opts;
  const cloneDrift = bodyCloneDriftCssPx(root);
  // TV profile: drop out-of-flow, fully-invisible subtrees.
  const prunable = profile.viewportOnlyClone ? computePrunableNodes(root) : null;
  // Off-screen images the viewport crop will discard — resolved to a lookup
  // set here because `fetchFn` below only ever sees a URL.
  const skippableImageUrls = computeSkippableImageUrls(root);
  const cloneFilter =
    prunable && prunable.size > 0
      ? (node: Node): boolean => filter(node) && !prunable.has(node as Element)
      : filter;
  const modernScreenshot = await import('modern-screenshot');
  const canvas = await modernScreenshot.domToCanvas(root, {
        scale: pixelRatio,
        backgroundColor: '#ffffff',
        filter: cloneFilter,
        // Bounds the pre-clone resource wait. Required IN ADDITION to dropping
        // <video> in filterNode, not instead of it: measured, the filter alone
        // still costs the full 30s default on a stalled source (that wait runs
        // BEFORE the filter is consulted), and this option alone does not stop
        // the hang at all (it never reaches the clone step). Only both together
        // are fast.
        timeout: RESOURCE_WAIT_BUDGET_MS,
        // NOTE — clone-margin drift (do NOT "fix" this with style overrides):
        // modern-screenshot deletes the root's margin properties from the
        // cloned node's inline style; when the root is document.body the clone
        // picks the UA default body margin (8px) back up inside the SVG
        // foreignObject render (the page's own `body { margin: 0 }` stylesheet
        // does not exist in the clone), so ALL in-flow content renders shifted
        // down/right by 8px. Measured live on chromium, firefox and webkit.
        // Every attempted clone-side correction (style:{margin:'0'}, the same
        // via !important, a <style> sheet in the SVG, position:relative
        // offsets, capturing documentElement instead) makes Chromium's SVG
        // rasterizer DROP absolutely/fixed-positioned elements anchored to the
        // initial containing block (toasts, FABs, portaled modals) — measured:
        // they render in the baseline configuration only. The drift is instead
        // compensated at crop time (see bodyCloneDriftCssPx +
        // cropCanvasToViewport below), which never touches the clone.
        // Opt-in feature — defaults off in modern-screenshot for backcompat.
        // Walks the cloned tree; per node, reads ORIGINAL's scrollTop/scrollLeft
        // and composes a translate into the clone's transform matrix. Composes
        // correctly across nested scrollables.
          features: { restoreScrollPosition: true },
          // Resolve off-screen images to a transparent pixel instead of a
          // network round trip (see computeSkippableImageUrls). Returning
          // `false` hands the URL back to modern-screenshot's normal fetch, so
          // everything on screen — and everything this scan never saw — is
          // embedded exactly as before. Omitted entirely when nothing is
          // skippable, leaving the default fetch path untouched.
          ...(skippableImageUrls.size > 0
            ? {
                fetchFn: (url: string): Promise<string | false> =>
                  Promise.resolve(skippableImageUrls.has(url) ? SKIPPED_IMAGE_DATA_URL : false),
              }
            : {}),
          // TV profile only: skip webfont embedding and copy the curated style
          // whitelist instead of all ~300 computed properties — the clone walk
          // is the dominant capture cost on TV CPUs (capture-profile.ts).
          ...(profile.fastClone
            ? { font: false as const, includeStyleProperties: FAST_CLONE_STYLE_PROPERTIES }
            : {}),
        });
  // Legacy rect-based masking (codex round-3 finding 1): rects are
  // ROOT-relative device px, so they must land on the un-cropped
  // canvas — the old pipeline masked the full-document blob before
  // cropping, and masking after the crop paints at the wrong offset
  // on scrolled pages, shipping the content the mask exists to hide.
  // Blank verdict BEFORE the mask paint — see ModernScreenshotRenderResult.
  const blank = isCanvasBlank(canvas) === true;
  if (opts.maskPlan && opts.maskPlan.length > 0) {
    // Rects arrive in requested-DPR device px; the canvas renders at
    // the (possibly capped) effective ratio — scale or the mask shifts
    // and exposes excluded pixels (codex round-4 finding).
    paintMaskRectsOnCanvas(canvas, opts.maskPlan, pixelRatio / (requestedRatio || 1));
  }
  return { canvas: cropCanvasToViewport(canvas, pixelRatio, cloneDrift), blank };
}
