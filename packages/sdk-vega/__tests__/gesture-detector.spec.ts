// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindingsEqual,
  createGestureDetector,
  DEFAULT_TV_BINDING,
  REPEAT_GAP_MS,
  resolveTvBinding,
  type GestureBinding,
} from '../src/gesture-detector.js';
import type { GestureKey } from '../src/remote-keys.js';

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
async function hold(d: ReturnType<typeof detector>['d'], key: GestureKey, ms: number) {
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
});

const KONAMI: GestureBinding = {
  kind: 'sequence',
  keys: ['DPAD_UP', 'DPAD_UP', 'DPAD_DOWN', 'DPAD_DOWN'],
  windowMs: 1000,
};

/** One press: down, `heldMs` later up. */
async function tap(d: ReturnType<typeof detector>['d'], key: GestureKey, heldMs = 80) {
  d.onKey(key, 'down');
  await vi.advanceTimersByTimeAsync(heldMs);
  d.onKey(key, 'up');
}

describe('sequence', () => {
  it('sequenceFiresWithinWindow', async () => {
    const { d, fired } = detector(KONAMI);
    // Four taps, 300 ms apart: the last down is 900 ms after the first.
    for (const key of KONAMI.keys) {
      await tap(d, key, 80);
      await vi.advanceTimersByTimeAsync(220);
    }
    expect(fired).toEqual([900]);
  });

  it('sequenceFiresAtExactlyTheWindow', async () => {
    const { d, fired } = detector(KONAMI);
    for (const key of KONAMI.keys) {
      await tap(d, key, 50);
      await vi.advanceTimersByTimeAsync(283);
    }
    // Downs at 0, 333, 666, 999: inside a 1000 ms window.
    expect(fired).toEqual([999]);
  });

  it('sequenceTooSlowDoesNotFire', async () => {
    const { d, fired } = detector(KONAMI);
    for (const key of KONAMI.keys) {
      await tap(d, key, 80);
      await vi.advanceTimersByTimeAsync(260);
    }
    // Downs at 0, 340, 680, 1020.
    expect(fired).toEqual([]);
  });

  it('slowStartThenFastFinishFiresOnTheLastFour', async () => {
    const { d, fired } = detector(KONAMI);
    await tap(d, 'DPAD_UP');
    await vi.advanceTimersByTimeAsync(2000);
    for (const key of KONAMI.keys) {
      await tap(d, key, 50);
      await vi.advanceTimersByTimeAsync(150);
    }
    expect(fired).toHaveLength(1);
  });

  it('heldDownIsOnePressInSequence', async () => {
    const { d, fired } = detector({ ...KONAMI, windowMs: 3000 });
    await tap(d, 'DPAD_UP');
    await tap(d, 'DPAD_UP');
    // A held ↓ with Vega's repeats is one press, not the final two.
    await hold(d, 'DPAD_DOWN', 1000);
    expect(fired).toEqual([]);
    // A second, real ↓ completes it.
    await tap(d, 'DPAD_DOWN');
    expect(fired).toHaveLength(1);
  });

  it('sequenceFiresOnceThenClears', async () => {
    const { d, fired } = detector({
      kind: 'sequence',
      keys: ['DPAD_DOWN', 'DPAD_DOWN'],
      windowMs: 1000,
    });
    await tap(d, 'DPAD_DOWN');
    await tap(d, 'DPAD_DOWN');
    expect(fired).toHaveLength(1);
    // The third ↓ would complete "the last two" again; history was cleared.
    await tap(d, 'DPAD_DOWN');
    expect(fired).toHaveLength(1);
    await tap(d, 'DPAD_DOWN');
    expect(fired).toHaveLength(2);
  });

  it('anotherKeyBreaksTheSequence', async () => {
    const { d, fired } = detector(KONAMI);
    await tap(d, 'DPAD_UP');
    await tap(d, 'DPAD_UP');
    await tap(d, 'DPAD_LEFT');
    await tap(d, 'DPAD_DOWN');
    await tap(d, 'DPAD_DOWN');
    expect(fired).toEqual([]);
  });

  it('unmappedKeyBreaksTheSequence', async () => {
    const { d, fired } = detector(KONAMI);
    await tap(d, 'DPAD_UP');
    await tap(d, 'DPAD_UP');
    d.onKey(null, 'down');
    d.onKey(null, 'up');
    await tap(d, 'DPAD_DOWN');
    await tap(d, 'DPAD_DOWN');
    expect(fired).toEqual([]);
  });

  it('fastDownDownPagingDoesNotFireUpUpDownDown', async () => {
    const { d, fired } = detector(KONAMI);
    // Fast paging through a list: ↓ taps every 120 ms, then a held ↓.
    for (let i = 0; i < 12; i++) {
      await tap(d, 'DPAD_DOWN', 60);
      await vi.advanceTimersByTimeAsync(60);
    }
    await hold(d, 'DPAD_DOWN', 2500);
    await tap(d, 'DPAD_UP', 60);
    await tap(d, 'DPAD_DOWN', 60);
    expect(fired).toEqual([]);
  });

  it('resetForgetsHistory', async () => {
    const { d, fired } = detector(KONAMI);
    await tap(d, 'DPAD_UP');
    await tap(d, 'DPAD_UP');
    await tap(d, 'DPAD_DOWN');
    d.reset();
    await tap(d, 'DPAD_DOWN');
    expect(fired).toEqual([]);
  });

  it('resetForgetsHeldKeys', async () => {
    const { d, fired } = detector({
      kind: 'sequence',
      keys: ['DPAD_DOWN', 'DPAD_DOWN'],
      windowMs: 1000,
    });
    d.onKey('DPAD_DOWN', 'down');
    d.reset();
    // The up was lost (the app left the screen): the next down is a new press.
    d.onKey('DPAD_DOWN', 'down');
    d.onKey('DPAD_DOWN', 'up');
    await tap(d, 'DPAD_DOWN');
    expect(fired).toHaveLength(1);
  });
});

describe('chord', () => {
  const CHORD: GestureBinding = { kind: 'chord', keys: ['DPAD_UP', 'BACK'] };

  it('chordFiresOnceUntilReleased', async () => {
    const { d, fired } = detector(CHORD);
    d.onKey('DPAD_UP', 'down');
    await vi.advanceTimersByTimeAsync(100);
    expect(fired).toEqual([]);
    d.onKey('BACK', 'down');
    expect(fired).toEqual([100]);
    // Repeats of both keys while held do not fire again.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(200);
      d.onKey('DPAD_UP', 'down');
      d.onKey('BACK', 'down');
    }
    // Releasing one and pressing it again while the other is still held: no rearm.
    d.onKey('BACK', 'up');
    d.onKey('BACK', 'down');
    expect(fired).toHaveLength(1);
    d.onKey('BACK', 'up');
    d.onKey('DPAD_UP', 'up');
    // Everything released: the chord rearms.
    d.onKey('BACK', 'down');
    d.onKey('DPAD_UP', 'down');
    expect(fired).toHaveLength(2);
  });

  it('chordKeysPressedOneAfterAnotherDoNotFire', async () => {
    const { d, fired } = detector(CHORD);
    await tap(d, 'DPAD_UP');
    await tap(d, 'BACK');
    await tap(d, 'DPAD_UP');
    expect(fired).toEqual([]);
  });

  it('otherKeysDoNotCountTowardsTheChord', async () => {
    const { d, fired } = detector({ kind: 'chord', keys: ['DPAD_UP', 'BACK', 'MENU'] });
    d.onKey('DPAD_UP', 'down');
    d.onKey('BACK', 'down');
    d.onKey('DPAD_DOWN', 'down');
    d.onKey(null, 'down');
    expect(fired).toEqual([]);
    d.onKey('MENU', 'down');
    expect(fired).toHaveLength(1);
  });

  it('resetRearmsTheChord', async () => {
    const { d, fired } = detector(CHORD);
    d.onKey('DPAD_UP', 'down');
    d.onKey('BACK', 'down');
    d.reset();
    d.onKey('DPAD_UP', 'down');
    d.onKey('BACK', 'down');
    expect(fired).toHaveLength(2);
  });
});

describe('binding in effect', () => {
  it('equalBindingsCompareByValue', () => {
    expect(bindingsEqual(KONAMI, { ...KONAMI, keys: [...KONAMI.keys] })).toBe(true);
    expect(bindingsEqual(KONAMI, { ...KONAMI, windowMs: 1001 })).toBe(false);
    expect(
      bindingsEqual(KONAMI, { ...KONAMI, keys: ['DPAD_UP', 'DPAD_DOWN', 'DPAD_UP', 'DPAD_DOWN'] }),
    ).toBe(false);
    expect(
      bindingsEqual(DEFAULT_TV_BINDING, {
        kind: 'longPress',
        keys: ['MEDIA_PLAY_PAUSE'],
        holdMs: 1600,
      }),
    ).toBe(false);
    expect(
      bindingsEqual(
        { kind: 'chord', keys: ['DPAD_UP', 'BACK'] },
        { kind: 'chord', keys: ['DPAD_UP', 'BACK'] },
      ),
    ).toBe(true);
    expect(
      bindingsEqual(
        { kind: 'chord', keys: ['DPAD_UP', 'DPAD_DOWN'] },
        { kind: 'sequence', keys: ['DPAD_UP', 'DPAD_DOWN'], windowMs: 1000 },
      ),
    ).toBe(false);
    expect(bindingsEqual(null, null)).toBe(true);
    expect(bindingsEqual(null, DEFAULT_TV_BINDING)).toBe(false);
  });

  it('missingBindingIsTheDefault', () => {
    expect(resolveTvBinding(undefined)).toEqual({
      binding: DEFAULT_TV_BINDING,
      unsupported: false,
    });
  });

  it('supportedBindingIsUsed', () => {
    expect(resolveTvBinding(KONAMI)).toEqual({ binding: KONAMI, unsupported: false });
  });

  it('bindingWithAKeyVegaLacksDisarms', () => {
    for (const binding of [
      { kind: 'chord', keys: ['SHIFT', 'B'] },
      { kind: 'longPress', keys: ['PROG_RED'], holdMs: 1500 },
      { kind: 'sequence', keys: ['DPAD_UP', 'A'], windowMs: 1000 },
    ] as GestureBinding[])
      expect(resolveTvBinding(binding)).toEqual({ binding: null, unsupported: true });
  });
});
