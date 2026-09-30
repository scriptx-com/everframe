// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
// Legacy maskPlan rects come from sensitiveRegistry.snapshot(). On Chrome < 61
// (webOS 4) getBoundingClientRect returns a ClientRect with no x/y, so the
// registry must read left/top, and a rect that is still not finite must stop
// the capture rather than paint nothing.
import { afterEach, describe, expect, it } from 'vitest';
import { isFiniteRect, paintMaskRectsOnCanvas, UnmaskableRectError } from '../../src/capture/mask-paint.js';
import { sensitiveRegistry } from '../../src/sensitive/registry.js';

afterEach(() => {
  document.body.innerHTML = '';
  sensitiveRegistry.__clearForTesting();
});

const clientRect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect;

function recordingCanvas(fills: number[][]): HTMLCanvasElement {
  return { getContext: () => ({ fillStyle: '', fillRect: (...a: number[]) => fills.push(a) }) } as unknown as HTMLCanvasElement;
}

describe('maskPlan rects on old engines', () => {
  it('the registry reads a ClientRect without x/y from left/top, and the mask lands there', () => {
    document.body.innerHTML = '<div id="s" data-everframe-sensitive>PIN</div>';
    const el = document.getElementById('s')!;
    el.getBoundingClientRect = () => clientRect(40, 30, 120, 30);
    const rects = sensitiveRegistry.snapshot();
    expect(rects).toEqual([{ x: 40, y: 30, width: 120, height: 30 }]);
    const fills: number[][] = [];
    paintMaskRectsOnCanvas(recordingCanvas(fills), rects);
    expect(fills).toEqual([[38, 28, 124, 34]]);
  });

  it('the display:contents union path reads left/top too', () => {
    document.body.innerHTML = '<div id="s" data-everframe-sensitive style="display:contents"><p id="a">A</p><p id="b">B</p></div>';
    document.getElementById('s')!.getBoundingClientRect = () => clientRect(0, 0, 0, 0);
    document.getElementById('a')!.getBoundingClientRect = () => clientRect(10, 20, 100, 10);
    document.getElementById('b')!.getBoundingClientRect = () => clientRect(10, 30, 80, 10);
    expect(sensitiveRegistry.snapshot()).toEqual([{ x: 10, y: 20, width: 100, height: 20 }]);
  });

  it('a non-finite rect throws (the capture fails closed) and paints nothing', () => {
    const fills: number[][] = [];
    expect(() => paintMaskRectsOnCanvas(recordingCanvas(fills), [{ x: Number.NaN, y: 0, width: 10, height: 10 }])).toThrow(UnmaskableRectError);
    expect(fills).toEqual([]);
    // Even without a 2d context, where masking is otherwise best-effort.
    const none = { getContext: () => null } as unknown as HTMLCanvasElement;
    expect(() => paintMaskRectsOnCanvas(none, [{ x: 0, y: Number.NaN, width: 10, height: 10 }])).toThrow(UnmaskableRectError);
  });

  it('isFiniteRect', () => {
    expect(isFiniteRect({ x: 0, y: 0, width: 1, height: 1 })).toBe(true);
    expect(isFiniteRect({ x: undefined as unknown as number, y: 0, width: 1, height: 1 })).toBe(false);
  });
});
