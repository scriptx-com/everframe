// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Crash-only sessions (spec 2026-10-12). A session with the reporter turned
// off samples replay against `crashOnlySamplingRate` instead of
// `samplingRate`; a companion bond upgrades it to the report rate for the rest
// of the session. One held draw serves both kinds, so the upgrade compares
// the same number against the new rate.
import { describe, it, expect, vi } from 'vitest';
import {
  createReplayLifecycle,
  replaySamplingRate,
  type ReplaySessionKind,
} from '../../src/types/replay/lifecycle.js';
import { ReplayConfigResponse, type ReplayConfig } from '../../src/types/replay/config-provider.js';

function makeReplay() {
  const calls: string[] = [];
  return {
    calls,
    replay: {
      start: (durationSec: number) => {
        calls.push(`start:${durationSec}`);
      },
      freeze: () => {
        calls.push('freeze');
      },
      discardAndResume: () => {
        calls.push('discardAndResume');
      },
      takeFrozen: async () => null,
      stop: () => {
        calls.push('stop');
      },
    },
  };
}

const cfg = (samplingRate: number, crashOnlySamplingRate?: number): ReplayConfig => ({
  replayEnabled: true,
  replayDurationSec: 30,
  samplingRate,
  ...(crashOnlySamplingRate !== undefined ? { crashOnlySamplingRate } : {}),
});

describe('replaySamplingRate', () => {
  it('uses samplingRate for a report session', () => {
    expect(replaySamplingRate(cfg(0.4, 0.1), 'report')).toBe(0.4);
  });

  it('uses crashOnlySamplingRate for a crash-only session', () => {
    expect(replaySamplingRate(cfg(1, 0.05), 'crashOnly')).toBe(0.05);
  });

  it('treats an absent crash-only rate as 0 (older server)', () => {
    expect(replaySamplingRate(cfg(1), 'crashOnly')).toBe(0);
  });
});

describe('per-kind replay sampling', () => {
  function wire(config: () => ReplayConfig, kind: () => ReplaySessionKind, random: () => number) {
    const r = makeReplay();
    const lc = createReplayLifecycle({
      adapter: { replay: r.replay },
      getConfig: config,
      locallyDisabled: false,
      sessionKind: kind,
      random,
    });
    return { lc, calls: r.calls };
  }

  it('defaults to the report rate when no session kind is given', () => {
    const r = makeReplay();
    const lc = createReplayLifecycle({
      adapter: { replay: r.replay },
      getConfig: () => cfg(1, 0),
      locallyDisabled: false,
      random: () => 0.5,
    });
    expect(lc.tryStart()).toBe(true);
  });

  it('a crash-only session at the default rate never records, even with the lowest draw', () => {
    const { lc, calls } = wire(() => cfg(1), () => 'crashOnly', () => 0);
    expect(lc.tryStart()).toBe(false);
    expect(lc.state).toBe('IDLE');
    expect(calls).toEqual([]);
  });

  it('a crash-only session records when its draw is under crashOnlySamplingRate', () => {
    const { lc } = wire(() => cfg(1, 0.05), () => 'crashOnly', () => 0.03);
    expect(lc.tryStart()).toBe(true);
    expect(lc.state).toBe('BUFFERING');
  });

  it('a crash-only session ignores samplingRate', () => {
    const { lc } = wire(() => cfg(1, 0.05), () => 'crashOnly', () => 0.5);
    expect(lc.tryStart()).toBe(false);
  });

  it('an upgrade starts recording against samplingRate with the same draw', () => {
    const random = vi.fn(() => 0.3);
    let kind: ReplaySessionKind = 'crashOnly';
    const { lc } = wire(() => cfg(0.5, 0), () => kind, random);

    expect(lc.tryStart()).toBe(false);
    kind = 'report';
    expect(lc.tryStart()).toBe(true);

    expect(random).toHaveBeenCalledTimes(1);
    expect(lc.state).toBe('BUFFERING');
  });

  it('an upgrade whose draw is above samplingRate stays off', () => {
    let kind: ReplaySessionKind = 'crashOnly';
    const { lc } = wire(() => cfg(0.5, 0), () => kind, () => 0.7);
    lc.tryStart();
    kind = 'report';
    expect(lc.tryStart()).toBe(false);
    expect(lc.state).toBe('IDLE');
  });

  it('an upgrade never stops or restarts a recording that is running', () => {
    let kind: ReplaySessionKind = 'crashOnly';
    const { lc, calls } = wire(() => cfg(1, 0.05), () => kind, () => 0.01);
    expect(lc.tryStart()).toBe(true);
    kind = 'report';
    expect(lc.tryStart()).toBe(false); // already BUFFERING: guarded no-op
    expect(lc.state).toBe('BUFFERING');
    expect(calls).toEqual(['start:30']);
  });

  it('keeps an admitted kind admitted when its rate later drops', () => {
    let rate = 0.5;
    const { lc } = wire(() => cfg(rate), () => 'report', () => 0.3);
    expect(lc.tryStart()).toBe(true);
    rate = 0.1; // the draw no longer passes the live rate
    lc.forceDiscard(); // identity change: back to IDLE
    expect(lc.tryStart()).toBe(true);
  });

  it('keeps the crash-only decision separate from the report decision', () => {
    let kind: ReplaySessionKind = 'report';
    let reportRate = 0.5;
    const { lc } = wire(() => cfg(reportRate, 0), () => kind, () => 0.3);
    expect(lc.tryStart()).toBe(true);
    lc.forceDiscard();
    // Not a real transition (an upgrade is one-way); it proves the report
    // admission is not reused for a kind that never admitted the session.
    kind = 'crashOnly';
    expect(lc.tryStart()).toBe(false);
    kind = 'report';
    reportRate = 0;
    expect(lc.tryStart()).toBe(true);
  });

  it('a sampled-out crash-only session is admitted when its rate widens past the draw', () => {
    let crashRate = 0.01;
    const random = vi.fn(() => 0.04);
    const { lc } = wire(() => cfg(1, crashRate), () => 'crashOnly', random);
    expect(lc.tryStart()).toBe(false);
    crashRate = 0.05;
    expect(lc.tryStart()).toBe(true);
    expect(random).toHaveBeenCalledTimes(1);
  });
});

describe('locallyDisabled as a live predicate', () => {
  it('is read on every start attempt', () => {
    let vetoed = true;
    const r = makeReplay();
    const lc = createReplayLifecycle({
      adapter: { replay: r.replay },
      getConfig: () => cfg(1),
      locallyDisabled: () => vetoed,
      random: () => 0,
    });
    expect(lc.tryStart()).toBe(false);
    vetoed = false;
    expect(lc.tryStart()).toBe(true);
  });

  it('never draws while vetoed', () => {
    const random = vi.fn(() => 0);
    const lc = createReplayLifecycle({
      adapter: { replay: makeReplay().replay },
      getConfig: () => cfg(1),
      locallyDisabled: () => true,
      random,
    });
    lc.tryStart();
    expect(random).not.toHaveBeenCalled();
  });
});

describe('crashOnlySamplingRate in GET /api/config', () => {
  const BASE = { replayEnabled: true, replayDurationSec: 30, samplingRate: 1 };

  it('parses a valid rate', () => {
    const parsed = ReplayConfigResponse.safeParse({ ...BASE, crashOnlySamplingRate: 0.05 });
    expect(parsed.success && parsed.data.crashOnlySamplingRate).toBe(0.05);
  });

  it('is absent when the server does not send it', () => {
    const parsed = ReplayConfigResponse.safeParse(BASE);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.crashOnlySamplingRate).toBeUndefined();
  });

  it.each([1.5, -0.1, 'x', null])('degrades %j to absent without failing the parse', (value) => {
    const parsed = ReplayConfigResponse.safeParse({ ...BASE, crashOnlySamplingRate: value });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.crashOnlySamplingRate).toBeUndefined();
    expect(parsed.success && parsed.data.samplingRate).toBe(1);
  });
});
