// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// setExtra object-form parity (react-sdk-surface-parity follow-up). The
// object overload landed in @traceitx/sdk-core and reached @traceitx/web /
// @traceitx/react, but NOT React Native: `setExtra` stayed string-only here,
// and the NATIVE side truncates a too-long string at EXTRA_MAX_CHARS with a
// raw character cut — exactly the "slice serialized JSON" bug the core fix
// set out to kill, reintroduced on native the moment a host JSON.stringifies
// an object itself. This gives RN's `setExtra` the same object overload,
// budgeted in JS BEFORE the value crosses the bridge, using
// @traceitx/sdk-core's `budgetExtra` — the same function the web/React
// client uses. Mirrors set-user.spec.ts's shape.
import { afterEach, describe, expect, it, vi } from 'vitest';
import NativeTraceItX from '../src/NativeTraceItX.js';
import { setExtra, __setCurrentContext } from '../src/contextSeam.js';
import { createRuntime } from '../src/runtime.js';
import { EXTRA_MAX_CHARS } from '@traceitx/sdk-core';

interface MockedNative {
  setExtra: ReturnType<typeof vi.fn>;
}
const nativeMock = NativeTraceItX as unknown as MockedNative;

/**
 * Mount a real runtime as the module-level current context, mirroring what
 * <TraceItXProvider> does on mount (runtime.mount() calls
 * __setCurrentContext(runtime) — see src/runtime.ts). Same local helper
 * set-user.spec.ts/record-screen.test.ts use, scoped to this file.
 */
function mountProvider(): ReturnType<typeof createRuntime> {
  const rt = createRuntime({ apiKey: 'txx_test_key' });
  rt.mount();
  return rt;
}

describe('setExtra', () => {
  afterEach(() => {
    __setCurrentContext(null);
    vi.clearAllMocks();
  });

  it('is a no-op when no provider is mounted', () => {
    expect(() => setExtra('hello')).not.toThrow();
    expect(() => setExtra({ a: 1 })).not.toThrow();
    expect(nativeMock.setExtra).not.toHaveBeenCalled();
  });

  it('string form forwards verbatim', () => {
    mountProvider();
    setExtra('plain string extra');
    expect(nativeMock.setExtra).toHaveBeenCalledWith('plain string extra');
  });

  it('string form forwards verbatim even over budget (native truncation is unchanged)', () => {
    mountProvider();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const big = 'x'.repeat(EXTRA_MAX_CHARS + 500);
    setExtra(big);
    // NOT truncated or cleared in the seam — forwarded exactly as given.
    expect(nativeMock.setExtra).toHaveBeenCalledWith(big);
    expect(nativeMock.setExtra).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain(`${big.length} chars exceeds the ${EXTRA_MAX_CHARS} limit`);
    warnSpy.mockRestore();
  });

  it('string form under budget warns nothing', () => {
    mountProvider();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setExtra('short');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('object form under budget forwards the exact serialized JSON to the bridge', () => {
    mountProvider();
    const value = { userId: 'u_1', screen: 'checkout', cartSize: 3 };
    setExtra(value);
    expect(nativeMock.setExtra).toHaveBeenCalledWith(JSON.stringify(value));
  });

  it('object form that fits 16 KiB (but would have failed the old 2000-char cap) forwards whole', () => {
    mountProvider();
    const value = { blob: 'y'.repeat(10_000) };
    setExtra(value);
    expect(nativeMock.setExtra).toHaveBeenCalledWith(JSON.stringify(value));
  });

  it('object form over budget is omitted (forwarded as empty string) with a warning, never sliced', () => {
    mountProvider();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const value = { huge: 'y'.repeat(EXTRA_MAX_CHARS * 2) };
    setExtra(value);
    expect(nativeMock.setExtra).toHaveBeenCalledWith('');
    expect(nativeMock.setExtra).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain(`exceeds the ${EXTRA_MAX_CHARS}-char limit`);
    warnSpy.mockRestore();
  });

  it('top-level export forwards the object to the mounted context', () => {
    const ctx = { setExtra: vi.fn() };
    __setCurrentContext(ctx as never);
    setExtra({ a: 1 });
    expect(ctx.setExtra).toHaveBeenCalledWith({ a: 1 });
  });
});
