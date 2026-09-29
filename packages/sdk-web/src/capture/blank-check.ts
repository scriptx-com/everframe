// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';

/**
 * Blank-screenshot detection.
 *
 * Measured 2026-09-29: the SVG-foreignObject renderers can rasterize a page to
 * a single flat colour without throwing — every run on an LG webOS 6 home
 * screen, and any desktop page past ~10k nodes. A flat image shipped as a
 * real screenshot is worse than an honest degraded flag, so every canvas is
 * checked before it is accepted.
 *
 * The check is a luminance RANGE over a downscaled copy: a real page has at
 * least one edge (text, border, image) whose luminance differs from the
 * background by more than encoder noise. 128x72 keeps a single short line of
 * text on a white page above the threshold; smaller samples average it away.
 */
export const BLANK_LUMA_RANGE = 8;
export const BLANK_SAMPLE_WIDTH = 128;
export const BLANK_SAMPLE_HEIGHT = 72;

/** True when every pixel's luminance lies within `range` of every other's. */
export function isNearUniform(rgba: ArrayLike<number>, range: number = BLANK_LUMA_RANGE): boolean {
  let min = 255;
  let max = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const alpha = (rgba[i + 3] ?? 0) / 255;
    // Composite over the white capture background so transparent == white.
    const r = (rgba[i] ?? 0) * alpha + 255 * (1 - alpha);
    const g = (rgba[i + 1] ?? 0) * alpha + 255 * (1 - alpha);
    const b = (rgba[i + 2] ?? 0) * alpha + 255 * (1 - alpha);
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    if (luma < min) min = luma;
    if (luma > max) max = luma;
    if (max - min > range) return false;
  }
  return true;
}

/**
 * Sample the canvas down and test it. `null` = the check could not run (no 2d
 * context, tainted canvas, detached engine) — callers must treat that as NOT
 * blank, so a missing capability never discards a real screenshot.
 */
export function isCanvasBlank(canvas: HTMLCanvasElement): boolean | null {
  try {
    const sample = document.createElement('canvas');
    sample.width = BLANK_SAMPLE_WIDTH;
    sample.height = BLANK_SAMPLE_HEIGHT;
    const ctx = sample.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, BLANK_SAMPLE_WIDTH, BLANK_SAMPLE_HEIGHT);
    ctx.drawImage(canvas, 0, 0, BLANK_SAMPLE_WIDTH, BLANK_SAMPLE_HEIGHT);
    return isNearUniform(ctx.getImageData(0, 0, BLANK_SAMPLE_WIDTH, BLANK_SAMPLE_HEIGHT).data);
  } catch {
    return null;
  }
}
