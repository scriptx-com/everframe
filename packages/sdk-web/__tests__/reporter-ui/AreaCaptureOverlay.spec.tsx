// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/react';
import { AreaCaptureOverlay } from '../../src/reporter-ui/AreaCaptureOverlay.js';

function stubScroll(x: number, y: number): void {
  Object.defineProperty(window, 'scrollX', { value: x, configurable: true });
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
}

afterEach(() => {
  cleanup();
  stubScroll(0, 0);
  vi.restoreAllMocks();
});

describe('<AreaCaptureOverlay>', () => {
  it('reports the drag rect in VIEWPORT space — page scroll must not leak in', () => {
    // Regression: the screenshot the rect is applied to is viewport-anchored
    // (capture crops the PNG to the viewport), so a page-space rect (client
    // coords + scrollX/Y) lands the crop wrong — or past the bitmap — on any
    // scrolled page.
    stubScroll(200, 300);
    const onSelect = vi.fn();
    const { getByTestId } = render(
      <AreaCaptureOverlay onSelect={onSelect} onCancel={() => undefined} />,
    );
    const overlay = getByTestId('area-capture-overlay');
    fireEvent.pointerDown(overlay, { pointerId: 1, clientX: 50, clientY: 60 });
    fireEvent.pointerMove(overlay, { pointerId: 1, clientX: 150, clientY: 180 });
    fireEvent.pointerUp(overlay, { pointerId: 1, clientX: 150, clientY: 180 });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith({ x: 50, y: 60, width: 100, height: 120 });
  });

  it('treats a sub-8px drag as a stray click — no onSelect', () => {
    const onSelect = vi.fn();
    const { getByTestId } = render(
      <AreaCaptureOverlay onSelect={onSelect} onCancel={() => undefined} />,
    );
    const overlay = getByTestId('area-capture-overlay');
    fireEvent.pointerDown(overlay, { pointerId: 1, clientX: 50, clientY: 60 });
    fireEvent.pointerMove(overlay, { pointerId: 1, clientX: 54, clientY: 63 });
    fireEvent.pointerUp(overlay, { pointerId: 1, clientX: 54, clientY: 63 });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('"Capture full page" calls onSelect(null); Cancel calls onCancel', () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const { getByTestId } = render(
      <AreaCaptureOverlay onSelect={onSelect} onCancel={onCancel} />,
    );
    fireEvent.click(getByTestId('area-capture-full'));
    expect(onSelect).toHaveBeenCalledWith(null);
    fireEvent.click(getByTestId('area-capture-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  // This overlay is a sibling of the HOST page's DOM, not a separate
  // document, so a drag that anchors a native text selection extends through
  // the customer's own content and gets painted by THEIR `::selection` rule —
  // then outlives the gesture, leaving their app looking washed in a colour
  // with no cue a selection is involved. `user-select: none` on
  // `.txx-area-capture` is the other half of the guard; this is the half a
  // spec can observe.
  it('prevents the default that anchors a text selection when a drag starts', () => {
    const { getByTestId } = render(
      <AreaCaptureOverlay onSelect={() => undefined} onCancel={() => undefined} />,
    );
    const overlay = getByTestId('area-capture-overlay');
    const notPrevented = fireEvent.pointerDown(overlay, {
      pointerId: 1,
      clientX: 50,
      clientY: 60,
    });
    expect(notPrevented).toBe(false);
  });

  // The bar holds two real <button>s. Preventing the default there would
  // suppress focus along with the selection, so the guard is scoped to the
  // drag surface — which is not focusable and loses nothing.
  it('leaves the toolbar default intact, so its buttons still take focus', () => {
    const { getByTestId } = render(
      <AreaCaptureOverlay onSelect={() => undefined} onCancel={() => undefined} />,
    );
    const notPrevented = fireEvent.pointerDown(getByTestId('area-capture-cancel'), {
      pointerId: 1,
      clientX: 10,
      clientY: 10,
    });
    expect(notPrevented).toBe(true);
  });
});
