// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// Critical PR-review finding (two-way-replies-client): on a config gate
// ON -> OFF transition, handleAuthFailure(replies_disabled) in sdk-core's
// thread-client.ts deliberately PRESERVES the thread list, marks every row
// closed, sets `readOnly`, and notifies subscribers — existing conversations
// are meant to stay reachable, read-only. But the Provider gated the FAB's
// render on `threadState.enabled` alone, and the very config flip that
// engages the read-only latch also flips `enabled` to false — so the only
// entry point into the retained inbox (the FAB) disappeared at exactly the
// moment the kill-switch contract says it must not.
//
// The first fix widened the Provider's threadState to also track `readOnly`
// (off the SAME subscription — no second one) and rendered the FAB when
// replies were enabled OR the client was retaining rows read-only.
//
// PR re-review (Minor finding): that `enabled || readOnly` disjunction
// introduced a visible flicker. wake() (sdk-core thread-client.ts)
// optimistically clears `readOnly` and notifies BEFORE its forced config
// refetch resolves — so on every visibility return to a kill-switched app
// there was a beat where `enabled` was still false (config refetch still in
// flight) and `readOnly` had already flipped false too. Both prongs false
// -> the FAB unmounted, then remounted once the next poll re-latched.
// A disappear/reappear on every tab return.
//
// The actual fix (not a special case): the disjunction was redundant.
// Thread rows are populated EXCLUSIVELY by a successful listThreads() call
// inside pollOnce(), strictly after its `if (!enabledNow || readOnly)
// return` gate — so `count > 0` alone already proves "this device has
// conversations worth showing," whether currently enabled or read-only
// latched (rows are closed in place, never deleted, by the latch;
// shutdown() empties them outright). The Provider's threadState was reduced
// back to `{ unread, count }` and the render gate to `adapter.threads &&
// ui !== 'headless' && count > 0` — no enabled/readOnly signal needed at
// all, so there is no gap for either of them to glitch through.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, act, fireEvent, within, waitFor } from '@testing-library/react';
import { useContext, useEffect } from 'react';
import { TraceItXProvider, TraceItXContext } from '../src/provider.js';
import { REPORTER_TOKEN_STORAGE_KEY } from '@traceitx/web';
import type { ThreadClient } from '@traceitx/sdk-core';
import type { WebTraceItXConfig } from '@traceitx/web';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const baseConfig = { apiKey: 'txx_live_test' };

function ClientProbe({ onAdapter }: { onAdapter: (threads: ThreadClient | undefined) => void }) {
  const ctx = useContext(TraceItXContext);
  useEffect(() => {
    onAdapter(ctx?.adapter.threads);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

/**
 * Stubs global fetch. `/api/config` reflects a caller-controlled `enabled`
 * flag (read fresh on every call, so flipping it mid-test changes the NEXT
 * fetch's response). `/api/reporter/threads` returns whatever `threads`
 * currently holds (array, mutable by reference).
 */
function stubFetch(state: { enabled: boolean; threads: unknown[] }): { calls: string[] } {
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
          replies: { enabled: state.enabled },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/api/reporter/threads')) {
      return new Response(JSON.stringify({ threads: state.threads }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
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

/**
 * Assert the FAB is present, WAITING for it rather than assuming a preceding
 * `flush(30)` was long enough.
 *
 * `flush` advances the act/timer cycle, but 30ms is a wall-clock guess at how
 * long the config fetch plus React state settle takes. That guess holds when
 * this file runs alone and stops holding when `pnpm test` runs 19 packages
 * concurrently and the event loop is contended — which is exactly how this
 * spec failed in the full suite while passing in isolation. `waitFor` polls
 * the condition instead of betting on a duration, so the test measures the
 * behaviour it names rather than the machine's current load.
 */
async function expectFabPresent(getByTestId: (id: string) => HTMLElement): Promise<void> {
  await waitFor(() => {
    expect(getByTestId('reporter-fab')).toBeTruthy();
  });
}

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

function configResponse(enabled: boolean): Response {
  return new Response(
    JSON.stringify({
      replayEnabled: false,
      replayDurationSec: 30,
      samplingRate: 1,
      replies: { enabled },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/**
 * Same shape as `stubFetch`, but `/api/config` can be redirected to a
 * caller-controlled deferred for exactly one in-flight call — lets a test
 * inspect DOM state in the gap between wake()'s synchronous optimistic
 * `readOnly` clear and the forced config refetch it kicks off actually
 * resolving.
 */
function stubFetchWithDeferrableConfig(state: {
  enabled: boolean;
  threads: unknown[];
  configDeferred: Deferred<Response> | null;
}): { calls: string[] } {
  const calls: string[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/api/config')) {
      if (state.configDeferred) return state.configDeferred.promise;
      return configResponse(state.enabled);
    }
    if (url.includes('/api/reporter/threads')) {
      return new Response(JSON.stringify({ threads: state.threads }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', impl);
  return { calls };
}

/** Fires the exact real-world sequence that force-refreshes the config gate: tab hidden, then visible again (Provider's wake() path). */
async function cycleVisibilityToForceConfigRefresh(): Promise<void> {
  act(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  act(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await flush(30);
}

const oneOpenThread = [
  {
    id: 'thread-1',
    status: 'open',
    reportTitle: 'Broken checkout',
    createdAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
    unreadCount: 1,
  },
];

describe('FAB stays reachable when the replies kill switch latches read-only', () => {
  it('(a) gate ON -> OFF with a retained thread: FAB renders, and opening it shows the read-only inbox with the retained thread', async () => {
    localStorage.setItem(REPORTER_TOKEN_STORAGE_KEY, 'txr_test0000000000000000000000000000000000');
    const state = { enabled: true, threads: oneOpenThread };
    stubFetch(state);

    const { getByTestId, queryByTestId, getByText, getByRole } = render(
      <TraceItXProvider config={baseConfig}>
        <div />
      </TraceItXProvider>,
    );

    await flush(30);
    // Precondition: replies started out enabled with a real thread, so the
    // FAB rendering here is not vacuous.
    await expectFabPresent(getByTestId);

    // Flip the server gate OFF and force the client to re-resolve config —
    // the exact ON->OFF transition the finding describes (Task 8's
    // pollOnce() reconciles this into the SAME latch handleAuthFailure
    // drives, per thread-client.ts's own inline comment).
    state.enabled = false;
    await cycleVisibilityToForceConfigRefresh();

    // The retained thread must still be present, closed, with the client
    // latched read-only — confirms the repro state from the finding, not
    // just an assumption about it.
    // (Assertion below on the rendered inbox proves this end-to-end.)

    // THE FIX: the FAB must still be present — the kill switch closes
    // conversations, it does not remove the only way to reach them.
    expect(queryByTestId('reporter-fab')).not.toBeNull();

    // Opening the FAB must show the retained conversation, read-only.
    fireEvent.click(getByTestId('reporter-fab'));
    expect(getByText(/Replies are turned off\. Existing conversations are read-only\./)).toBeTruthy();
    const row = getByRole('button', { name: /Broken checkout/ });
    expect(row).toBeTruthy();
    expect(within(row).getByText('Closed')).toBeTruthy();

    // Sanity: the preserved unread count must not crash or render garbage —
    // it may legitimately carry over from before the latch (acceptable per
    // the finding), just not something nonsensical.
    const fab = getByTestId('reporter-fab');
    expect(fab.getAttribute('aria-label')).toBe('Your reports — 1 unread');
  });

  it('(b) regression guard: replies enabled with threads still renders the FAB', async () => {
    localStorage.setItem(REPORTER_TOKEN_STORAGE_KEY, 'txr_test0000000000000000000000000000000000');
    stubFetch({ enabled: true, threads: oneOpenThread });

    const { getByTestId } = render(<TraceItXProvider config={baseConfig}><div /></TraceItXProvider>);
    await flush(30);

    await expectFabPresent(getByTestId);
  });

  it('(c) count === 0 renders nothing, whether enabled or read-only-latched', async () => {
    localStorage.setItem(REPORTER_TOKEN_STORAGE_KEY, 'txr_test0000000000000000000000000000000000');
    const state = { enabled: true, threads: [] as unknown[] };
    stubFetch(state);

    const { queryByTestId } = render(<TraceItXProvider config={baseConfig}><div /></TraceItXProvider>);
    await flush(30);
    // No threads at all: enabled, but nothing to show.
    expect(queryByTestId('reporter-fab')).toBeNull();

    // Flip OFF with zero threads retained — read-only-latched but still
    // count === 0, must still render nothing.
    state.enabled = false;
    await cycleVisibilityToForceConfigRefresh();
    expect(queryByTestId('reporter-fab')).toBeNull();
  });

  it('(d) the local veto (replies.disabled) renders nothing even with retained rows', async () => {
    localStorage.setItem(REPORTER_TOKEN_STORAGE_KEY, 'txr_test0000000000000000000000000000000000');
    stubFetch({ enabled: true, threads: oneOpenThread });
    const vetoConfig: WebTraceItXConfig = { ...baseConfig, replies: { disabled: true } };

    const seen: Array<ThreadClient | undefined> = [];
    const { queryByTestId } = render(
      <TraceItXProvider config={vetoConfig}>
        <ClientProbe onAdapter={(t) => seen.push(t)} />
      </TraceItXProvider>,
    );
    await flush(30);

    // The local veto means no thread client is ever constructed at all.
    expect(seen[0]).toBeUndefined();
    expect(queryByTestId('reporter-fab')).toBeNull();
  });

  it('(d) headless mode renders nothing even with replies enabled and retained rows', async () => {
    localStorage.setItem(REPORTER_TOKEN_STORAGE_KEY, 'txr_test0000000000000000000000000000000000');
    stubFetch({ enabled: true, threads: oneOpenThread });
    const headlessConfig: WebTraceItXConfig = { ...baseConfig, replies: { ui: 'headless' } };

    const { queryByTestId } = render(<TraceItXProvider config={headlessConfig}><div /></TraceItXProvider>);
    await flush(30);

    expect(queryByTestId('reporter-fab')).toBeNull();
  });

  it('(e) pins the flicker fix: the FAB stays mounted through wake()\'s optimistic readOnly clear, before the forced config refetch resolves', async () => {
    localStorage.setItem(REPORTER_TOKEN_STORAGE_KEY, 'txr_test0000000000000000000000000000000000');
    const state: { enabled: boolean; threads: unknown[]; configDeferred: Deferred<Response> | null } = {
      enabled: true,
      threads: oneOpenThread,
      configDeferred: null,
    };
    stubFetchWithDeferrableConfig(state);

    const { getByTestId, queryByTestId } = render(
      <TraceItXProvider config={baseConfig}>
        <div />
      </TraceItXProvider>,
    );
    await flush(30);
    await expectFabPresent(getByTestId);

    // Latch read-only, same as test (a) — the server gate flips OFF and the
    // client reconciles into the replies_disabled latch, retaining the
    // (now closed) thread.
    state.enabled = false;
    await cycleVisibilityToForceConfigRefresh();
    await expectFabPresent(getByTestId);

    // Now arm a deferred config response — the NEXT /api/config fetch
    // (the forced refetch wake() kicks off below) will hang until resolved.
    state.configDeferred = deferred<Response>();

    // The exact real-world sequence: tab hidden, then visible again. The
    // 'visible' transition calls threads.wake() directly (Provider's
    // visibilitychange listener), which SYNCHRONOUSLY clears the latched
    // `readOnly` flag and notifies subscribers BEFORE awaiting its forced
    // config refetch (deliberately stuck in-flight here). Pre-fix, this
    // exact moment was where both `enabled` (still false; refetch hasn't
    // resolved) and `readOnly` (just optimistically cleared) were false at
    // once, and the FAB unmounted.
    act(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    act(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // THE FIX: still mounted, mid-gap, before the deferred config fetch has
    // resolved — the render gate never depended on enabled/readOnly at all.
    expect(queryByTestId('reporter-fab')).not.toBeNull();

    // Let the forced refetch resolve (still disabled) and the subsequent
    // re-latch poll run to completion.
    await act(async () => {
      state.configDeferred!.resolve(configResponse(false));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    // Still mounted afterward — the retained, now-closed thread is still
    // present and count > 0 never stopped being true throughout.
    expect(queryByTestId('reporter-fab')).not.toBeNull();
  });
});
