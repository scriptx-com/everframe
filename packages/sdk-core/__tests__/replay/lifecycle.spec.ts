// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// REPLAY-02 — session-replay lifecycle state machine (HIGHEST-LIABILITY GATE).
// Turned RED→GREEN in plan 20-02. Also covers CONFIG-04 (sampling gate) and
// REPLAY-06 (shared session epoch).
//
// State machine (locked, RESEARCH §"Lifecycle state machine"):
//   IDLE → BUFFERING → FROZEN → (SUBMITTED | DISCARDED) → BUFFERING
//   - IDLE→BUFFERING:        config ON + sampling gate passes → start(durationSec)
//   - BUFFERING→FROZEN:      freeze() at top of __openReporter (capture freezeTs first)
//   - FROZEN→SUBMITTED:      onComplete → takeFrozen() → attach → resume start()
//   - FROZEN→DISCARDED:      onCancel → discardAndResume() (zeroize, resume)
//   - Any→DISCARDED (forced): logout / identity change
//   - Idempotency:           open while FROZEN = no-op (never a second buffer)
import { describe, it, expect } from 'vitest';
import { createReplayLifecycle } from '../../src/types/replay/lifecycle.js';
import type { ReplayConfig } from '../../src/types/replay/config-provider.js';
import type { ReplayCapture } from '../../src/types/platform.js';

const ON: ReplayConfig = { replayEnabled: true, replayDurationSec: 30, samplingRate: 1.0 };
const OFF: ReplayConfig = { replayEnabled: false, replayDurationSec: 30, samplingRate: 1.0 };

/** A spy replay adapter that records the call sequence driven by the lifecycle. */
function makeAdapter(capture: ReplayCapture | null = null) {
  const calls: string[] = [];
  let started = 0;
  let discarded = 0;
  return {
    calls,
    get started() {
      return started;
    },
    get discarded() {
      return discarded;
    },
    replay: {
      start(durationSec: number) {
        calls.push(`start:${durationSec}`);
        started += 1;
      },
      freeze() {
        calls.push('freeze');
      },
      discardAndResume() {
        calls.push('discardAndResume');
        discarded += 1;
      },
      async takeFrozen(): Promise<ReplayCapture | null> {
        calls.push('takeFrozen');
        return capture;
      },
      stop() {
        calls.push('stop');
      },
    },
  };
}

describe('REPLAY-02 session-replay lifecycle state machine', () => {
  it('starts IDLE', () => {
    const lc = createReplayLifecycle({ adapter: makeAdapter(), getConfig: () => ON, locallyDisabled: false });
    expect(lc.state).toBe('IDLE');
  });

  it('tryStart with config ON + sampling pass → BUFFERING and calls adapter.start(durationSec)', () => {
    const a = makeAdapter();
    const lc = createReplayLifecycle({ adapter: a, getConfig: () => ON, locallyDisabled: false, random: () => 0 });
    const ok = lc.tryStart();
    expect(ok).toBe(true);
    expect(lc.state).toBe('BUFFERING');
    expect(a.calls).toContain('start:30');
  });

  it('tryStart with config OFF stays IDLE (no buffer)', () => {
    const a = makeAdapter();
    const lc = createReplayLifecycle({ adapter: a, getConfig: () => OFF, locallyDisabled: false, random: () => 0 });
    expect(lc.tryStart()).toBe(false);
    expect(lc.state).toBe('IDLE');
    expect(a.started).toBe(0);
  });

  it('tryStart with locallyDisabled (client veto) stays IDLE even when server is ON', () => {
    const a = makeAdapter();
    const lc = createReplayLifecycle({ adapter: a, getConfig: () => ON, locallyDisabled: true, random: () => 0 });
    expect(lc.tryStart()).toBe(false);
    expect(lc.state).toBe('IDLE');
    expect(a.started).toBe(0);
  });

  it('CONFIG-04: sampling gate below the threshold ⇒ stays IDLE (no buffer for this report)', () => {
    const a = makeAdapter();
    const cfg: ReplayConfig = { replayEnabled: true, replayDurationSec: 30, samplingRate: 0.5 };
    // random() returns 0.9, NOT < 0.5 ⇒ gate fails
    const lc = createReplayLifecycle({ adapter: a, getConfig: () => cfg, locallyDisabled: false, random: () => 0.9 });
    expect(lc.tryStart()).toBe(false);
    expect(lc.state).toBe('IDLE');
    expect(a.started).toBe(0);
  });

  it('CONFIG-04: sampling gate at samplingRate 0 NEVER buffers; at 1 ALWAYS buffers', () => {
    const never = createReplayLifecycle({
      adapter: makeAdapter(),
      getConfig: () => ({ replayEnabled: true, replayDurationSec: 30, samplingRate: 0 }),
      locallyDisabled: false,
      random: () => 0, // 0 < 0 is false
    });
    expect(never.tryStart()).toBe(false);

    const always = createReplayLifecycle({
      adapter: makeAdapter(),
      getConfig: () => ({ replayEnabled: true, replayDurationSec: 30, samplingRate: 1 }),
      locallyDisabled: false,
      random: () => 0.999999,
    });
    expect(always.tryStart()).toBe(true);
  });

  it('CONFIG-04: the sampling gate is evaluated EXACTLY ONCE per tryStart (not per event)', () => {
    let rolls = 0;
    const lc = createReplayLifecycle({
      adapter: makeAdapter(),
      getConfig: () => ON,
      locallyDisabled: false,
      random: () => {
        rolls += 1;
        return 0;
      },
    });
    lc.tryStart();
    expect(rolls).toBe(1);
  });

  it('freeze() BUFFERING→FROZEN and calls adapter.freeze()', () => {
    const a = makeAdapter();
    const lc = createReplayLifecycle({ adapter: a, getConfig: () => ON, locallyDisabled: false, random: () => 0 });
    lc.tryStart();
    lc.freeze();
    expect(lc.state).toBe('FROZEN');
    expect(a.calls).toContain('freeze');
  });

  it('open while FROZEN is a no-op (idempotent — never a second freeze/buffer)', () => {
    const a = makeAdapter();
    const lc = createReplayLifecycle({ adapter: a, getConfig: () => ON, locallyDisabled: false, random: () => 0 });
    lc.tryStart();
    lc.freeze();
    lc.freeze(); // second open while FROZEN
    lc.tryStart(); // tryStart while FROZEN
    const freezeCount = a.calls.filter((c) => c === 'freeze').length;
    expect(freezeCount).toBe(1); // only one freeze ever
    expect(lc.state).toBe('FROZEN');
  });

  it('complete(): FROZEN→SUBMITTED→resume BUFFERING (start again) and returns the capture', async () => {
    const capture: ReplayCapture = {
      format: 'rrweb',
      bytes: new Uint8Array([1, 2, 3]),
      durationMs: 30000,
      contentType: 'application/json',
    };
    const a = makeAdapter(capture);
    const lc = createReplayLifecycle({ adapter: a, getConfig: () => ON, locallyDisabled: false, random: () => 0 });
    lc.tryStart();
    lc.freeze();
    const out = await lc.complete();
    expect(out).toEqual(capture);
    expect(a.calls).toContain('takeFrozen');
    expect(lc.state).toBe('BUFFERING'); // resumed for the next report
    expect(a.started).toBe(2); // initial start + resume
  });

  it('cancel(): FROZEN→DISCARDED→resume BUFFERING (zeroize) via discardAndResume', () => {
    const a = makeAdapter();
    const lc = createReplayLifecycle({ adapter: a, getConfig: () => ON, locallyDisabled: false, random: () => 0 });
    lc.tryStart();
    lc.freeze();
    lc.cancel();
    expect(a.calls).toContain('discardAndResume');
    expect(lc.state).toBe('BUFFERING'); // resumed
  });

  it('open→cancel→open→submit leaves a clean buffer (no carry-over): discard happened before the 2nd freeze', async () => {
    const capture: ReplayCapture = {
      format: 'rrweb',
      bytes: new Uint8Array([9]),
      durationMs: 30000,
      contentType: 'application/json',
    };
    const a = makeAdapter(capture);
    const lc = createReplayLifecycle({ adapter: a, getConfig: () => ON, locallyDisabled: false, random: () => 0 });
    lc.tryStart(); // BUFFERING
    lc.freeze(); // FROZEN
    lc.cancel(); // DISCARDED → BUFFERING (zeroized)
    lc.freeze(); // FROZEN (2nd open)
    await lc.complete(); // SUBMITTED → BUFFERING
    // the discard preceded the 2nd freeze ⇒ no carry-over frames
    expect(a.calls.indexOf('discardAndResume')).toBeLessThan(a.calls.lastIndexOf('freeze'));
    expect(a.discarded).toBe(1);
  });

  it('forceDiscard() from ANY state → DISCARDED then IDLE (logout/identity change), zeroizing', () => {
    const a = makeAdapter();
    const lc = createReplayLifecycle({ adapter: a, getConfig: () => ON, locallyDisabled: false, random: () => 0 });
    lc.tryStart();
    lc.freeze();
    lc.forceDiscard();
    expect(lc.state).toBe('IDLE'); // forced discard returns to IDLE (not auto-resume)
    expect(a.calls).toContain('discardAndResume');
  });

  it('forceDiscard() from BUFFERING also returns to IDLE', () => {
    const a = makeAdapter();
    const lc = createReplayLifecycle({ adapter: a, getConfig: () => ON, locallyDisabled: false, random: () => 0 });
    lc.tryStart();
    lc.forceDiscard();
    expect(lc.state).toBe('IDLE');
  });

  it('REPLAY-06: exposes a stable monotonic sessionEpoch minted at creation', () => {
    let t = 1000;
    const lc = createReplayLifecycle({
      adapter: makeAdapter(),
      getConfig: () => ON,
      locallyDisabled: false,
      now: () => t,
    });
    const epoch = lc.sessionEpoch;
    expect(epoch).toBe(1000);
    t = 5000;
    // epoch is minted once and never drifts as the clock advances
    expect(lc.sessionEpoch).toBe(1000);
  });
});
