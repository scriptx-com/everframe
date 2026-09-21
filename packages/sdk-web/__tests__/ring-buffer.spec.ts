// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { RingBuffer } from '../src/internal/ring-buffer.js';

describe('RingBuffer', () => {
  it('respects capacity, evicts oldest first when overfilled', () => {
    const rb = new RingBuffer<number>(3);
    for (let i = 1; i <= 8; i++) rb.push(i);
    expect(rb.size()).toBe(3);
    expect(rb.snapshot()).toEqual([6, 7, 8]);
  });

  it('snapshot returns independent copy', () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1);
    rb.push(2);
    const snap = rb.snapshot() as number[];
    snap[0] = 999;
    expect(rb.snapshot()[0]).toBe(1);
  });

  it('clear empties the buffer', () => {
    const rb = new RingBuffer<string>(2);
    rb.push('a');
    rb.push('b');
    rb.clear();
    expect(rb.size()).toBe(0);
    expect(rb.snapshot()).toEqual([]);
  });

  it('throws on non-positive capacity', () => {
    expect(() => new RingBuffer<number>(0)).toThrow(/capacity/);
    expect(() => new RingBuffer<number>(-1)).toThrow(/capacity/);
    expect(() => new RingBuffer<number>(1.5)).toThrow(/capacity/);
  });
});
