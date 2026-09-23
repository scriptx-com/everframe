// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import type { Rect } from '@everframe/sdk-core';
import {
  HIGHLIGHTER_OPACITY,
  HIGHLIGHTER_WIDTH_MULTIPLIER,
  TEXT_FONT_FAMILY,
  TEXT_LINE_HEIGHT,
  newAnnotationId,
  type Annotation,
  type BlurRect,
} from './annotation-model.js';

/**
 * Bake annotations into the screenshot bytes BEFORE the Blob leaves the device.
 *
 * PRIV-03 / ANN-02 lock — redaction regions are baked as SOLID BLACK fills.
 * (Earlier versions used a gaussian blur; reverted because residual shape +
 * color information leaks through a blur, defeating the redaction's purpose.)
 *
 * Every other shape kind — pen, highlighter, rect, ellipse, arrow, text — is
 * baked too: the envelope still ships the structured annotation data for
 * audit visibility, but the admin viewer renders just the PNG, so marks that
 * aren't painted into the bytes are invisible to triagers.
 *
 * Order: redactions first (so the underlying image is hidden), then every
 * other annotation in array order — i.e. the order the user drew them in —
 * so a shape drawn across a redacted region remains visible and layering
 * between overlapping shapes matches what the user saw while editing.
 *
 * Falls back from OffscreenCanvas to HTMLCanvasElement for environments without
 * OffscreenCanvas (older mobile Safari, jsdom).
 */
export async function bakeAnnotations(
  source: Blob,
  annotations: Annotation[],
  // Retained for backwards compat — no longer used now that redactions are
  // a solid fill. New code should omit this argument.
  _legacyBlurRadius?: number,
): Promise<Blob> {
  void _legacyBlurRadius;
  if (annotations.length === 0) return source;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch {
    // jsdom / unsupported decoder — return input unchanged (DEFE-02: never block submit).
    return source;
  }
  const W = bitmap.width;
  const H = bitmap.height;
  const useOffscreen = typeof OffscreenCanvas !== 'undefined';
  const canvas: OffscreenCanvas | HTMLCanvasElement = useOffscreen
    ? new OffscreenCanvas(W, H)
    : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const ctx = (canvas as HTMLCanvasElement).getContext('2d');
  if (!ctx) return source;
  ctx.drawImage(bitmap as unknown as CanvasImageSource, 0, 0);

  // Pass 1 — redaction regions painted as solid black.
  const blurs = annotations.filter((a): a is BlurRect => a.kind === 'blur');
  if (blurs.length > 0) {
    ctx.save();
    ctx.fillStyle = '#000';
    for (const r of blurs) ctx.fillRect(r.x, r.y, r.width, r.height);
    ctx.restore();
  }

  // Pass 2 — every non-blur annotation, in array order (user layering).
  for (const a of annotations) {
    if (a.kind === 'blur') continue;
    ctx.save();
    if (a.kind === 'pen' || a.kind === 'highlighter') {
      if (a.points.length < 2) {
        ctx.restore();
        continue;
      }
      ctx.strokeStyle = a.color;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (a.kind === 'highlighter') {
        ctx.globalAlpha = HIGHLIGHTER_OPACITY;
        ctx.lineWidth = a.thickness * HIGHLIGHTER_WIDTH_MULTIPLIER;
      } else {
        ctx.lineWidth = a.thickness;
      }
      ctx.beginPath();
      ctx.moveTo(a.points[0]!, a.points[1]!);
      for (let i = 2; i < a.points.length; i += 2) {
        ctx.lineTo(a.points[i]!, a.points[i + 1]!);
      }
      ctx.stroke();
    } else if (a.kind === 'rect') {
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.thickness;
      ctx.lineJoin = 'round';
      ctx.strokeRect(a.x, a.y, a.width, a.height);
    } else if (a.kind === 'ellipse') {
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.thickness;
      ctx.beginPath();
      ctx.ellipse(
        a.x + a.width / 2,
        a.y + a.height / 2,
        Math.abs(a.width / 2),
        Math.abs(a.height / 2),
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    } else if (a.kind === 'text') {
      ctx.font = `${a.fontSize}px ${TEXT_FONT_FAMILY}`;
      ctx.textBaseline = 'top';
      ctx.fillStyle = a.color;
      const lines = a.text.split('\n');
      for (let li = 0; li < lines.length; li++) {
        ctx.fillText(lines[li]!, a.x, a.y + li * a.fontSize * TEXT_LINE_HEIGHT);
      }
    } else {
      // arrow — shaft + solid triangular head at `to` (unchanged geometry).
      const [x1, y1] = a.from;
      const [x2, y2] = a.to;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      if (len < 1) {
        ctx.restore();
        continue;
      }
      ctx.strokeStyle = a.color;
      ctx.fillStyle = a.color;
      ctx.lineWidth = a.thickness;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const headLen = Math.max(8, a.thickness * 3);
      const shaftEndX = x2 - (dx / len) * (headLen * 0.6);
      const shaftEndY = y2 - (dy / len) * (headLen * 0.6);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(shaftEndX, shaftEndY);
      ctx.stroke();
      const angle = Math.atan2(dy, dx);
      const p2x = x2 - Math.cos(angle - Math.PI / 6) * headLen;
      const p2y = y2 - Math.sin(angle - Math.PI / 6) * headLen;
      const p3x = x2 - Math.cos(angle + Math.PI / 6) * headLen;
      const p3y = y2 - Math.sin(angle + Math.PI / 6) * headLen;
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(p2x, p2y);
      ctx.lineTo(p3x, p3y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // Encode preference: WebP @ q=0.85 first (~70-80% byte reduction vs PNG
  // for screenshot-class images, no visible loss), PNG fallback when:
  //   - the browser can't encode WebP (canvas.toBlob returns null), or
  //   - the WebP output isn't actually smaller (rare; happens for tiny
  //     solid-color images where the WebP container overhead dominates).
  // The blob's `.type` property reflects what was actually encoded, so
  // downstream multipart uploads use the correct content-type without any
  // branching at the call site.
  return encodeBlobPreferWebP(canvas);
}

async function encodeBlobPreferWebP(
  canvas: HTMLCanvasElement | OffscreenCanvas,
): Promise<Blob> {
  // Guard with `typeof` first — environments without OffscreenCanvas (jsdom,
  // older mobile Safari) don't declare the identifier at all, so a bare
  // `instanceof OffscreenCanvas` throws a ReferenceError instead of just
  // being false. Mirrors the `useOffscreen &&` guard in capture/screenshot.ts.
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    const webp = await canvas
      .convertToBlob({ type: 'image/webp', quality: 0.85 })
      .catch(() => null);
    const png = await canvas.convertToBlob({ type: 'image/png' });
    if (webp && webp.size < png.size) return webp;
    return png;
  }
  const c = canvas as HTMLCanvasElement;
  const webp = await new Promise<Blob | null>((resolve) =>
    c.toBlob((b) => resolve(b), 'image/webp', 0.85),
  );
  const png = await new Promise<Blob>((resolve, reject) =>
    c.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))),
      'image/png',
    ),
  );
  if (webp && webp.size < png.size) return webp;
  return png;
}

/**
 * @deprecated Use `bakeAnnotations`. Kept as a thin shim so callers still
 * passing rect-only `Rect[]` (i.e. pre-annotation-baking code paths) keep
 * working. New callers should pass the full Annotation[] so pen strokes
 * get painted too.
 */
export async function bakeBlurRegions(source: Blob, regions: Rect[]): Promise<Blob> {
  if (regions.length === 0) return source;
  const annotations: Annotation[] = regions.map((r) => ({
    id: newAnnotationId(),
    kind: 'blur',
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
  }));
  return bakeAnnotations(source, annotations);
}
