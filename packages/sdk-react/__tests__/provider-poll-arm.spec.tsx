// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// Finding C1 (final review, two-way-replies-client, 2026-08-01): on a fresh
// page load the thread poller's first 0ms tick could run BEFORE the config
// fetch (which gates `isEnabled()`) resolved. Pre-fix, that first tick sees
// isEnabled()===false, pollOnce() returns nextDelayMs=null, and the poller
// idles PERMANENTLY — nothing else re-arms it (wake() only fires on
// visibilitychange or a new submit), so the FAB/unread dot never appears on a
// fresh load without a tab hide/show.
//
// This spec proves the fix: `threads.startPolling()` is deferred until the
// SAME `__initReplay()` settle signal that warms the config gate resolves, so
// the poller's first real tick always observes the resolved config instead of
// the fail-closed OFF default. Verified RED against the pre-fix provider.tsx
// (synchronous `threads.startPolling()` at mount): both assertions after the
// config resolves fail — no `/api/reporter/threads` request is ever made, and
// `getByTestId('reporter-fab')` throws because the FAB never renders.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { TraceItXProvider } from '../src/provider.js';
import { REPORTER_TOKEN_STORAGE_KEY } from '@traceitx/web';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const config = { apiKey: 'txx_live_test' };

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Stubs global fetch: `/api/config` resolves via the caller-controlled deferred; `/api/reporter/threads` returns one open thread immediately. */
function stubFetch(configDeferred: Deferred<Response>): { calls: string[] } {
  const calls: string[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/api/config')) return configDeferred.promise;
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

describe('C1: thread poller arms after the config gate settles, not before', () => {
  it('fires a poll and populates threads once isEnabled() resolves true after mount', async () => {
    // A device token must already be present or pollOnce() idles on the
    // (unrelated) missing-token path before ever reaching isEnabled().
    localStorage.setItem(REPORTER_TOKEN_STORAGE_KEY, 'txr_test0000000000000000000000000000000000');
    const cfgDeferred = deferred<Response>();
    const { calls } = stubFetch(cfgDeferred);

    const { getByTestId, queryByTestId } = render(
      <TraceItXProvider config={config}>
        <div>host</div>
      </TraceItXProvider>,
    );

    // Let mount effects run and any 0ms-armed first tick fire WHILE the
    // config fetch is still pending — isEnabled() would read the fail-closed
    // OFF default here if polling were armed synchronously at mount.
    await flush(20);
    expect(calls.some((u) => u.includes('/api/reporter/threads'))).toBe(false);
    expect(queryByTestId('reporter-fab')).toBeNull();

    // Config resolves: replies enabled, so isEnabled() flips true.
    await act(async () => {
      cfgDeferred.resolve(
        new Response(
          JSON.stringify({
            replayEnabled: false,
            replayDurationSec: 30,
            samplingRate: 1,
            replies: { enabled: true },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    });
    await flush(30);

    // The poller must have armed AFTER the gate warmed and fired a real poll
    // — not idled to zero before the gate was known. This is the assertion
    // pair that fails on pre-fix code (verified RED): pre-fix, active flips
    // to false on the very first (pre-config) tick and nothing ever re-arms
    // it, so neither a reporter/threads request nor the FAB ever appears.
    expect(calls.some((u) => u.includes('/api/reporter/threads'))).toBe(true);
    expect(getByTestId('reporter-fab')).toBeTruthy();
  });

  it('a permanently-disabled app ends with no armed timer once the gate is known off', async () => {
    localStorage.setItem(REPORTER_TOKEN_STORAGE_KEY, 'txr_test0000000000000000000000000000000000');
    const cfgDeferred = deferred<Response>();
    const { calls } = stubFetch(cfgDeferred);

    render(
      <TraceItXProvider config={config}>
        <div>host</div>
      </TraceItXProvider>,
    );
    await flush(20);

    // Config resolves with replies OFF (block omitted, exactly like a server
    // that never turned the feature on for this app).
    await act(async () => {
      cfgDeferred.resolve(
        new Response(
          JSON.stringify({ replayEnabled: false, replayDurationSec: 30, samplingRate: 1 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    });
    await flush(30);

    // idle-to-zero: the single post-resolution tick sees isEnabled()===false
    // and returns immediately — no network call, no lingering armed timer.
    expect(calls.some((u) => u.includes('/api/reporter/threads'))).toBe(false);
  });
});
