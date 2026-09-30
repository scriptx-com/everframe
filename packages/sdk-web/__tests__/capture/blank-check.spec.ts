// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isCanvasBlank } from '../../src/capture/blank-check.js';

const px = (...rgba: number[][]): number[] => rgba.flat();

describe('isCanvasBlank', () => {
  it('returns null when no 2d context is available (jsdom)', () => {
    const canvas = document.createElement('canvas');
    expect(isCanvasBlank(canvas)).toBeNull();
  });

  describe('with a stubbed 2d context', () => {
    afterEach(() => vi.restoreAllMocks());
    const stubContext = (data: number[]) => {
      const drawImage = vi.fn();
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
        () =>
          ({
            fillStyle: '',
            fillRect: vi.fn(),
            drawImage,
            getImageData: () => ({ data }),
          }) as unknown as CanvasRenderingContext2D,
      );
      return drawImage;
    };

    it('samples the whole canvas by default', () => {
      const drawImage = stubContext(px([255, 255, 255, 255], [255, 255, 255, 255]));
      const src = document.createElement('canvas');
      expect(isCanvasBlank(src)).toBe(true);
      expect(drawImage).toHaveBeenCalledWith(src, 0, 0, 128, 72);
    });

    it('samples only the given region when one is passed (the part that ships)', () => {
      const drawImage = stubContext(px([255, 255, 255, 255], [0, 0, 0, 255]));
      const src = document.createElement('canvas');
      expect(isCanvasBlank(src, { sx: 0, sy: 500, sw: 1024, sh: 768 })).toBe(false);
      expect(drawImage).toHaveBeenCalledTimes(1);
      expect(drawImage).toHaveBeenCalledWith(src, 0, 500, 1024, 768, 0, 0, 128, 72);
    });
  });
});
