// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { isCanvasBlank } from '../blank-check.js';

/**
 * Primary screenshot renderer (2026-09-29 benchmark, design doc
 * 2026-09-29-web-screenshot-capture-design.md): 2-25x faster than
 * modern-screenshot on desktop, no blank rasters where modern-screenshot
 * produced them, and `fast: false` yields to the page about once per frame
 * so the capture deadline can actually fire.
 *
 * `clip: 'viewport'` makes snapDOM prune off-screen styling and inlining and
 * return a viewport-sized canvas, which replaces the modern-screenshot
 * path's own pruning pre-pass, off-screen image skipping and clone-drift
 * crop. `filterMode: 'remove'` matches what modern-screenshot's filter did:
 * a filtered node contributes no layout box (videos are already
 * `display: none` behind their stand-ins; SDK chrome is portaled).
 *
 * Nested scroll is restored by snapDOM itself, in its clone step: each
 * scrolled element's children move into one wrapper translated by the scroll
 * offset. Our pnpm patch (patches/@zumer__snapdom@3.2.0.patch) makes that
 * wrapper carry a flex/grid scroller's layout, drops snapDOM's counter-offset
 * that left absolute descendants unscrolled, exempts wrapped scrollers from
 * the shrink pass that expanded stylesheet-sized ones. Documented
 * limitations: an absolutely
 * positioned element anchored OUTSIDE a static scroller, or anchored to a
 * scroller that has padding, lands off by that offset; percent-height
 * children of block scrollers lose their percentage basis; flex/grid
 * scrollers sized only by max-height may lay out their items differently.
 */
export interface SnapdomRenderOptions {
  /** Effective (already capped) device pixel ratio for the output. */
  pixelRatio: number;
  /** Keep-predicate — false drops the node from the capture. */
  filter: (node: Node) => boolean;
  /**
   * How long to wait for a previous, still-running snapDOM capture before
   * giving up with SnapdomBusyError (default 0: fail at once). See
   * renderViewportWithSnapdom.
   */
  busyWaitMs?: number;
}

/**
 * `clip: 'viewport'` sizes the canvas from documentElement.clientWidth/Height,
 * which EXCLUDES a classic (non-overlay) scrollbar. Callers - the reporter's
 * area-select math divides by innerWidth - expect exactly
 * innerWidth x innerHeight x ratio, as the old viewport crop produced. A
 * smaller canvas is copied onto a white canvas of that size at (0,0); an
 * equal or larger one (or no 2d context, e.g. jsdom) is returned unchanged.
 */
function padToViewport(canvas: HTMLCanvasElement, pixelRatio: number): HTMLCanvasElement {
  if (typeof window === 'undefined') return canvas;
  const targetW = Math.round(window.innerWidth * pixelRatio);
  const targetH = Math.round(window.innerHeight * pixelRatio);
  if (canvas.width >= targetW && canvas.height >= targetH) return canvas;
  const padded = document.createElement('canvas');
  padded.width = Math.max(targetW, canvas.width);
  padded.height = Math.max(targetH, canvas.height);
  const ctx = padded.getContext('2d');
  if (!ctx) return canvas;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, padded.width, padded.height);
  ctx.drawImage(canvas, 0, 0);
  return padded;
}

/** Viewport-sized snapDOM canvas plus its PRE-PADDING, PRE-MASK blank verdict. */
export interface SnapdomRenderResult {
  canvas: HTMLCanvasElement;
  /**
   * Whether the raw snapDOM raster was near-uniform, measured BEFORE
   * padToViewport adds a white scrollbar strip (a flat dark raster plus that
   * strip must still read as blank) and before any `maskPlan` painting.
   * An unavailable check (null) counts as not blank.
   */
  blank: boolean;
  /**
   * The capture root's viewport rect (CSS px), read synchronously right
   * before snapDOM started: where the root sits on this viewport-sized
   * canvas, so root-relative mask rects map onto it. snapDOM yields while
   * rendering, so a read after it settles may describe a different viewport.
   */
  rootLeft: number;
  rootTop: number;
}

/** A previous snapDOM capture is still running (see renderViewportWithSnapdom). */
export class SnapdomBusyError extends Error {}

/** The running snapDOM capture, settled only when snapDOM's own work has finished. */
let inflight: Promise<void> | null = null;

/**
 * snapDOM captures never overlap. snapDOM rewrites the LIVE page while it
 * clones (ellipsized text, scroll wrappers are read from it) and restores it
 * afterwards; two interleaved runs can restore each other's rewrites - e.g.
 * permanently truncate text. A capture therefore waits up to `busyWaitMs`
 * for a running one - including one its caller abandoned on the deadline,
 * which keeps running until snapDOM settles - and then fails with
 * SnapdomBusyError without starting snapDOM.
 */
export async function renderViewportWithSnapdom(
  root: HTMLElement,
  opts: SnapdomRenderOptions,
): Promise<SnapdomRenderResult> {
  const until = Date.now() + (opts.busyWaitMs ?? 0);
  while (inflight) {
    const remaining = until - Date.now();
    if (remaining <= 0) throw new SnapdomBusyError('a previous snapDOM capture is still running');
    const current = inflight;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, remaining);
      void current.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  // Claimed synchronously after the loop: no await between seeing the slot
  // free and taking it.
  const run = runSnapdom(root, opts);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  inflight = settled;
  void settled.then(() => {
    if (inflight === settled) inflight = null;
  });
  return run;
}

async function runSnapdom(root: HTMLElement, opts: SnapdomRenderOptions): Promise<SnapdomRenderResult> {
  const { snapdom } = await import('@zumer/snapdom');
  const rootRect = root.getBoundingClientRect();
  const capture = await snapdom(root, {
    clip: 'viewport',
    fast: false,
    scale: 1,
    dpr: opts.pixelRatio,
    backgroundColor: '#ffffff',
    filter: (el: Element) => opts.filter(el),
    filterMode: 'remove',
    embedFonts: 'auto',
    // Clears snapDOM's per-element style snapshots on every capture (the
    // resource cache - fonts, images - is kept). Without it, a script edit
    // to an existing stylesheet rule (`rule.style.background = ...`) ships
    // the PREVIOUS capture's styling. Repeat-capture memoization is also
    // skipped today only because `filter` is a function - do not rely on
    // that; this flag is the explicit guarantee.
    invalidate: true,
  });
  const raw = await capture.toCanvas();
  const blank = isCanvasBlank(raw) === true;
  return {
    canvas: padToViewport(raw, opts.pixelRatio),
    blank,
    rootLeft: rootRect.left,
    rootTop: rootRect.top,
  };
}
