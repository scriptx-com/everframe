// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// CONFIG-04 — samplingRate gates buffer-start as a real probability.
// Turned RED→GREEN in plan 20-04 by driving the sdk-core lifecycle (which owns the
// gate) against the web rrweb recorder so the gate provably governs whether the
// recorder ever starts.
//
// Contract (RESEARCH §"Sampling gate"):
//   - evaluate Math.random() < samplingRate ONCE per eligible report at
//     buffer-start (not per-event).
//   - 0 ⇒ never buffers; 1 ⇒ always buffers; below the gate ⇒ no attachment.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createReplayLifecycle, type ReplayConfig } from '@traceitx/sdk-core';
import { createReplayRecorder } from '../../../src/capture/replay/recorder.js';

function cfg(over: Partial<ReplayConfig> = {}): ReplayConfig {
  return { replayEnabled: true, replayDurationSec: 30, samplingRate: 1, ...over };
}

function wire(config: ReplayConfig, random: () => number) {
  const importSpy = vi.fn(async () => ({ record: () => () => undefined }));
  const recorder = createReplayRecorder({ importRrweb: importSpy });
  const lifecycle = createReplayLifecycle({
    adapter: { replay: recorder },
    getConfig: () => config,
    locallyDisabled: false,
    random,
  });
  return { importSpy, recorder, lifecycle };
}

describe('CONFIG-04 sampling gate', () => {
  afterEach(() => vi.restoreAllMocks());

  it('samplingRate 0 never starts a buffer (recorder.start never runs)', async () => {
    const { importSpy, lifecycle } = wire(cfg({ samplingRate: 0 }), () => 0);
    const started = lifecycle.tryStart();
    await Promise.resolve();
    expect(started).toBe(false);
    expect(importSpy).not.toHaveBeenCalled();
  });

  it('samplingRate 1 always starts a buffer (recorder.start runs)', async () => {
    const { importSpy, lifecycle } = wire(cfg({ samplingRate: 1 }), () => 0.999999);
    const started = lifecycle.tryStart();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toBe(true);
    expect(importSpy).toHaveBeenCalledTimes(1);
  });

  it('the gate is evaluated exactly once at buffer-start, not per event', () => {
    const random = vi.fn(() => 0.4);
    const { lifecycle } = wire(cfg({ samplingRate: 0.5 }), random);
    lifecycle.tryStart();
    lifecycle.tryStart(); // idempotent — already BUFFERING, no second draw
    expect(random).toHaveBeenCalledTimes(1);
  });

  it('draw below the rate buffers; at-or-above the rate does not', () => {
    const below = wire(cfg({ samplingRate: 0.5 }), () => 0.49);
    expect(below.lifecycle.tryStart()).toBe(true);
    const atOrAbove = wire(cfg({ samplingRate: 0.5 }), () => 0.5);
    expect(atOrAbove.lifecycle.tryStart()).toBe(false);
  });

  it('config replayEnabled:false never starts regardless of sampling', () => {
    const { lifecycle } = wire(cfg({ replayEnabled: false, samplingRate: 1 }), () => 0);
    expect(lifecycle.tryStart()).toBe(false);
  });
});
