// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// recordScreen JS plumbing (spec 2026-07-14): top-level seam export is a
// safe no-op when no provider is mounted, and the runtime forwards
// positionally to the TurboModule with NO validation/coercion (the native
// singleton owns all of that — same contract as addBreadcrumb).
import { afterEach, describe, expect, it, vi } from 'vitest';
import NativeTraceItX from '../src/NativeTraceItX.js';
import { recordScreen, __setCurrentContext } from '../src/contextSeam.js';
import { createRuntime } from '../src/runtime.js';

describe('recordScreen', () => {
  afterEach(() => {
    __setCurrentContext(null);
    vi.clearAllMocks();
  });

  it('top-level export is a no-op (no throw, no native call) when unmounted', () => {
    __setCurrentContext(null);
    expect(() => recordScreen('Home')).not.toThrow();
    expect(NativeTraceItX.recordScreen).not.toHaveBeenCalled();
  });

  it('top-level export forwards to the mounted context', () => {
    const ctx = { recordScreen: vi.fn() };
    __setCurrentContext(ctx as never);
    recordScreen('Home', { stack: 'root' });
    expect(ctx.recordScreen).toHaveBeenCalledWith('Home', { stack: 'root' });
  });

  it('runtime forwards positionally to NativeTraceItX.recordScreen', () => {
    const runtime = createRuntime({ apiKey: 'txx_test_key' });
    runtime.recordScreen('Detail', { stack: 'root' });
    expect(NativeTraceItX.recordScreen).toHaveBeenCalledWith('Detail', { stack: 'root' });
    runtime.recordScreen('Detail2');
    expect(NativeTraceItX.recordScreen).toHaveBeenCalledWith('Detail2', undefined);
  });
});
