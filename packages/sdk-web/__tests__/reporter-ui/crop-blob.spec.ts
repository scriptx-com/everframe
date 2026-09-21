// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cropBlob } from '../../src/reporter-ui/crop-blob.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubBitmapAndCanvas(
  w: number,
  h: number,
): { drawArgs: unknown[][]; fillArgs: unknown[][]; canvas: { fillStyleAtFill: string[] } } {
  const drawArgs: unknown[][] = [];
  const fillArgs: unknown[][] = [];
  const fillStyleAtFill: string[] = [];
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: w, height: h })));
  vi.stubGlobal('OffscreenCanvas', undefined);
  const ctx = {
    fillStyle: '',
    fillRect: function (...args: unknown[]) {
      fillArgs.push(args);
      fillStyleAtFill.push(this.fillStyle as string);
    },
    drawImage: (...args: unknown[]) => void drawArgs.push(args),
  };
  vi.spyOn(document, 'createElement').mockImplementation(
    () =>
      ({
        width: 0,
        height: 0,
        getContext: () => ctx,
        toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(['png'], { type: 'image/png' })),
      }) as unknown as HTMLCanvasElement,
  );
  return { drawArgs, fillArgs, canvas: { fillStyleAtFill } };
}

describe('cropBlob', () => {
  it('crops to the requested rect', async () => {
    const { drawArgs } = stubBitmapAndCanvas(200, 100);
    const out = await cropBlob(new Blob(['x']), { x: 10, y: 20, width: 50, height: 30 });
    expect(out.width).toBe(50);
    expect(out.height).toBe(30);
    // drawImage(bitmap, sx, sy, sw, sh, dx, dy, dw, dh)
    expect(drawArgs[0]!.slice(1)).toEqual([10, 20, 50, 30, 0, 0, 50, 30]);
  });

  it('pads a rect that overflows the bitmap bottom/right — output keeps the REQUESTED size', async () => {
    // The captured source bitmap can be SHORTER than the viewport (short body,
    // clone-render drift) — a selection extending past its bottom/right edge
    // must still produce an image of the full requested size, with the
    // available source pixels drawn at the correct offset and the uncovered
    // remainder left as the capture background. Silent clamping shrank the
    // selection's bottom edge (Bug 3).
    const { drawArgs, fillArgs, canvas } = stubBitmapAndCanvas(200, 100);
    const out = await cropBlob(new Blob(['x']), { x: 180, y: 90, width: 50, height: 30 });
    expect(out.width).toBe(50);
    expect(out.height).toBe(30);
    // Background fill covers the whole requested canvas, in white (matches
    // captureScreenshot's backgroundColor so padded areas aren't black when
    // later re-encoded to opaque formats).
    expect(fillArgs[0]).toEqual([0, 0, 50, 30]);
    expect(canvas.fillStyleAtFill[0]).toBe('#ffffff');
    // Only the 20x10 source sliver that exists is drawn, at dest (0,0).
    expect(drawArgs[0]!.slice(1)).toEqual([180, 90, 20, 10, 0, 0, 20, 10]);
  });

  it('pads a rect with a negative origin — source lands at the correct dest offset', async () => {
    const { drawArgs } = stubBitmapAndCanvas(200, 100);
    const out = await cropBlob(new Blob(['x']), { x: -10, y: -5, width: 50, height: 30 });
    expect(out.width).toBe(50);
    expect(out.height).toBe(30);
    // Source starts at bitmap (0,0); drawn at dest (10,5) to preserve geometry.
    expect(drawArgs[0]!.slice(1)).toEqual([0, 0, 40, 25, 10, 5, 40, 25]);
  });

  it('throws on a rect fully outside the bitmap', async () => {
    stubBitmapAndCanvas(200, 100);
    await expect(
      cropBlob(new Blob(['x']), { x: 500, y: 500, width: 10, height: 10 }),
    ).rejects.toThrow();
  });
});
