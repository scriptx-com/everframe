// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { RENDER_BLANK_CHECK, isNearUniform } from '../src/index.js';

const px = (...rgba: number[][]): number[] => rgba.flat();

describe('RENDER_BLANK_CHECK', () => {
  it('pins the sampling shared by the SDK and the server render', () => {
    expect(RENDER_BLANK_CHECK).toEqual({ lumaRange: 8, sampleWidth: 128, sampleHeight: 72 });
  });
});

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
    expect(isNearUniform(px([0, 0, 0, 255], [255, 255, 255, 255]))).toBe(false);
  });
  it('treats an empty buffer as blank', () => {
    expect(isNearUniform([])).toBe(true);
  });
  it('accepts typed arrays (canvas ImageData, sharp raw buffers)', () => {
    expect(isNearUniform(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]))).toBe(false);
    expect(isNearUniform(new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255]))).toBe(true);
  });
  it('honours a custom range', () => {
    expect(isNearUniform(px([100, 100, 100, 255], [110, 110, 110, 255]), 20)).toBe(true);
    expect(isNearUniform(px([100, 100, 100, 255], [110, 110, 110, 255]), 5)).toBe(false);
  });
});
