// @vitest-environment jsdom
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import * as React from 'react';
import { Platform } from 'react-native';
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureException, EverframeProvider, useEverframe } from '../src/index.js';
import NativeEverframe from '../src/NativeEverframe.js';
import { createRuntime, type RuntimeConfig, type Runtime } from '../src/runtime.js';
import { __getCurrentContext, __setCurrentContext } from '../src/contextSeam.js';

type Handler = (error: unknown, fatal?: boolean) => void;
const handled = vi.mocked(NativeEverframe.captureHandledException);
const automatic = vi.mocked(NativeEverframe.reportCrash);
let current: Handler;
let predecessor: ReturnType<typeof vi.fn<Handler>>;
const runtimes: Runtime[] = [];
function mount(config: Partial<RuntimeConfig> = {}) {
  const runtime = createRuntime({ apiKey: 'txx_test_key', ...config });
  runtimes.push(runtime);
  runtime.mount();
  return runtime;
}
function error(frame: string) {
  return Object.assign(new Error('boom'), { stack: `Error: boom\n at ${frame} (bundle.js:12:3)` });
}
function provider(config: Partial<RuntimeConfig> = {}) {
  return ({ children }: { children: React.ReactNode }) => (
    <EverframeProvider config={{ apiKey: 'txx_test_key', ...config }}>{children}</EverframeProvider>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  handled.mockReset().mockReturnValue(true);
  automatic.mockReset().mockReturnValue(true);
  predecessor = vi.fn<Handler>();
  current = predecessor;
  vi.stubGlobal('ErrorUtils', {
    getGlobalHandler: () => current,
    setGlobalHandler: (handler: Handler) => { current = handler; },
  });
});
afterEach(() => {
  cleanup();
  for (const runtime of runtimes.splice(0)) runtime.unmount();
  __setCurrentContext(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('public captureException ownership', () => {
  it('snapshots deliberate details from the hook and top-level facade', () => {
    const { result } = renderHook(useEverframe, { wrapper: provider() });
    const nested = { state: 'before' };
    result.current.captureException(error('hook-details'), {
      severity: 'warning',
      context: 'checkout',
      metadata: { nested },
    });
    captureException(error('facade-details'), { metadata: { path: 'top-level' } });
    nested.state = 'after';

    expect(JSON.parse(handled.mock.calls[0]![0]).details).toEqual({
      severity: 'warning',
      context: 'checkout',
      metadata: { nested: { state: 'before' } },
    });
    expect(JSON.parse(handled.mock.calls[1]![0]).details).toEqual({
      severity: 'error',
      metadata: { path: 'top-level' },
    });
  });

  it('routes the real hook and public facade only while mounted and returns void', () => {
    expect(captureException(error('before'))).toBeUndefined();
    expect(handled).not.toHaveBeenCalled();
    const { result, unmount } = renderHook(useEverframe, { wrapper: provider() });
    const retained = result.current;
    expect(retained.captureException(error('hook'))).toBeUndefined();
    expect(captureException(error('facade'))).toBeUndefined();
    expect(handled).toHaveBeenCalledTimes(2);
    expect(JSON.parse(handled.mock.calls[0]![0])).toMatchObject({
      exceptionType: 'Error', message: 'boom', framesRaw: ['at hook (bundle.js:12:3)'],
      source: 'error', mechanism: 'captureException', handled: true, fatal: false,
    });
    unmount();
    retained.captureException(error('stale'));
    captureException(error('after'));
    const next = renderHook(useEverframe, { wrapper: provider() });
    retained.captureException(error('still-stale'));
    next.result.current.captureException(error('new'));
    expect(handled).toHaveBeenCalledTimes(3);
    expect(automatic).not.toHaveBeenCalled();
    expect(NativeEverframe.openReporter).not.toHaveBeenCalled();
    // Only configuration and crash facts crossed the native module boundary.
    for (const [name, fn] of Object.entries(NativeEverframe)) {
      if (vi.isMockFunction(fn) && !['configureSync', 'captureHandledException'].includes(name)) {
        expect(fn, name).not.toHaveBeenCalled();
      }
    }
  });

  it('disabled reporting gates both hook/facade and automatic capture', () => {
    const { result } = renderHook(useEverframe, { wrapper: provider({ crashReporting: { disabled: true } }) });
    result.current.captureException(error('hook'));
    captureException(error('facade'));
    current(error('automatic'), false);
    expect(handled).not.toHaveBeenCalled();
    expect(automatic).not.toHaveBeenCalled();
    expect(current).toBe(predecessor);
  });

  it.each(['absent', 'lookup', 'get', 'set'])('explicit capture survives %s ErrorUtils', (failure) => {
    if (failure === 'absent') vi.stubGlobal('ErrorUtils', undefined);
    else if (failure === 'lookup') Object.defineProperty(globalThis, 'ErrorUtils', {
      configurable: true, get() { throw new Error('lookup'); },
    });
    else vi.stubGlobal('ErrorUtils', {
      getGlobalHandler: () => { if (failure === 'get') throw new Error('get'); return predecessor; },
      setGlobalHandler: () => { throw new Error('set'); },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(useEverframe, { wrapper: provider() });
    result.current.captureException(error('available'));
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it('copies the validated Hermes metadata before host mutation', () => {
    const platform = Platform.OS;
    Platform.OS = 'android';
    vi.stubGlobal('HermesInternal', {});
    const jsBundle = { buildId: 'original-build', bundleName: 'index.android.bundle' };
    const { result } = renderHook(useEverframe, { wrapper: provider({ jsBundle }) });
    Platform.OS = platform;
    jsBundle.buildId = 'mutated-build';
    result.current.captureException(error('metadata'), { context: 'loaded-bundle' });
    current(error('automatic'), false);
    for (const call of [handled.mock.calls[0], automatic.mock.calls[0]]) {
      expect(JSON.parse(call![0]).jsBundle).toEqual({
        engine: 'hermes', platform: 'android', buildId: 'original-build', bundleName: 'index.android.bundle',
      });
    }
    expect(JSON.parse(handled.mock.calls[0]![0]).details).toEqual({
      severity: 'error', context: 'loaded-bundle',
    });
    expect(JSON.parse(automatic.mock.calls[0]![0]).details).toBeUndefined();
  });

  it.each(['missing', 'nonfunction', 'lookup', 'call'])('fails softly on %s native handled capability with no legacy explicit fallback', (failure) => {
    const runtime = mount();
    // Define the bridge property directly: RN host-object getters can throw too.
    const descriptor = Object.getOwnPropertyDescriptor(NativeEverframe, 'captureHandledException')!;
    try {
      Object.defineProperty(NativeEverframe, 'captureHandledException', failure === 'lookup'
        ? { configurable: true, get() { throw new Error('lookup'); } }
        : { configurable: true, value: failure === 'missing' ? undefined : failure === 'nonfunction' ? 42 : () => { throw new Error('call'); } });
      expect(() => runtime.captureException(error('explicit'))).not.toThrow();
      expect(automatic).not.toHaveBeenCalled();
      current(error('automatic'), false);
      expect(automatic).toHaveBeenCalledTimes(1);
      expect(JSON.parse(automatic.mock.calls[0]![0]).details).toBeUndefined();
    } finally {
      Object.defineProperty(NativeEverframe, 'captureHandledException', descriptor);
    }
  });

  it('keeps core handled facts independent when an older decoder ignores additive details', () => {
    let oldDecoderFacts: Record<string, unknown> | undefined;
    handled.mockImplementationOnce((payload) => {
      const { details: ignored, ...facts } = JSON.parse(payload);
      void ignored;
      oldDecoderFacts = facts;
      return true;
    });
    mount().captureException(error('old-decoder'), {
      severity: 'warning', context: 'new-js', metadata: { attempt: 1 },
    });

    expect(oldDecoderFacts).toMatchObject({
      exceptionType: 'Error', message: 'boom', framesRaw: ['at old-decoder (bundle.js:12:3)'],
      source: 'error', mechanism: 'captureException', handled: true, fatal: false,
    });
  });

  it('deactivates old ownership before teardown callbacks and preserves a different runtime remount', () => {
    let next: Runtime | undefined;
    let contextInTeardown: unknown;
    const old = mount({ integrations: [{ name: 'reentrant', setup: () => () => {
      contextInTeardown = __getCurrentContext();
      old.captureException(error('old'));
      captureException(error('facade-old'));
      current(error('auto-old'), false);
      next = mount();
      captureException(error('new'));
    } }] });
    old.unmount();
    expect(contextInTeardown).toBeNull();
    expect(handled).toHaveBeenCalledTimes(1);
    expect(automatic).not.toHaveBeenCalled();
    expect(__getCurrentContext()).toBe(next);
    old.unmount();
    expect(__getCurrentContext()).toBe(next);
  });

  it('detaches the old mount before same-runtime remount inside teardown', () => {
    let teardownCount = 0;
    const runtime = mount({ integrations: [{ name: 'remount', setup: () => () => {
      teardownCount++;
      runtime.captureException(error('inactive'));
      if (teardownCount === 1) runtime.mount();
    } }] });
    runtime.unmount();
    expect(__getCurrentContext()).toBe(runtime);
    captureException(error('remounted'));
    current(error('auto-remounted'), false);
    expect(handled).toHaveBeenCalledTimes(1);
    expect(automatic).toHaveBeenCalledTimes(1);
    runtime.unmount();
    expect(teardownCount).toBe(2);
    expect(__getCurrentContext()).toBeNull();
    captureException(error('after'));
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it('preserves a later handler and delegates through inactive retained wrappers after remount', () => {
    const old = mount();
    const oldWrapper = current;
    const later = vi.fn((value: unknown, fatal?: boolean) => oldWrapper(value, fatal));
    current = later;
    old.unmount();
    expect(current).toBe(later);
    const next = mount();
    const thrown = error('next');
    current(thrown, false);
    expect(automatic).toHaveBeenCalledTimes(1);
    expect(later).toHaveBeenCalledWith(thrown, false);
    expect(predecessor).toHaveBeenCalledWith(thrown, false);
    next.unmount();
    expect(current).toBe(later);
    current(error('inactive-chain'), true);
    expect(automatic).toHaveBeenCalledTimes(1);
    expect(predecessor).toHaveBeenCalledTimes(2);
  });

  it.each(['same', 'different'])('preserves the new handler when initial lookup remounts the %s runtime', (kind) => {
    const old = createRuntime({ apiKey: 'txx_test_key' });
    runtimes.push(old);
    const eu = (globalThis as unknown as { ErrorUtils: { getGlobalHandler: () => Handler } }).ErrorUtils;
    let reenter = true;
    let next: Runtime | undefined;
    let newWrapper: Handler | undefined;
    eu.getGlobalHandler = () => {
      const snapshot = current;
      if (reenter) {
        reenter = false;
        old.unmount();
        if (kind === 'same') { old.mount(); next = old; }
        else next = mount();
        newWrapper = current;
      }
      return snapshot;
    };

    old.mount();
    expect(newWrapper).toBeDefined();
    expect(current).toBe(newWrapper);
    expect(__getCurrentContext()).toBe(next);
    const thrown = error('initial-lookup-remount');
    current(thrown, false);
    expect(automatic).toHaveBeenCalledTimes(1);
    expect(JSON.parse(automatic.mock.calls[0]![0])).toMatchObject({
      mechanism: 'errorutils', message: 'boom', fatal: false,
    });
    expect(predecessor).toHaveBeenCalledExactlyOnceWith(thrown, false);
    next!.unmount();
    expect(__getCurrentContext()).toBeNull();
    expect(current).toBe(predecessor);
    current(error('inactive-after-remount'), false);
    newWrapper!(error('retained-after-remount'), true);
    old.captureException(error('old-after-remount'));
    captureException(error('facade-after-remount'));
    expect(automatic).toHaveBeenCalledTimes(1);
    expect(handled).not.toHaveBeenCalled();
  });

  it.each(['same', 'different'])('preserves the new handler when restore lookup remounts the %s runtime', (kind) => {
    const old = mount();
    const eu = (globalThis as unknown as { ErrorUtils: { getGlobalHandler: () => Handler } }).ErrorUtils;
    let reenter = true;
    let next: Runtime | undefined;
    let newWrapper: Handler | undefined;
    eu.getGlobalHandler = () => {
      const snapshot = current;
      if (reenter) {
        reenter = false;
        if (kind === 'same') { old.mount(); next = old; }
        else next = mount();
        newWrapper = current;
      }
      return snapshot;
    };

    old.unmount();
    expect(newWrapper).toBeDefined();
    expect(current).toBe(newWrapper);
    expect(__getCurrentContext()).toBe(next);
    const thrown = error('restore-lookup-remount');
    current(thrown, false);
    expect(automatic).toHaveBeenCalledTimes(1);
    expect(JSON.parse(automatic.mock.calls[0]![0])).toMatchObject({
      mechanism: 'errorutils', message: 'boom', fatal: false,
    });
    expect(predecessor).toHaveBeenCalledExactlyOnceWith(thrown, false);
    next!.unmount();
    current(error('inactive-after-remount'), false);
    expect(automatic).toHaveBeenCalledTimes(1);
  });
});
