// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, renderHook, act } from '@testing-library/react';
import { useContext, useEffect } from 'react';
import { EverframeProvider, EverframeContext } from '../src/provider.js';
import { useEverframe } from '../src/hook.js';
import type { ReactNode } from 'react';
import type { ThreadClient } from '@everframe/sdk-core';

afterEach(() => cleanup());

const config = { apiKey: 'txx_live_test' };
const wrapper = ({ children }: { children: ReactNode }) => (
  <EverframeProvider config={config}>{children}</EverframeProvider>
);

type AdapterThreads = ThreadClient;

/** Surfaces the adapter's thread client to the test without reaching into module internals. */
function AdapterProbe({ onAdapter }: { onAdapter: (threads: AdapterThreads | undefined) => void }) {
  const ctx = useContext(EverframeContext);
  useEffect(() => {
    onAdapter(ctx?.adapter.threads);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

describe('provider thread wiring', () => {
  it('exposes threads and a live unreadCount through useEverframe', () => {
    const { result } = renderHook(() => useEverframe(), { wrapper });
    expect(typeof result.current.threads.subscribe).toBe('function');
    expect(result.current.unreadCount).toBe(0);
  });

  it('pauses polling when the document is hidden and wakes when visible', () => {
    const seen: AdapterThreads[] = [];
    render(
      <EverframeProvider config={config}>
        <AdapterProbe onAdapter={(threads) => { if (threads) seen.push(threads); }} />
      </EverframeProvider>,
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
      <EverframeProvider config={{ ...config, replies: { disabled: true } }}>
        <AdapterProbe onAdapter={(threads) => seen.push(threads)} />
      </EverframeProvider>,
    );
    expect(seen[0]).toBeUndefined();
  });
});
