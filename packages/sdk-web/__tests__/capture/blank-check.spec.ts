// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
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
});
