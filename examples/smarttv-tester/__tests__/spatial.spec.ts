// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { pickNextFocus, type Rect } from '../src/focus/spatial.js';

const rect = (left: number, top: number, size = 100): Rect => ({
  left,
  top,
  width: size,
  height: size,
});

// A 2x3 grid, 120px pitch:
//   a b c
//   d e f
const grid = [
  { id: 'a', rect: rect(0, 0) },
  { id: 'b', rect: rect(120, 0) },
  { id: 'c', rect: rect(240, 0) },
  { id: 'd', rect: rect(0, 120) },
  { id: 'e', rect: rect(120, 120) },
  { id: 'f', rect: rect(240, 120) },
];

const others = (id: string) => grid.filter((c) => c.id !== id);
const rectOf = (id: string) => grid.find((c) => c.id === id)!.rect;

describe('pickNextFocus', () => {
  it('moves to the adjacent tile in each direction from the middle', () => {
    expect(pickNextFocus(rectOf('e'), others('e'), 'left')).toBe('d');
    expect(pickNextFocus(rectOf('e'), others('e'), 'right')).toBe('f');
    expect(pickNextFocus(rectOf('e'), others('e'), 'up')).toBe('b');
  });

  it('returns null at an edge with nothing further in that direction', () => {
    expect(pickNextFocus(rectOf('a'), others('a'), 'left')).toBeNull();
    expect(pickNextFocus(rectOf('a'), others('a'), 'up')).toBeNull();
    expect(pickNextFocus(rectOf('f'), others('f'), 'down')).toBeNull();
  });

  it('prefers the aligned neighbour over a nearer but offset one', () => {
    // From "a", pressing right: "b" is aligned; "e" is diagonal. Even if we
    // nudge "e" closer on the x axis, the off-axis penalty keeps "b" winning.
    const nudged = [
      { id: 'b', rect: rect(140, 0) },
      { id: 'e', rect: rect(120, 120) },
    ];
    expect(pickNextFocus(rectOf('a'), nudged, 'right')).toBe('b');
  });

  it('skips candidates strictly behind the current rect', () => {
    // From "c", pressing right: everything is at or behind its center.
    expect(pickNextFocus(rectOf('c'), others('c'), 'right')).toBeNull();
  });

  it('falls diagonally when no aligned candidate exists', () => {
    // From "d", pressing up with "a" missing: "b" (diagonal) is the only
    // candidate above, so focus should still move rather than get stuck.
    const noA = others('d').filter((c) => c.id !== 'a');
    expect(pickNextFocus(rectOf('d'), noA, 'up')).toBe('b');
  });
});
