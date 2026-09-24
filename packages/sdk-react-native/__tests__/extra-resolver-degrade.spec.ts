// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Review finding F3 (spec 2026-09-17 setExtra-resolver): `setExtra(resolver)`
// must never throw out of its own registration.
//
// `runtime.ts`'s `installExtraResolveHandler()` reaches `getEmitter()` →
// `new NativeEventEmitter(mod)` (`events.ts`), and RN's own constructor
// `invariant`-throws on iOS when the backing native module is missing (pod
// not linked / codegen not run) — exactly the case `getEmitter()`'s own doc
// comment warns about. Before this fix, that throw propagated straight out
// of `setExtra(() => ...)` into host render code. This file mocks
// `NativeEventEmitter` to throw exactly the way RN's real one does in that
// situation, and asserts `setExtra(resolver)`:
//   1. never throws,
//   2. degrades to the EAGER path — resolves the value once, right now, and
//      pushes it through the ordinary `setExtra` bridge method, instead of
//      silently losing `extra` forever (which is what registering a
//      resolver nobody can ever ask would do), and
//   3. still fails open if the resolver itself throws during that one eager
//      resolution.
//
// Separate file (not added to `extra-resolver.spec.ts`) because that file's
// `vi.mock('react-native', ...)` provides a WORKING `NativeEventEmitter` and
// relies on its listener being installed exactly once, at module scope,
// across the whole file (see its ORDERING NOTE) — a throwing emitter here
// would fight that invariant. A fresh module registry per test file keeps
// the two mocks from interfering.
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('react-native', () => {
  // Mirrors react-native's real `NativeEventEmitter` constructor behavior on
  // iOS when the backing native module is missing: `invariant(nativeModule
  // != null, ...)` throws. `NativeModules.EverframeEventEmitter` is left
  // `undefined` below (unlinked pod), so `events.ts`'s `getEmitter()` calls
  // `new NativeEventEmitter(undefined)`, which must throw here exactly like
  // it would on a real device.
  class ThrowingNativeEventEmitter {
    constructor() {
      throw new Error('`new NativeEventEmitter()` requires a non-null argument.');
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
    __nativeMock: nativeMock,
    NativeEventEmitter: ThrowingNativeEventEmitter,
    // No EverframeEventEmitter entry — the unlinked-pod case.
    NativeModules: {},
    Platform: { OS: 'ios' },
    TurboModuleRegistry: {
      getEnforcing: () => nativeMock,
    },
  };
});

import * as RN from 'react-native';
import { createRuntime } from '../src/runtime.js';
import { __setCurrentContext } from '../src/contextSeam.js';

const nativeMock = (
  RN as unknown as {
    __nativeMock: {
      setExtra: ReturnType<typeof vi.fn>;
      setExtraResolverActive: ReturnType<typeof vi.fn>;
      signalExtraResolverReady: ReturnType<typeof vi.fn>;
    };
  }
).__nativeMock;

let currentRt: ReturnType<typeof createRuntime> | undefined;

function mountProvider(): ReturnType<typeof createRuntime> {
  const rt = createRuntime({ apiKey: 'txx_test_key' });
  rt.mount();
  currentRt = rt;
  return rt;
}

describe('setExtra(resolver) degrades instead of throwing when the native listener cannot be installed', () => {
  afterEach(() => {
    currentRt?.unmount();
    currentRt = undefined;
    __setCurrentContext(null);
    vi.clearAllMocks();
  });

  // MUST run first in this file: `_extraResolveHandlerInstallWarned` is
  // module-scoped in `runtime.ts` and never resets, so "the warning hasn't
  // fired yet" is only observable from the very first `setExtra(resolver)`
  // call in this module's lifetime — mirrors `extra-resolver.spec.ts`'s own
  // ORDERING NOTE.
  it('warns at most once even across repeated setExtra(resolver) calls', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rt = mountProvider();

    rt.setExtra(() => 'a');
    rt.setExtra(() => 'b');
    rt.setExtra(() => 'c');

    const installWarnings = warnSpy.mock.calls.filter((call) =>
      String(call[0]).includes('could not install the native resolver listener'),
    );
    expect(installWarnings.length).toBe(1);
    warnSpy.mockRestore();
  });

  it('does not throw, and pushes the resolved value once through the eager path', () => {
    const rt = mountProvider();
    const resolver = vi.fn(() => 'resolved value');

    expect(() => rt.setExtra(resolver)).not.toThrow();

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(nativeMock.setExtra).toHaveBeenCalledWith('resolved value');
    // Never claims a resolver is active — there is no live round trip.
    expect(nativeMock.setExtraResolverActive).not.toHaveBeenCalledWith(true);
  });

  it('budgets an object result exactly like the working round trip would', () => {
    const rt = mountProvider();
    const value = { screen: 'checkout', cartSize: 3 };

    expect(() => rt.setExtra(() => value)).not.toThrow();

    expect(nativeMock.setExtra).toHaveBeenCalledWith(JSON.stringify(value));
  });

  it('still fails open if the resolver itself throws during the one eager resolution', () => {
    const rt = mountProvider();
    const resolver = vi.fn(() => {
      throw new Error('resolver blew up');
    });

    expect(() => rt.setExtra(resolver)).not.toThrow();

    expect(nativeMock.setExtra).toHaveBeenCalledWith('');
  });
});
