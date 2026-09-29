// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import type { ScreenshotResult, Rect } from '@everframe/sdk-core';
import { sha256Hex } from './sha256.js';
import { applyDomMask } from '../sensitive/registry.js';
import { DEGRADED_REASONS, type DegradedReason } from '../internal/degraded-reasons.js';
import { installVideoStandIns } from './video-frames.js';
import { renderViewportWithModernScreenshot } from './renderers/modern-screenshot-renderer.js';
import { renderViewportWithSnapdom } from './renderers/snapdom-renderer.js';
import { paintMaskRectsOnCanvas } from './mask-paint.js';
export { computeViewportCropRect, type ViewportCropRect } from './renderers/modern-screenshot-renderer.js';
import { computeCappedPixelRatio, getCaptureProfile } from './capture-profile.js';

export type ScreenshotRenderer = 'snapdom' | 'modern-screenshot' | 'none';

/**
 * Share of the profile deadline the primary renderer may use before the
 * fallback starts. snapDOM cannot be cancelled either — a stalled attempt
 * keeps running in the background — but the fallback no longer waits on it.
 */
const PRIMARY_BUDGET_SHARE = 0.6;

/**
 * Minimum time the single encode gets even when rendering used the whole
 * budget: a real canvas is never thrown away for want of an encode slot.
 * Worst case total = profile.deadlineMs + ENCODE_FLOOR_MS.
 */
const ENCODE_FLOOR_MS = 2_000;

export interface CaptureScreenshotOptions {
  /** Root element to capture; defaults to document.body */
  root?: HTMLElement;
  /** CSP nonce — threaded into dynamically-injected styles to satisfy strict-CSP environments (Pitfall 11). */
  cspNonce?: string;
  /**
   * Legacy auto-mask plan (rect-based). Painted onto the rendered canvas
   * (mask-paint.ts) before the single encode — kept for backwards-compat with callers that have
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
  /** Surface (out-param) — which renderer produced the shipped image ('none' = placeholder). */
  __setRenderer?: (renderer: ScreenshotRenderer) => void;
}

/**
 * 1x1 transparent PNG bytes — used as the degraded-result blob when no
 * renderer produced a usable canvas. DEFE-02: never block submission on a
 * screenshot failure.
 */
const TRANSPARENT_PIXEL_PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

/** WebP quality for the TV profile's single-pass encode (matches the relay hop's 0.85). */
const WEBP_QUALITY = 0.85;

/*
 * Wall-clock ceiling for the whole capture — per device tier, see
 * capture-profile.ts (10s desktop, 45s Smart-TV webviews), split between the
 * renderers by PRIMARY_BUDGET_SHARE plus the ENCODE_FLOOR_MS encode slot.
 *
 * DEFENCE IN DEPTH, and the load-bearing part of it. `<video>` is handled
 * explicitly (see video-frames.ts), but that is a fix for the ONE unbounded
 * await we found by decompiling modern-screenshot — we cannot prove there isn't
 * another in either renderer's clone walk, and the failure mode is a
 * permanently stuck reporter rather than an error anyone can see. This makes a
 * hang structurally impossible: whatever stalls, the deadline rejects and
 * capture degrades to a transparent placeholder.
 */

/**
 * Raised when screenshot capture blows its deadline.
 */
class CaptureTimeoutError extends Error {}

/**
 * Reject if `work` has not settled within `ms`.
 *
 * Note this does not (and cannot) CANCEL the underlying work — neither
 * renderer takes an AbortSignal. The stalled promise stays pending and becomes
 * garbage once unreferenced; what matters is that our caller stops waiting on it.
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
 * the customer's CSP nonce. The capture libraries may inject <style> nodes (embedded
 * font CSS, inlined image data, measurement sandboxes) — without the nonce the
 * strict-CSP page blocks them (Pitfall 11) and the screenshot is empty.
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

  // Apply live-DOM masking to sensitive elements BEFORE the renderer clones
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

  // snapDOM first (faster, and no blank rasters where modern-screenshot
  // produced them), with modern-screenshot as the fallback when snapDOM
  // throws, stalls past its budget share, or hands back a blank canvas
  // (on TV only when it throws — see the policy below).
  // Both renderers return a VIEWPORT-sized canvas, which is encoded exactly
  // ONCE below. Every stage is deadline-guarded: a degraded engine's
  // canvas.toBlob can simply never invoke its callback, and an unguarded
  // await would hang capture forever (DEFE-02).
  type Attempt = { canvas: HTMLCanvasElement; renderer: Exclude<ScreenshotRenderer, 'none'> };
  const started = Date.now();
  const elapsed = (): number => Date.now() - started;
  let accepted: Attempt | null = null;
  let firstBlank: Attempt | null = null;
  let primaryTimedOut = false;

  try {
    try {
      // `blank` is measured by the renderer on the RAW raster — before its
      // scrollbar padding and before mask boxes add edges to a flat canvas.
      // `rootLeft/rootTop` is the capture root's viewport rect, read
      // synchronously right before snapDOM started. maskPlan rects are
      // ROOT-relative; snapDOM's viewport clip draws the root at that rect,
      // so the rect (not the window scroll - which only matches for a
      // margin-0 <body> root) maps them onto the canvas. Reading it after the
      // render settles would use wherever the page has scrolled since
      // (snapDOM `fast: false` yields), shipping the pixels the mask hides.
      const { canvas, blank, rootLeft, rootTop } = await withDeadline(
        renderViewportWithSnapdom(root, { pixelRatio, filter: filterNode }),
        Math.round(profile.deadlineMs * PRIMARY_BUDGET_SHARE),
        'snapdom',
      );
      if (opts.maskPlan && opts.maskPlan.length > 0) {
        paintMaskRectsOnCanvas(
          canvas,
          opts.maskPlan,
          pixelRatio / (requestedRatio || 1),
          -rootLeft * pixelRatio,
          -rootTop * pixelRatio,
        );
      }
      const attempt: Attempt = { canvas, renderer: 'snapdom' };
      if (blank) firstBlank = attempt;
      else accepted = attempt;
    } catch (err) {
      // Fall through to the fallback renderer (subject to the TV policy below).
      primaryTimedOut = err instanceof CaptureTimeoutError;
    }

    // TV profile: the fallback runs only when snapDOM threw a real error — a
    // blank snapDOM canvas ships flagged, and a snapDOM timeout degrades to
    // the placeholder. See CaptureProfile.fallbackOnlyOnPrimaryError.
    const runFallback =
      !accepted &&
      (!profile.fallbackOnlyOnPrimaryError || (firstBlank === null && !primaryTimedOut));

    if (runFallback) {
      try {
        // The renderer measures `blank` itself, before it paints maskPlan.
        const { canvas, blank } = await withDeadline(
          renderViewportWithModernScreenshot(root, {
            pixelRatio,
            requestedRatio,
            filter: filterNode,
            profile,
            ...(opts.maskPlan ? { maskPlan: opts.maskPlan } : {}),
          }),
          Math.max(0, profile.deadlineMs - elapsed()),
          'modern-screenshot',
        );
        const attempt: Attempt = { canvas, renderer: 'modern-screenshot' };
        if (!blank) accepted = attempt;
        else firstBlank ??= attempt;
      } catch {
        // Both renderers failed — handled below.
      }
    }

    const chosen: Attempt | null = accepted ?? firstBlank;
    if (chosen) {
      const encoded = await withDeadline(
        encodeCanvas(chosen.canvas, profile.preferWebP),
        Math.max(ENCODE_FLOOR_MS, profile.deadlineMs - elapsed()),
        'encode',
      );
      if (!encoded) throw new Error('canvas encode returned null blob');
      blob = encoded;
      // Dimensions come ONLY from the chosen canvas, here inside the deadline-guarded path — abandoned (timed-out) render work must never relabel the 1x1 placeholder (the "late raster relabel" bug).
      width = chosen.canvas.width;
      height = chosen.canvas.height;
      opts.__setRenderer?.(chosen.renderer);
      if (!accepted) opts.__setDegradedReason?.(DEGRADED_REASONS.screenshot_blank);
    }
  } catch {
    blob = null;
  } finally {
    restoreObserver();
    restoreDomMask();
    // Puts the customer's videos back on screen. Must run whatever happened
    // above — leaving a page with display:none videos and orphaned stand-in
    // divs would be a far worse bug than a failed screenshot.
    restoreVideoStandIns();
  }

  // No usable canvas (or the encode failed) — ship the placeholder with an
  // honest degraded reason so the report still sends.
  if (!blob) {
    opts.__setDegradedReason?.(DEGRADED_REASONS.screenshot_failed);
    opts.__setRenderer?.('none');
    blob = new Blob([TRANSPARENT_PIXEL_PNG_BYTES as BlobPart], { type: 'image/png' });
    width = 0;
    height = 0;
  }

  // NOTE — the legacy `maskPlan` pass now runs on the CANVAS inside the
  // deadline above: on the snapDOM path directly on the viewport-sized canvas
  // (offset by the root's viewport position), on the modern-screenshot path in
  // root-relative space before that renderer's viewport crop. The primary
  // masking path is live-DOM masking via `maskTargets`.

  // NOTE — video frames are NOT composited on here. They ride in the DOM as
  // stand-ins (see installVideoStandIns above), so they are rendered by the
  // capture library along with everything else. Painting them on afterwards is
  // what an earlier revision did, and it silently overwrote the `maskPlan`
  // redaction applied a few lines up, as well as any element stacked over a
  // video. Do not reintroduce a post-redaction paint step.

  // The success path already knows its dimensions from the chosen canvas —
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

