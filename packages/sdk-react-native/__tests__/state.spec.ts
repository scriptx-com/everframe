// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, describe, expect, it, vi } from 'vitest';
import NativeEverframe from '../src/NativeEverframe.js';
import * as seam from '../src/contextSeam.js';
import { createRuntime } from '../src/runtime.js';
const native = NativeEverframe as any;
let runtime: ReturnType<typeof createRuntime> | undefined;
function mount() {
  runtime = createRuntime({ sdkKey: 'test', crashReporting: { disabled: true } });
  runtime.mount();
  return runtime;
}
afterEach(() => {
  runtime?.unmount();
  runtime = undefined;
  seam.__setCurrentContext(null);
  vi.restoreAllMocks();
});
describe('state labels', () => {
  it('is a safe no-op before mount', () => {
    expect((seam as any).setState).toBeTypeOf('function');
    expect(() => (seam as any).setState('plan', 'premium')).not.toThrow();
    expect(() => (seam as any).clearState('plan')).not.toThrow();
  });
  it('publishes typed primitives synchronously before subsequent capture', () => {
    const calls: unknown[] = [];
    native.setStateSync = vi.fn((key, json) => {
      calls.push([key, JSON.parse(json)]);
      return true;
    });
    native.clearStateSync = vi.fn((key) => {
      calls.push(['clear', key]);
      return true;
    });
    mount();
    expect((seam as any).setState).toBeTypeOf('function');
    for (const value of ['premium', false, 0, '']) (seam as any).setState('plan', value);
    (seam as any).clearState('plan');
    expect(calls).toEqual([
      ['plan', 'premium'],
      ['plan', false],
      ['plan', 0],
      ['plan', ''],
      ['clear', 'plan'],
    ]);
  });
  it('rejects invalid values and keys without crossing native', () => {
    native.setStateSync = vi.fn();
    mount();
    expect((seam as any).setState).toBeTypeOf('function');
    for (const value of [null, undefined, {}, [], NaN, Infinity, 'x'.repeat(257)])
      (seam as any).setState('plan', value);
    for (const key of ['', '__proto__', 'x'.repeat(65), '\u0000', '\ud800', 123])
      (seam as any).setState(key, true);
    expect(native.setStateSync).not.toHaveBeenCalled();
  });
  it('does not let a stale runtime write into a replacement provider', () => {
    native.setStateSync = vi.fn();
    native.clearStateSync = vi.fn();
    const old = mount();
    old.unmount();
    mount();
    expect((old as any).setState).toBeTypeOf('function');
    (old as any).setState('plan', 'old');
    (old as any).clearState('plan');
    expect(native.setStateSync).not.toHaveBeenCalled();
    expect(native.clearStateSync).not.toHaveBeenCalled();
  });
});
