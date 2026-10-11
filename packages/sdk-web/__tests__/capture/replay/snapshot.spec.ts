// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// Replays on errors (spec 2026-10-11, "Snapshot, not freeze"): the recorder's
// non-destructive snapshot of the rolling window. It never stops, freezes,
// clears or rotates the recorder, so a later error or bug report keeps its
// full history.
import { describe, it, expect, vi } from 'vitest';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createReplayRecorder, windowFromAnchor } from '../../../src/capture/replay/recorder.js';

const META = 4;
const FULL = 2;
const INCR = 3;

const testGzip = async (input: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(gzipSync(Buffer.from(input)));
const decode = (bytes: Uint8Array) =>
  JSON.parse(gunzipSync(Buffer.from(bytes)).toString('utf8')) as Array<{ type: number; timestamp: number }>;

function harness(opts: {
  now?: number;
  gzip?: (input: Uint8Array) => Promise<Uint8Array>;
  yieldToHost?: () => Promise<void>;
} = {}) {
  let emit: ((e: unknown, isCheckout?: boolean) => void) | undefined;
  let clock = opts.now ?? 100_000;
  const rec = createReplayRecorder({
    importRrweb: async () => ({
      record: (o: Record<string, unknown>) => {
        emit = o['emit'] as typeof emit;
        return () => undefined;
      },
    }),
    now: () => 0,
    freezeNow: () => clock,
    gzip: opts.gzip ?? testGzip,
    yieldToHost: opts.yieldToHost ?? (() => Promise.resolve()),
  });
  return {
    rec,
    emit: (type: number, timestamp: number, data: unknown = {}) => emit!({ type, timestamp, data }, type === FULL),
    setNow: (t: number) => {
      clock = t;
    },
  };
}

async function started(h: ReturnType<typeof harness>): Promise<void> {
  h.rec.start(30);
  await Promise.resolve();
  await Promise.resolve();
}

describe('replay snapshot (non-destructive)', () => {
  it('returns the window and leaves the recorder recording with its full history', async () => {
    const h = harness();
    await started(h);
    h.emit(META, 80_000);
    h.emit(FULL, 80_000);
    h.emit(INCR, 90_000);
    const capture = await h.rec.snapshot();
    expect(capture).toMatchObject({ format: 'rrweb', durationMs: 10_000, contentType: 'application/octet-stream' });
    expect(decode(capture!.bytes).map((e) => e.timestamp)).toEqual([80_000, 80_000, 90_000]);
    expect(h.rec.__diagnostics()).toMatchObject({ recording: true, frozen: false, frames: 3 });
    h.emit(INCR, 95_000);
    expect(h.rec.__size).toBe(4);
    // A later bug report still gets everything, the snapshot's frames included.
    h.rec.freeze();
    expect(decode((await h.rec.takeFrozen())!.bytes).map((e) => e.timestamp)).toEqual([80_000, 80_000, 90_000, 95_000]);
  });

  it('starts at the newest full snapshot that still covers the window', async () => {
    const h = harness({ now: 100_000 });
    await started(h);
    h.emit(META, 50_000);
    h.emit(FULL, 50_000);
    h.emit(INCR, 60_000);
    h.emit(META, 72_000);
    h.emit(FULL, 72_000);
    h.emit(INCR, 95_000);
    // 30 s ending at 100 000 starts at 70 000: the snapshot at 50 000 covers it.
    expect(decode((await h.rec.snapshot())!.bytes).map((e) => e.timestamp))
      .toEqual([50_000, 50_000, 60_000, 72_000, 72_000, 95_000]);
    // 30 s ending at 110 000 starts at 80 000: the snapshot at 72 000 covers it.
    h.setNow(110_000);
    expect(decode((await h.rec.snapshot())!.bytes).map((e) => e.timestamp)).toEqual([72_000, 72_000, 95_000]);
    expect(h.rec.__size).toBe(6); // the buffer itself was not pruned
  });

  it('copies at the call: frames emitted while it encodes are not in it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({ yieldToHost: () => gate });
    await started(h);
    h.emit(FULL, 90_000);
    const pending = h.rec.snapshot();
    h.emit(INCR, 99_000);
    release();
    expect(decode((await pending)!.bytes).map((e) => e.timestamp)).toEqual([90_000]);
  });

  it('keeps an independent copy while a bug report freezes and exports the full history', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let encodingStarted!: () => void;
    const encoding = new Promise<void>((resolve) => { encodingStarted = resolve; });
    let exports = 0;
    const h = harness({ gzip: async (bytes) => {
      if (++exports === 1) {
        encodingStarted();
        await gate;
      }
      return testGzip(bytes);
    } });
    await started(h);
    h.emit(META, 80_000);
    h.emit(FULL, 80_000);
    h.emit(INCR, 90_000);
    const pending = h.rec.snapshot();
    await encoding;
    h.emit(INCR, 95_000);
    h.rec.freeze();
    const report = await h.rec.takeFrozen();
    expect(decode(report!.bytes).map((e) => e.timestamp)).toEqual([80_000, 80_000, 90_000, 95_000]);
    expect(h.rec.__diagnostics()).toMatchObject({ frozen: true, frames: 4 });
    release();
    expect(decode((await pending)!.bytes).map((e) => e.timestamp)).toEqual([80_000, 80_000, 90_000]);
    expect(h.rec.__diagnostics()).toMatchObject({ frozen: true, frames: 4 });
  });

  it('yields to the page before scrubbing and compressing', async () => {
    const gzip = vi.fn(testGzip);
    let release!: () => void;
    const h = harness({
      gzip,
      yieldToHost: () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    await started(h);
    h.emit(FULL, 90_000);
    const pending = h.rec.snapshot();
    await Promise.resolve();
    expect(gzip).not.toHaveBeenCalled();
    release();
    await pending;
    expect(gzip).toHaveBeenCalledTimes(1);
  });

  it('scrubs the snapshot exactly like a bug report replay', async () => {
    const h = harness();
    await started(h);
    h.emit(FULL, 90_000, { node: { type: 3, textContent: 'card 4111111111111111', id: 1 } });
    const text = gunzipSync(Buffer.from((await h.rec.snapshot())!.bytes)).toString('utf8');
    expect(text).not.toContain('4111111111111111');
    expect(text).toContain('[REDACTED:CC]');
  });

  it('declines while a bug report has frozen the window, and leaves that window intact', async () => {
    const h = harness();
    await started(h);
    h.emit(FULL, 90_000);
    h.rec.freeze();
    expect(await h.rec.snapshot()).toBeNull();
    expect(decode((await h.rec.takeFrozen())!.bytes).map((e) => e.timestamp)).toEqual([90_000]);
  });

  it('declines without a full snapshot to anchor the window', async () => {
    const h = harness();
    await started(h);
    h.emit(INCR, 90_000);
    expect(await h.rec.snapshot()).toBeNull();
    expect(h.rec.__size).toBe(1);
  });

  it('declines once killed, and before start', async () => {
    const idle = harness();
    expect(await idle.rec.snapshot()).toBeNull();
    const h = harness();
    await started(h);
    h.emit(FULL, 90_000);
    h.rec.kill();
    expect(await h.rec.snapshot()).toBeNull();
  });

  it('windowFromAnchor keeps the Meta event that sizes the player', () => {
    const frames = [
      { type: META, timestamp: 10 }, { type: FULL, timestamp: 10 }, { type: INCR, timestamp: 20 },
    ];
    expect(windowFromAnchor(frames, 0)).toEqual(frames);
    expect(windowFromAnchor([{ type: INCR, timestamp: 1 }], 0)).toEqual([]);
  });
});
