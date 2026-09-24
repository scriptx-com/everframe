// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import type { ScreenshotResult, Rect } from '@everframe/sdk-core';
import { sha256Hex } from './sha256.js';
import { applyDomMask } from '../sensitive/registry.js';
import { DEGRADED_REASONS, type DegradedReason } from '../internal/degraded-reasons.js';
import { installVideoStandIns } from './video-frames.js';
import {
  FAST_CLONE_STYLE_PROPERTIES,
  computeCappedPixelRatio,
  getCaptureProfile,
} from './capture-profile.js';

export interface CaptureScreenshotOptions {
  /** Root element to capture; defaults to document.body */
  root?: HTMLElement;
  /** CSP nonce — threaded into dynamically-injected styles to satisfy strict-CSP environments (Pitfall 11). */
  cspNonce?: string;
  /**
   * Legacy auto-mask plan (rect-based). Painted post-capture via
   * `applyMaskRectsToBlob` — kept for backwards-compat with callers that have
   * rects but not the underlying DOM elements. New callers should prefer
   * `maskTargets` (live-DOM masking), which sidesteps the viewport→PNG
   * coordinate transform entirely.
   */
  maskPlan?: Rect[];
  /**
   * Live-DOM masking targets — sensitive elements that should be rendered as
   * solid-black boxes in the captured PNG. Each element gets an inline-style
   * mask applied just before the capture library clones the DOM, restored in a
   * `finally` immediately after. Layout is preserved (boxes keep their size);
   * content is invisible. Strongly preferred over `maskPlan` because the
   * capture library handles the coordinate transform natively.
   */
  maskTargets?: Element[];
  /** Optional pixel ratio override (default = window.devicePixelRatio). */
  pixelRatio?: number;
  /**
   * Surface (out-param) — set to a DegradedReason if screenshot capture fails. Adapter reads this
   * to populate envelope.captureControl.degradedReason (plan 07).
   */
  __setDegradedReason?: (reason: DegradedReason) => void;
}

/**
 * 1x1 transparent PNG bytes — used as the degraded-result blob when
 * modern-screenshot fails. DEFE-02: never block submission on a screenshot failure.
 */
const TRANSPARENT_PIXEL_PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

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
 * Wall-clock ceiling for the whole capture — per device tier, see
 * capture-profile.ts (10s desktop, 20s Smart-TV webviews where a legitimate
 * capture measures 8-12s).
 *
 * DEFENCE IN DEPTH, and the load-bearing part of it. `<video>` is handled
 * explicitly (see video-frames.ts), but that is a fix for the ONE unbounded
 * await we found by decompiling modern-screenshot — we cannot prove there isn't
 * another in the library's clone walk, and the failure mode is a permanently
 * stuck reporter rather than an error anyone can see. This makes a hang
 * structurally impossible: whatever stalls, the deadline rejects and capture
 * degrades to a transparent placeholder.
 */

/** WebP quality for the TV profile's single-pass encode (matches the relay hop's 0.85). */
const WEBP_QUALITY = 0.85;

/**
 * Raised when screenshot capture blows its deadline.
 */
class CaptureTimeoutError extends Error {}

/**
 * Reject if `work` has not settled within `ms`.
 *
 * Note this does not (and cannot) CANCEL the underlying work — modern-screenshot
 * does not take an AbortSignal. The stalled promise stays pending and becomes garbage
 * once unreferenced; what matters is that our caller stops waiting on it.
 */
function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new CaptureTimeoutError(`${label} exceeded ${ms}ms`)),
      ms,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Hook into the document so any <style> tag inserted while the capture is running gets
 * the customer's CSP nonce. modern-screenshot injects <style> nodes for embedded font
 * CSS / inlined image data — without the nonce the strict-CSP page
 * blocks them (Pitfall 11) and the screenshot is empty.
 */
function applyNonceToFreshStyles(nonce: string): () => void {
  const observer = new MutationObserver((muts) => {
    for (const m of muts) {
      // NodeList iteration via Array.from — workspace tsconfig.base.json does not
      // include 'DOM.Iterable' in lib, so `for (const node of nodeList)` errors with
      // TS2488. Array.from materialises a one-shot snapshot which is correct for
      // MutationObserver semantics (addedNodes is a static NodeList per spec).
      for (const node of Array.from(m.addedNodes)) {
        if (node instanceof HTMLStyleElement && !node.nonce) {
          node.nonce = nonce;
          node.setAttribute('nonce', nonce);
        }
      }
    }
  });
  observer.observe(document.head, { childList: true, subtree: false });
  return () => observer.disconnect();
}

/**
 * Apply solid-fill mask rects on top of a PNG blob via OffscreenCanvas (or HTMLCanvas
 * fallback). Plan 06 will replace the solid #000 fill with a blur for ANN-02; plan 03
 * only needs the rect-based MASK that Phase-1 redaction emits for password fields.
 *
 * Exported so adapter.applyMaskPlan can re-use the same code path (no duplication).
 */
/**
 * Coordinate-transform options for mask rects. Rects from
 * `sensitiveRegistry.snapshot()` are in VIEWPORT CSS pixels (returned by
 * `getBoundingClientRect`). The captured PNG is in ROOT-relative DEVICE pixels
 * (width = root.scrollWidth * pixelRatio). Without these two transforms the
 * mask appears at 1/pixelRatio scale and offset by the root's viewport origin,
 * which is what causes phones to paint the black bar in the wrong place.
 */
export interface ApplyMaskRectsOptions {
  /** Device pixel ratio used when capturing the PNG. Defaults to 1. */
  pixelRatio?: number;
  /** Root element's viewport-relative origin (typically `root.getBoundingClientRect()`). */
  rootOriginX?: number;
  rootOriginY?: number;
}

export async function applyMaskRectsToBlob(
  blob: Blob,
  rects: Rect[],
  opts: ApplyMaskRectsOptions = {},
): Promise<Blob> {
  if (rects.length === 0) return blob;
  const ratio = opts.pixelRatio ?? 1;
  const ox = opts.rootOriginX ?? 0;
  const oy = opts.rootOriginY ?? 0;
  // Safety inflation — expand every rect by 2 CSS px on each side before
  // painting. Subpixel rounding, system font metric differences between the
  // live page and the cloned render, and tiny layout shifts that
  // happen between snapshot-time and capture-time all conspire to leave a
  // 1-2px sliver of sensitive content visible at the edges. Inflating is the
  // pragmatic cure — over-masking is harmless (worst case a few extra black
  // pixels around the rect); under-masking leaks PII.
  const inflateCssPx = 2;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    // jsdom or unsupported decoder — return input unmodified rather than fail
    return blob;
  }
  const useOffscreen = typeof OffscreenCanvas !== 'undefined';
  const canvas: OffscreenCanvas | HTMLCanvasElement = useOffscreen
    ? new OffscreenCanvas(bitmap.width, bitmap.height)
    : Object.assign(document.createElement('canvas'), {
        width: bitmap.width,
        height: bitmap.height,
      });
  const ctx = (canvas as HTMLCanvasElement).getContext('2d');
  if (!ctx) return blob;
  ctx.drawImage(bitmap as unknown as CanvasImageSource, 0, 0);
  ctx.fillStyle = '#000000';
  for (const r of rects) {
    ctx.fillRect(
      (r.x - ox - inflateCssPx) * ratio,
      (r.y - oy - inflateCssPx) * ratio,
      (r.width + inflateCssPx * 2) * ratio,
      (r.height + inflateCssPx * 2) * ratio,
    );
  }
  if (useOffscreen && canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: 'image/png' });
  }
  return new Promise<Blob>((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))),
      'image/png',
    );
  });
}

/**
 * Paint legacy `maskPlan` rects (root-relative DEVICE px) straight onto the
 * full-document capture canvas — same coordinate space, same 2px safety
 * inflation as `applyMaskRectsToBlob`, minus that path's decode/encode round.
 * Best-effort: a missing 2d context skips masking rather than failing the
 * capture (the caller's primary masking is live-DOM `maskTargets`).
 */
function paintMaskRectsOnCanvas(
  canvas: HTMLCanvasElement,
  rects: Rect[],
  /** effective (capped) ratio ÷ requested ratio — 1 whenever no cap applied. */
  scale = 1,
): void {
  const inflate = 2;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext('2d');
  } catch {
    return;
  }
  if (!ctx) return;
  ctx.fillStyle = '#000000';
  for (const r of rects) {
    ctx.fillRect(
      r.x * scale - inflate,
      r.y * scale - inflate,
      r.width * scale + inflate * 2,
      r.height * scale + inflate * 2,
    );
  }
}

/**
 * Skip the SDK's own DOM (bubble, modal, toast) from the captured page so the screenshot
 * shows the customer's app underneath, not the reporter widget itself. SDK roots are
 * tagged with `data-everframe-skip-capture="true"` (see provider.tsx + primitives).
 *
 * Hoisted to module scope (rather than nested in `captureScreenshot`) so it can be
 * exercised directly by tests via `__filterNodeForTests` without mocking `modern-screenshot`.
 */
// Typed on `Node`, not `HTMLElement`, because the clone walk hands us text and comment
// nodes that have no getAttribute at all. The probe below is the narrowing.
const filterNode = (node: Node): boolean => {
  const el = node as Partial<Element>;
  if (typeof el?.getAttribute !== 'function') return true;
  // <video> NEVER reaches the capture library. modern-screenshot's
  // cloneVideoElement awaits a `seeked` event that a readyState-0 element is
  // spec'd never to fire, hanging capture forever. This is avoided by
  // excluding the element and compositing the frame back ourselves — see
  // video-frames.ts for the measurements.
  if (el.tagName === 'VIDEO') return false;
  return el.getAttribute('data-everframe-skip-capture') !== 'true';
};

/** Test seam — the real clone filter, callable directly without mocking modern-screenshot. */
export function __filterNodeForTests(node: Node): boolean {
  return filterNode(node);
}

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

export async function captureScreenshot(
  opts: CaptureScreenshotOptions = {},
): Promise<ScreenshotResult> {
  const root = opts.root ?? document.body;
  const restoreObserver = opts.cspNonce ? applyNonceToFreshStyles(opts.cspNonce) : () => undefined;
  const profile = getCaptureProfile();
  const requestedRatio =
    opts.pixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1);
  // Cap the OUTPUT's longest edge (capture-profile.ts) — a dpr-2 TV otherwise
  // rasterises AND PNG-encodes 3840x2160, measured at 7.4s of encode alone on
  // webOS silicon. Measured against the VIEWPORT, because that is what the
  // final bitmap is cropped to (codex round-2 finding 5: measuring the
  // document shrank long pages to unreadable ratios); the root rect is only
  // the no-window fallback.
  const capW =
    typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : rootCssWidth(root);
  const capH =
    typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : rootCssHeight(root);
  const pixelRatio = computeCappedPixelRatio(
    requestedRatio,
    capW,
    capH,
    profile.maxOutputEdgePx,
  );

  let blob: Blob | null = null;
  let width = 0;
  let height = 0;
  // In-flow clone drift of the PRIMARY capture path (see the long note on the
  // domToBlob call) — compensated at viewport-crop time.
  let cloneDrift = bodyCloneDriftCssPx(root);

  // Apply live-DOM masking to sensitive elements BEFORE modern-screenshot clones
  // the page. The capture library snapshots whatever the DOM looks like at
  // clone time, so the masked elements end up as solid-black boxes in the
  // PNG automatically — no post-capture coordinate transform required. The
  // restore() runs in `finally` so a throwing capture still un-masks.
  const restoreDomMask =
    opts.maskTargets && opts.maskTargets.length > 0
      ? applyDomMask(opts.maskTargets)
      : (): void => undefined;

  // Swap each <video> for a same-sized stand-in carrying its current frame,
  // because filterNode below drops every <video> from the clone and a filtered
  // node contributes NO LAYOUT BOX — measured, an in-flow 320x180 video made
  // everything beneath it render 180px too high. The stand-in holds the box
  // open and shows the frame; see video-frames.ts for the full reasoning.
  //
  // Ordering matters twice over: AFTER applyDomMask, so a masked video is
  // observed in its masked state; and BEFORE the capture, so the frame matches
  // the moment the rest of the page was sampled rather than lagging it.
  let restoreVideoStandIns: () => void = () => undefined;
  try {
    restoreVideoStandIns = await installVideoStandIns(root, {
      pixelRatio,
      maskTargets: opts.maskTargets ?? [],
    });
  } catch {
    // An enhancement; never let it cost us the screenshot.
    restoreVideoStandIns = () => undefined;
  }

  // Try modern-screenshot (primary, since it supports `restoreScrollPosition`
  // — applies `transform: translate(-scrollLeft, -scrollTop)` per element in
  // the CLONE tree, never mutating the live DOM. This avoids the prior
  // approach's two failure modes: (a) firing scroll events on live elements,
  // which `react-virtualized`/`react-window`/`@tanstack/virtual` listen to
  // and re-render mid-capture against, breaking the capture; and (b) any
  // observable side-effects from temporary live mutations).
  //
  // domToCanvas, not domToBlob: the viewport crop happens in CANVAS space and
  // the result is encoded exactly ONCE. The previous blob-based pipeline
  // encoded a full PNG, decoded it again for the viewport crop, and re-encoded
  // — measured at ~7s of pure re-encode on webOS hardware.
  try {
    // TV profile: drop out-of-flow, fully-invisible subtrees.
    const prunable = profile.viewportOnlyClone ? computePrunableNodes(root) : null;
    // Off-screen images the viewport crop will discard — resolved to a lookup
    // set here because `fetchFn` below only ever sees a URL.
    const skippableImageUrls = computeSkippableImageUrls(root);
    const cloneFilter =
      prunable && prunable.size > 0
        ? (node: Node): boolean => filterNode(node) && !prunable.has(node as Element)
        : filterNode;
    const modernScreenshot = await import('modern-screenshot');
    // The deadline covers the WHOLE chain — clone+raster, crop AND encode.
    // Codex round-1 finding 1: a degraded engine's canvas.toBlob can simply
    // never invoke its callback; an encode outside the deadline would hang
    // capture forever (DEFE-02), which is exactly what the deadline exists
    // to make structurally impossible.
    const captured = await withDeadline(
      (async () => {
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
        if (opts.maskPlan && opts.maskPlan.length > 0) {
          // Rects arrive in requested-DPR device px; the canvas renders at
          // the (possibly capped) effective ratio — scale or the mask shifts
          // and exposes excluded pixels (codex round-4 finding).
          paintMaskRectsOnCanvas(canvas, opts.maskPlan, pixelRatio / (requestedRatio || 1));
        }
        const cropped = cropCanvasToViewport(canvas, pixelRatio, cloneDrift);
        const encoded = await encodeCanvas(cropped, profile.preferWebP);
        // Dims travel WITH the result (codex round-3 finding 6): mutating
        // outer state from abandoned deadline work let a late raster relabel
        // the degraded 1x1 placeholder with full-screen dimensions.
        return { encoded, width: cropped.width, height: cropped.height };
      })(),
      profile.deadlineMs,
      'modern-screenshot',
    );
    if (!captured.encoded) throw new Error('canvas encode returned null blob');
    blob = captured.encoded;
    width = captured.width;
    height = captured.height;
  } catch {
    opts.__setDegradedReason?.(DEGRADED_REASONS.screenshot_failed);
    blob = new Blob([TRANSPARENT_PIXEL_PNG_BYTES as BlobPart], { type: 'image/png' });
  } finally {
    restoreObserver();
    restoreDomMask();
    // Puts the customer's videos back on screen. Must run whatever happened
    // above — leaving a page with display:none videos and orphaned stand-in
    // divs would be a far worse bug than a failed screenshot.
    restoreVideoStandIns();
  }

  // Treat a null result as a failed capture so the report still sends with an
  // honest degraded reason attached.
  if (!blob) {
    opts.__setDegradedReason?.(DEGRADED_REASONS.screenshot_failed);
    blob = new Blob([TRANSPARENT_PIXEL_PNG_BYTES as BlobPart], { type: 'image/png' });
  }

  // NOTE — the legacy `maskPlan` pass now runs on the CANVAS inside the
  // deadline above (root-relative space, before the viewport crop). The
  // primary masking path is live-DOM masking via `maskTargets`.

  // NOTE — video frames are NOT composited on here. They ride in the DOM as
  // stand-ins (see installVideoStandIns above), so they are rendered by the
  // capture library along with everything else. Painting them on afterwards is
  // what an earlier revision did, and it silently overwrote the `maskPlan`
  // redaction applied a few lines up, as well as any element stacked over a
  // video. Do not reintroduce a post-redaction paint step.

  // The success path already knows its dimensions from the cropped canvas —
  // only the degraded path (transparent-pixel placeholder) still resolves them
  // by decoding, falling back to the root element rect under jsdom.
  if (width === 0 || height === 0) {
    try {
      const bm = await createImageBitmap(blob);
      width = bm.width;
      height = bm.height;
    } catch {
      width = Math.max(1, Math.round(root.clientWidth || 1));
      height = Math.max(1, Math.round(root.clientHeight || 1));
    }
  }

  const sha256 = await sha256Hex(blob);
  return { blob, width, height, sha256 };
}

/** Root size in CSS px for the output-edge cap; tolerates detached/jsdom roots. */
function rootCssWidth(root: HTMLElement): number {
  return root.clientWidth || (typeof root.getBoundingClientRect === 'function' ? root.getBoundingClientRect().width : 0);
}

function rootCssHeight(root: HTMLElement): number {
  return root.clientHeight || (typeof root.getBoundingClientRect === 'function' ? root.getBoundingClientRect().height : 0);
}

/**
 * Encode the final canvas exactly once. TV profile prefers WebP (the relay hop
 * re-encodes PNG to WebP anyway — encoding WebP here lets that hop no-op and
 * saves a full decode/encode round on the slowest hardware); anything else
 * keeps PNG. Falls back to PNG when the WebP encoder hands back null.
 */
async function encodeCanvas(canvas: HTMLCanvasElement, preferWebP: boolean): Promise<Blob | null> {
  const encode = (type: string, quality?: number): Promise<Blob | null> =>
    new Promise((resolve) => {
      try {
        canvas.toBlob((b) => resolve(b), type, quality);
      } catch {
        resolve(null);
      }
    });
  if (preferWebP) {
    const webp = await encode('image/webp', WEBP_QUALITY);
    if (webp) return webp;
  }
  return encode('image/png');
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
