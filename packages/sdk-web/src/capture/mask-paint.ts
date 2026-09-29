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
