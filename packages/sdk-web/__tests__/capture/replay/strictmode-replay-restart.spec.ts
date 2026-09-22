// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
// @vitest-environment jsdom
//
// Codex round-5 finding 2 (P1) — the remount got its recorder back and never
// started recording again.
//
// Round 4 made `ReplayRecorder.kill()` revivable, and stopped there: `revive()`
// cleared the consent latch and, by its own comment, restarted nothing, on the
// reasoning that the next `start()` rebuilds the buffer. There is no next
// `start()` when replay was already running. `kill()` never tells the sdk-core
// lifecycle anything, so a recorder killed while BUFFERING leaves the lifecycle
// in BUFFERING — and `tryStart()` is a guarded no-op in every state but IDLE.
// The committed mount was left with a lifecycle certain it was recording and a
// recorder holding no buffer and no rrweb handle: the next report froze an
// absent window and shipped WITHOUT a replay, and only completing or cancelling
// that report ever armed one again. React Fast Refresh, or any effect
// teardown/remount after replay had started, was enough.
//
// The spec round 4 left behind could not see any of that: it mocked the
// recorder wholesale and asserted that `kill()` and `revive()` had been called,
// explicitly accepting the missing restart. So this one runs the REAL recorder
// (with only rrweb and gzip doubled) behind the REAL adapter and the REAL
// lifecycle, and asserts on recording state and on a shippable capture —
// the two things the field bug was about.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';

/** A controllable rrweb: counts `record()` calls and hands back a live emit. */
interface FakeRrweb {
  recordCalls: number;
  stops: number[];
  fire: (ts: number, type?: number) => void;
}
const rrweb: FakeRrweb & { reset: () => void } = {
  recordCalls: 0,
  stops: [],
  fire: () => undefined,
  reset: () => {
    rrweb.recordCalls = 0;
    rrweb.stops.length = 0;
    rrweb.fire = () => undefined;
  },
};

const importRrweb = async (): Promise<{
  record: (o: Record<string, unknown>) => () => void;
}> => ({
  record: (options: Record<string, unknown>) => {
    const id = ++rrweb.recordCalls;
    const emit = options['emit'] as (e: unknown, isCheckout?: boolean) => void;
    rrweb.fire = (ts: number, type = 2): void => {
      emit({ type, timestamp: ts, data: {} }, type === 2);
    };
    return () => rrweb.stops.push(id);
  },
});

const testGzip = async (input: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(gzipSync(Buffer.from(input)));

// The REAL recorder, with only its two injectable edges doubled. Everything the
// adapter and the lifecycle drive — the latches, the buffer, the freeze cutoff,
// the anchor rule — is the shipped code.
const recorders: unknown[] = [];

vi.mock('../../../src/capture/replay/index.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/capture/replay/index.js')>();
  return {
    ...actual,
    createReplayRecorder: (deps: Record<string, unknown> = {}) => {
      const rec = actual.createReplayRecorder({ ...deps, importRrweb, gzip: testGzip });
      recorders.push(rec);
      return rec;
    },
  };
});

import type { ReplayRecorder } from '../../../src/capture/replay/recorder.js';
import { createWebPlatformAdapter, type WebPlatformAdapter } from '../../../src/adapter.js';

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/** /api/config answering replay ON at full sampling — the lifecycle says "go". */
function stubConfigOn(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (urlOf(input).includes('/api/config')) {
        return new Response(
          JSON.stringify({ replayEnabled: true, replayDurationSec: 30, samplingRate: 1 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

const adapters: WebPlatformAdapter[] = [];
function makeAdapter(): WebPlatformAdapter {
  const adapter = createWebPlatformAdapter({ apiKey: 'pk_test' });
  adapters.push(adapter);
  return adapter;
}

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/**
 * Is rrweb actually recording right now, as the recorder itself reports it?
 * `recording` is `stopFn !== null` — rrweb loaded and its stop handle held —
 * which is the state the round-4 spec's mocked `kill`/`revive` counters could
 * not see.
 */
function recording(): boolean {
  return (recorders[recorders.length - 1] as ReplayRecorder).__diagnostics().recording;
}

beforeEach(() => {
  recorders.length = 0;
  rrweb.reset();
  stubConfigOn();
});

afterEach(() => {
  while (adapters.length) adapters.pop()!.__testCleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a StrictMode remount gets a RECORDING window back, not just permission', () => {
  it('LIVE control: a plain mount is buffering AND recording', async () => {
    const adapter = makeAdapter();

    await adapter.__initReplay();
    await flush();

    expect(adapter.__replayLifecycle?.state).toBe('BUFFERING');
    expect(recording()).toBe(true);
    expect(rrweb.recordCalls).toBe(1);
  });

  it('records again after a teardown/remount of an ALREADY-buffering window', async () => {
    // The finding's exact trigger: replay is up before the cleanup runs, so
    // the lifecycle is BUFFERING when the kill lands and stays BUFFERING
    // afterwards — nothing tells it otherwise, and nothing may.
    const adapter = makeAdapter();
    await adapter.__initReplay();
    await flush();
    expect(recording()).toBe(true);

    adapter.onKill?.(); // provider.tsx cleanup → client.kill()
    expect(recording()).toBe(false); // round 3: the observers really stop

    adapter.__rebindCrumbHooks(); // remount
    await adapter.__initReplay(); // remount's second effect — a no-op here
    await flush();

    // The lifecycle never left BUFFERING, so `tryStart()` refused (correctly);
    // the recorder is what had to come back on its own.
    expect(adapter.__replayLifecycle?.state).toBe('BUFFERING');
    expect(recording()).toBe(true);
    expect(rrweb.recordCalls).toBe(2);
  });

  it("the committed mount's next report actually carries a replay", async () => {
    // What the missing restart cost in the field, stated as the user-visible
    // outcome: the report ships with no replay attached.
    const adapter = makeAdapter();
    await adapter.__initReplay();
    await flush();

    adapter.onKill?.();
    adapter.__rebindCrumbHooks();
    await flush();

    // The user goes on using the page after the remount.
    rrweb.fire(1_000, 2); // FullSnapshot — a window with no anchor is unplayable
    rrweb.fire(1_100, 3);

    adapter.__replayLifecycle?.freeze(); // reporter opens
    const capture = await adapter.__replayLifecycle?.complete();

    expect(capture).not.toBeNull();
    expect(capture!.bytes.byteLength).toBeGreaterThan(0);
  });

  it('a genuine kill still ships no replay — the consent switch is unchanged', async () => {
    // The half that must NOT come back. `revive()` is reachable only from
    // `__rebindCrumbHooks()`, which a host that pulled the switch never calls.
    const adapter = makeAdapter();
    await adapter.__initReplay();
    await flush();

    adapter.onKill?.();
    await flush();

    rrweb.fire(2_000, 2);
    adapter.__replayLifecycle?.freeze();
    const capture = await adapter.__replayLifecycle?.complete();

    expect(recording()).toBe(false);
    expect(capture ?? null).toBeNull();
    expect(rrweb.recordCalls).toBe(1);
  });

  it('a remount after an IDLE kill arms the window the ordinary way', async () => {
    // Nothing was running when the kill landed, so there is nothing to put
    // back: the revived recorder stays idle until the lifecycle's own
    // `tryStart()` opens a window. This is the path round 4 covered, and the
    // restart above must not pre-empt it.
    const adapter = makeAdapter();

    adapter.onKill?.(); // kill BEFORE any replay start
    adapter.__rebindCrumbHooks();
    expect(recording()).toBe(false);
    expect(rrweb.recordCalls).toBe(0);

    await adapter.__initReplay();
    await flush();

    expect(adapter.__replayLifecycle?.state).toBe('BUFFERING');
    expect(recording()).toBe(true);
    expect(rrweb.recordCalls).toBe(1);
  });
});
