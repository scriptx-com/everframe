// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import type { KeyInput } from '../../src/quickcapture/gesture-detector.js';
import { DURATION_MS, GestureRecorder, MAX_EVENTS } from '../../src/quickcapture/recorder.js';
import type { GestureKeyName } from '../../src/quickcapture/remote-keys.js';

const NAMES: { [code: number]: GestureKeyName } = {
  38: 'DPAD_UP',
  40: 'DPAD_DOWN',
  415: 'MEDIA_PLAY_PAUSE',
  16: 'SHIFT',
  66: 'B',
};
const down = (code: number, atMs: number, repeat = false): KeyInput => ({
  type: 'down',
  name: NAMES[code] ?? null,
  code,
  shift: false,
  repeat,
  atMs,
});
const up = (code: number, atMs: number): KeyInput => ({
  type: 'up',
  name: NAMES[code] ?? null,
  code,
  shift: false,
  atMs,
});

describe('GestureRecorder', () => {
  it('records times relative to the first down and ignores repeats and unmapped keys', () => {
    const r = new GestureRecorder();
    r.onKey(up(38, 900)); // an up whose down came before the recording
    r.onKey(down(999, 950)); // unmapped
    r.onKey(down(38, 1000));
    r.onKey(down(38, 1400, true));
    r.onKey(down(38, 1450)); // inferred repeat
    r.onKey(up(38, 1080 + 400));
    r.onKey(up(999, 1500));
    r.onKey(down(415, 2578));
    r.onKey(up(415, 4180));
    expect(r.finish(6000)).toEqual([
      { key: 'DPAD_UP', downMs: 0, upMs: 480 },
      { key: 'MEDIA_PLAY_PAUSE', downMs: 1578, upMs: 3180 },
    ]);
  });

  it('a key still held at the end gets upMs = now - first down', () => {
    const r = new GestureRecorder();
    r.onKey(down(38, 100));
    r.onKey(up(38, 180));
    r.onKey(down(415, 500));
    expect(r.finish(10_100)).toEqual([
      { key: 'DPAD_UP', downMs: 0, upMs: 80 },
      { key: 'MEDIA_PLAY_PAUSE', downMs: 400, upMs: 10_000 },
    ]);
  });

  it('keeps at most 32 presses', () => {
    const r = new GestureRecorder();
    for (let i = 0; i < 40; i++) {
      r.onKey(down(38, i * 100));
      r.onKey(up(38, i * 100 + 50));
    }
    const events = r.finish(5000);
    expect(MAX_EVENTS).toBe(32);
    expect(events).toHaveLength(32);
    expect(events[31]).toEqual({ key: 'DPAD_UP', downMs: 3100, upMs: 3150 });
  });

  it('overlapping keys keep their own times (a chord)', () => {
    const r = new GestureRecorder();
    r.onKey(down(16, 0));
    r.onKey(down(66, 200));
    r.onKey(up(66, 300));
    r.onKey(up(16, 400));
    expect(r.finish(1000)).toEqual([
      { key: 'SHIFT', downMs: 0, upMs: 400 },
      { key: 'B', downMs: 200, upMs: 300 },
    ]);
  });

  it('records nothing without a key and lasts 10 s', () => {
    expect(new GestureRecorder().finish(10_000)).toEqual([]);
    expect(DURATION_MS).toBe(10_000);
  });
});
