// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// Round-6 PR-review Finding 2 (HIGH): a successful outbox retry that
// provisions a thread never woke the idle poller. `submitReportFromDraft`'s
// direct-submit path wakes the poller off `outcome.threadId` (provider.tsx
// onComplete), but the mount/online outbox-drain trigger (provider.tsx) fired
// `drainOutbox(...)` fire-and-forget and never inspected its result — and
// `drainOutbox` itself (submit.ts) deliberately dropped `result.thread` from
// every successful response, returning only `{ submitted, failed }`. If the
// client had already idled to zero before reconnect, a retried item that
// provisions a real conversation went undiscovered until an unrelated
// visibility transition or reload.
//
// The fix: `drainOutbox` now returns `provisionedThreadIds: string[]`
// (populated only for items belonging to the CURRENTLY MOUNTED app — a
// foreign-app item is opted out and provisions nothing this app could ever
// display), and the Provider's drain trigger calls
// `ctxValue.adapter.threads?.wake()` whenever that list is non-empty.
//
// These specs render the real Provider with a pre-seeded localStorage
// outbox item so the mount-time "best-effort drain" (provider.tsx) exercises
// the full pipeline against a stubbed `/api/ingest`. Verified RED against the
// pre-fix provider.tsx + submit.ts (drain result discarded / thread dropped):
// `wake` is never called even though the drained item's response carried a
// `thread` block.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useContext, useEffect } from 'react';
import { EverframeProvider, EverframeContext } from '../src/provider.js';
import { createLocalStorageOutbox } from '@everframe/web';
import type { ThreadClient } from '@everframe/sdk-core';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const APP_KEY = 'txx_live_drain_wake_test';
const config = { apiKey: APP_KEY };

/** Surfaces the adapter's thread client synchronously, before any drain promise settles. */
function AdapterProbe({ onAdapter }: { onAdapter: (threads: ThreadClient | undefined) => void }) {
  const ctx = useContext(EverframeContext);
  useEffect(() => {
    onAdapter(ctx?.adapter.threads);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
}

async function seedOutboxItem(reportId: string, sdkKey: string): Promise<void> {
  const ob = createLocalStorageOutbox()!;
  await ob.enqueue({
    reportId,
    enqueuedAt: 1,
    attempts: 0,
    payload: new TextEncoder().encode(JSON.stringify({ reportId, protocolVersion: '1.0' })),
    metadata: { sdkKey },
  });
}

/** Flush pending microtasks + real macrotasks so the async mount-time drain settles. */
async function flush(ms = 20): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function stubFetch(ingestBody: Record<string, unknown>): void {
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = urlOf(input);
    if (url.includes('/api/ingest')) {
      return new Response(
        JSON.stringify({
          status: 'received',
          eventId: 'e1',
          deliveryCount: 0,
          idempotent: false,
          ...ingestBody,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/api/config')) {
      return new Response(
        JSON.stringify({ replayEnabled: false, replayDurationSec: 30, samplingRate: 1 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/api/reporter/threads')) {
      return new Response(JSON.stringify({ threads: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', impl);
}

describe('round-6 Finding 2: outbox-drain-provisioned thread wakes the poller', () => {
  it('wakes the poller when the mount-time drain of a THIS-app item provisions a thread', async () => {
    await seedOutboxItem('r1', APP_KEY);
    stubFetch({ thread: { id: 't-provisioned' } });

    const seen: ThreadClient[] = [];
    render(
      <EverframeProvider config={config}>
        <AdapterProbe onAdapter={(threads) => { if (threads) seen.push(threads); }} />
      </EverframeProvider>,
    );
    const threads = seen[0];
    expect(threads).toBeDefined();
    const wake = vi.spyOn(threads, 'wake');

    await flush(30);

    expect(wake).toHaveBeenCalled();
  });

  it('does not wake the poller when the mount-time drain provisions no thread', async () => {
    await seedOutboxItem('r1', APP_KEY);
    stubFetch({}); // no thread block in the ingest response

    const seen: ThreadClient[] = [];
    render(
      <EverframeProvider config={config}>
        <AdapterProbe onAdapter={(threads) => { if (threads) seen.push(threads); }} />
      </EverframeProvider>,
    );
    const threads = seen[0];
    expect(threads).toBeDefined();
    const wake = vi.spyOn(threads, 'wake');

    await flush(30);

    expect(wake).not.toHaveBeenCalled();
  });

  it('does not wake the poller for a foreign-app item even if it (hypothetically) returned a thread', async () => {
    // Enqueued by a DIFFERENT app than the one currently mounted.
    await seedOutboxItem('r1', 'txx_live_a_different_app');
    stubFetch({ thread: { id: 't-foreign' } });

    const seen: ThreadClient[] = [];
    render(
      <EverframeProvider config={config}>
        <AdapterProbe onAdapter={(threads) => { if (threads) seen.push(threads); }} />
      </EverframeProvider>,
    );
    const threads = seen[0];
    expect(threads).toBeDefined();
    const wake = vi.spyOn(threads, 'wake');

    await flush(30);

    expect(wake).not.toHaveBeenCalled();
  });
});
