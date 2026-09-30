// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import type { Rect } from '@everframe/sdk-core';

/**
 * Paint legacy `maskPlan` rects (root-relative DEVICE px) straight onto a
 * capture canvas: the full-document modern-screenshot fallback canvas (same
 * coordinate space, no offsets) or the viewport-sized snapDOM canvas (offset
 * by the root's viewport position via `offsetX`/`offsetY`). Same 2px safety inflation
 * as `applyMaskRectsToBlob`, minus that path's decode/encode round.
 * Best-effort: a missing 2d context skips masking rather than failing the
 * capture (the caller's primary masking is live-DOM `maskTargets`).
 */
/**
 * Whether a mask rect can be painted where it belongs. Positions come from
 * `left`/`top` (Chrome < 61's ClientRect has no x/y); a rect that is still
 * not finite must stop the capture (fail closed), never paint nothing.
 */
export function isFiniteRect(r: { x: number; y: number; width: number; height: number }): boolean {
  return Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.width) && Number.isFinite(r.height);
}

/** Thrown when a sensitive area has no finite position: the shot must not ship. */
export class UnmaskableRectError extends Error {
  constructor() {
    super('a sensitive area has no finite position; refusing to ship it unmasked');
    this.name = 'UnmaskableRectError';
  }
}

export function paintMaskRectsOnCanvas(
  canvas: HTMLCanvasElement,
  rects: Rect[],
  /** effective (capped) ratio ÷ requested ratio — 1 whenever no cap applied. */
  scale = 1,
  /** Effective device px to subtract — minus the root's viewport origin for a viewport-sized canvas. */
  offsetX = 0,
  offsetY = 0,
): void {
  const inflate = 2;
  // Before the context check: an unpaintable rect fails the capture even
  // where the best-effort path would otherwise skip masking.
  if (!rects.every(isFiniteRect) || !Number.isFinite(scale) || !Number.isFinite(offsetX) || !Number.isFinite(offsetY)) {
    throw new UnmaskableRectError();
  }
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
      r.x * scale - offsetX - inflate,
      r.y * scale - offsetY - inflate,
      r.width * scale + inflate * 2,
      r.height * scale + inflate * 2,
    );
  }
}
