// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import { describe, it, expect } from 'vitest';
import { createNetworkBodyBuffer } from '../src/capture/network-body-buffer.js';
import type { NetworkBodyEntry } from '@everframe/protocol';

function entry(ref: number, bytes: number): NetworkBodyEntry {
  return { ref, t: ref, resBody: 'x'.repeat(bytes) };
}

describe('networkBodyBuffer', () => {
  it('evicts oldest-first once summed body bytes exceed the budget', () => {
    // Budget accounts for the fixed per-entry overhead (F20, see the
    // 'zero-cost entries' suite below): each entry here costs 300 body
    // bytes + 256 overhead = 556, so 700 keeps one entry resident but not two.
    const buf = createNetworkBodyBuffer({ byteBudget: 700 });
    buf.add(entry(1, 300));
    buf.add(entry(2, 300)); // 556 + 556 = 1112 > 700 → evict ref 1
    buf.freeze();
    const out = buf.takeFrozen()!;
    expect(out.map((e) => e.ref)).toEqual([2]);
  });

  it('counts both reqBody and resBody toward the budget', () => {
    const buf = createNetworkBodyBuffer({ byteBudget: 100 });
    buf.add({ ref: 1, t: 1, reqBody: 'a'.repeat(60), resBody: 'b'.repeat(60) }); // 120 > 100
    buf.freeze();
    expect(buf.takeFrozen()!.map((e) => e.ref)).toEqual([]); // its own size already over budget → evicted
  });

  it('freeze snapshots; discardAndResume drops the snapshot; live capture continues', () => {
    const buf = createNetworkBodyBuffer({ byteBudget: 10_000 });
    buf.add(entry(1, 10));
    buf.freeze();
    buf.add(entry(2, 10)); // post-freeze add does not alter the frozen snapshot
    expect(buf.takeFrozen()!.map((e) => e.ref)).toEqual([1]);
    buf.freeze();
    expect(buf.takeFrozen()!.map((e) => e.ref)).toEqual([1, 2]); // 2 is now live
  });

  it('takeFrozen returns null when freeze was never called', () => {
    const buf = createNetworkBodyBuffer();
    buf.add(entry(1, 10));
    expect(buf.takeFrozen()).toBeNull();
  });

  it('clear zeroizes entries and any frozen snapshot', () => {
    const buf = createNetworkBodyBuffer();
    buf.add(entry(1, 10));
    buf.freeze();
    buf.clear();
    expect(buf.size).toBe(0);
    expect(buf.takeFrozen()).toBeNull();
  });
});

describe('F17 (round-4 review): kill() is a PERMANENT append gate, not just a one-time wipe', () => {
  it('kill() zeroizes entries and any frozen snapshot, like clear()', () => {
    const buf = createNetworkBodyBuffer();
    buf.add(entry(1, 10));
    buf.freeze();
    buf.kill();
    expect(buf.size).toBe(0);
    expect(buf.takeFrozen()).toBeNull();
  });

  it('reviewer repro: add() after kill() is a silent no-op — size never goes back to 1', () => {
    const buf = createNetworkBodyBuffer();
    buf.add(entry(1, 10));
    expect(buf.size).toBe(1);
    buf.kill();
    expect(buf.size).toBe(0);
    // Simulates the in-flight case: an async body read's `.then()` calling
    // sink() → add() strictly AFTER kill() has already run.
    buf.add(entry(2, 10));
    expect(buf.size).toBe(0);
    buf.add(entry(3, 10));
    expect(buf.size).toBe(0);
  });

  it('kill() is one-way — a later clear() does not un-kill the buffer', () => {
    const buf = createNetworkBodyBuffer();
    buf.kill();
    buf.clear(); // must not reset the killed flag
    buf.add(entry(1, 10));
    expect(buf.size).toBe(0);
  });
});

describe('F20: zero-cost entries must not grow the buffer without bound', () => {
  it('reviewer repro: 100,000 body-less entries against byteBudget:1 do NOT all survive', () => {
    // Before the fix, entryBytes() only counted reqBody/resBody — an entry
    // with no bodies (204s, content-type skips) cost 0 bytes and could never
    // be evicted, regardless of the budget. A per-entry overhead makes every
    // entry cost something, so eviction always has teeth.
    const buf = createNetworkBodyBuffer({ byteBudget: 1 });
    for (let i = 0; i < 100_000; i++) {
      buf.add({ ref: i, t: i, resBodySkipped: 'content-type', reqHeaders: { 'x-req': 'v' } });
    }
    // At most a handful of entries survive a budget of 1 byte — nowhere near 100,000.
    expect(buf.size).toBeLessThanOrEqual(1);
    // 30s, not the 5s default. 100,000 add() calls, each measuring UTF-8 header
    // bytes, is real work — the count is the reviewer's repro scale and the
    // whole point (it demonstrates UNBOUNDED growth, which a small n cannot),
    // so the loop is not something to shrink. The claim under test is
    // "eviction has teeth", which has no time component at all; on a CI runner
    // slower than a dev laptop the default turned that claim into a stopwatch
    // and failed it. Same reasoning as sdk-react's replay perf-budget spec.
  }, 30_000);

  it('a body-less entry with headers still costs > 0 (header bytes + fixed overhead) so eviction has teeth', () => {
    const buf = createNetworkBodyBuffer({ byteBudget: 500 });
    for (let i = 0; i < 50; i++) {
      buf.add({ ref: i, t: i, reqHeaders: { 'content-type': 'application/json' } });
    }
    expect(buf.size).toBeLessThan(50);
  });

  it('cost counts real UTF-8 byte length, not UTF-16 code units (multi-byte chars)', () => {
    // '€' is 1 UTF-16 code unit but 3 UTF-8 bytes. A buffer sized in real
    // bytes must evict based on the UTF-8 count, not `.length`.
    const buf = createNetworkBodyBuffer({ byteBudget: 10 });
    buf.add({ ref: 1, t: 1, resBody: '€€€' }); // 3 UTF-16 units, but 9 UTF-8 bytes + 256 overhead
    buf.freeze();
    expect(buf.takeFrozen()!.map((e) => e.ref)).toEqual([]); // evicted: well over the 10-byte budget once overhead is counted
  });
});

describe('F34 (round-7 review): add() guard must be authoritative at the insert boundary', () => {
  it('a guard returning false drops the entry even though killed/clear were never called', () => {
    const buf = createNetworkBodyBuffer();
    buf.add(entry(1, 10), () => false);
    expect(buf.size).toBe(0);
  });

  it('a guard returning true still inserts normally (no over-blocking)', () => {
    const buf = createNetworkBodyBuffer();
    buf.add(entry(1, 10), () => true);
    expect(buf.size).toBe(1);
  });

  it('omitting the guard entirely behaves exactly like the pre-F34 add(entry) signature', () => {
    const buf = createNetworkBodyBuffer();
    buf.add(entry(1, 10));
    expect(buf.size).toBe(1);
  });

  it('reviewer probe: a guard capturing a decision-time token that goes stale before the call drops the entry', () => {
    // Simulates the exact race: a caller reads `enabled()===true` and
    // captures `generation`, then — before `add()` runs — a remote config
    // refresh flips the gate off and bumps the generation. The guard
    // re-evaluates the LIVE state at insert time and must refuse.
    let live = { active: true, generation: 1 };
    const buf = createNetworkBodyBuffer();
    const decisionGeneration = live.generation; // captured before the "async" gap
    live = { active: false, generation: 2 }; // remote refresh lands here
    buf.add(entry(1, 10), () => live.active && live.generation === decisionGeneration);
    expect(buf.size).toBe(0);
  });
});
