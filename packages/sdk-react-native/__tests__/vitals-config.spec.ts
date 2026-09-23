// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import NativeEverframe from '../src/NativeEverframe.js';
import { createRuntime, type RuntimeConfig } from '../src/runtime.js';
import { __setCurrentContext } from '../src/contextSeam.js';

const native = NativeEverframe as unknown as { configureSync: ReturnType<typeof vi.fn> };

describe('RuntimeConfig.vitals → flat ConfigOpts (spec 2026-09-06 §1)', () => {
  beforeEach(() => native.configureSync.mockClear());
  // Each `.mount()` below installs a module-level singleton context (single-
  // instance enforcement, T-06-05-04) — clear it between cases so the next
  // `.mount()` doesn't throw EverframeNotMountedError. Mirrors set-user.spec.ts.
  afterEach(() => __setCurrentContext(null));

  it('flattens all three fields when set', () => {
    createRuntime({ apiKey: 'k', vitals: { enabled: false, sampleRate: 0.25, captureSourceQuery: true } }).mount();
    expect(native.configureSync).toHaveBeenCalledWith(
      expect.objectContaining({ vitalsEnabled: false, vitalsSampleRate: 0.25, vitalsCaptureSourceQuery: true }),
    );
  });

  it('sends nothing when vitals is absent — natives keep their defaults', () => {
    createRuntime({ apiKey: 'k' }).mount();
    const opts = native.configureSync.mock.calls[0][0];
    expect('vitalsEnabled' in opts).toBe(false);
    expect('vitalsSampleRate' in opts).toBe(false);
    expect('vitalsCaptureSourceQuery' in opts).toBe(false);
  });

  it('sends only the fields that are present', () => {
    createRuntime({ apiKey: 'k', vitals: { sampleRate: 0.5 } }).mount();
    const opts = native.configureSync.mock.calls[0][0];
    expect(opts.vitalsSampleRate).toBe(0.5);
    expect('vitalsEnabled' in opts).toBe(false);
  });

  describe('sampleRate range guard', () => {
    // `__DEV__` is undefined under vitest (it is a Metro/RN global), and the
    // warning is deliberately DEV-only — set it for the cases that assert it.
    const g = globalThis as unknown as { __DEV__?: boolean };
    beforeEach(() => { g.__DEV__ = true; });
    afterEach(() => { delete g.__DEV__; });

    it('drops an out-of-range sampleRate and warns', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      createRuntime({ apiKey: 'k', vitals: { sampleRate: 50 } }).mount();
      const opts = native.configureSync.mock.calls[0][0];
      expect('vitalsSampleRate' in opts).toBe(false);
      expect(warn).toHaveBeenCalledWith('[everframe] vitals.sampleRate must be within 0..1; ignoring 50');
      warn.mockRestore();
    });

    it('drops a non-finite sampleRate', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      createRuntime({ apiKey: 'k', vitals: { sampleRate: NaN } }).mount();
      expect('vitalsSampleRate' in native.configureSync.mock.calls[0][0]).toBe(false);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it.each([0, 1, 0.25])('forwards an in-range sampleRate (%s)', (rate) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      createRuntime({ apiKey: 'k', vitals: { sampleRate: rate } }).mount();
      expect(native.configureSync.mock.calls[0][0].vitalsSampleRate).toBe(rate);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  it('the flat wire fields are NOT part of the host-facing RuntimeConfig (NN4)', () => {
    // @ts-expect-error — flat form must be a compile-time error
    const bad: RuntimeConfig = { apiKey: 'k', vitalsEnabled: false };
    void bad;
  });
});
