// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// timeoutSignal — bounded-fetch signal that works on engines WITHOUT
// AbortSignal.timeout (Chrome 103+). Smart-TV webviews (webOS 6.x = Chrome 79,
// Tizen ≤ 7 = ≤ M94) lack it; calling it there throws synchronously, which is
// how every /api/config fetch on those TVs died before reaching the network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { timeoutSignal } from '../../src/transport/timeout-signal.js';

const nativeTimeout = AbortSignal.timeout;

afterEach(() => {
  (AbortSignal as { timeout?: typeof AbortSignal.timeout }).timeout = nativeTimeout;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('timeoutSignal', () => {
  it('uses native AbortSignal.timeout when available', () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    const signal = timeoutSignal(5_000);
    expect(spy).toHaveBeenCalledWith(5_000);
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('falls back to AbortController when AbortSignal.timeout is missing', () => {
    vi.useFakeTimers();
    // Simulate Chrome 79: AbortController exists, AbortSignal.timeout does not.
    (AbortSignal as { timeout?: unknown }).timeout = undefined;

    const signal = timeoutSignal(1_000);
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);
    vi.advanceTimersByTime(1_001);
    expect(signal!.aborted).toBe(true);
  });

  it('returns null when no abort primitives exist at all', () => {
    (AbortSignal as { timeout?: unknown }).timeout = undefined;
    const OriginalController = globalThis.AbortController;
    globalThis.AbortController = undefined as unknown as typeof AbortController;
    try {
      expect(timeoutSignal(1_000)).toBeNull();
    } finally {
      globalThis.AbortController = OriginalController;
    }
  });
});
