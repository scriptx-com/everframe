// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, renderHook, act } from '@testing-library/react';
import { useContext, useEffect } from 'react';
import { TraceItXProvider, TraceItXContext } from '../src/provider.js';
import { useTraceItX } from '../src/hook.js';
import type { ReactNode } from 'react';
import type { ThreadClient } from '@traceitx/sdk-core';

afterEach(() => cleanup());

const config = { apiKey: 'txx_live_test' };
const wrapper = ({ children }: { children: ReactNode }) => (
  <TraceItXProvider config={config}>{children}</TraceItXProvider>
);

type AdapterThreads = ThreadClient;

/** Surfaces the adapter's thread client to the test without reaching into module internals. */
function AdapterProbe({ onAdapter }: { onAdapter: (threads: AdapterThreads | undefined) => void }) {
  const ctx = useContext(TraceItXContext);
  useEffect(() => {
    onAdapter(ctx?.adapter.threads);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

describe('provider thread wiring', () => {
  it('exposes threads and a live unreadCount through useTraceItX', () => {
    const { result } = renderHook(() => useTraceItX(), { wrapper });
    expect(typeof result.current.threads.subscribe).toBe('function');
    expect(result.current.unreadCount).toBe(0);
  });

  it('pauses polling when the document is hidden and wakes when visible', () => {
    const seen: AdapterThreads[] = [];
    render(
      <TraceItXProvider config={config}>
        <AdapterProbe onAdapter={(threads) => { if (threads) seen.push(threads); }} />
      </TraceItXProvider>,
    );
    const threads = seen[0];
    expect(threads).toBeDefined();
    const stop = vi.spyOn(threads, 'stopPolling');
    const wake = vi.spyOn(threads, 'wake');
    act(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(stop).toHaveBeenCalled();
    act(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(wake).toHaveBeenCalled();
  });

  it('honors replies.disabled: no thread client is constructed', () => {
    const seen: Array<AdapterThreads | undefined> = [];
    render(
      <TraceItXProvider config={{ ...config, replies: { disabled: true } }}>
        <AdapterProbe onAdapter={(threads) => seen.push(threads)} />
      </TraceItXProvider>,
    );
    expect(seen[0]).toBeUndefined();
  });
});
