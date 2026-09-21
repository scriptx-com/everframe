// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import {
  ResourceSample,
  MAX_RESOURCE_SAMPLES,
  RESOURCE_SAMPLE_INTERVAL_MS,
  RESOURCE_WINDOW_PRESETS,
  DEFAULT_RESOURCE_WINDOW_SEC,
} from '../src/index.js';

describe('ResourceSample', () => {
  it('round-trips a native sample with cpu', () => {
    const s = { t: 1756700000000, cpu: 0.42, mem: 52428800 };
    expect(ResourceSample.parse(s)).toEqual(s);
  });

  // Web emits NO cpu — there is no browser CPU API. This is the common
  // case for web reports, not an edge case.
  it('round-trips a web sample with cpu absent and extras present', () => {
    const s = { t: 1756700000000, mem: 12345, extras: { longTaskMs: 12, loopLagMs: 3 } };
    expect(ResourceSample.parse(s)).toEqual(s);
  });

  it('allows cpu above 1 (multicore: fraction of ONE core)', () => {
    expect(ResourceSample.parse({ t: 1, cpu: 3.5, mem: 0 }).cpu).toBe(3.5);
  });

  it('rejects negative cpu and negative mem', () => {
    expect(() => ResourceSample.parse({ t: 1, cpu: -0.1, mem: 0 })).toThrow();
    expect(() => ResourceSample.parse({ t: 1, mem: -1 })).toThrow();
  });

  // Bounded so a mis-computed delta cannot poison the admin chart's y-axis.
  it('rejects an absurd cpu reading', () => {
    expect(() => ResourceSample.parse({ t: 1, cpu: 5000, mem: 0 })).toThrow();
  });

  it('requires mem', () => {
    expect(() => ResourceSample.parse({ t: 1 })).toThrow();
  });

  it('pins the shared constants', () => {
    expect(MAX_RESOURCE_SAMPLES).toBe(256);
    expect(RESOURCE_SAMPLE_INTERVAL_MS).toBe(2_000);
    expect(RESOURCE_WINDOW_PRESETS).toEqual([30, 60, 120]);
    expect(DEFAULT_RESOURCE_WINDOW_SEC).toBe(60);
  });

  // The cap must comfortably exceed the worst legal config so a legitimate
  // full window is never truncated: 120s / 2s = 60 samples.
  it('caps above the worst legal window/interval combination', () => {
    const worst = (Math.max(...RESOURCE_WINDOW_PRESETS) * 1000) / RESOURCE_SAMPLE_INTERVAL_MS;
    expect(MAX_RESOURCE_SAMPLES).toBeGreaterThan(worst);
  });
});
