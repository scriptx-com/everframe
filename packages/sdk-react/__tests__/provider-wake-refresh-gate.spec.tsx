// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// Finding 1 (round 5, PR review, HIGH — replies can never turn on during a
// live session): the Provider resolves the remote config gate exactly once
// at mount. A later successful submit that authoritatively returns a new
// `threadId` only calls `adapter.threads.wake()` (provider.tsx onComplete);
// pre-fix, wake() never re-resolved the config-gate cache, so the next poll
// idled immediately on the stale `isEnabled()===false` cache — the reporter
// saw the reply-aware toast but no FAB/inbox until a full reload. The same
// permanent-for-this-page failure happened when the single mount-time
// config fetch transiently failed.
//
// The fix threads a `refreshGate` dep through wake() (sdk-core
// thread-client.ts) that force-refreshes the SAME hoisted config-provider
// instance (adapter.ts) before deciding whether to arm polling. These specs
// exercise that end to end through the real Provider + submit pipeline —
// verified RED against the pre-fix adapter.ts (no refreshGate wired): both
// specs below fail because wake() never re-resolves the gate, so
// `/api/reporter/threads` is never requested and the FAB never renders.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { useContext, useEffect } from 'react';
import { useTraceItX } from '../src/hook.js';
import { TraceItXProvider, TraceItXContext } from '../src/provider.js';
import { REPORTER_TOKEN_STORAGE_KEY } from '@traceitx/web';
import type { ThreadClient } from '@traceitx/sdk-core';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function OpenButton() {
  const { open } = useTraceItX();
  return (
    <button type="button" data-testid="host-open" onClick={open}>
      open
    </button>
  );
}

/** Surfaces the adapter's thread client to the test without reaching into module internals. */
function AdapterProbe({ onAdapter }: { onAdapter: (threads: ThreadClient | undefined) => void }) {
  const ctx = useContext(TraceItXContext);
  useEffect(() => {
    onAdapter(ctx?.adapter.threads);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
}

const OPEN_THREAD = {
  id: 't1',
  status: 'open',
  reportTitle: 'Bug X',
  createdAt: new Date().toISOString(),
  lastMessageAt: new Date().toISOString(),
  unreadCount: 1,
};

async function flush(ms = 20): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe('finding 1 (round 5): wake() re-resolves the config gate mid-session', () => {
  it('config OFF at mount, then a submit that provisions a thread while the server has since turned replies on: polling starts and the FAB appears', async () => {
    const originalFetch = globalThis.fetch;
    let configCalls = 0;
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.includes('/api/config')) {
        configCalls += 1;
        // First resolution (mount): replies OFF. Every call after that
        // (i.e. the wake()-triggered force refresh) reflects the server
        // having turned replies on mid-session.
        const repliesEnabled = configCalls > 1;
        return new Response(
          JSON.stringify({
            replayEnabled: false,
            replayDurationSec: 30,
            samplingRate: 1,
            ...(repliesEnabled ? { replies: { enabled: true } } : {}),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/api/reporter/threads')) {
        return new Response(JSON.stringify({ threads: [OPEN_THREAD] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/ingest')) {
        // The ingest response authoritatively provisions a thread — this is
        // what drives the Provider's post-submit `threads.wake()` call.
        return new Response(JSON.stringify({ thread: { id: 't1' } }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    try {
      const { findByTestId, queryByTestId } = render(
        <TraceItXProvider config={{ apiKey: 'txx_live_wake_gate_test', appName: 'test', appVersion: '1.0.0' }}>
          <div>app</div>
          <OpenButton />
        </TraceItXProvider>,
      );

      // Let mount settle: the single config fetch resolves OFF, so the
      // thread poller's first (and only, pre-wake) tick idles to zero.
      await waitFor(() => expect(configCalls).toBeGreaterThanOrEqual(1));
      await flush(20);
      expect(fetchSpy.mock.calls.some((c) => urlOf(c[0]).includes('/api/reporter/threads'))).toBe(false);
      expect(queryByTestId('reporter-fab')).toBeNull();

      const opener = await findByTestId('host-open');
      await act(async () => {
        fireEvent.click(opener);
      });
      const titleInput = (await findByTestId('report-title')) as HTMLInputElement;
      await act(async () => {
        fireEvent.change(titleInput, { target: { value: 'Bug X' } });
      });
      const submit = await findByTestId('submit-report');
      await act(async () => {
        fireEvent.click(submit);
      });

      // The submit's ingest response carried a threadId, so onComplete calls
      // threads.wake() — which must force-refresh the config gate (now ON)
      // BEFORE deciding whether to arm, then actually poll.
      await waitFor(
        () => {
          expect(fetchSpy.mock.calls.some((c) => urlOf(c[0]).includes('/api/reporter/threads'))).toBe(true);
        },
        { timeout: 5000 },
      );
      expect(await findByTestId('reporter-fab')).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('a mount-time config fetch failure followed by a wake() recovers once the config endpoint is healthy', async () => {
    localStorage.setItem(REPORTER_TOKEN_STORAGE_KEY, 'txr_test0000000000000000000000000000000000');
    const originalFetch = globalThis.fetch;
    let configCalls = 0;
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.includes('/api/config')) {
        configCalls += 1;
        if (configCalls === 1) {
          // The one mount-time fetch fails outright (fail-closed OFF).
          return new Response('', { status: 503 });
        }
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
        return new Response(JSON.stringify({ threads: [OPEN_THREAD] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200 });
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    try {
      const seen: ThreadClient[] = [];
      render(
        <TraceItXProvider config={{ apiKey: 'txx_live_wake_gate_recover_test', appName: 'test', appVersion: '1.0.0' }}>
          <AdapterProbe
            onAdapter={(threads) => {
              if (threads) seen.push(threads);
            }}
          />
        </TraceItXProvider>,
      );

      await waitFor(() => expect(configCalls).toBeGreaterThanOrEqual(1));
      await flush(20);
      expect(fetchSpy.mock.calls.some((c) => urlOf(c[0]).includes('/api/reporter/threads'))).toBe(false);

      const threads = seen[0];
      expect(threads).toBeDefined();

      // A deliberate wake signal (e.g. the tab regaining focus) — must
      // force-refresh the now-healthy config endpoint and actually poll,
      // not idle again on the stale fail-closed OFF cache.
      act(() => {
        threads.wake();
      });

      await waitFor(
        () => {
          expect(fetchSpy.mock.calls.some((c) => urlOf(c[0]).includes('/api/reporter/threads'))).toBe(true);
        },
        { timeout: 5000 },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
