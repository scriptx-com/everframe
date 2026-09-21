// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// REPLAY-02 (freeze/trim half) — HIGHEST-LIABILITY GATE companion.
// Turned RED→GREEN in plan 20-04.
//
// Contract (RESEARCH §"Lifecycle state machine"):
//   - freeze() captures freezeTs FIRST, before the reporter modal mounts.
//   - takeFrozen() trims every frame with ts > freezeTs.
//   - the reporter UI subtree is NEVER recorded into the replay.
import { describe, it, expect, vi } from 'vitest';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createReplayRecorder } from '../../../src/capture/replay/recorder.js';

const FULL = 2;
const INCR = 3;

// jsdom's Blob lacks .stream() so the production CompressionStream path can't run
// here — inject a node:zlib gzip that round-trips with gunzipSync. The production
// default (sdk-core gzipBytes) is exercised in the real browser e2e.
const testGzip = async (input: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(gzipSync(Buffer.from(input)));

/**
 * Drive the recorder via an injected fake rrweb whose `record()` returns the emit
 * callback so the test can synthesize frames deterministically (no real DOM clock).
 */
function recorderWithEmit() {
  let emit: ((e: unknown, isCheckout?: boolean) => void) | undefined;
  const fakeRrweb = {
    record: (options: Record<string, unknown>) => {
      emit = options['emit'] as (e: unknown, isCheckout?: boolean) => void;
      return () => undefined;
    },
  };
  const rec = createReplayRecorder({
    importRrweb: async () => fakeRrweb,
    now: () => 0,
    gzip: testGzip,
  });
  return { rec, getEmit: () => emit };
}

/**
 * Variant that injects the WR-01 `freezeNow` clock alongside a benign `now`, so a
 * test can assert the freeze cutoff is the freeze INSTANT (Date.now epoch) and not
 * Math.max against the latest buffered frame.
 */
function recorderWithClocks(freezeNow: () => number) {
  let emit: ((e: unknown, isCheckout?: boolean) => void) | undefined;
  const fakeRrweb = {
    record: (options: Record<string, unknown>) => {
      emit = options['emit'] as (e: unknown, isCheckout?: boolean) => void;
      return () => undefined;
    },
  };
  const rec = createReplayRecorder({
    importRrweb: async () => fakeRrweb,
    now: () => 0,
    freezeNow,
    gzip: testGzip,
  });
  return { rec, getEmit: () => emit };
}

describe('REPLAY-02 freeze + trim', () => {
  it('no frame has ts > freezeTs after trim', async () => {
    const { rec, getEmit } = recorderWithEmit();
    rec.start(30);
    await Promise.resolve();
    await Promise.resolve();
    const emit = getEmit()!;
    emit({ type: FULL, timestamp: 10, data: {} }, true);
    emit({ type: INCR, timestamp: 20, data: {} });
    emit({ type: INCR, timestamp: 25, data: {} });
    rec.freeze(); // freezeTs becomes the latest retained ts (25)
    // Post-freeze noise (e.g. modal animation) must be ignored — recorder is frozen.
    emit({ type: INCR, timestamp: 40, data: {} });
    emit({ type: INCR, timestamp: 50, data: {} });
    const capture = await rec.takeFrozen();
    expect(capture).not.toBeNull();
    const events = JSON.parse(gunzipSync(Buffer.from(capture!.bytes)).toString('utf8')) as Array<{
      timestamp: number;
    }>;
    expect(events.every((f) => f.timestamp <= 25)).toBe(true);
  });

  it('the reporter UI subtree is never present in the recorded frames', async () => {
    const { rec, getEmit } = recorderWithEmit();
    rec.start(30);
    await Promise.resolve();
    await Promise.resolve();
    const emit = getEmit()!;
    emit({ type: FULL, timestamp: 5, data: { html: '<div id="app">hi</div>' } }, true);
    rec.freeze();
    // Reporter mounts AFTER freeze — its emits are dropped.
    emit({ type: FULL, timestamp: 60, data: { html: '<div data-traceitx-reporter>modal</div>' } }, true);
    const capture = await rec.takeFrozen();
    const serialized = gunzipSync(Buffer.from(capture!.bytes)).toString('utf8');
    expect(serialized).not.toContain('data-traceitx-reporter');
    expect(serialized).not.toContain('modal');
  });

  it('discardAndResume zeroizes the buffer (clean buffer after open→cancel)', async () => {
    const { rec, getEmit } = recorderWithEmit();
    rec.start(30);
    await Promise.resolve();
    await Promise.resolve();
    const emit = getEmit()!;
    emit({ type: FULL, timestamp: 5, data: {} }, true);
    emit({ type: INCR, timestamp: 10, data: {} });
    rec.freeze();
    rec.discardAndResume();
    // After discard the frozen window is gone — takeFrozen yields nothing.
    const capture = await rec.takeFrozen();
    expect(capture).toBeNull();
  });

  it('a frame emitted synchronously after freeze() (Date.now epoch) is trimmed (WR-01)', async () => {
    // The reporter UI can synthesize a frame in the SAME synchronous turn as
    // freeze(), carrying a Date.now()-epoch ts LATER than the freeze instant. With
    // the freeze cutoff on the Date.now epoch (no Math.max against the latest
    // buffered frame), that frame must be trimmed even though the recorder is
    // momentarily not yet frozen at emit-construction time.
    const FREEZE_AT = 1_700_000_000_100;
    const { rec, getEmit } = recorderWithClocks(() => FREEZE_AT);
    rec.start(30);
    await Promise.resolve();
    await Promise.resolve();
    const emit = getEmit()!;
    // Pre-freeze frames (wall-clock epoch) — the latest buffered ts (...080) is
    // BELOW the freeze instant, so the old Math.max-vs-latest defect would have
    // pinned the cutoff to ...080 and (wrongly) let nothing post-freeze through —
    // but here we prove the cutoff is the freeze instant, not the latest frame.
    emit({ type: FULL, timestamp: 1_700_000_000_050, data: {} }, true);
    emit({ type: INCR, timestamp: 1_700_000_000_080, data: {} });
    rec.freeze(); // freezeTs = 1_700_000_000_100 (Date.now epoch)
    // Synchronous reporter-UI-shaped frame AFTER freeze — must be trimmed.
    emit({ type: INCR, timestamp: 1_700_000_000_500, data: {} });
    const capture = await rec.takeFrozen();
    expect(capture).not.toBeNull();
    const events = JSON.parse(gunzipSync(Buffer.from(capture!.bytes)).toString('utf8')) as Array<{
      timestamp: number;
    }>;
    // Every retained frame is at or before the freeze instant; the ...500 frame is gone.
    expect(events.every((f) => f.timestamp <= FREEZE_AT)).toBe(true);
    expect(events.some((f) => f.timestamp === 1_700_000_000_500)).toBe(false);
    // The pre-freeze anchor + frame are retained (window is playable, no over-trim).
    expect(events.some((f) => f.timestamp === 1_700_000_000_050)).toBe(true);
    expect(events.some((f) => f.timestamp === 1_700_000_000_080)).toBe(true);
  });

  it('the cutoff equals the freeze instant — a frame 1ms after freeze is trimmed (no Math.max defect)', async () => {
    // Guards the dead-code defect: the cutoff must be the freeze instant, NOT
    // raised by the latest buffered frame. A frame just 1ms after the freeze
    // instant is trimmed even though it sits well within the wall-clock range.
    const FREEZE_AT = 1_700_000_000_100;
    const { rec, getEmit } = recorderWithClocks(() => FREEZE_AT);
    rec.start(30);
    await Promise.resolve();
    await Promise.resolve();
    const emit = getEmit()!;
    emit({ type: FULL, timestamp: 1_700_000_000_090, data: {} }, true);
    rec.freeze();
    // 1ms after the freeze instant — must NOT survive.
    emit({ type: INCR, timestamp: 1_700_000_000_101, data: {} });
    const capture = await rec.takeFrozen();
    expect(capture).not.toBeNull();
    const events = JSON.parse(gunzipSync(Buffer.from(capture!.bytes)).toString('utf8')) as Array<{
      timestamp: number;
    }>;
    expect(events.some((f) => f.timestamp === 1_700_000_000_101)).toBe(false);
    expect(events.every((f) => f.timestamp <= FREEZE_AT)).toBe(true);
  });

  it('a window with no full-snapshot anchor is not emitted (unplayable)', async () => {
    const { rec, getEmit } = recorderWithEmit();
    rec.start(30);
    await Promise.resolve();
    await Promise.resolve();
    const emit = getEmit()!;
    // Only incrementals — no anchor.
    emit({ type: INCR, timestamp: 10, data: {} });
    emit({ type: INCR, timestamp: 20, data: {} });
    rec.freeze();
    const capture = await rec.takeFrozen();
    expect(capture).toBeNull();
  });
});
