// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// Field bug 2026-08-27 (webOS): reports shipped with no session replay while
// /api/config answered `replayEnabled: true`. The device flight recorder showed
// a single `lifecycle.tryStart from=IDLE started=false reason=disabled` and
// nothing after it — the boot config read failed, replay fell closed, and the
// ONLY thing that ever re-attempted the start was the 5-minute periodic tick.
// Every other path that re-resolves config (wake / refreshGate) applied
// breadcrumbs, network bodies, badge and branding, but never replay — so a
// report filed in the first five minutes of a session had no replay, with a
// clean 200 in the network trace and no signal anywhere.
//
// The start is a guarded no-op once buffering, so the fix is simply to attempt
// it wherever config resolves.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { DEFAULT_CONFIG_TTL_MS } from '@everframe/sdk-core';
import { createWebPlatformAdapter, type WebPlatformAdapter } from '../../src/adapter.js';

const adapters: WebPlatformAdapter[] = [];
afterEach(() => {
  while (adapters.length) adapters.pop()!.__testCleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

const configOn = (): Response =>
  new Response(
    JSON.stringify({ replayEnabled: true, replayDurationSec: 30, samplingRate: 1 }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** Config endpoint that fails until `healthy` is flipped. */
function stubConfig(state: { healthy: boolean }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (urlOf(input).includes('/api/config')) {
      return state.healthy ? configOn() : new Response('{}', { status: 503 });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function makeAdapter(): WebPlatformAdapter {
  const adapter = createWebPlatformAdapter({ apiKey: 'k' });
  adapters.push(adapter);
  return adapter;
}

describe('replay start is retried whenever config resolves', () => {
  it('stays IDLE while the boot config read is failing', async () => {
    stubConfig({ healthy: false });
    const adapter = makeAdapter();

    await adapter.__initReplay();

    expect(adapter.__replayLifecycle?.state).toBe('IDLE');
  });

  it('starts on a later successful refresh without waiting for the periodic tick', async () => {
    const state = { healthy: false };
    stubConfig(state);
    const adapter = makeAdapter();
    await adapter.__initReplay();

    state.healthy = true;
    await adapter.__testRefreshConfigNow();
    await flush();

    expect(adapter.__replayLifecycle?.state).toBe('BUFFERING');
  });

  it('still starts via the periodic tick when nothing else re-resolves config', async () => {
    vi.useFakeTimers();
    const state = { healthy: false };
    stubConfig(state);
    const adapter = makeAdapter();
    await adapter.__initReplay();

    state.healthy = true;
    await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG_TTL_MS);
    await flush();

    expect(adapter.__replayLifecycle?.state).toBe('BUFFERING');
  });

  it('does not start when the server keeps replay off', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes('/api/config')) {
          return new Response(
            JSON.stringify({ replayEnabled: false, replayDurationSec: 30, samplingRate: 1 }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    const adapter = makeAdapter();

    await adapter.__initReplay();
    await adapter.__testRefreshConfigNow();
    await flush();

    expect(adapter.__replayLifecycle?.state).toBe('IDLE');
  });
});
