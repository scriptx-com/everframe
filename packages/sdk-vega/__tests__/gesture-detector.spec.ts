// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGestureDetector,
  DEFAULT_TV_BINDING,
  REPEAT_GAP_MS,
  type GestureBinding,
} from '../src/gesture-detector.js';

function detector(binding: GestureBinding = DEFAULT_TV_BINDING) {
  const fired: number[] = [];
  const start = Date.now();
  const d = createGestureDetector(binding, {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    onFire: () => fired.push(Date.now() - start),
  });
  return { d, fired };
}

/** A held key as Vega delivers it: down, repeated downs every 200 ms after ~530 ms, then up. */
async function hold(
  d: ReturnType<typeof detector>['d'],
  key: 'MEDIA_PLAY_PAUSE' | 'DPAD_DOWN',
  ms: number,
) {
  d.onKey(key, 'down');
  let t = 0;
  for (let next = 530; next < ms; next += 200) {
    await vi.advanceTimersByTimeAsync(next - t);
    t = next;
    d.onKey(key, 'down');
  }
  await vi.advanceTimersByTimeAsync(ms - t);
  d.onKey(key, 'up');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-24T10:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('long press', () => {
  it('defaultBindingIsTheContractDefault', () => {
    expect(DEFAULT_TV_BINDING).toEqual({
      kind: 'longPress',
      keys: ['MEDIA_PLAY_PAUSE'],
      holdMs: 1500,
    });
    // Vega repeats a held key as more downs, never as up/down pairs.
    expect(REPEAT_GAP_MS).toBe(0);
  });

  it('holdFiresOnceAt1500', async () => {
    const { d, fired } = detector();
    d.onKey('MEDIA_PLAY_PAUSE', 'down');
    await vi.advanceTimersByTimeAsync(1499);
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toEqual([1500]);
    await vi.advanceTimersByTimeAsync(2500);
    d.onKey('MEDIA_PLAY_PAUSE', 'up');
    expect(fired).toEqual([1500]);
  });

  it('heldWithVegaRepeatsFiresOnceFor4s', async () => {
    const { d, fired } = detector();
    await hold(d, 'MEDIA_PLAY_PAUSE', 4000);
    expect(fired).toEqual([1500]);
  });

  it('tapDoesNotFire', async () => {
    const { d, fired } = detector();
    d.onKey('MEDIA_PLAY_PAUSE', 'down');
    await vi.advanceTimersByTimeAsync(200);
    d.onKey('MEDIA_PLAY_PAUSE', 'up');
    await vi.advanceTimersByTimeAsync(5000);
    expect(fired).toEqual([]);
  });

  it('repeatsWhileHeldDoNotRestartTimer', async () => {
    const { d, fired } = detector();
    d.onKey('MEDIA_PLAY_PAUSE', 'down');
    await vi.advanceTimersByTimeAsync(1000);
    d.onKey('MEDIA_PLAY_PAUSE', 'down');
    await vi.advanceTimersByTimeAsync(500);
    expect(fired).toEqual([1500]);
  });

  it('otherKeyCancels', async () => {
    const { d, fired } = detector();
    d.onKey('MEDIA_PLAY_PAUSE', 'down');
    await vi.advanceTimersByTimeAsync(800);
    d.onKey('DPAD_DOWN', 'down');
    await vi.advanceTimersByTimeAsync(2000);
    expect(fired).toEqual([]);
  });

  it('unmappedKeyCancels', async () => {
    const { d, fired } = detector();
    d.onKey('MEDIA_PLAY_PAUSE', 'down');
    await vi.advanceTimersByTimeAsync(800);
    d.onKey(null, 'down');
    await vi.advanceTimersByTimeAsync(2000);
    expect(fired).toEqual([]);
  });

  it('otherKeyUpDoesNotCancel', async () => {
    const { d, fired } = detector();
    d.onKey('MEDIA_PLAY_PAUSE', 'down');
    await vi.advanceTimersByTimeAsync(800);
    d.onKey('DPAD_DOWN', 'up');
    await vi.advanceTimersByTimeAsync(700);
    expect(fired).toEqual([1500]);
  });

  it('heldDpadNeverFires', async () => {
    const { d, fired } = detector();
    await hold(d, 'DPAD_DOWN', 4000);
    expect(fired).toEqual([]);
  });

  it('twoTapsDoNotFire', async () => {
    const { d, fired } = detector();
    d.onKey('MEDIA_PLAY_PAUSE', 'down');
    await vi.advanceTimersByTimeAsync(300);
    d.onKey('MEDIA_PLAY_PAUSE', 'up');
    await vi.advanceTimersByTimeAsync(100);
    d.onKey('MEDIA_PLAY_PAUSE', 'down');
    await vi.advanceTimersByTimeAsync(300);
    d.onKey('MEDIA_PLAY_PAUSE', 'up');
    await vi.advanceTimersByTimeAsync(3000);
    expect(fired).toEqual([]);
  });

  it('upWithoutDownIsHarmless', async () => {
    const { d, fired } = detector();
    d.onKey('MEDIA_PLAY_PAUSE', 'up');
    await vi.advanceTimersByTimeAsync(2000);
    expect(fired).toEqual([]);
  });

  it('secondHoldFiresAgain', async () => {
    const { d, fired } = detector();
    await hold(d, 'MEDIA_PLAY_PAUSE', 1600);
    await vi.advanceTimersByTimeAsync(400);
    await hold(d, 'MEDIA_PLAY_PAUSE', 1600);
    expect(fired).toEqual([1500, 3500]);
  });

  it('resetCancelsAPendingHold', async () => {
    const { d, fired } = detector();
    d.onKey('MEDIA_PLAY_PAUSE', 'down');
    await vi.advanceTimersByTimeAsync(1000);
    d.reset();
    await vi.advanceTimersByTimeAsync(2000);
    expect(fired).toEqual([]);
    // A reset forgets the held key, so the next press is a fresh one.
    await hold(d, 'MEDIA_PLAY_PAUSE', 1600);
    expect(fired).toEqual([4500]);
  });

  it('sequenceAndChordAreInertUntilPr2', async () => {
    const seq = detector({ kind: 'sequence', keys: ['DPAD_UP', 'DPAD_UP'], windowMs: 1000 });
    seq.d.onKey('DPAD_UP', 'down');
    seq.d.onKey('DPAD_UP', 'up');
    seq.d.onKey('DPAD_UP', 'down');
    const chord = detector({ kind: 'chord', keys: ['DPAD_UP', 'DPAD_DOWN'] });
    chord.d.onKey('DPAD_UP', 'down');
    chord.d.onKey('DPAD_DOWN', 'down');
    await vi.advanceTimersByTimeAsync(3000);
    expect([...seq.fired, ...chord.fired]).toEqual([]);
  });
});
