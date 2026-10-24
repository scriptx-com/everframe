// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture: while quick capture is armed on a linked or debug
// device with `captureHotkey.replay`, the replay buffer runs even when the
// server has replay off or sampling at 0. `reevaluate()` ends a buffer that
// only forcing started once forcing stops.
import { describe, it, expect } from 'vitest';
import { createReplayLifecycle } from '../../src/types/replay/lifecycle.js';
import type { ReplayConfig } from '../../src/types/replay/config-provider.js';

const ON: ReplayConfig = { replayEnabled: true, replayDurationSec: 30, samplingRate: 1 };
const OFF: ReplayConfig = { replayEnabled: false, replayDurationSec: 30, samplingRate: 1 };

function makeAdapter() {
  const calls: string[] = [];
  return {
    calls,
    count(name: string): number {
      return calls.filter((c) => c === name || c.startsWith(`${name}:`)).length;
    },
    replay: {
      start(durationSec: number) {
        calls.push(`start:${durationSec}`);
      },
      freeze() {
        calls.push('freeze');
      },
      discardAndResume() {
        calls.push('discardAndResume');
      },
      async takeFrozen() {
        calls.push('takeFrozen');
        return null;
      },
      stop() {
        calls.push('stop');
      },
    },
  };
}

describe('forced replay for armed quick capture', () => {
  it('a forced session buffers with replay off on the server and sampling at 0', () => {
    const adapter = makeAdapter();
    const lc = createReplayLifecycle({
      adapter,
      getConfig: () => ({ ...OFF, samplingRate: 0 }),
      locallyDisabled: false,
      forced: () => true,
    });
    expect(lc.tryStart()).toBe(true);
    expect(lc.state).toBe('BUFFERING');
    expect(adapter.calls).toEqual(['start:30']);
  });

  it('the local veto still wins over forcing', () => {
    const adapter = makeAdapter();
    const lc = createReplayLifecycle({
      adapter,
      getConfig: () => OFF,
      locallyDisabled: true,
      forced: () => true,
    });
    expect(lc.tryStart()).toBe(false);
    expect(lc.state).toBe('IDLE');
    expect(adapter.calls).toEqual([]);
  });

  it('a throwing forced() reads as not forced', () => {
    const lc = createReplayLifecycle({
      adapter: makeAdapter(),
      getConfig: () => OFF,
      locallyDisabled: false,
      forced: () => {
        throw new Error('boom');
      },
    });
    expect(lc.tryStart()).toBe(false);
    expect(lc.state).toBe('IDLE');
  });

  it('reevaluate discards a forced buffer once forcing ends', () => {
    const adapter = makeAdapter();
    let forced = true;
    const lc = createReplayLifecycle({
      adapter,
      getConfig: () => OFF,
      locallyDisabled: false,
      forced: () => forced,
    });
    expect(lc.tryStart()).toBe(true);
    lc.reevaluate();
    expect(lc.state).toBe('BUFFERING'); // still forced: untouched
    forced = false;
    lc.reevaluate();
    expect(lc.state).toBe('IDLE');
    expect(adapter.count('discardAndResume')).toBe(1);
    expect(adapter.count('stop')).toBe(1);
    // A second reevaluate in IDLE does nothing.
    lc.reevaluate();
    expect(adapter.count('discardAndResume')).toBe(1);
  });

  it('reevaluate keeps a buffer the sampling gate admitted', () => {
    const adapter = makeAdapter();
    let forced = false;
    const lc = createReplayLifecycle({
      adapter,
      getConfig: () => ON,
      locallyDisabled: false,
      forced: () => forced,
      random: () => 0.5,
    });
    expect(lc.tryStart()).toBe(true);
    forced = false;
    lc.reevaluate();
    expect(lc.state).toBe('BUFFERING');
    expect(adapter.count('discardAndResume')).toBe(0);
  });

  it('a forced buffer the normal gate now admits is kept and becomes a sampled one', () => {
    const adapter = makeAdapter();
    let forced = true;
    let config = OFF;
    const lc = createReplayLifecycle({
      adapter,
      getConfig: () => config,
      locallyDisabled: false,
      forced: () => forced,
      random: () => 0.5,
    });
    expect(lc.tryStart()).toBe(true);
    config = ON;
    forced = false;
    lc.reevaluate();
    expect(lc.state).toBe('BUFFERING');
    // Now sampling owns it: turning the server off later is not a forced stop.
    config = OFF;
    lc.reevaluate();
    expect(lc.state).toBe('BUFFERING');
    expect(adapter.count('discardAndResume')).toBe(0);
  });

  it('a forced buffer whose held draw is above the rate is discarded', () => {
    const adapter = makeAdapter();
    let forced = true;
    const lc = createReplayLifecycle({
      adapter,
      getConfig: () => ({ ...ON, samplingRate: 0.1 }),
      locallyDisabled: false,
      forced: () => forced,
      random: () => 0.5,
    });
    expect(lc.tryStart()).toBe(true);
    forced = false;
    lc.reevaluate();
    expect(lc.state).toBe('IDLE');
  });

  it('reevaluate leaves a FROZEN capture alone, and applies when complete() resumes', async () => {
    const adapter = makeAdapter();
    let forced = true;
    const lc = createReplayLifecycle({
      adapter,
      getConfig: () => OFF,
      locallyDisabled: false,
      forced: () => forced,
    });
    expect(lc.tryStart()).toBe(true);
    lc.freeze();
    forced = false;
    lc.reevaluate();
    expect(lc.state).toBe('FROZEN');
    expect(adapter.count('discardAndResume')).toBe(0);
    await lc.complete();
    // The remembered reevaluation applies at the resume: no new buffer starts.
    expect(lc.state).toBe('IDLE');
    expect(adapter.count('takeFrozen')).toBe(1);
    expect(adapter.count('start')).toBe(1);
    expect(adapter.count('stop')).toBe(1);
  });

  it('a reevaluation remembered during FROZEN applies when cancel() resumes', () => {
    const adapter = makeAdapter();
    let forced = true;
    const lc = createReplayLifecycle({
      adapter,
      getConfig: () => OFF,
      locallyDisabled: false,
      forced: () => forced,
    });
    lc.tryStart();
    lc.freeze();
    forced = false;
    lc.reevaluate();
    lc.cancel();
    expect(lc.state).toBe('IDLE');
    expect(adapter.count('discardAndResume')).toBe(1);
    expect(adapter.count('start')).toBe(1);
    expect(adapter.count('stop')).toBe(1);
  });

  it('a remembered reevaluation keeps buffering when the normal gate now admits the session', async () => {
    const adapter = makeAdapter();
    let forced = true;
    let config = OFF;
    const lc = createReplayLifecycle({
      adapter,
      getConfig: () => config,
      locallyDisabled: false,
      forced: () => forced,
      random: () => 0.5,
    });
    lc.tryStart();
    lc.freeze();
    forced = false;
    lc.reevaluate();
    config = ON;
    await lc.complete();
    expect(lc.state).toBe('BUFFERING');
    expect(adapter.count('stop')).toBe(0);
  });

  it('forcing that comes back before the resume keeps the forced buffer', async () => {
    const adapter = makeAdapter();
    let forced = true;
    const lc = createReplayLifecycle({
      adapter,
      getConfig: () => OFF,
      locallyDisabled: false,
      forced: () => forced,
    });
    lc.tryStart();
    lc.freeze();
    forced = false;
    lc.reevaluate();
    forced = true;
    await lc.complete();
    expect(lc.state).toBe('BUFFERING');
  });

  it('a forced buffer resumed by cancel() is still a forced one', () => {
    const adapter = makeAdapter();
    let forced = true;
    const lc = createReplayLifecycle({
      adapter,
      getConfig: () => OFF,
      locallyDisabled: false,
      forced: () => forced,
    });
    lc.tryStart();
    lc.freeze();
    lc.cancel();
    expect(lc.state).toBe('BUFFERING');
    forced = false;
    lc.reevaluate();
    expect(lc.state).toBe('IDLE');
  });

  it('without forced the lifecycle behaves as before', () => {
    const lc = createReplayLifecycle({
      adapter: makeAdapter(),
      getConfig: () => OFF,
      locallyDisabled: false,
    });
    expect(lc.tryStart()).toBe(false);
    lc.reevaluate();
    expect(lc.state).toBe('IDLE');
  });
});
