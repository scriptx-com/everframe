// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The lifecycle's contribution to the replay flight recorder: every transition
// records the state it was ENTERED from, so a report that shipped without a
// replay can be read back to the guard that swallowed it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createReplayLifecycle } from '../../src/types/replay/lifecycle.js';
import type { ReplayConfig } from '../../src/types/replay/config-provider.js';
import type { ReplayCapture } from '../../src/types/platform.js';
import {
  __enableReplayTrace,
  __getReplayTrace,
  __resetReplayTrace,
} from '../../src/debug/replay-trace.js';

const ON: ReplayConfig = { replayEnabled: true, replayDurationSec: 30, samplingRate: 1.0 };
const OFF: ReplayConfig = { replayEnabled: false, replayDurationSec: 30, samplingRate: 1.0 };

const CAPTURE: ReplayCapture = {
  format: 'rrweb',
  bytes: new Uint8Array([1, 2, 3]),
  durationMs: 1000,
  contentType: 'application/octet-stream',
};

function makeLifecycle(config: ReplayConfig, capture: ReplayCapture | null = CAPTURE) {
  return createReplayLifecycle({
    adapter: {
      replay: {
        start: () => undefined,
        freeze: () => undefined,
        discardAndResume: () => undefined,
        takeFrozen: async () => capture,
        stop: () => undefined,
      },
    },
    getConfig: () => config,
    locallyDisabled: false,
  });
}

const events = (): string[] => __getReplayTrace().map((e) => e.ev);

describe('replay lifecycle tracing', () => {
  beforeEach(() => {
    __resetReplayTrace();
    __enableReplayTrace(true);
  });
  afterEach(() => {
    __resetReplayTrace();
  });

  it('records nothing when the trace is disarmed', () => {
    __enableReplayTrace(false);
    makeLifecycle(ON).tryStart();
    expect(__getReplayTrace()).toEqual([]);
  });

  it('records a successful tryStart', () => {
    makeLifecycle(ON).tryStart();
    expect(__getReplayTrace()).toContainEqual(
      expect.objectContaining({ ev: 'lifecycle.tryStart', from: 'IDLE', started: true }),
    );
  });

  it('records why a tryStart was refused', () => {
    makeLifecycle(OFF).tryStart();
    expect(__getReplayTrace()).toContainEqual(
      expect.objectContaining({ ev: 'lifecycle.tryStart', started: false, reason: 'disabled' }),
    );
  });

  it('records the state a freeze was entered from', () => {
    const lc = makeLifecycle(ON);
    lc.tryStart();
    lc.freeze();
    expect(__getReplayTrace()).toContainEqual(
      expect.objectContaining({ ev: 'lifecycle.freeze', from: 'BUFFERING', applied: true }),
    );
  });

  it('records a freeze that was a guarded no-op', () => {
    makeLifecycle(ON).freeze(); // never started — still IDLE
    expect(__getReplayTrace()).toContainEqual(
      expect.objectContaining({ ev: 'lifecycle.freeze', from: 'IDLE', applied: false }),
    );
  });

  it('records the byte length a complete produced', async () => {
    const lc = makeLifecycle(ON);
    lc.tryStart();
    lc.freeze();
    await lc.complete();
    expect(__getReplayTrace()).toContainEqual(
      expect.objectContaining({ ev: 'lifecycle.complete', from: 'FROZEN', bytes: 3 }),
    );
  });

  it('records a complete that was refused for not being FROZEN', async () => {
    const lc = makeLifecycle(ON);
    lc.tryStart();
    await lc.complete(); // still BUFFERING — the guard returns null
    expect(__getReplayTrace()).toContainEqual(
      expect.objectContaining({ ev: 'lifecycle.complete', from: 'BUFFERING', applied: false }),
    );
  });

  it('records a complete whose recorder handed back nothing', async () => {
    const lc = makeLifecycle(ON, null);
    lc.tryStart();
    lc.freeze();
    await lc.complete();
    expect(__getReplayTrace()).toContainEqual(
      expect.objectContaining({ ev: 'lifecycle.complete', from: 'FROZEN', bytes: null }),
    );
  });

  it('records a cancel that discarded a frozen window', () => {
    const lc = makeLifecycle(ON);
    lc.tryStart();
    lc.freeze();
    lc.cancel();
    expect(__getReplayTrace()).toContainEqual(
      expect.objectContaining({ ev: 'lifecycle.cancel', from: 'FROZEN', applied: true }),
    );
  });

  it('records a forceDiscard', () => {
    const lc = makeLifecycle(ON);
    lc.tryStart();
    lc.forceDiscard();
    expect(events()).toContain('lifecycle.forceDiscard');
  });
});
