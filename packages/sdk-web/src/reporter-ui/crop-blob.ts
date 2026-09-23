// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import type { Rect } from '@everframe/sdk-core';

export interface CropResult {
  blob: Blob;
  width: number;
  height: number;
}

/**
 * Crop a screenshot blob to `rect` (IMAGE-pixel space). The output ALWAYS has
 * the requested (rounded) dimensions: where the rect extends past the source
 * bitmap, the uncovered remainder stays capture-background white instead of
 * being silently clamped away. This matters because the captured bitmap can
 * be SHORTER than the viewport (body content shorter than the window, or the
 * capture library's clone rendering slightly short of the live page) — a
 * selection hugging the viewport bottom would otherwise come back with its
 * bottom edge shaved off. A rect entirely outside the bitmap still throws
 * (caller treats it as a failed capture — DEFE-02 shows a notice, adds
 * nothing). Output is PNG: additional shots go through BlurBakery on submit
 * anyway when annotated, so WebP re-encoding happens there — no double lossy
 * pass here.
 */
export async function cropBlob(source: Blob, rect: Rect): Promise<CropResult> {
  const bitmap = await createImageBitmap(source);
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));

  // Intersection of the requested rect with the source bitmap. Empty
  // intersection = the selection missed the rendered content entirely.
  const sx = Math.max(0, x);
  const sy = Math.max(0, y);
  const sw = Math.min(x + width, bitmap.width) - sx;
  const sh = Math.min(y + height, bitmap.height) - sy;
  if (sw <= 0 || sh <= 0) {
    throw new Error(`crop rect outside bitmap (${bitmap.width}x${bitmap.height})`);
  }
  // Destination offset preserves geometry when the rect starts above/left of
  // the bitmap origin (negative rect coords).
  const dx = sx - x;
  const dy = sy - y;

  const useOffscreen = typeof OffscreenCanvas !== 'undefined';
  const canvas: OffscreenCanvas | HTMLCanvasElement = useOffscreen
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = (canvas as HTMLCanvasElement).getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  // White base matches captureScreenshot's backgroundColor, so padded areas
  // read as page background — not transparent-black — if the blob is later
  // baked/re-encoded into an opaque format.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap as unknown as CanvasImageSource, sx, sy, sw, sh, dx, dy, sw, sh);
  const blob = useOffscreen
    ? await (canvas as OffscreenCanvas).convertToBlob({ type: 'image/png' })
    : await new Promise<Blob>((resolve, reject) =>
        (canvas as HTMLCanvasElement).toBlob(
          (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))),
          'image/png',
        ),
      );
  return { blob, width, height };
}
