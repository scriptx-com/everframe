// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// setExtra resolver round trip (spec 2026-09-17 setExtra-resolver) — RN
// parity for the resolver form @traceitx/sdk-core / @traceitx/web already
// have. Native (Android/iOS) asks JS for a fresh value right before it
// drains pending attachments for a report, mirroring the companion
// `reportRequested`/`signalCompanionReportRequestReady` handshake in
// `companion.ts`. This file exercises the JS half of that handshake end to
// end: the real `src/runtime.ts`, the real `traceitx.extra.resolveRequested`
// listener it installs, real budgeting via `@traceitx/sdk-core`'s
// `budgetExtra`.
//
// WHAT THIS FILE ACTUALLY EXERCISES
// The `react-native` mock below stands in for RN's `NativeEventEmitter` and
// `TurboModuleRegistry` ONLY (mirrors `companion-code.spec.ts`'s harness). A
// payload pushed through the fake emitter under the event name travels
// exactly the path a native `emitter.emit(...)` payload travels, so deleting
// the listener in `runtime.ts` — or renaming the event constant on one side
// only — turns these tests red.
//
// ORDERING NOTE: `runtime.ts` keeps the resolver, and the
// `resolveRequested` listener subscription, at MODULE scope (matching
// `companion.ts`'s own style — see runtime.ts's comment on
// `_currentExtraResolver`). The listener is installed once and NEVER torn
// down (mirrors `installReportRequestedHandler`), so "the listener isn't
// installed yet" can only be observed by the FIRST test in this file that
// exercises the resolver form — it runs first, deliberately. Every other
// test's `afterEach` unmounts its runtime, which clears the resolver itself
// (but not the listener subscription), keeping `_currentExtraResolver`
// state isolated between tests.
import { describe, it, expect, afterEach, vi } from 'vitest';

// Per-file mock — deliberately overrides the package-wide `react-native`
// mock in `vitest.setup.ts`, which stubs only TurboModuleRegistry + UI
// primitives and has no NativeEventEmitter. `vi.mock` is hoisted, so the
// listener registry has to live INSIDE the factory and be re-exported for
// the tests to reach — same shape as `companion-code.spec.ts`.
vi.mock('react-native', () => {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  class FakeNativeEventEmitter {
    addListener(event: string, handler: (payload: unknown) => void) {
      let bucket = listeners.get(event);
      if (bucket === undefined) {
        bucket = new Set();
        listeners.set(event, bucket);
      }
      bucket.add(handler);
      return {
        remove: () => {
          listeners.get(event)?.delete(handler);
        },
      };
    }
  }
  const nativeMock = {
    configure: vi.fn(),
    configureSync: vi.fn(() => true),
    openReporter: vi.fn().mockResolvedValue({ status: 'cancelled' }),
    registerSensitiveRect: vi.fn(),
    setExtra: vi.fn(),
    setExtraResolverActive: vi.fn(),
    signalExtraResolverReady: vi.fn(),
  };
  return {
    __listeners: listeners,
    __nativeMock: nativeMock,
    NativeEventEmitter: FakeNativeEventEmitter,
    // Non-undefined so `getEmitter()` doesn't take its __DEV__ warning branch.
    NativeModules: { TraceItXEventEmitter: {} },
    Platform: { OS: 'ios' },
    TurboModuleRegistry: {
      getEnforcing: () => nativeMock,
    },
  };
});

import * as RN from 'react-native';
import { EXTRA_MAX_CHARS } from '@traceitx/sdk-core';
import { createRuntime } from '../src/runtime.js';
import { __setCurrentContext } from '../src/contextSeam.js';

const EXTRA_RESOLVE_REQUESTED_EVENT = 'traceitx.extra.resolveRequested';

const listeners = (
  RN as unknown as {
    __listeners: Map<string, Set<(payload: unknown) => void>>;
  }
).__listeners;

const nativeMock = (
  RN as unknown as {
    __nativeMock: {
      setExtra: ReturnType<typeof vi.fn>;
      setExtraResolverActive: ReturnType<typeof vi.fn>;
      signalExtraResolverReady: ReturnType<typeof vi.fn>;
    };
  }
).__nativeMock;

/** Drive the native side: deliver `payload` to every JS listener on `event`. */
function emitNative(event: string, payload: unknown): void {
  for (const handler of [...(listeners.get(event) ?? [])]) handler(payload);
}

function listenerCount(event: string): number {
  return listeners.get(event)?.size ?? 0;
}

let currentRt: ReturnType<typeof createRuntime> | undefined;

function mountProvider(): ReturnType<typeof createRuntime> {
  const rt = createRuntime({ apiKey: 'txx_test_key' });
  rt.mount();
  currentRt = rt;
  return rt;
}

describe('setExtra resolver round trip', () => {
  afterEach(() => {
    // Unmount clears `_currentExtraResolver` (module-scoped in runtime.ts)
    // so the NEXT test starts from a known state — see the file header note.
    currentRt?.unmount();
    currentRt = undefined;
    __setCurrentContext(null);
    vi.clearAllMocks();
  });

  // MUST run first in this file — see the file header's ORDERING NOTE.
  it('installs the resolveRequested listener lazily — never for a string/object-only host', () => {
    const rt = mountProvider();
    expect(listenerCount(EXTRA_RESOLVE_REQUESTED_EVENT)).toBe(0);
    rt.setExtra('plain string');
    expect(listenerCount(EXTRA_RESOLVE_REQUESTED_EVENT)).toBe(0);
    expect(nativeMock.setExtraResolverActive).not.toHaveBeenCalled();
    rt.setExtra(() => 'now a resolver');
    expect(listenerCount(EXTRA_RESOLVE_REQUESTED_EVENT)).toBe(1);
  });

  it('registering a resolver never invokes it, and pushes no value — only the presence flag', () => {
    const resolver = vi.fn(() => ({ screen: 'checkout' }));
    const rt = mountProvider();
    rt.setExtra(resolver);
    expect(resolver).not.toHaveBeenCalled();
    expect(nativeMock.setExtra).not.toHaveBeenCalled();
    expect(nativeMock.setExtraResolverActive).toHaveBeenCalledWith(true);
  });

  it('invokes the resolver, budgets an object result, and pushes the result when native asks', () => {
    const rt = mountProvider();
    const value = { screen: 'checkout', cartSize: 3 };
    const resolver = vi.fn(() => value);
    rt.setExtra(resolver);
    expect(resolver).not.toHaveBeenCalled();

    emitNative(EXTRA_RESOLVE_REQUESTED_EVENT, 'corr-1');

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(nativeMock.setExtra).toHaveBeenCalledWith(JSON.stringify(value));
    expect(nativeMock.signalExtraResolverReady).toHaveBeenCalledWith('corr-1');
  });

  it('invokes the resolver and forwards a string result verbatim when under budget', () => {
    const rt = mountProvider();
    const resolver = vi.fn(() => 'fresh player snapshot');
    rt.setExtra(resolver);

    emitNative(EXTRA_RESOLVE_REQUESTED_EVENT, 'corr-2');

    expect(nativeMock.setExtra).toHaveBeenCalledWith('fresh player snapshot');
    expect(nativeMock.signalExtraResolverReady).toHaveBeenCalledWith('corr-2');
  });

  it('an over-budget object result is OMITTED (pushed as empty string), never truncated — mirrors resolveClientExtra', () => {
    const rt = mountProvider();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resolver = vi.fn(() => ({ huge: 'y'.repeat(EXTRA_MAX_CHARS * 2) }));
    rt.setExtra(resolver);

    emitNative(EXTRA_RESOLVE_REQUESTED_EVENT, 'corr-3');

    expect(nativeMock.setExtra).toHaveBeenCalledWith('');
    expect(nativeMock.signalExtraResolverReady).toHaveBeenCalledWith('corr-3');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('an over-budget string result is OMITTED (unlike the eager string form, which forwards raw for native to truncate)', () => {
    const rt = mountProvider();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const big = 'x'.repeat(EXTRA_MAX_CHARS + 500);
    const resolver = vi.fn(() => big);
    rt.setExtra(resolver);

    emitNative(EXTRA_RESOLVE_REQUESTED_EVENT, 'corr-4');

    expect(nativeMock.setExtra).toHaveBeenCalledWith('');
    expect(nativeMock.signalExtraResolverReady).toHaveBeenCalledWith('corr-4');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('a throwing resolver fails open: extra is omitted, native still gets its ack, and nothing throws', () => {
    const rt = mountProvider();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resolver = vi.fn(() => {
      throw new Error('boom');
    });
    rt.setExtra(resolver);

    expect(() => emitNative(EXTRA_RESOLVE_REQUESTED_EVENT, 'corr-5')).not.toThrow();

    expect(nativeMock.setExtra).toHaveBeenCalledWith('');
    expect(nativeMock.signalExtraResolverReady).toHaveBeenCalledWith('corr-5');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('switching back to the string form clears the resolver and flips the presence flag off', () => {
    const rt = mountProvider();
    const resolver = vi.fn(() => 'stale');
    rt.setExtra(resolver);
    expect(nativeMock.setExtraResolverActive).toHaveBeenCalledWith(true);

    rt.setExtra('plain again');
    expect(nativeMock.setExtraResolverActive).toHaveBeenCalledWith(false);
    // The line above's own eager string push already called `setExtra`
    // once — clear call history so the assertion below is about what the
    // resolveRequested round trip itself does, not that unrelated push.
    nativeMock.setExtra.mockClear();

    emitNative(EXTRA_RESOLVE_REQUESTED_EVENT, 'corr-6');
    // The listener is still installed (never torn down), but there is no
    // resolver to invoke any more — nothing pushed, only the ack.
    expect(resolver).not.toHaveBeenCalled();
    expect(nativeMock.setExtra).not.toHaveBeenCalled();
    expect(nativeMock.signalExtraResolverReady).toHaveBeenCalledWith('corr-6');
  });

  it('a string/object-only host never calls setExtraResolverActive at all', () => {
    const rt = mountProvider();
    rt.setExtra('a');
    rt.setExtra({ b: 1 });
    rt.setExtra('c');
    expect(nativeMock.setExtraResolverActive).not.toHaveBeenCalled();
  });

  it('unmount clears the resolver and flips the presence flag off', () => {
    const rt = mountProvider();
    rt.setExtra(() => 'x');
    expect(nativeMock.setExtraResolverActive).toHaveBeenCalledWith(true);
    vi.clearAllMocks();

    rt.unmount();
    currentRt = undefined; // already unmounted; afterEach must not double-unmount
    expect(nativeMock.setExtraResolverActive).toHaveBeenCalledWith(false);
  });
});
