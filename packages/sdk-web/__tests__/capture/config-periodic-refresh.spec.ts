// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Round-4 review Finding F18 (P1) — web has no live config re-read, so the
// remote kill switch can't disable capture.
//
// Before this fix, the web adapter called `provider.refresh()` exactly once
// from `__initReplay()` and installed no periodic refresh: once a session
// resolved `captureBodies:true`, the dashboard kill switch could never turn
// capture off again until the page remounted/reloaded. Fixed by mirroring
// iOS's forced periodic re-read (7a047bdd, ac39a9c9 F4/F5):
//   - a periodic FORCED refresh at the same 300s cadence as the config TTL
//     (DEFAULT_CONFIG_TTL_MS), owned by the adapter and started once from
//     __initReplay();
//   - `ConfigProvider.refresh()` now returns a success/freshness boolean; a
//     FAILED periodic read fails ONLY the network-body gate closed
//     (`bodyGateFailedClosed`), leaving replay/breadcrumb config at their
//     ordinary last-good semantics;
//   - the interval is cancelled by `onKill()` (F17's kill seam) and by
//     `__testCleanup()`, so it can never leak across kills/remounts/tests;
//   - the interval never re-arms after kill (composes with F17), and a
//     re-read never re-draws the one-shot sampling decision (createSessionSampler
//     already memoizes — this suite pins that it survives a live re-read too).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createClient, __internalClientState, DEFAULT_CONFIG_TTL_MS } from '@everframe/sdk-core';
import { createWebPlatformAdapter, type WebPlatformAdapter } from '../../src/adapter.js';

const adapters: WebPlatformAdapter[] = [];
afterEach(() => {
  while (adapters.length) adapters.pop()!.__testCleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function configResponse(opts: { captureBodies: boolean; replayEnabled?: boolean }): Response {
  return new Response(
    JSON.stringify({
      replayEnabled: opts.replayEnabled ?? true,
      replayDurationSec: 30,
      samplingRate: 1,
      networkBodies: { captureBodies: opts.captureBodies },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** Advance the fake clock by one full periodic-refresh tick, flushing the
 * async tick's own microtasks along the way. */
async function advanceOneTick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG_TTL_MS);
  await flushMicrotasks();
}

describe('F18: periodic config re-read (web kill-switch parity)', () => {
  it('a periodic re-read picks up captureBodies flipping true → false and disables capture', async () => {
    vi.useFakeTimers();
    let captureBodies = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (urlOf(input).includes('/api/config')) return configResponse({ captureBodies });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createWebPlatformAdapter({ apiKey: 'k' });
    adapters.push(adapter);
    const client = createClient(adapter);
    client.init({ apiKey: 'k' });
    adapter.__setNetworkBodiesBuffer(() => __internalClientState.get(client)?.networkBodies);
    const buf = () => __internalClientState.get(client)!.networkBodies;

    await adapter.__initReplay();
    await fetch('https://api.test/a');
    await flushMicrotasks();
    expect(buf().size).toBe(1); // ON initially

    captureBodies = false; // dashboard kill switch flips
    await advanceOneTick(); // the periodic re-read must pick this up

    await fetch('https://api.test/b');
    await flushMicrotasks();
    expect(buf().size).toBe(1); // unchanged — the second request was NOT captured
  });

  it('a failed periodic re-read fails the body gate CLOSED while leaving replay config at last-good', async () => {
    vi.useFakeTimers();
    let configCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (urlOf(input).includes('/api/config')) {
        configCalls += 1;
        if (configCalls === 1) return configResponse({ captureBodies: true, replayEnabled: true });
        return new Response('', { status: 503 }); // every periodic tick fails from here on
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createWebPlatformAdapter({ apiKey: 'k' });
    adapters.push(adapter);
    const client = createClient(adapter);
    client.init({ apiKey: 'k' });
    adapter.__setNetworkBodiesBuffer(() => __internalClientState.get(client)?.networkBodies);
    const buf = () => __internalClientState.get(client)!.networkBodies;

    await adapter.__initReplay();
    expect(adapter.__replayLifecycle?.state).toBe('BUFFERING'); // replay started (replayEnabled:true, rate 1)

    await fetch('https://api.test/a');
    await flushMicrotasks();
    expect(buf().size).toBe(1);

    await advanceOneTick(); // periodic re-read fails (503)

    await fetch('https://api.test/b');
    await flushMicrotasks();
    expect(buf().size).toBe(1); // body gate failed CLOSED — second request not captured

    // Replay config is UNTOUCHED by the failed body-gate-only fail-close —
    // it keeps its last-good state, same as before this fix existed.
    expect(adapter.__replayLifecycle?.state).toBe('BUFFERING');

    // And a SUBSEQUENT successful re-read recovers capture (the fail-closed
    // posture is per-tick, not sticky forever).
    configCalls = 0; // next tick's increment brings it to 1 — behaves like call #1 again (200, captureBodies:true)
    await advanceOneTick();
    await fetch('https://api.test/c');
    await flushMicrotasks();
    expect(buf().size).toBe(2);
  });

  it('a successful wake refresh (refreshGate) resets the body fail-closed latch, not just the next periodic tick', async () => {
    // Codex round-2 fix — the successful periodic branch above resets
    // `bodyGateFailedClosed = false` before re-applying live config; the
    // successful `refreshGate` branch (threads.wake(), sdk-core
    // thread-client.ts) calls `applyLiveConfig()` too (Codex round-1 fix C)
    // but never reset the latch, so a failed periodic refresh left bodies
    // disabled for up to PERIODIC_REFRESH_MS even after a successful wake
    // refresh reconfirmed a live, ON config. Threads a real ThreadClient
    // through `client.init()` (rather than driving `refreshGate` directly,
    // which isn't part of the adapter's public surface) and calls
    // `threads.wake()`, mirroring provider-wake-refresh-gate.spec.tsx.
    vi.useFakeTimers();
    let configCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.includes('/api/config')) {
        configCalls += 1;
        if (configCalls === 1) return configResponse({ captureBodies: true, replayEnabled: true });
        return new Response('', { status: 503 }); // every periodic tick fails from here on
      }
      if (url.includes('/api/reporter/threads')) {
        return new Response(JSON.stringify({ threads: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createWebPlatformAdapter({ apiKey: 'k' });
    adapters.push(adapter);
    const client = createClient(adapter);
    client.init({ apiKey: 'k' });
    adapter.__setNetworkBodiesBuffer(() => __internalClientState.get(client)?.networkBodies);
    const buf = () => __internalClientState.get(client)!.networkBodies;

    await adapter.__initReplay();
    await fetch('https://api.test/a');
    await flushMicrotasks();
    expect(buf().size).toBe(1);

    await advanceOneTick(); // periodic re-read fails (503) — sets the latch
    await fetch('https://api.test/b');
    await flushMicrotasks();
    expect(buf().size).toBe(1); // body gate failed CLOSED

    expect(adapter.threads).toBeDefined();

    // Next config fetch (the wake()-triggered refreshGate call) succeeds —
    // mirrors the "next config call resolves the same as call #1 again"
    // setup the periodic-recovery test above uses.
    configCalls = 0;
    adapter.threads!.wake();
    await flushMicrotasks(20);

    await fetch('https://api.test/c');
    await flushMicrotasks();
    expect(
      buf().size,
    ).toBe(2); // recovered immediately via the successful wake refresh, not the next periodic tick
  });

  it('the periodic interval is cancelled by kill() — no further config fetches after kill', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (urlOf(input).includes('/api/config')) return configResponse({ captureBodies: true });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createWebPlatformAdapter({ apiKey: 'k' });
    adapters.push(adapter);
    const client = createClient(adapter);
    client.init({ apiKey: 'k' });

    await adapter.__initReplay();
    const configCallsAfterInit = fetchMock.mock.calls.filter((c) => urlOf(c[0]).includes('/api/config')).length;
    expect(configCallsAfterInit).toBe(1);

    client.kill();

    // Advance well past several would-be periodic ticks. If the interval
    // leaked, this would fire ~5 more config fetches.
    await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG_TTL_MS * 5);
    await flushMicrotasks();

    const configCallsAfterKill = fetchMock.mock.calls.filter((c) => urlOf(c[0]).includes('/api/config')).length;
    expect(configCallsAfterKill).toBe(configCallsAfterInit); // no additional ticks fired
  });

  it('__testCleanup() also cancels the periodic interval (no leak across remounts/tests)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (urlOf(input).includes('/api/config')) return configResponse({ captureBodies: true });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createWebPlatformAdapter({ apiKey: 'k' });
    // Deliberately NOT pushed to `adapters` — we call __testCleanup() ourselves below.
    await adapter.__initReplay();
    const before = fetchMock.mock.calls.filter((c) => urlOf(c[0]).includes('/api/config')).length;

    adapter.__testCleanup();

    await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG_TTL_MS * 3);
    await flushMicrotasks();

    const after = fetchMock.mock.calls.filter((c) => urlOf(c[0]).includes('/api/config')).length;
    expect(after).toBe(before); // interval torn down, no further ticks
  });

  it('a periodic re-read never re-draws the one-shot sampling decision', async () => {
    vi.useFakeTimers();
    // samplingRate:0 initially ⇒ the FIRST (real) draw is sampled OUT and
    // memoized. A later tick raising the rate to 1.0 must NOT re-draw —
    // if it did, capture would incorrectly turn back on.
    let samplingRate = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (urlOf(input).includes('/api/config')) {
        return new Response(
          JSON.stringify({
            replayEnabled: false,
            replayDurationSec: 30,
            samplingRate,
            networkBodies: { captureBodies: true },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createWebPlatformAdapter({ apiKey: 'k' });
    adapters.push(adapter);
    const client = createClient(adapter);
    client.init({ apiKey: 'k' });
    adapter.__setNetworkBodiesBuffer(() => __internalClientState.get(client)?.networkBodies);
    const buf = () => __internalClientState.get(client)!.networkBodies;

    await adapter.__initReplay();
    await fetch('https://api.test/a'); // sampledIn drawn now, rate 0 ⇒ false, memoized
    await flushMicrotasks();
    expect(buf().size).toBe(0);

    samplingRate = 1.0; // server raises the rate — must not trigger a re-draw
    await advanceOneTick();

    await fetch('https://api.test/b');
    await flushMicrotasks();
    expect(buf().size).toBe(0); // still sampled OUT — the memoized decision held
  });
});
