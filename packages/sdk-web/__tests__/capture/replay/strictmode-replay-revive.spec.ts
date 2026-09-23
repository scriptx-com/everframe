// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
// @vitest-environment jsdom
//
// Codex round-4 finding 2 (P1) — React StrictMode permanently disabled session
// replay, and it took TWO latches to do it.
//
// `EverframeProvider`'s unmount cleanup calls `client.kill()`. StrictMode (the
// Next.js dev default) simulates an unmount by running every effect cleanup and
// then every effect again against the SAME client and adapter — so that kill
// lands on a Provider that is about to go on living. Round 3 made `onKill()`
// call `ReplayRecorder.kill()`, which was terminal; and `attemptReplayStart()`
// was gated on the never-reset `killed`. Between them, the committed mount
// never armed a replay window and every report it filed shipped without one.
//
// Both halves are fixed the way round 2 fixed `reportingKilled`: revivable
// through `__rebindCrumbHooks()`, the seam that means "a live host mount owns
// this adapter" and which a host that genuinely pulled the consent switch never
// calls. This spec drives the real StrictMode ORDER (mount → cleanup → mount)
// against the real adapter, with the recorder doubled so the two calls that
// matter — `kill()` and `revive()` — are observable, and the config endpoint
// stubbed ON so the lifecycle actually wants to start.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface RecorderDouble {
  start: ReturnType<typeof vi.fn>;
  freeze: ReturnType<typeof vi.fn>;
  discardAndResume: ReturnType<typeof vi.fn>;
  takeFrozen: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  revive: ReturnType<typeof vi.fn>;
  disabled: boolean;
  __size: number;
  __diagnostics: ReturnType<typeof vi.fn>;
}

const recorders: RecorderDouble[] = [];

vi.mock('../../../src/capture/replay/index.js', () => ({
  createReplayRecorder: () => {
    const rec: RecorderDouble = {
      start: vi.fn(),
      freeze: vi.fn(),
      discardAndResume: vi.fn(),
      takeFrozen: vi.fn().mockResolvedValue(null),
      stop: vi.fn(),
      kill: vi.fn(),
      revive: vi.fn(),
      disabled: false,
      __size: 0,
      __diagnostics: vi.fn(),
    };
    recorders.push(rec);
    return rec;
  },
}));

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

beforeEach(() => {
  stubConfigOn();
});

afterEach(() => {
  while (adapters.length) adapters.pop()!.__testCleanup();
  recorders.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('replay survives a StrictMode remount', () => {
  it('LIVE control: a plain mount arms the window', async () => {
    const adapter = makeAdapter();

    await adapter.__initReplay();
    await flush();

    expect(recorders).toHaveLength(1);
    expect(recorders[0]!.start).toHaveBeenCalled();
    expect(adapter.__replayLifecycle?.state).toBe('BUFFERING');
  });

  it('arms the window again after kill → rebind → init (the StrictMode order)', async () => {
    const adapter = makeAdapter();
    const rec = recorders[0]!;

    // Mount pass 1: the effect fires `__initReplay()`, whose /api/config fetch
    // is still in flight when React tears the tree back down.
    const pass1 = adapter.__initReplay();
    // Simulated unmount: provider.tsx's cleanup → client.kill() → onKill().
    adapter.onKill?.();
    // Remount, in provider.tsx's effect order — the rebind effect is declared
    // before the `__initReplay()` effect, so the revive lands first.
    adapter.__rebindCrumbHooks();
    const pass2 = adapter.__initReplay();
    await Promise.all([pass1, pass2]);
    await flush();

    expect(rec.kill).toHaveBeenCalledTimes(1);
    // Half one: the recorder's consent latch was cleared by the live mount…
    expect(rec.revive).toHaveBeenCalledTimes(1);
    // …half two: and `attemptReplayStart()` no longer refuses on the never-
    // reset `killed`, so the committed mount actually gets a window. Both are
    // required — this assertion is red if either regresses.
    expect(rec.start).toHaveBeenCalled();
    expect(adapter.__replayLifecycle?.state).toBe('BUFFERING');
  });

  it('a genuine kill still holds: no rebind, no revive, no window', async () => {
    // The consent case. `kill()` WITHOUT a remount is exactly what withdrawing
    // consent looks like — the host wants the SDK mounted and inert — and
    // nothing here may hand the recorder back.
    const adapter = makeAdapter();
    const rec = recorders[0]!;

    adapter.onKill?.();
    await adapter.__initReplay();
    await adapter.__testRefreshConfigNow();
    await flush();

    expect(rec.revive).not.toHaveBeenCalled();
    expect(rec.start).not.toHaveBeenCalled();
    expect(adapter.__replayLifecycle?.state).toBe('IDLE');
  });

  // The other StrictMode shape — a kill landing on an ALREADY-BUFFERING window
  // — is NOT covered here, deliberately.
  //
  // A case for it lived here through round 4 and asserted only that the mocked
  // `kill()` and `revive()` had been called, with a comment accepting that
  // nothing restarted. Codex round 5 (finding 2) found the bug it was written
  // over: with the lifecycle stuck in BUFFERING, `tryStart()` refuses and the
  // revived recorder never records again, so the next report ships without a
  // replay. The case could not have failed on that, because a recorder double
  // has no recording state to observe and the fix lives INSIDE the recorder,
  // where this file's whole-module mock cannot see it.
  //
  // It is not replaced with a weaker assertion here. It moved, with real
  // recording state and a real shippable capture, to
  // `strictmode-replay-restart.spec.ts`, which runs the shipped recorder behind
  // this same adapter with only rrweb and gzip doubled.

  it('survives a recorder whose revive() throws (DEFE-02)', () => {
    const adapter = makeAdapter();
    recorders[0]!.revive.mockImplementation(() => {
      throw new Error('recorder blew up');
    });

    expect(() => adapter.__rebindCrumbHooks()).not.toThrow();
  });
});
