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
import { RENDER_BLANK_CHECK, isNearUniform } from '@everframe/protocol';

// The algorithm and constants live in @everframe/protocol (zod-free module), so
// the render service's server-side blank check is the same code, not a copy.
export { isNearUniform };
export const BLANK_LUMA_RANGE = RENDER_BLANK_CHECK.lumaRange;
export const BLANK_SAMPLE_WIDTH = RENDER_BLANK_CHECK.sampleWidth;
export const BLANK_SAMPLE_HEIGHT = RENDER_BLANK_CHECK.sampleHeight;

/** Source region (canvas px) to sample instead of the whole canvas. */
export interface BlankCheckRegion {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * Sample the canvas (or `region` of it — the part that will actually ship)
 * down and test it. `null` = the check could not run (no 2d context, tainted
 * canvas, detached engine) — callers must treat that as NOT blank, so a
 * missing capability never discards a real screenshot.
 */
export function isCanvasBlank(canvas: HTMLCanvasElement, region?: BlankCheckRegion): boolean | null {
  try {
    const sample = document.createElement('canvas');
    sample.width = BLANK_SAMPLE_WIDTH;
    sample.height = BLANK_SAMPLE_HEIGHT;
    const ctx = sample.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, BLANK_SAMPLE_WIDTH, BLANK_SAMPLE_HEIGHT);
    if (region) {
      ctx.drawImage(canvas, region.sx, region.sy, region.sw, region.sh, 0, 0, BLANK_SAMPLE_WIDTH, BLANK_SAMPLE_HEIGHT);
    } else {
      ctx.drawImage(canvas, 0, 0, BLANK_SAMPLE_WIDTH, BLANK_SAMPLE_HEIGHT);
    }
    return isNearUniform(ctx.getImageData(0, 0, BLANK_SAMPLE_WIDTH, BLANK_SAMPLE_HEIGHT).data);
  } catch {
    return null;
  }
}
