// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// Finding 6 (round 3, two-way-replies-client): client.kill() called
// `_adapter.threads?.stopPolling()`, but stopPolling() only sets `active =
// false` — deliberately reversible. The mounted Provider keeps its
// visibilitychange listener (provider.tsx) which calls `threads.wake()`
// directly on the adapter, and wake() does `if (!active) startPolling()`, so
// reporter traffic resumed after the public kill switch the moment the tab
// regained focus. The fix adds a terminal `shutdown()` to ThreadClient and
// routes client.kill() through it instead of stopPolling().
//
// This spec proves the fix end to end through the Provider: the FAB (fed by
// the SAME threadState subscription the fix must deliver a final empty
// snapshot through) disappears on kill(), and a subsequent visibilitychange
// to 'visible' — the exact escape path from the finding — does not restart
// polling.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, act, waitFor } from '@testing-library/react';
import { useContext, useEffect } from 'react';
import { EverframeProvider, EverframeContext } from '../src/provider.js';
import { REPORTER_TOKEN_STORAGE_KEY } from '@everframe/web';
import type { EverframeClient } from '@everframe/sdk-core';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const config = { apiKey: 'txx_live_test' };

/** Surfaces the sdk-core client to the test without reaching into module internals. */
function ClientProbe({ onClient }: { onClient: (client: EverframeClient) => void }) {
  const ctx = useContext(EverframeContext);
  useEffect(() => {
    if (ctx) onClient(ctx.client);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

/** Stubs global fetch: config resolves immediately with replies enabled; threads returns one open thread. */
function stubFetch(): { calls: string[] } {
  const calls: string[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/api/config')) {
      return new Response(
        JSON.stringify({
          replayEnabled: false,
          replayDurationSec: 30,
          samplingRate: 1,
          replies: { enabled: true },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/api/reporter/threads')) {
      return new Response(
        JSON.stringify({
          threads: [
            {
              id: 'thread-1',
              status: 'open',
              reportTitle: 'Broken checkout',
              createdAt: new Date().toISOString(),
              lastMessageAt: new Date().toISOString(),
              unreadCount: 1,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', impl);
  return { calls };
}

/** Flush pending microtasks + real macrotasks (the 0ms poll timer) inside `act`. */
async function flush(ms = 20): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe('finding 6: client.kill() terminally shuts down thread polling through the Provider', () => {
  it('kill() makes the FAB disappear, and a subsequent visibilitychange to visible does not resurrect polling', async () => {
    localStorage.setItem(REPORTER_TOKEN_STORAGE_KEY, 'evr_test0000000000000000000000000000000000');
    const { calls } = stubFetch();

    let client: EverframeClient | undefined;
    const { getByTestId, queryByTestId } = render(
      <EverframeProvider config={config}>
        <ClientProbe onClient={(c) => { client = c; }} />
      </EverframeProvider>,
    );

    await flush(30);
    // Precondition: the poller actually ran and the FAB actually rendered —
    // otherwise the assertions below would pass vacuously.
    //
    // WAITED FOR, not asserted straight after `flush(30)`. That 30ms is a
    // guess at how long the first /api/reporter/threads poll plus the React
    // state settle takes; it holds on a dev machine and stopped holding on a
    // CI runner, where this failed with "expected false to be true" — the poll
    // simply had not happened yet. Nothing here is a claim about speed, so
    // polling for the condition measures the behaviour instead of the machine.
    await waitFor(() => {
      expect(calls.some((u) => u.includes('/api/reporter/threads'))).toBe(true);
      expect(getByTestId('reporter-fab')).toBeTruthy();
    });
    const pollCallsBeforeKill = calls.filter((u) => u.includes('/api/reporter/threads')).length;

    expect(client).toBeDefined();
    act(() => {
      client!.kill();
    });

    // The final empty snapshot must reach the Provider's threadState
    // subscription synchronously (shutdown() notifies once before clearing
    // subscribers), so the FAB drops away immediately — no need to flush.
    expect(queryByTestId('reporter-fab')).toBeNull();

    // The exact escape path from the finding: the tab regains focus, the
    // Provider's visibilitychange listener fires `threads.wake()` directly
    // on the adapter (bypassing the killed tx.threads.* facade). Pre-fix,
    // wake() did `if (!active) startPolling()` unconditionally and traffic
    // resumed. Post-fix, shutdown() is terminal — wake() is a no-op.
    act(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flush(30);

    const pollCallsAfterVisible = calls.filter((u) => u.includes('/api/reporter/threads')).length;
    expect(pollCallsAfterVisible).toBe(pollCallsBeforeKill);
    expect(queryByTestId('reporter-fab')).toBeNull();
  });
});
