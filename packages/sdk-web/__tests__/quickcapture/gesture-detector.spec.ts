// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { GestureDetector, type KeyInput } from '../../src/quickcapture/gesture-detector.js';
import {
  DEFAULT_TV_BINDING,
  type GestureKeyName,
  type TvGestureBinding,
} from '../../src/quickcapture/remote-keys.js';

const PP = 415;
const UP = 38;
const DOWN = 40;
const RED = 403;
const BLUE = 406;
const SHIFT = 16;
const B = 66;
const NAMES: { [code: number]: GestureKeyName } = {
  [PP]: 'MEDIA_PLAY_PAUSE',
  19: 'MEDIA_PLAY_PAUSE',
  [UP]: 'DPAD_UP',
  [DOWN]: 'DPAD_DOWN',
  [RED]: 'PROG_RED',
  [BLUE]: 'PROG_BLUE',
  [SHIFT]: 'SHIFT',
  [B]: 'B',
};

function down(
  code: number,
  atMs: number,
  opts: { shift?: boolean; repeat?: boolean } = {},
): KeyInput {
  return {
    type: 'down',
    name: NAMES[code] ?? null,
    code,
    shift: opts.shift ?? false,
    repeat: opts.repeat ?? false,
    atMs,
  };
}
function up(code: number, atMs: number, opts: { shift?: boolean } = {}): KeyInput {
  return {
    type: 'up',
    name: NAMES[code] ?? null,
    code,
    shift: opts.shift ?? false,
    repeat: false,
    atMs,
  };
}

const SEQ: TvGestureBinding = {
  kind: 'sequence',
  keys: ['DPAD_UP', 'DPAD_UP', 'DPAD_DOWN', 'DPAD_DOWN'],
  windowMs: 1000,
};
const CHORD: TvGestureBinding = { kind: 'chord', keys: ['SHIFT', 'B'] };
const COLORS: TvGestureBinding = { kind: 'chord', keys: ['PROG_RED', 'PROG_BLUE'] };

describe('GestureDetector — longPress', () => {
  it('a 1500 ms hold fires once from the timer', () => {
    const d = new GestureDetector(DEFAULT_TV_BINDING);
    const first = d.onKey(down(PP, 1000));
    expect(first).toEqual({ fire: false, swallow: false, holdDeadlineMs: 2500 });
    expect(d.onHoldTimer(2499)).toBe(false);
    expect(d.onHoldTimer(2500)).toBe(true);
    expect(d.onHoldTimer(2600)).toBe(false);
    // Later repeats are swallowed and never fire again.
    expect(d.onKey(down(PP, 2600, { repeat: true }))).toEqual({
      fire: false,
      swallow: true,
      holdDeadlineMs: null,
    });
  });

  it('a hold fires from a repeat after the deadline, and that repeat is swallowed', () => {
    const d = new GestureDetector(DEFAULT_TV_BINDING);
    d.onKey(down(PP, 0));
    const verdicts = [];
    for (let t = 500; t <= 2000; t += 100) verdicts.push(d.onKey(down(PP, t, { repeat: true })));
    const fired = verdicts.filter((v) => v.fire);
    expect(fired).toHaveLength(1);
    const firedAt = verdicts.findIndex((v) => v.fire);
    expect(500 + firedAt * 100).toBe(1500);
    expect(verdicts[firedAt]).toEqual({ fire: true, swallow: true, holdDeadlineMs: null });
    for (const v of verdicts.slice(0, firedAt)) expect(v.swallow).toBe(false);
    for (const v of verdicts.slice(firedAt + 1))
      expect(v).toMatchObject({ fire: false, swallow: true });
    expect(d.onHoldTimer(2100)).toBe(false);
  });

  it('a repeat counts as a repeat even without event.repeat', () => {
    const d = new GestureDetector(DEFAULT_TV_BINDING);
    d.onKey(down(PP, 0));
    expect(d.onKey(down(PP, 1600))).toMatchObject({ fire: true, swallow: true });
  });

  it('a tap and rapid taps never fire', () => {
    const d = new GestureDetector(DEFAULT_TV_BINDING);
    for (let i = 0; i < 10; i++) {
      expect(d.onKey(down(PP, i * 200)).fire).toBe(false);
      expect(d.onKey(up(PP, i * 200 + 120))).toEqual({
        fire: false,
        swallow: false,
        holdDeadlineMs: null,
      });
    }
    expect(d.onHoldTimer(5_000)).toBe(false);
  });

  it('the keyup after a long press fires is not swallowed', () => {
    const d = new GestureDetector(DEFAULT_TV_BINDING);
    d.onKey(down(PP, 0));
    expect(d.onHoldTimer(1500)).toBe(true);
    expect(d.onKey(up(PP, 1700))).toEqual({ fire: false, swallow: false, holdDeadlineMs: null });
    // The next press starts over.
    expect(d.onKey(down(PP, 3000)).holdDeadlineMs).toBe(4500);
    expect(d.onHoldTimer(4500)).toBe(true);
  });

  it('a repeat whose first down was never seen never fires', () => {
    const d = new GestureDetector(DEFAULT_TV_BINDING);
    for (let t = 0; t <= 3000; t += 100) {
      expect(d.onKey(down(PP, t, { repeat: true }))).toEqual({
        fire: false,
        swallow: false,
        holdDeadlineMs: null,
      });
    }
    expect(d.onHoldTimer(5000)).toBe(false);
    expect(d.onKey(up(PP, 3100))).toEqual({ fire: false, swallow: false, holdDeadlineMs: null });
  });

  it('other keys pass and do not disturb the hold', () => {
    const d = new GestureDetector(DEFAULT_TV_BINDING);
    d.onKey(down(PP, 0));
    expect(d.onKey(down(UP, 300))).toEqual({ fire: false, swallow: false, holdDeadlineMs: null });
    d.onKey(up(UP, 400));
    expect(d.onHoldTimer(1500)).toBe(true);
  });

  it('dropPending cancels a hold that has not fired', () => {
    const d = new GestureDetector(DEFAULT_TV_BINDING);
    d.onKey(down(PP, 0));
    d.dropPending();
    expect(d.onHoldTimer(1500)).toBe(false);
    expect(d.onKey(down(PP, 1600, { repeat: true })).fire).toBe(false);
  });

  it('dropPending keeps a fired key swallowed until its own up', () => {
    const d = new GestureDetector(DEFAULT_TV_BINDING);
    d.onKey(down(PP, 0));
    expect(d.onHoldTimer(1500)).toBe(true);
    d.dropPending();
    expect(d.onKey(down(PP, 1600, { repeat: true })).swallow).toBe(true);
    d.onKey(up(PP, 1700));
    expect(d.onKey(down(PP, 1800)).swallow).toBe(false);

    // The same for a sequence's completing key.
    const s = new GestureDetector(SEQ);
    s.onKey(down(UP, 0));
    s.onKey(up(UP, 50));
    s.onKey(down(UP, 100));
    s.onKey(up(UP, 150));
    s.onKey(down(DOWN, 200));
    s.onKey(up(DOWN, 250));
    expect(s.onKey(down(DOWN, 300)).fire).toBe(true);
    s.dropPending();
    expect(s.onKey(down(DOWN, 400, { repeat: true })).swallow).toBe(true);
    expect(s.onKey(up(DOWN, 500)).swallow).toBe(true);
    expect(s.onKey(down(DOWN, 600)).swallow).toBe(false);
  });

  it('reset forgets everything, including fired keys', () => {
    const d = new GestureDetector(DEFAULT_TV_BINDING);
    d.onKey(down(PP, 0));
    d.onHoldTimer(1500);
    d.reset();
    expect(d.onKey(down(PP, 1600, { repeat: true })).swallow).toBe(false);
    expect(d.onHoldTimer(9_000)).toBe(false);
  });
});

describe('GestureDetector — sequence', () => {
  function tap(d: GestureDetector, code: number, at: number) {
    const v = d.onKey(down(code, at));
    d.onKey(up(code, at + 80));
    return v;
  }

  it('holding a D-pad key to scroll never completes ↑↑↓↓', () => {
    const d = new GestureDetector(SEQ);
    const verdicts = [d.onKey(down(UP, 0))];
    for (let i = 1; i <= 30; i++) verdicts.push(d.onKey(down(UP, i * 30, { repeat: true })));
    verdicts.push(d.onKey(up(UP, 950)));
    verdicts.push(d.onKey(down(DOWN, 960)));
    for (let i = 1; i <= 30; i++) verdicts.push(d.onKey(down(DOWN, 960 + i * 5)));
    verdicts.push(d.onKey(up(DOWN, 1200)));
    expect(verdicts.some((v) => v.fire || v.swallow)).toBe(false);
  });

  it('↑↑↓↓ within 1000 ms fires on the last down and swallows its repeats and up', () => {
    const d = new GestureDetector(SEQ);
    expect(tap(d, UP, 0).fire).toBe(false);
    expect(tap(d, UP, 300).fire).toBe(false);
    expect(tap(d, DOWN, 600).fire).toBe(false);
    expect(d.onKey(down(DOWN, 1000))).toEqual({ fire: true, swallow: true, holdDeadlineMs: null });
    expect(d.onKey(down(DOWN, 1400, { repeat: true }))).toMatchObject({
      fire: false,
      swallow: true,
    });
    expect(d.onKey(down(DOWN, 1450))).toMatchObject({ fire: false, swallow: true });
    expect(d.onKey(up(DOWN, 1500))).toMatchObject({ fire: false, swallow: true });
    // History is cleared: one more ↓ does not fire again.
    expect(tap(d, DOWN, 1600).fire).toBe(false);
    expect(tap(d, DOWN, 1700).swallow).toBe(false);
  });

  it('↑↑↓↓ spread over 1200 ms does not fire', () => {
    const d = new GestureDetector(SEQ);
    tap(d, UP, 0);
    tap(d, UP, 400);
    tap(d, DOWN, 800);
    expect(tap(d, DOWN, 1200).fire).toBe(false);
    // The window slides: ↑↓↓ plus one more ↑↑↓↓ in time still fires.
    tap(d, UP, 2000);
    tap(d, UP, 2200);
    tap(d, DOWN, 2400);
    expect(tap(d, DOWN, 2600).fire).toBe(true);
  });

  it('an unmapped key in between breaks the sequence', () => {
    const d = new GestureDetector(SEQ);
    tap(d, UP, 0);
    tap(d, UP, 100);
    tap(d, 999, 150);
    tap(d, DOWN, 200);
    expect(tap(d, DOWN, 300).fire).toBe(false);
  });
});

describe('GestureDetector — chord', () => {
  it("a chord fires when the last binding key goes down, with SHIFT from the event's shiftKey", () => {
    const d = new GestureDetector(CHORD);
    // SHIFT's own keydown was never seen (or the engine does not send it).
    expect(d.onKey(down(B, 0, { shift: true }))).toEqual({
      fire: true,
      swallow: true,
      holdDeadlineMs: null,
    });
    expect(d.onKey(down(B, 400, { shift: true, repeat: true }))).toMatchObject({
      fire: false,
      swallow: true,
    });
    expect(d.onKey(up(B, 500, { shift: true }))).toMatchObject({ swallow: true });

    // B without shift does not fire.
    expect(d.onKey(down(B, 1000)).fire).toBe(false);
    d.onKey(up(B, 1100));

    // SHIFT down, then B: fires on B; SHIFT's events pass.
    const e = new GestureDetector(CHORD);
    expect(e.onKey(down(SHIFT, 0, { shift: true }))).toMatchObject({ fire: false, swallow: false });
    expect(e.onKey(down(B, 100, { shift: true }))).toMatchObject({ fire: true, swallow: true });
    expect(e.onKey(up(SHIFT, 200))).toMatchObject({ swallow: false });
    expect(e.onKey(up(B, 300))).toMatchObject({ swallow: true });
  });

  it('a key that is not in the binding never completes the chord', () => {
    const d = new GestureDetector(COLORS);
    d.onKey(down(RED, 0));
    expect(d.onKey(down(UP, 50)).fire).toBe(false);
    expect(d.onKey(down(BLUE, 100)).fire).toBe(true);
  });

  it('overlapping completions keep every fired key swallowed until its own up', () => {
    const d = new GestureDetector(COLORS);
    d.onKey(down(RED, 0));
    expect(d.onKey(down(BLUE, 100)).fire).toBe(true);
    expect(d.onKey(up(RED, 200)).swallow).toBe(false);
    expect(d.onKey(down(RED, 300)).fire).toBe(true);
    expect(d.onKey(down(BLUE, 400, { repeat: true })).swallow).toBe(true);
    expect(d.onKey(up(BLUE, 500)).swallow).toBe(true);
    expect(d.onKey(down(RED, 600, { repeat: true })).swallow).toBe(true);
    expect(d.onKey(up(RED, 700)).swallow).toBe(true);
  });

  it('dropPending forgets held chord keys', () => {
    const d = new GestureDetector(COLORS);
    d.onKey(down(RED, 0));
    d.dropPending();
    expect(d.onKey(down(BLUE, 100)).fire).toBe(false);
  });
});
