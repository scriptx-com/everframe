// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// Finding 5 (round-4 PR review): the thread-polling arm effect in
// provider.tsx unconditionally calls `threads.startPolling()` once the
// config promise settles, regardless of the CURRENT visibility state. If
// `document.visibilityState` is already 'hidden' at that moment (tab opened
// in the background, prerender, restored session), no visibilitychange
// transition ever fires to stop it — nothing else in the poller's lifecycle
// re-checks visibility on its own — so the client polls in the background,
// violating the foreground-only contract until the user happens to switch
// tabs.
//
// This spec proves the fix: the initial arm is gated on
// `document.visibilityState === 'visible'` (treating a missing/undefined
// value as visible, so non-browser/test environments are unaffected).
// Mounted hidden, no poll ever fires after config resolves; a later
// hidden->visible transition still starts polling via the existing wake()
// path. Verified RED against the pre-fix provider.tsx (unconditional
// `threads.startPolling()`): the first assertion pair fails — a
// `/api/reporter/threads` request fires and the FAB renders even though the
// tab was hidden the entire time.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, act, waitFor } from '@testing-library/react';
import { EverframeProvider } from '../src/provider.js';
import { REPORTER_TOKEN_STORAGE_KEY } from '@everframe/web';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const config = { apiKey: 'txx_live_test' };

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

describe('finding 5: a Provider mounted while the document is hidden does not start background polling', () => {
  it('mounted with visibilityState=hidden: no poll fires after config settles; a later visible transition starts it', async () => {
    localStorage.setItem(REPORTER_TOKEN_STORAGE_KEY, 'evr_test0000000000000000000000000000000000');
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    const { calls } = stubFetch();

    const { getByTestId, queryByTestId } = render(
      <EverframeProvider config={config}>
        <div>host</div>
      </EverframeProvider>,
    );

    await flush(30);
    // Config has resolved (replies enabled) but the tab was hidden the whole
    // time — no /api/reporter/threads poll should ever have fired, and the
    // FAB (gated on threadState.count > 0) must not render.
    expect(calls.some((u) => u.includes('/api/reporter/threads'))).toBe(false);
    expect(queryByTestId('reporter-fab')).toBeNull();

    // Tab regains focus: the existing visibilitychange listener calls
    // wake(), which must now actually start polling (the listener itself is
    // untouched by the fix — only the initial arm is gated).
    act(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flush(30);

    // Waited for rather than asserted straight after the sleep: `flush(30)` is
    // a guess at how long the config settle plus the first threads poll takes,
    // and the same guess failed on a CI runner in
    // provider-kill-threads.spec.tsx. Absence assertions elsewhere in this file
    // legitimately keep the fixed sleep — a short wait can only make those
    // weaker, never spuriously red — but a PRESENCE assertion after a fixed
    // sleep is a race.
    await waitFor(() => {
      expect(calls.some((u) => u.includes('/api/reporter/threads'))).toBe(true);
      expect(getByTestId('reporter-fab')).toBeTruthy();
    });
  });

  it('unchanged: mounted with the default (visible) state still polls after config settles', async () => {
    localStorage.setItem(REPORTER_TOKEN_STORAGE_KEY, 'evr_test0000000000000000000000000000000000');
    // jsdom's default visibilityState is 'visible' — no explicit stub here,
    // proving the fix doesn't regress the ordinary foreground-mount path.
    const { calls } = stubFetch();

    const { getByTestId } = render(
      <EverframeProvider config={config}>
        <div>host</div>
      </EverframeProvider>,
    );

    await flush(30);
    // Waited for rather than asserted straight after the sleep: `flush(30)` is
    // a guess at how long the config settle plus the first threads poll takes,
    // and the same guess failed on a CI runner in
    // provider-kill-threads.spec.tsx. Absence assertions elsewhere in this file
    // legitimately keep the fixed sleep — a short wait can only make those
    // weaker, never spuriously red — but a PRESENCE assertion after a fixed
    // sleep is a race.
    await waitFor(() => {
      expect(calls.some((u) => u.includes('/api/reporter/threads'))).toBe(true);
      expect(getByTestId('reporter-fab')).toBeTruthy();
    });
  });
});
