// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// CONFIG-04 says the sampling gate is drawn EXACTLY ONCE. It wasn't: every
// `tryStart()` that reached the gate while IDLE re-drew it, so a sampled-out
// session got another chance on each one. Harmless while `tryStart` ran twice
// a session; not harmless once every config resolution retries it (the
// 2026-08-27 replay-start fix), which inflates the effective rate above the
// configured one.
//
// The draw is memoized per session, re-drawn ONLY if the server changes the
// rate — so a genuine config change still applies, and nothing else re-rolls.
import { describe, it, expect, vi } from 'vitest';
import { createReplayLifecycle } from '../../src/types/replay/lifecycle.js';
import type { ReplayConfig } from '../../src/types/replay/config-provider.js';

const noopReplay = {
  start: () => undefined,
  freeze: () => undefined,
  discardAndResume: () => undefined,
  takeFrozen: async () => null,
  stop: () => undefined,
};

function makeLifecycle(config: () => ReplayConfig, random: () => number) {
  return createReplayLifecycle({
    adapter: { replay: noopReplay },
    getConfig: config,
    locallyDisabled: false,
    random,
  });
}

const cfg = (samplingRate: number): ReplayConfig => ({
  replayEnabled: true,
  replayDurationSec: 30,
  samplingRate,
});

describe('sampling gate is drawn once per session', () => {
  it('draws only once across repeated refused starts', () => {
    const random = vi.fn(() => 0.9); // above 0.5 ⇒ sampled out
    const lc = makeLifecycle(() => cfg(0.5), random);

    lc.tryStart();
    lc.tryStart();
    lc.tryStart();

    expect(random).toHaveBeenCalledTimes(1);
  });

  it('keeps a sampled-out session out however often the start is retried', () => {
    const lc = makeLifecycle(() => cfg(0.5), () => 0.9);

    lc.tryStart();
    lc.tryStart();

    expect(lc.state).toBe('IDLE');
  });

  // A SECOND draw on a rate change would compound: sampled out at 0.5 then
  // re-drawn at 0.6 gives a cumulative 0.8 inclusion, not 0.6. One draw held
  // for the session and compared against the live rate gives exactly the rate.
  it('reuses the one draw when the server changes the rate', () => {
    const random = vi.fn(() => 0.9);
    let rate = 0.5;
    const lc = makeLifecycle(() => cfg(rate), random);

    lc.tryStart(); // draw 0.9 vs rate 0.5 ⇒ out
    rate = 0.95; // server widens past the draw
    lc.tryStart();

    expect(random).toHaveBeenCalledTimes(1);
    expect(lc.state).toBe('BUFFERING');
  });

  it('does not admit a session whose draw still exceeds a widened rate', () => {
    let rate = 0.1;
    const lc = makeLifecycle(() => cfg(rate), () => 0.7);

    lc.tryStart();
    rate = 0.5; // widened, but still below the draw
    lc.tryStart();

    expect(lc.state).toBe('IDLE');
  });

  it('still lets a sampled-in session start', () => {
    const lc = makeLifecycle(() => cfg(0.5), () => 0.1);

    expect(lc.tryStart()).toBe(true);
  });

  it('never draws while replay is disabled server-side', () => {
    const random = vi.fn(() => 0.1);
    const lc = makeLifecycle(
      () => ({ replayEnabled: false, replayDurationSec: 30, samplingRate: 1 }),
      random,
    );

    lc.tryStart();

    expect(random).not.toHaveBeenCalled();
  });
});
