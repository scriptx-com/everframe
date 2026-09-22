// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pushEscapeHandler } from '../../src/reporter-ui/primitives/escapeStack.js';

function pressEscape(): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  window.dispatchEvent(e);
  return e;
}

describe('escapeStack', () => {
  const popAll: Array<() => void> = [];
  afterEach(() => {
    while (popAll.length) popAll.pop()!();
    vi.restoreAllMocks();
  });
  const push = (h: () => void): void => {
    popAll.push(pushEscapeHandler(h));
  };

  it('routes Escape to the single registered handler and preventDefaults', () => {
    const fn = vi.fn();
    push(fn);
    const e = pressEscape();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it('routes Escape only to the TOP layer (LIFO go-back)', () => {
    const bottom = vi.fn();
    const top = vi.fn();
    push(bottom);
    push(top);
    pressEscape();
    expect(top).toHaveBeenCalledTimes(1);
    expect(bottom).not.toHaveBeenCalled();
  });

  it('falls back to the lower layer once the top is popped', () => {
    const bottom = vi.fn();
    const top = vi.fn();
    push(bottom);
    const popTop = pushEscapeHandler(top);
    popTop();
    pressEscape();
    expect(top).not.toHaveBeenCalled();
    expect(bottom).toHaveBeenCalledTimes(1);
  });

  it('stops the event reaching a host-app bubble-phase listener registered earlier', () => {
    const appListener = vi.fn();
    // App subscribes first (the realistic order — app boots before the reporter
    // mounts). Bubble phase is the common case. Our capture-phase handler runs
    // before the bubble phase and stopImmediatePropagations, so this never fires.
    window.addEventListener('keydown', appListener);
    push(vi.fn());
    const e = pressEscape();
    expect(appListener).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
    window.removeEventListener('keydown', appListener);
  });

  it('stops a host-app capture-phase listener registered after the reporter', () => {
    const appListener = vi.fn();
    push(vi.fn());
    // Capture listener registered AFTER ours → ours fires first + stops it.
    window.addEventListener('keydown', appListener, true);
    pressEscape();
    expect(appListener).not.toHaveBeenCalled();
    window.removeEventListener('keydown', appListener, true);
  });

  it('ignores non-Escape keys and uninstalls the listener when drained', () => {
    const appListener = vi.fn();
    const fn = vi.fn();
    const pop = pushEscapeHandler(fn);
    // Non-Escape passes through untouched.
    window.addEventListener('keydown', appListener);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(fn).not.toHaveBeenCalled();
    expect(appListener).toHaveBeenCalledTimes(1);
    // After draining the stack, Escape is no longer intercepted.
    pop();
    const e = pressEscape();
    expect(fn).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
    window.removeEventListener('keydown', appListener);
  });
});
