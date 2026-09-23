// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Report Resource Window (spec 2026-09-05, Task 8) — standalone web resource
// sampler. Deliberately NOT the same module as vitals/resource-sampler.ts
// (Global Constraints: Session Vitals is not touched) — this reimplements
// the same PerformanceObserver('longtask') guard and
// visibilitychange/pageshow baseline-reset behaviour from that file as a
// REFERENCE, independently, so the two features stay decoupled.
import { describe, expect, it, vi } from 'vitest';
import { RESOURCE_SAMPLE_INTERVAL_MS } from '@everframe/protocol';
import type { ResourceSampleT } from '@everframe/protocol';
import { startResourceSampler } from '../../src/resources/sampler.js';

describe('startResourceSampler', () => {
  it('emits mem and web extras, and never a cpu field', () => {
    vi.useFakeTimers();
    const seen: ResourceSampleT[] = [];
    const stop = startResourceSampler({ onSample: (s) => seen.push(s) });
    vi.advanceTimersByTime(RESOURCE_SAMPLE_INTERVAL_MS);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty('cpu');
    expect(seen[0].extras).toHaveProperty('longTaskMs');
    expect(seen[0].extras).toHaveProperty('loopLagMs');
    stop();
    vi.useRealTimers();
  });

  it('skips ticks while the tab is hidden', () => {
    vi.useFakeTimers();
    const seen: ResourceSampleT[] = [];
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const stop = startResourceSampler({ onSample: (s) => seen.push(s) });
    vi.advanceTimersByTime(RESOURCE_SAMPLE_INTERVAL_MS * 3);
    expect(seen).toEqual([]);
    stop();
    vi.useRealTimers();
  });

  // A lag delta computed across a freeze reports the ENTIRE frozen gap as
  // lag. Same bug vitals/resource-sampler.ts's resetBaseline fixes.
  //
  // Fix round 1 (Important finding) — the brief's original version of this
  // test (`vi.advanceTimersByTime(600_000)` BEFORE dispatching `pageshow`)
  // was vacuous: advancing fake timers fires every intermediate 2s tick on
  // the way, and every tick unconditionally updates `lastTick`
  // (sampler.ts), so no gap ever opens up for the reset to close — the
  // reviewer proved this by neutering `onPageShow` to a no-op and watching
  // all 5 tests still pass. THE FIX (mirroring
  // `__tests__/vitals/resource-sampler.spec.ts`'s own
  // "resets the loopLagMs baseline on pageshow after a huge clock jump",
  // lines 244-259 — read as reference, not imported/edited): inject a
  // manually-controlled `now` and advance THAT clock by a large amount
  // WITHOUT advancing fake timers. That is the key move — it simulates a
  // suspended tab where wall-clock moved but no timer (and so no tick) ever
  // fired, which is exactly the scenario `resetBaseline` exists for. Only
  // then advance fake timers by exactly one interval and assert the
  // resulting sample's `loopLagMs` is small.
  it('resets the lag baseline on pageshow so a freeze is not reported as lag', () => {
    vi.useFakeTimers();
    const seen: ResourceSampleT[] = [];
    let clock = 0;
    const now = () => clock;
    const stop = startResourceSampler({ onSample: (s) => seen.push(s), now });

    clock += 600_000; // wall-clock jumps 10m forward — NO timer tick fires during this gap
    window.dispatchEvent(new Event('pageshow'));

    vi.advanceTimersByTime(RESOURCE_SAMPLE_INTERVAL_MS);
    expect(seen).toHaveLength(1);
    expect(seen[0].extras!.loopLagMs).toBe(0);

    stop();
    vi.useRealTimers();
  });

  // Same reset wiring, the OTHER trigger (`visibilitychange` -> visible).
  // Same non-vacuous pattern as the pageshow test above, and the same
  // reference test in vitals/resource-sampler.spec.ts (lines 199-218) this
  // one mirrors.
  it('resets the lag baseline on visibilitychange -> visible so a freeze is not reported as lag', () => {
    vi.useFakeTimers();
    const seen: ResourceSampleT[] = [];
    let clock = 0;
    const now = () => clock;
    let visibility: 'visible' | 'hidden' = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const stop = startResourceSampler({ onSample: (s) => seen.push(s), now });

    visibility = 'hidden';
    clock += 600_000; // frozen while hidden — NO timer tick fires during this gap
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));

    vi.advanceTimersByTime(RESOURCE_SAMPLE_INTERVAL_MS);
    expect(seen).toHaveLength(1);
    expect(seen[0].extras!.loopLagMs).toBe(0);

    stop();
    vi.useRealTimers();
  });

  it('stops emitting after the returned disposer runs', () => {
    vi.useFakeTimers();
    const seen: ResourceSampleT[] = [];
    startResourceSampler({ onSample: (s) => seen.push(s) })();
    vi.advanceTimersByTime(RESOURCE_SAMPLE_INTERVAL_MS * 3);
    expect(seen).toEqual([]);
    vi.useRealTimers();
  });

  it('degrades to longTaskMs 0 when PerformanceObserver is unavailable', () => {
    vi.useFakeTimers();
    const orig = globalThis.PerformanceObserver;
    // @ts-expect-error deliberately removing the global
    delete globalThis.PerformanceObserver;
    const seen: ResourceSampleT[] = [];
    const stop = startResourceSampler({ onSample: (s) => seen.push(s) });
    vi.advanceTimersByTime(RESOURCE_SAMPLE_INTERVAL_MS);
    expect(seen[0].extras!.longTaskMs).toBe(0);
    stop();
    globalThis.PerformanceObserver = orig;
    vi.useRealTimers();
  });
});
