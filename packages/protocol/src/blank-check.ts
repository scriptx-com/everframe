// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Blank detection shared by on-device captures (sdk-web) and server renders
// (the render service): ONE algorithm and one set of constants. Deliberately
// zod-free and dependency-free: the web SDK's always-loaded bundle imports it.

/**
 * Downscale to sampleWidth x sampleHeight, composite over white, and call the
 * image blank when every pixel's luminance is within lumaRange of every other's.
 */
export const RENDER_BLANK_CHECK = Object.freeze({
  lumaRange: 8,
  sampleWidth: 128,
  sampleHeight: 72,
} as const);

/** True when every pixel's luminance lies within `range` of every other's (RGBA, 4 bytes per pixel). */
export function isNearUniform(rgba: ArrayLike<number>, range: number = RENDER_BLANK_CHECK.lumaRange): boolean {
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
