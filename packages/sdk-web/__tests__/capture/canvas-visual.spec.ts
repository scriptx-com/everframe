// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it, vi } from 'vitest';
import { createCanvasVisualCapture } from '../../src/capture/canvas-visual.js';

const png = (): Blob => {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  new DataView(bytes.buffer).setUint32(16, 100);
  new DataView(bytes.buffer).setUint32(20, 80);
  return new Blob([bytes], { type: 'image/png' });
};

describe('KMP browser canvas capture', () => {
  it('copies renderer pixels then masks validated sensitive rectangles', async () => {
    const drawImage = vi.fn();
    const fillRect = vi.fn();
    const output = { width: 0, height: 0, getContext: () => ({ drawImage, fillRect, set fillStyle(_: string) {} }), toBlob: (cb: (blob: Blob) => void) => cb(png()) };
    vi.spyOn(document, 'createElement').mockReturnValueOnce(output as unknown as HTMLCanvasElement);
    const source = { width: 100, height: 80 } as HTMLCanvasElement;
    const capture = createCanvasVisualCapture({ canvas: source, sensitiveRects: () => [{ x: 4, y: 5, width: 20, height: 10 }] });
    expect(await capture.captureScreenshot()).toBeInstanceOf(Blob);
    expect(drawImage).toHaveBeenCalledWith(source, 0, 0);
    expect(fillRect).toHaveBeenCalledWith(4, 5, 20, 10);
    vi.restoreAllMocks();
  });

  it('fails closed without markers or with unsafe geometry', async () => {
    const canvas = { width: 100, height: 80 } as HTMLCanvasElement;
    expect(await createCanvasVisualCapture({ canvas, sensitiveRects: () => [] }).captureScreenshot()).toBeNull();
    expect(await createCanvasVisualCapture({ canvas, sensitiveRects: () => [{ x: -1, y: 0, width: 5, height: 5 }] }).captureScreenshot()).toBeNull();
  });
});
