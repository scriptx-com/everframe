// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isCanvasBlank, isNearUniform } from '../../src/capture/blank-check.js';

const px = (...rgba: number[][]): number[] => rgba.flat();

describe('isNearUniform', () => {
  it('flags a fully white image', () => {
    expect(isNearUniform(px([255, 255, 255, 255], [255, 255, 255, 255]))).toBe(true);
  });
  it('flags a fully black image', () => {
    expect(isNearUniform(px([0, 0, 0, 255], [0, 0, 0, 255]))).toBe(true);
  });
  it('tolerates encoder noise below the range', () => {
    expect(isNearUniform(px([250, 250, 250, 255], [255, 255, 255, 255], [253, 252, 254, 255]))).toBe(true);
  });
  it('accepts an image with real contrast', () => {
    expect(isNearUniform(px([255, 255, 255, 255], [20, 20, 20, 255]))).toBe(false);
  });
  it('accepts a dark theme with a light element', () => {
    expect(isNearUniform(px([13, 17, 23, 255], [13, 17, 23, 255], [230, 230, 230, 255]))).toBe(false);
  });
  it('treats fully transparent pixels as the white capture background', () => {
    expect(isNearUniform(px([0, 0, 0, 0], [255, 255, 255, 255]))).toBe(true);
  });
  it('treats an empty buffer as blank', () => {
    expect(isNearUniform([])).toBe(true);
  });
  it('honours a custom range', () => {
    expect(isNearUniform(px([100, 100, 100, 255], [110, 110, 110, 255]), 20)).toBe(true);
    expect(isNearUniform(px([100, 100, 100, 255], [110, 110, 110, 255]), 5)).toBe(false);
  });
});

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
