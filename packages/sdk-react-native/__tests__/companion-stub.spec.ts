// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// Everframe Companion has been removed. The `companion` namespace stays as
// deprecated no-op stubs: `start()` warns once and reaches no native code,
// no handler is ever called, `useCompanion()` returns the same idle object on
// every render, and the deprecated config fields are accepted but never
// forwarded to native.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import NativeEverframe from '../src/NativeEverframe.js';
import { companion, useCompanion } from '../src/index.js';
import * as root from '../src/index.js';
import {
  __companionDeprecationCount,
  __resetCompanionDeprecation,
} from '../src/companion-deprecation.js';
import {
  __extractBridgeConfigForTesting as extractBridgeConfig,
  type RuntimeConfig,
} from '../src/runtime.js';

beforeEach(() => __resetCompanionDeprecation());
afterEach(() => {
  __resetCompanionDeprecation();
  vi.restoreAllMocks();
});

describe('deprecated Companion stubs (React Native)', () => {
  it('start() twice warns once and the TurboModule has no companion methods', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    companion.stop(); // stop before start is safe
    companion.start();
    companion.start();
    companion.stop();
    expect(__companionDeprecationCount()).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const nativeKeys = Object.keys(NativeEverframe as unknown as Record<string, unknown>);
    expect(nativeKeys).not.toContain('startCompanion');
    expect(nativeKeys).not.toContain('stopCompanion');
    expect(nativeKeys).not.toContain('signalCompanionReportRequestReady');
  });

  it('every on* returns an unsubscribe and never calls its handler', () => {
    const handler = vi.fn();
    const offs = [
      companion.onRunning(handler),
      companion.onState(handler),
      companion.onPairUrl(handler),
      companion.onCode(handler),
      companion.onAttachedUserName(handler),
      companion.onResolvedName(handler),
      companion.onAttachChallenge(handler),
    ];
    for (const off of offs) {
      off();
      off();
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('useCompanion returns the same idle object across rerenders', () => {
    const { result, rerender } = renderHook(() => useCompanion());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    expect(first).toEqual({
      state: 'unpaired',
      pairUrl: null,
      code: null,
      attachedUserName: null,
      resolvedName: null,
      attachChallenge: null,
      running: false,
    });
    expect(companion.useCompanion).toBe(useCompanion);
  });

  it('getEmitter and the test seams are not on the companion namespace or the package root', () => {
    const ns = companion as Record<string, unknown>;
    expect(ns.getEmitter).toBeUndefined();
    expect(ns.__companionDeprecationCount).toBeUndefined();
    expect((root as Record<string, unknown>).__resetCompanionDeprecation).toBeUndefined();
  });

  it('the deprecated config fields type-check and are not forwarded to native', () => {
    const config: RuntimeConfig = {
      sdkKey: 'k',
      attachPinUi: 'custom',
      companionDeviceId: 'x',
      companionBadge: { enabled: false, position: 'top-left' },
    };
    const bridge = extractBridgeConfig(config) as Record<string, unknown>;
    expect(Object.keys(bridge).filter((k) => /companion|attachPinUi/i.test(k))).toEqual([]);
  });
});
