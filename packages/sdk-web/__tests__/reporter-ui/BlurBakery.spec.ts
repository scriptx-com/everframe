// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bakeAnnotations, bakeBlurRegions } from '../../src/reporter-ui/BlurBakery.js';

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0,
  1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 0x0d, 0x49, 0x44, 0x41, 0x54,
  0x78, 0x9c, 0x63, 0, 1, 0, 0, 5, 0, 1, 0x0d, 0x0a, 0x2d, 0xb4, 0, 0, 0, 0, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

describe('bakeBlurRegions', () => {
  it('returns input blob unchanged when regions[] is empty (zero-allocation fast path)', async () => {
    const blob = new Blob([PNG_BYTES as BlobPart], { type: 'image/png' });
    const out = await bakeBlurRegions(blob, []);
    expect(out).toBe(blob);
  });

  it('returns a Blob when regions[] non-empty (jsdom path falls back gracefully on missing decoder)', async () => {
    if (typeof globalThis.createImageBitmap !== 'function') {
      (globalThis as { createImageBitmap?: typeof createImageBitmap }).createImageBitmap = (async () => ({
        width: 1,
        height: 1,
        close: () => undefined,
      })) as typeof createImageBitmap;
    }
    const blob = new Blob([PNG_BYTES as BlobPart], { type: 'image/png' });
    const out = await bakeBlurRegions(blob, [{ x: 0, y: 0, width: 1, height: 1 }]);
    expect(out).toBeInstanceOf(Blob);
  });
});

// --- Report-window overhaul: new shape kinds -------------------------------
import {
  newAnnotationId,
  TEXT_FONT_FAMILY,
  HIGHLIGHTER_OPACITY,
  HIGHLIGHTER_WIDTH_MULTIPLIER,
  type Annotation as ModelAnnotation,
} from '../../src/reporter-ui/annotation-model.js';

describe('bakeAnnotations — overhaul shape kinds', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('paints rect and ellipse outlines with stroke color/thickness', async () => {
    const { ctx, blob } = installCanvasSpies();
    const annotations: ModelAnnotation[] = [
      { id: newAnnotationId(), kind: 'rect', x: 5, y: 6, width: 20, height: 10, color: '#FF3B30', thickness: 4 },
      { id: newAnnotationId(), kind: 'ellipse', x: 40, y: 6, width: 20, height: 10, color: '#FFCC00', thickness: 2 },
    ];
    await bakeAnnotations(blob, annotations);
    expect(ctx.strokeRect).toHaveBeenCalledWith(5, 6, 20, 10);
    expect(ctx.ellipse).toHaveBeenCalledWith(50, 11, 10, 5, 0, 0, Math.PI * 2);
  });

  it('paints highlighter strokes with reduced alpha and multiplied width', async () => {
    const { ctx, blob } = installCanvasSpies();
    const annotations: ModelAnnotation[] = [
      { id: newAnnotationId(), kind: 'highlighter', points: [0, 0, 30, 0], color: '#FFCC00', thickness: 8 },
    ];
    await bakeAnnotations(blob, annotations);
    expect(ctx.globalAlpha).toBe(HIGHLIGHTER_OPACITY);
    expect(ctx.lineWidth).toBe(8 * HIGHLIGHTER_WIDTH_MULTIPLIER);
  });

  it('paints text with the shared font family and per-line offsets', async () => {
    const { ctx, blob } = installCanvasSpies();
    const annotations: ModelAnnotation[] = [
      { id: newAnnotationId(), kind: 'text', x: 10, y: 20, text: 'line1\nline2', color: '#FFFFFF', fontSize: 24 },
    ];
    await bakeAnnotations(blob, annotations);
    expect(ctx.font).toBe(`24px ${TEXT_FONT_FAMILY}`);
    expect(ctx.fillText).toHaveBeenCalledWith('line1', 10, 20);
    expect(ctx.fillText).toHaveBeenCalledWith('line2', 10, 20 + 24 * 1.2);
  });

  it('still paints redactions before any other kind (PRIV-03 order)', async () => {
    const { ctx, blob, callOrder } = installCanvasSpies();
    const annotations: ModelAnnotation[] = [
      { id: newAnnotationId(), kind: 'rect', x: 0, y: 0, width: 5, height: 5, color: '#000', thickness: 2 },
      { id: newAnnotationId(), kind: 'blur', x: 1, y: 1, width: 2, height: 2 },
    ];
    await bakeAnnotations(blob, annotations);
    expect(callOrder.indexOf('fillRect')).toBeLessThan(callOrder.indexOf('strokeRect'));
  });
});

function installCanvasSpies(): {
  ctx: Record<string, ReturnType<typeof vi.fn>> & { globalAlpha: number; font: string };
  blob: Blob;
  callOrder: string[];
} {
  const callOrder: string[] = [];
  const track = (name: string) => vi.fn(() => void callOrder.push(name));
  const ctx = {
    drawImage: track('drawImage'),
    fillRect: track('fillRect'),
    strokeRect: track('strokeRect'),
    ellipse: track('ellipse'),
    fillText: track('fillText'),
    beginPath: track('beginPath'),
    closePath: track('closePath'),
    moveTo: track('moveTo'),
    lineTo: track('lineTo'),
    stroke: track('stroke'),
    fill: track('fill'),
    save: track('save'),
    restore: track('restore'),
    globalAlpha: 1,
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineCap: '',
    lineJoin: '',
    textBaseline: '',
  };
  // jsdom has no createImageBitmap — stub it plus a canvas whose 2d context is our spy.
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 100, height: 100 })));
  const fakeCanvas = {
    width: 100,
    height: 100,
    getContext: () => ctx,
    toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(['png'], { type: 'image/png' })),
  };
  vi.spyOn(document, 'createElement').mockImplementation(
    () => fakeCanvas as unknown as HTMLCanvasElement,
  );
  // Force the HTMLCanvasElement path (deterministic in jsdom).
  vi.stubGlobal('OffscreenCanvas', undefined);
  return { ctx: ctx as never, blob: new Blob(['x'], { type: 'image/png' }), callOrder };
}
