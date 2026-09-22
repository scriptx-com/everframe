// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResourceSampler } from '../../src/vitals/resource-sampler.js';

const INTERVAL = 20_000;

type Sample = { t: number; mem: number; extras: Record<string, number> };

class FakePerformanceObserver {
  static instances: FakePerformanceObserver[] = [];
  callback: (list: { getEntries(): Array<{ duration: number }> }) => void;
  disconnected = false;
  constructor(callback: (list: { getEntries(): Array<{ duration: number }> }) => void) {
    this.callback = callback;
    FakePerformanceObserver.instances.push(this);
  }
  observe(_opts: unknown) {
    // no-op — tests push entries manually via emit()
  }
  disconnect() {
    this.disconnected = true;
  }
  emit(entries: Array<{ duration: number }>) {
    this.callback({ getEntries: () => entries });
  }
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

function stubMemory(usedJSHeapSize: number | undefined) {
  Object.defineProperty(performance, 'memory', {
    configurable: true,
    value: usedJSHeapSize === undefined ? undefined : { usedJSHeapSize },
  });
}

describe('startResourceSampler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakePerformanceObserver.instances = [];
    (globalThis as Record<string, unknown>).PerformanceObserver = FakePerformanceObserver;
    setVisibility('visible');
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>).PerformanceObserver;
    // @ts-expect-error — test-only cleanup of a stubbed getter
    delete document.visibilityState;
    // @ts-expect-error — test-only cleanup of a stubbed getter
    delete performance.memory;
    vi.restoreAllMocks();
  });

  it('emits a sample per interval with mem from performance.memory', () => {
    stubMemory(12_345);
    const samples: Sample[] = [];
    const stop = startResourceSampler({ onSample: (s) => samples.push(s) });

    vi.advanceTimersByTime(INTERVAL);
    expect(samples).toHaveLength(1);
    expect(samples[0].mem).toBe(12_345);

    vi.advanceTimersByTime(INTERVAL);
    expect(samples).toHaveLength(2);

    stop();
  });

  it('defaults mem to 0 when performance.memory is entirely absent', () => {
    stubMemory(undefined);
    const samples: Sample[] = [];
    const stop = startResourceSampler({ onSample: (s) => samples.push(s) });

    vi.advanceTimersByTime(INTERVAL);
    expect(samples).toHaveLength(1);
    expect(samples[0].mem).toBe(0);

    stop();
  });

  it('accumulates long-task durations into extras.longTaskMs and resets each tick', () => {
    stubMemory(0);
    const samples: Sample[] = [];
    const stop = startResourceSampler({ onSample: (s) => samples.push(s) });

    const observer = FakePerformanceObserver.instances[0];
    observer.emit([{ duration: 40 }, { duration: 60 }]);

    vi.advanceTimersByTime(INTERVAL);
    expect(samples[0].extras.longTaskMs).toBe(100);

    // No new entries before the second tick — should reset to 0.
    vi.advanceTimersByTime(INTERVAL);
    expect(samples[1].extras.longTaskMs).toBe(0);

    observer.emit([{ duration: 15 }]);
    vi.advanceTimersByTime(INTERVAL);
    expect(samples[2].extras.longTaskMs).toBe(15);

    stop();
  });

  it('emits no samples while hidden and resumes when visible again', () => {
    stubMemory(0);
    const samples: Sample[] = [];
    const stop = startResourceSampler({ onSample: (s) => samples.push(s) });

    setVisibility('hidden');
    vi.advanceTimersByTime(INTERVAL);
    expect(samples).toHaveLength(0);

    vi.advanceTimersByTime(INTERVAL);
    expect(samples).toHaveLength(0);

    setVisibility('visible');
    vi.advanceTimersByTime(INTERVAL);
    expect(samples).toHaveLength(1);

    stop();
  });

  it('discards long tasks accumulated during a hidden window instead of carrying them into the resumed sample', () => {
    stubMemory(0);
    const samples: Sample[] = [];
    const stop = startResourceSampler({ onSample: (s) => samples.push(s) });
    const observer = FakePerformanceObserver.instances[0];

    setVisibility('hidden');
    observer.emit([{ duration: 500 }, { duration: 250 }]);
    vi.advanceTimersByTime(INTERVAL);
    expect(samples).toHaveLength(0);

    setVisibility('visible');
    vi.advanceTimersByTime(INTERVAL);
    expect(samples).toHaveLength(1);
    expect(samples[0].extras.longTaskMs).toBe(0);

    stop();
  });

  it('stop() silences further samples and disconnects the observer', () => {
    stubMemory(0);
    const samples: Sample[] = [];
    const stop = startResourceSampler({ onSample: (s) => samples.push(s) });
    const observer = FakePerformanceObserver.instances[0];
    const disconnectSpy = vi.spyOn(observer, 'disconnect');

    stop();
    expect(disconnectSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(INTERVAL * 3);
    expect(samples).toHaveLength(0);
  });

  it('does not throw and yields longTaskMs 0 when PerformanceObserver is missing', () => {
    delete (globalThis as Record<string, unknown>).PerformanceObserver;
    stubMemory(0);
    const samples: Sample[] = [];
    let stop: () => void = () => {};
    expect(() => {
      stop = startResourceSampler({ onSample: (s) => samples.push(s) });
    }).not.toThrow();

    vi.advanceTimersByTime(INTERVAL);
    expect(samples).toHaveLength(1);
    expect(samples[0].extras.longTaskMs).toBe(0);

    stop();
  });

  it('reports loopLagMs as the overshoot of the actual elapsed time over intervalMs', () => {
    stubMemory(0);
    const samples: Sample[] = [];
    let clock = 0;
    const now = () => clock;
    const stop = startResourceSampler({ onSample: (s) => samples.push(s), now });

    // Simulate the timer firing "late": advance fake timers by the interval,
    // but bump the injected clock further to model event-loop overshoot.
    clock += INTERVAL + 250;
    vi.advanceTimersByTime(INTERVAL);
    expect(samples[0].extras.loopLagMs).toBe(250);

    stop();
  });

  // Codex round-2 finding R10 — after a BFCache restore or an OS/browser
  // freeze (the tab is suspended entirely — no timer tick fires at all
  // during the freeze), the FIRST tick after resume must not report the
  // whole frozen gap as loopLagMs. `visibilitychange` -> visible must reset
  // the baseline.
  it('resets the loopLagMs baseline on visibilitychange -> visible after a huge clock jump', () => {
    stubMemory(0);
    const samples: Sample[] = [];
    let clock = 0;
    const now = () => clock;
    const stop = startResourceSampler({ onSample: (s) => samples.push(s), now });

    setVisibility('hidden');
    clock += 6 * 60 * 60 * 1000; // 6h frozen — no timer tick fires during this gap
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange')); // resume signal — resets the baseline

    // The next real tick lands right on schedule (one intervalMs after the
    // reset) — loopLagMs must be ~0, not ~6h.
    vi.advanceTimersByTime(INTERVAL);
    expect(samples).toHaveLength(1);
    expect(samples[0].extras.loopLagMs).toBe(0);

    stop();
  });

  it('does NOT reset the baseline on a visibilitychange that is not actually visible', () => {
    stubMemory(0);
    const samples: Sample[] = [];
    let clock = 0;
    const now = () => clock;
    const stop = startResourceSampler({ onSample: (s) => samples.push(s), now });

    setVisibility('hidden');
    clock += 6 * 60 * 60 * 1000;
    document.dispatchEvent(new Event('visibilitychange')); // still hidden — must be a no-op

    setVisibility('visible');
    vi.advanceTimersByTime(INTERVAL);
    // No reset happened, so the whole 6h gap (minus this interval) still
    // shows up as loopLagMs on the first visible tick.
    expect(samples).toHaveLength(1);
    expect(samples[0].extras.loopLagMs).toBeGreaterThan(0);

    stop();
  });

  // Codex round-2 finding R10 — `pageshow` fires on a BFCache restore even
  // when `visibilitychange` does not (the page can be restored already
  // "visible"), so it needs its own reset independent of visibility state.
  it('resets the loopLagMs baseline on pageshow after a huge clock jump', () => {
    stubMemory(0);
    const samples: Sample[] = [];
    let clock = 0;
    const now = () => clock;
    const stop = startResourceSampler({ onSample: (s) => samples.push(s), now });

    clock += 6 * 60 * 60 * 1000; // BFCache restore — page was already 'visible' the whole time
    window.dispatchEvent(new Event('pageshow'));

    vi.advanceTimersByTime(INTERVAL);
    expect(samples).toHaveLength(1);
    expect(samples[0].extras.loopLagMs).toBe(0);

    stop();
  });

  it('stop() removes the visibilitychange and pageshow listeners', () => {
    stubMemory(0);
    const samples: Sample[] = [];
    let clock = 0;
    const now = () => clock;
    const stop = startResourceSampler({ onSample: (s) => samples.push(s), now });
    stop();

    clock += 6 * 60 * 60 * 1000;
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pageshow'));

    // Listeners removed by stop() — dispatching these must not throw or
    // resurrect sampling.
    vi.advanceTimersByTime(INTERVAL * 3);
    expect(samples).toHaveLength(0);
  });

  it('supports a custom intervalMs', () => {
    stubMemory(0);
    const samples: Sample[] = [];
    const stop = startResourceSampler({ onSample: (s) => samples.push(s), intervalMs: 5_000 });

    vi.advanceTimersByTime(5_000);
    expect(samples).toHaveLength(1);

    stop();
  });
});
