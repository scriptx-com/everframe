// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// Codex round-3 finding 2 (P1) — `kill()` / `destroy()` never stopped the
// replay recorder.
//
// `onKill()` flipped `killed`/`reportingKilled` and cancelled the periodic
// config refresh, and `attemptReplayStart()` refuses to open a NEW window once
// killed — but nothing stopped a window already running. With replay enabled,
// withdrawing consent left rrweb's DOM observers serializing every mutation of
// the user's screen for the rest of the page.
//
// The fix is `ReplayRecorder.kill()`, deliberately terminal where `stop()` is
// reversible. That distinction is the whole point and the second half of this
// spec is what pins it: the replay LIFECYCLE restarts the recorder on its own
// initiative (`complete()` and `cancel()` both end in `beginBuffering()` →
// `start()`), and init.ts's `destroy()` runs `unwindOpen()` → `cancel()`
// BEFORE `client.kill()`. A reversible stop would be undone by that ordering.
import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createReplayLifecycle, type ReplayConfig } from '@everframe/sdk-core';
import { createReplayRecorder } from '../../../src/capture/replay/recorder.js';

const testGzip = async (input: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(gzipSync(Buffer.from(input)));

/** A controllable rrweb: counts `record()` calls, records which handles stopped. */
function fakeRrweb() {
  let recordCalls = 0;
  const stops: number[] = [];
  let emit: ((e: unknown, isCheckout?: boolean) => void) | null = null;
  const mod = {
    record: (options: Record<string, unknown>) => {
      const id = ++recordCalls;
      emit = options.emit as (e: unknown, isCheckout?: boolean) => void;
      return () => stops.push(id);
    },
  };
  return {
    importRrweb: async () => mod,
    get recordCalls() {
      return recordCalls;
    },
    stops,
    /** Push a frame the way rrweb's observers would. */
    fire(ts: number, type = 2): void {
      emit?.({ type, timestamp: ts, data: {} }, type === 2);
    },
  };
}

/** Let the recorder's `import()` chain settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('ReplayRecorder.kill() — the consent switch', () => {
  it('LIVE control: a running recorder holds rrweb open and buffers frames', async () => {
    const rrweb = fakeRrweb();
    const rec = createReplayRecorder({ importRrweb: rrweb.importRrweb, gzip: testGzip });

    rec.start(30);
    await settle();
    rrweb.fire(1_000);

    expect(rrweb.recordCalls).toBe(1);
    expect(rrweb.stops).toEqual([]);
    expect(rec.__size).toBe(1);
  });

  it('stops the rrweb observers instead of leaving them recording', async () => {
    const rrweb = fakeRrweb();
    const rec = createReplayRecorder({ importRrweb: rrweb.importRrweb, gzip: testGzip });

    rec.start(30);
    await settle();
    rrweb.fire(1_000);

    rec.kill();

    // The stop handle rrweb handed back was actually invoked — this is the
    // "the user's screen is no longer being read" assertion, and it is the one
    // that was false before the fix.
    expect(rrweb.stops).toEqual([1]);
    // …and the window already captured is zeroized, not merely orphaned.
    expect(rec.__size).toBe(0);
  });

  it('drops any frame that arrives after the switch was pulled', async () => {
    const rrweb = fakeRrweb();
    const rec = createReplayRecorder({ importRrweb: rrweb.importRrweb, gzip: testGzip });

    rec.start(30);
    await settle();
    rec.kill();

    // A real observer callback can outlive its own stop() by a tick.
    rrweb.fire(2_000);

    expect(rec.__size).toBe(0);
    expect(rec.disabled).toBe(true);
  });

  it('refuses to restart — a killed recorder never re-imports rrweb', async () => {
    const rrweb = fakeRrweb();
    const rec = createReplayRecorder({ importRrweb: rrweb.importRrweb, gzip: testGzip });

    rec.start(30);
    await settle();
    rec.kill();

    rec.start(30);
    await settle();
    rrweb.fire(3_000);

    expect(rrweb.recordCalls).toBe(1); // still just the pre-kill one
    expect(rec.__size).toBe(0);
  });

  // The interaction the finding calls out explicitly: `destroy()` while the
  // reporter is open runs `unwindOpen()` → `lifecycle.cancel()`, which
  // discards AND RESUMES, and only then `client.kill()`. If teardown used the
  // reversible `stop()`, the resume would have restarted the observers.
  it('survives the destroy-while-open ordering (cancel resumes, then kill)', async () => {
    const rrweb = fakeRrweb();
    const rec = createReplayRecorder({ importRrweb: rrweb.importRrweb, gzip: testGzip });
    const config: ReplayConfig = {
      replayEnabled: true,
      replayDurationSec: 30,
      samplingRate: 1,
    } as ReplayConfig;
    const lifecycle = createReplayLifecycle({
      adapter: { replay: rec },
      getConfig: () => config,
      locallyDisabled: false,
      random: () => 0,
    });

    lifecycle.tryStart(); // BUFFERING
    await settle();
    lifecycle.freeze(); // the reporter opened
    lifecycle.cancel(); // unwindOpen(): discard + resume
    await settle();
    const callsAfterResume = rrweb.recordCalls;

    rec.kill(); // client.kill() → adapter.onKill()

    // Whatever the resume started is stopped…
    expect(rrweb.stops.length).toBe(callsAfterResume);
    // …and the lifecycle can no longer restart it. This is the half a
    // reversible `stop()` would fail: the lifecycle drives `start()` itself on
    // every later open/discard, so teardown that merely released the observers
    // would hand them straight back.
    lifecycle.forceDiscard(); // → IDLE
    expect(lifecycle.tryStart()).toBe(true); // the LIFECYCLE still says "go"…
    await settle();
    expect(rrweb.recordCalls).toBe(callsAfterResume); // …and the RECORDER refuses
    rrweb.fire(4_000);
    expect(rec.__size).toBe(0);
  });
});

// Codex round-4 finding 2 (P1) — the latch above was TERMINAL, and that broke
// React.
//
// `EverframeProvider`'s unmount cleanup calls `client.kill()`, and React
// StrictMode (the Next.js dev default) simulates an unmount by running every
// effect cleanup and then every effect again against the SAME client. So the
// kill above lands on a Provider that is about to go on living: with an
// unclearable latch, session replay was dead for the rest of the page in every
// React dev environment, and every report from the committed mount shipped
// without one.
//
// `revive()` is the answer, and it is the SAME shape round 2 used for the
// adapter's `reportingKilled`: only `__rebindCrumbHooks()` calls it, and that
// seam means "a live host mount owns this adapter" — a genuine `kill()` is
// never followed by one. The self-disable latch is deliberately NOT revivable:
// it is a performance verdict the recorder reached about this page, and a
// remount is no evidence against it.
describe('ReplayRecorder.revive() — the StrictMode remount', () => {
  it('DISCRIMINATOR: without a revive, a killed recorder stays dead across a restart', async () => {
    const rrweb = fakeRrweb();
    const rec = createReplayRecorder({ importRrweb: rrweb.importRrweb, gzip: testGzip });

    rec.start(30);
    await settle();
    rec.kill();

    rec.start(30); // the remount's `__initReplay()` → lifecycle.tryStart()
    await settle();
    rrweb.fire(1_000);

    expect(rrweb.recordCalls).toBe(1);
    expect(rec.__size).toBe(0);
    expect(rec.disabled).toBe(true);
  });

  it('records again after kill → revive → start (the StrictMode sequence)', async () => {
    const rrweb = fakeRrweb();
    const rec = createReplayRecorder({ importRrweb: rrweb.importRrweb, gzip: testGzip });

    rec.start(30); // mount pass 1
    await settle();
    rec.kill(); // simulated unmount: provider cleanup → client.kill()
    rec.revive(); // remount: __rebindCrumbHooks()
    rec.start(30); // remount: __initReplay() → tryStart()
    await settle();
    rrweb.fire(2_000);

    // rrweb was re-imported and re-started, and the frames the committed mount
    // produces are being buffered again — which is the whole claim.
    expect(rrweb.recordCalls).toBe(2);
    expect(rec.__size).toBe(1);
    expect(rec.disabled).toBe(false);
  });

  it('freeze/takeFrozen work again after a revive — a revived window is shippable', async () => {
    const rrweb = fakeRrweb();
    const rec = createReplayRecorder({ importRrweb: rrweb.importRrweb, gzip: testGzip });

    rec.kill();
    rec.revive();
    rec.start(30);
    await settle();
    rrweb.fire(1_000, 2); // FullSnapshot — a window with no anchor is unplayable
    rrweb.fire(1_100, 3);

    rec.freeze();
    const capture = await rec.takeFrozen();

    expect(capture).not.toBeNull();
    expect(capture!.bytes.byteLength).toBeGreaterThan(0);
  });

  it('a revive with no kill is a no-op (never a way to undo a self-disable)', async () => {
    // The hostile-page path: a cap breach with no `takeFullSnapshot` to
    // re-anchor with self-disables permanently. `revive()` must not hand that
    // page's recorder back — this is what keeps the two latches distinct.
    let emit: ((e: unknown, isCheckout?: boolean) => void) | undefined;
    const rec = createReplayRecorder({
      importRrweb: async () => ({
        record: (o: Record<string, unknown>) => {
          emit = o['emit'] as typeof emit;
          return () => undefined;
        },
      }),
      gzip: testGzip,
    });

    rec.start(30);
    await settle();
    emit!({ type: 2, timestamp: 0, data: {} }, true);
    for (let i = 1; i <= 5; i++) {
      emit!({ type: 3, timestamp: i, data: { blob: 'x'.repeat(1_000_000) } });
    }
    expect(rec.disabled).toBe(true);

    rec.revive();

    expect(rec.disabled).toBe(true);
  });

  // Codex round-5 finding 2 (P1) — round 4's revive restored PERMISSION and
  // nothing else, and there was no `start()` coming to use it: `kill()` never
  // tells the sdk-core lifecycle anything, so a recorder killed while BUFFERING
  // leaves it in BUFFERING, where `tryStart()` is a guarded no-op. The four
  // cases below pin the restart and the three shapes that must NOT restart.
  it('restarts the window kill() closed, with no start() call of its own', async () => {
    const rrweb = fakeRrweb();
    const rec = createReplayRecorder({ importRrweb: rrweb.importRrweb, gzip: testGzip });

    rec.start(30);
    await settle();
    rec.kill();
    rec.revive(); // __rebindCrumbHooks(), and NOTHING else — no tryStart follows
    await settle();
    rrweb.fire(1_000);

    expect(rrweb.recordCalls).toBe(2);
    expect(rec.__diagnostics().recording).toBe(true);
    expect(rec.__size).toBe(1);
  });

  it('restarts at the duration the killed window was running at', async () => {
    const rrweb = fakeRrweb();
    const rec = createReplayRecorder({ importRrweb: rrweb.importRrweb, gzip: testGzip });

    rec.start(5); // a server config of 5s, not the 30s default
    await settle();
    rec.kill();
    rec.revive();
    await settle();
    // Two anchors and a late frame. The rolling window prunes back to the
    // newest full snapshot at or before `now - durationSec`, so with 5s the
    // second anchor becomes the oldest retained frame; with the 30s default
    // (or an unset duration) nothing would be pruned at all.
    rrweb.fire(0, 2);
    rrweb.fire(3_000, 2);
    rrweb.fire(9_000, 3);

    expect(rec.__diagnostics().oldestTs).toBe(3_000);
  });

  it('a kill with nothing running restarts nothing', async () => {
    // The IDLE shape round 4 covered: there is no window to put back, and the
    // lifecycle's own `tryStart()` owns arming the first one.
    const rrweb = fakeRrweb();
    const rec = createReplayRecorder({ importRrweb: rrweb.importRrweb, gzip: testGzip });

    rec.kill();
    rec.revive();
    await settle();

    expect(rrweb.recordCalls).toBe(0);
    expect(rec.__diagnostics().recording).toBe(false);
  });

  it('does not re-open a FROZEN window', async () => {
    // A rolling buffer re-opened under a FROZEN lifecycle would admit
    // post-kill frames into a capture whose freeze cutoff no longer bounds
    // them. The report that owned the frozen window is over either way.
    const rrweb = fakeRrweb();
    const rec = createReplayRecorder({ importRrweb: rrweb.importRrweb, gzip: testGzip });

    rec.start(30);
    await settle();
    rec.freeze();
    rec.kill();
    rec.revive();
    await settle();

    expect(rrweb.recordCalls).toBe(1);
    expect(rec.__diagnostics().recording).toBe(false);
  });

  it('a second kill does not erase the window the first one closed', async () => {
    // `kill()` is idempotent-safe by contract (onKill can run twice). The
    // second call finds the buffer already released, and must not conclude
    // that nothing was running.
    const rrweb = fakeRrweb();
    const rec = createReplayRecorder({ importRrweb: rrweb.importRrweb, gzip: testGzip });

    rec.start(30);
    await settle();
    rec.kill();
    rec.kill();
    rec.revive();
    await settle();

    expect(rrweb.recordCalls).toBe(2);
    expect(rec.__diagnostics().recording).toBe(true);
  });

  it('a genuine kill still holds: no rebind, no revive, no recording', async () => {
    // The consent case the revive must not weaken. `revive()` is reachable
    // ONLY from `__rebindCrumbHooks()`, which a host that pulled the switch
    // never calls — so this is the same terminal behaviour as before.
    const rrweb = fakeRrweb();
    const rec = createReplayRecorder({ importRrweb: rrweb.importRrweb, gzip: testGzip });

    rec.start(30);
    await settle();
    rec.kill();

    rec.start(30);
    rec.freeze();
    await settle();
    rrweb.fire(5_000);

    expect(rrweb.recordCalls).toBe(1);
    expect(rec.__size).toBe(0);
    expect(await rec.takeFrozen()).toBeNull();
  });
});
