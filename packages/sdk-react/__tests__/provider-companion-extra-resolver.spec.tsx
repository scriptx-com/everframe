// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// setExtra resolver form (spec 2026-09-17 setExtra-resolver), sdk-react half.
// sdk-core's `resolveClientExtra` is the one seam that may read
// `ClientState.extra`; provider.tsx's companion host seam
// (`__setCompanionHost({ getExtra: () => resolveClientExtra(ctxValue.client) })`,
// provider.tsx ~line 236) is one of the two production call sites that go
// through it (the other is the in-app `onComplete` submit boundary). This
// mounts the REAL TraceItXProvider and drives the REAL seam object it
// publishes, mirroring provider-companion-user.spec.tsx's doctrine for
// `getUser` — proving `getExtra` is a live re-read, not a mount-time
// snapshot, and that resolution genuinely happens at THIS read point rather
// than inside `setExtra` itself.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { TraceItXProvider } from '../src/provider.js';
import { useTraceItX } from '../src/hook.js';
import { __getCompanionHost } from '@traceitx/web';

const cfg = { apiKey: 'txx_live_extra_resolver_test' };
const wrapper = ({ children }: { children: ReactNode }) => (
  <TraceItXProvider config={cfg}>{children}</TraceItXProvider>
);

describe('provider.tsx companion host seam — getExtra resolves the resolver form live', () => {
  afterEach(() => {
    cleanup();
  });

  it('setExtra(resolver) does not invoke it; the seam getter invokes it, once per call', () => {
    const { result } = renderHook(() => useTraceItX(), { wrapper });
    const resolve = vi.fn(() => ({ screen: 'checkout' }));

    act(() => {
      result.current.setExtra(resolve);
    });
    expect(resolve).toHaveBeenCalledTimes(0);

    const host = __getCompanionHost();
    expect(host).not.toBeNull();

    const first = host!.getExtra!();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(first).toBe(JSON.stringify({ screen: 'checkout' }));

    const second = host!.getExtra!();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(second).toBe(JSON.stringify({ screen: 'checkout' }));
  });

  it('the seam reflects a resolver registered AFTER mount, with no remount — same live doctrine as getUser', () => {
    const { result } = renderHook(() => useTraceItX(), { wrapper });
    const host = __getCompanionHost();
    expect(host).not.toBeNull();

    // Nobody registered anything yet.
    expect(host!.getExtra!()).toBe('');

    let channel = 'news';
    act(() => {
      result.current.setExtra(() => ({ channel }));
    });
    expect(host!.getExtra!()).toBe(JSON.stringify({ channel: 'news' }));

    // Switch channel with NO remount — the concrete staleness bug this
    // feature fixes: a pushed snapshot would still say 'news' here.
    channel = 'sports';
    expect(host!.getExtra!()).toBe(JSON.stringify({ channel: 'sports' }));
  });

  it('a throwing resolver is caught at the seam: extra omitted, no throw out of getExtra()', () => {
    const { result } = renderHook(() => useTraceItX(), { wrapper });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const host = __getCompanionHost();
    expect(host).not.toBeNull();

    act(() => {
      result.current.setExtra(() => {
        throw new Error('player store not ready');
      });
    });

    let value: string | undefined;
    expect(() => {
      value = host!.getExtra!();
    }).not.toThrow();
    expect(value).toBe('');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('setExtra');
  });

  it('the string and object forms still flow through the same live getter, unchanged', () => {
    const { result } = renderHook(() => useTraceItX(), { wrapper });
    const host = __getCompanionHost();
    expect(host).not.toBeNull();

    act(() => {
      result.current.setExtra('order-4417');
    });
    expect(host!.getExtra!()).toBe('order-4417');

    act(() => {
      result.current.setExtra({ a: 1, b: 2 });
    });
    expect(host!.getExtra!()).toBe(JSON.stringify({ a: 1, b: 2 }));
  });
});
