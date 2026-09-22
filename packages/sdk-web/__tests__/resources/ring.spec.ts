// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Report Resource Window (spec 2026-09-05, Task 8) — the in-memory ring that
// holds the last N seconds of resource samples. `windowMs()` is read LIVE on
// every `snapshot()` call (not captured at construction), mirroring how
// `replayDurationSec` is re-read on every replay-lifecycle evaluation — a
// server-config refresh that changes the window takes effect without a
// restart.
import { describe, expect, it } from 'vitest';
import { MAX_RESOURCE_SAMPLES } from '@traceitx/protocol';
import { createResourceRing } from '../../src/resources/ring.js';

describe('createResourceRing', () => {
  it('drops samples older than the window', () => {
    let t = 0;
    const ring = createResourceRing({ windowMs: () => 60_000, now: () => t });
    ring.push({ t: 0, mem: 1 });
    t = 30_000;
    ring.push({ t: 30_000, mem: 2 });
    t = 70_000;
    ring.push({ t: 70_000, mem: 3 });
    expect(ring.snapshot().map((s) => s.mem)).toEqual([2, 3]);
  });

  // The window is read LIVE, so a config refresh takes effect without a
  // restart — same contract as replayDurationSec.
  it('honours a window that changes at runtime', () => {
    let t = 0;
    let win = 60_000;
    const ring = createResourceRing({ windowMs: () => win, now: () => t });
    ring.push({ t: 0, mem: 1 });
    t = 30_000;
    ring.push({ t: 30_000, mem: 2 });
    win = 10_000;
    expect(ring.snapshot().map((s) => s.mem)).toEqual([2]);
  });

  it('never exceeds MAX_RESOURCE_SAMPLES even inside the window', () => {
    const ring = createResourceRing({ windowMs: () => Infinity, now: () => 0 });
    for (let i = 0; i < MAX_RESOURCE_SAMPLES + 50; i++) ring.push({ t: 0, mem: i });
    const snap = ring.snapshot();
    expect(snap).toHaveLength(MAX_RESOURCE_SAMPLES);
    expect(snap.at(-1)!.mem).toBe(MAX_RESOURCE_SAMPLES + 49);
  });

  it('clears', () => {
    const ring = createResourceRing({ windowMs: () => 60_000, now: () => 0 });
    ring.push({ t: 0, mem: 1 });
    ring.clear();
    expect(ring.snapshot()).toEqual([]);
  });
});
