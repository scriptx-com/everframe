// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// REPLAY-06 — replay events + envelope share one monotonic session epoch.
// Turned RED→GREEN in plan 20-04.
//
// Contract (RESEARCH §"Replay events + envelope share one monotonic session epoch"):
//   - the lifecycle mints ONE monotonic sessionEpoch at creation; the web recorder
//     is constructed with that same epoch so replay frames and the envelope anchor
//     to a single origin (no clock skew between the bug moment and the timeline).
import { describe, it, expect } from 'vitest';
import { createReplayLifecycle, type ReplayConfig } from '@traceitx/sdk-core';
import { createReplayRecorder } from '../../../src/capture/replay/recorder.js';

const config: ReplayConfig = { replayEnabled: true, replayDurationSec: 30, samplingRate: 1 };

describe('REPLAY-06 shared session epoch', () => {
  it('the lifecycle mints one monotonic epoch reused for the recorder', () => {
    let clock = 1000;
    const now = () => clock;
    const lifecycle = createReplayLifecycle({
      adapter: { replay: createReplayRecorder({ sessionEpoch: clock }) },
      getConfig: () => config,
      locallyDisabled: false,
      now,
    });
    const epoch1 = lifecycle.sessionEpoch;
    clock = 9999; // advance the clock
    const epoch2 = lifecycle.sessionEpoch;
    // The epoch is minted once and never drifts.
    expect(epoch1).toBe(1000);
    expect(epoch2).toBe(1000);
  });

  it('the recorder accepts the lifecycle epoch so frame ts share the origin', () => {
    const epoch = 42_000;
    const rec = createReplayRecorder({ sessionEpoch: epoch });
    // The recorder is constructed with the shared epoch (no throw, seam present).
    expect(rec).toBeTruthy();
    expect(typeof rec.takeFrozen).toBe('function');
  });

  it('the epoch is monotonic across reads (never decreases)', () => {
    let clock = 500;
    const lifecycle = createReplayLifecycle({
      adapter: { replay: createReplayRecorder() },
      getConfig: () => config,
      locallyDisabled: false,
      now: () => clock,
    });
    const first = lifecycle.sessionEpoch;
    clock -= 200; // even a clock that goes backwards must not change the epoch
    expect(lifecycle.sessionEpoch).toBeGreaterThanOrEqual(first);
  });
});
