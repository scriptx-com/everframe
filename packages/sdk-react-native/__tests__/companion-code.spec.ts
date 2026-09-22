// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// @vitest-environment jsdom
//
// Companion discovery (spec 2026-08-07) — JS half of the chain
//
//     native observable → bridge emit → JS listener → hook state
//
// for the values Wave 2 adds: the announce display `code`, the
// `attachedUserName` of the dashboard member who attached, and (naming spec
// 2026-08-24) the server-resolved device display `resolvedName`.
//
// WHAT THIS FILE ACTUALLY EXERCISES
// The `react-native` mock below stands in for RN's `NativeEventEmitter` ONLY.
// Every other link is real: the real `src/companion.ts`, the real
// `useCompanion()` hook, real React state, real effect teardown. A payload
// pushed through the fake emitter under an event name travels exactly the
// path a native `sendEvent` / `emitter.emit` payload travels, so deleting
// either subscription in `useCompanion` — or renaming either event constant
// on one side only — turns these tests red.
//
// The three-file event-name lock-step (companion.ts / TraceItXEventEmitter.swift
// / TraceItXModule.kt) and the `supportedEvents()` trap are covered separately
// in `companion-bridge-wiring.spec.ts`, which reads the native sources: the
// native halves of this chain have no runnable test host in this repo.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Per-file mock — deliberately overrides the package-wide `react-native` mock
// in `vitest.setup.ts`, which stubs only TurboModuleRegistry + UI primitives
// and has no NativeEventEmitter. `vi.mock` is hoisted, so the listener
// registry has to live INSIDE the factory and be re-exported for the tests to
// reach.
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
  return {
    __listeners: listeners,
    NativeEventEmitter: FakeNativeEventEmitter,
    // Non-undefined so `getEmitter()` doesn't take its __DEV__ warning branch.
    NativeModules: { TraceItXEventEmitter: {} },
    Platform: { OS: 'ios' },
    TurboModuleRegistry: {
      getEnforcing: () => ({
        startCompanion: vi.fn(),
        stopCompanion: vi.fn(),
        signalCompanionReportRequestReady: vi.fn(),
      }),
    },
  };
});

import { act, render } from '@testing-library/react';
import { createElement, type ReactElement } from 'react';
import * as RN from 'react-native';
import {
  onAttachedUserName,
  onCode,
  onResolvedName,
  start,
  useCompanion,
} from '../src/companion.js';

const CODE_EVENT = 'traceitx.companion.code';
const ATTACHED_USER_NAME_EVENT = 'traceitx.companion.attachedUserName';
const RESOLVED_NAME_EVENT = 'traceitx.companion.resolvedName';
const PAIR_URL_EVENT = 'traceitx.companion.pairUrl';
const STATE_EVENT = 'traceitx.companion.state';

const listeners = (
  RN as unknown as {
    __listeners: Map<string, Set<(payload: unknown) => void>>;
  }
).__listeners;

/** Drive the native side: deliver `payload` to every JS listener on `event`. */
function emitNative(event: string, payload: unknown): void {
  act(() => {
    for (const handler of [...(listeners.get(event) ?? [])]) handler(payload);
  });
}

function listenerCount(event: string): number {
  return listeners.get(event)?.size ?? 0;
}

/**
 * Render `useCompanion()` and expose its latest return value. Hand-rolled
 * rather than `renderHook` so the assertions read against a plain object and
 * the unmount path is the ordinary React one.
 */
function renderCompanion(): {
  latest: () => ReturnType<typeof useCompanion>;
  unmount: () => void;
} {
  let latest: ReturnType<typeof useCompanion> | undefined;
  function Probe(): ReactElement | null {
    latest = useCompanion();
    return null;
  }
  const view = render(createElement(Probe));
  return {
    latest: () => {
      if (latest === undefined) throw new Error('hook never rendered');
      return latest;
    },
    unmount: () => view.unmount(),
  };
}

describe('companion code + attachedUserName — native event → JS → hook state', () => {
  beforeEach(() => {
    // `src/companion.ts` caches one emitter per module instance, so the
    // listener registry is shared across tests in this file. Clear it so a
    // leaked subscription from an earlier test can't mask a missing one here.
    listeners.clear();
  });

  it('starts with code === null and attachedUserName === null', () => {
    const { latest, unmount } = renderCompanion();
    expect(latest().code).toBeNull();
    expect(latest().attachedUserName).toBeNull();
    expect(latest().resolvedName).toBeNull();
    unmount();
  });

  it('code follows the native event, including the flip back to null', () => {
    const { latest, unmount } = renderCompanion();

    emitNative(CODE_EVENT, 'TX-4821');
    expect(latest().code).toBe('TX-4821');

    // Re-announce after a reconnect mints a NEW code — the hook must track it,
    // not latch the first one.
    emitNative(CODE_EVENT, 'TX-9930');
    expect(latest().code).toBe('TX-9930');

    // Terminal socket close nulls it natively; that null must reach JS.
    emitNative(CODE_EVENT, null);
    expect(latest().code).toBeNull();

    unmount();
  });

  it('attachedUserName follows the native event, including the flip back to null', () => {
    const { latest, unmount } = renderCompanion();

    emitNative(ATTACHED_USER_NAME_EVENT, 'Dana Okafor');
    expect(latest().attachedUserName).toBe('Dana Okafor');

    // An ordinary QR bond carries no companion_user block — back to null.
    emitNative(ATTACHED_USER_NAME_EVENT, null);
    expect(latest().attachedUserName).toBeNull();

    unmount();
  });

  it('resolvedName follows the native event, including the flip back to null', () => {
    const { latest, unmount } = renderCompanion();

    emitNative(RESOLVED_NAME_EVENT, 'Conference Room TV');
    expect(latest().resolvedName).toBe('Conference Room TV');

    // A re-announce can resolve a different name (e.g. org config changed).
    emitNative(RESOLVED_NAME_EVENT, 'Lobby Display');
    expect(latest().resolvedName).toBe('Lobby Display');

    // No announce ever ran / announce failed — back to null.
    emitNative(RESOLVED_NAME_EVENT, null);
    expect(latest().resolvedName).toBeNull();

    unmount();
  });

  it('the two new values are independent of each other and of pairUrl/state', () => {
    const { latest, unmount } = renderCompanion();

    emitNative(PAIR_URL_EVENT, 'http://localhost:8787/r/tok');
    emitNative(STATE_EVENT, 'paired');
    emitNative(CODE_EVENT, 'TX-4821');

    // attachedUserName/resolvedName have had no event of their own — they
    // must still be null, proving each subscription is wired to its OWN
    // event name.
    expect(latest().attachedUserName).toBeNull();
    expect(latest().resolvedName).toBeNull();
    expect(latest().code).toBe('TX-4821');
    expect(latest().pairUrl).toBe('http://localhost:8787/r/tok');
    expect(latest().state).toBe('paired');

    emitNative(ATTACHED_USER_NAME_EVENT, 'Dana Okafor');
    expect(latest().attachedUserName).toBe('Dana Okafor');
    // ...and setting it must not disturb the code or resolvedName.
    expect(latest().code).toBe('TX-4821');
    expect(latest().resolvedName).toBeNull();

    emitNative(RESOLVED_NAME_EVENT, 'Conference Room TV');
    expect(latest().resolvedName).toBe('Conference Room TV');
    // ...and setting it must not disturb attachedUserName or code.
    expect(latest().attachedUserName).toBe('Dana Okafor');
    expect(latest().code).toBe('TX-4821');

    unmount();
  });

  it('unmount removes all new listeners', () => {
    const { unmount } = renderCompanion();
    expect(listenerCount(CODE_EVENT)).toBe(1);
    expect(listenerCount(ATTACHED_USER_NAME_EVENT)).toBe(1);
    expect(listenerCount(RESOLVED_NAME_EVENT)).toBe(1);

    unmount();

    expect(listenerCount(CODE_EVENT)).toBe(0);
    expect(listenerCount(ATTACHED_USER_NAME_EVENT)).toBe(0);
    expect(listenerCount(RESOLVED_NAME_EVENT)).toBe(0);
  });

  it('an unmounted hook stops tracking — a later event does not resurrect state', () => {
    const { latest, unmount } = renderCompanion();
    emitNative(CODE_EVENT, 'TX-4821');
    expect(latest().code).toBe('TX-4821');

    unmount();
    // No listener remains, so this reaches nobody. If teardown were missing,
    // React would warn about setting state on an unmounted tree AND the
    // listener count above would already have failed.
    emitNative(CODE_EVENT, 'TX-0000');
    expect(latest().code).toBe('TX-4821');
  });
});

describe('onCode / onAttachedUserName / onResolvedName — standalone, outside the hook', () => {
  beforeEach(() => {
    listeners.clear();
  });

  it('onCode delivers values and its unsubscribe stops delivery', () => {
    const seen: Array<string | null> = [];
    const off = onCode((code) => seen.push(code));
    expect(listenerCount(CODE_EVENT)).toBe(1);

    emitNative(CODE_EVENT, 'TX-4821');
    emitNative(CODE_EVENT, null);
    expect(seen).toEqual(['TX-4821', null]);

    off();
    expect(listenerCount(CODE_EVENT)).toBe(0);
    emitNative(CODE_EVENT, 'TX-9930');
    expect(seen).toEqual(['TX-4821', null]);
  });

  it('onAttachedUserName delivers values and its unsubscribe stops delivery', () => {
    const seen: Array<string | null> = [];
    const off = onAttachedUserName((name) => seen.push(name));
    expect(listenerCount(ATTACHED_USER_NAME_EVENT)).toBe(1);

    emitNative(ATTACHED_USER_NAME_EVENT, 'Dana Okafor');
    emitNative(ATTACHED_USER_NAME_EVENT, null);
    expect(seen).toEqual(['Dana Okafor', null]);

    off();
    expect(listenerCount(ATTACHED_USER_NAME_EVENT)).toBe(0);
    emitNative(ATTACHED_USER_NAME_EVENT, 'Someone Else');
    expect(seen).toEqual(['Dana Okafor', null]);
  });

  it('onResolvedName delivers values and its unsubscribe stops delivery', () => {
    const seen: Array<string | null> = [];
    const off = onResolvedName((name) => seen.push(name));
    expect(listenerCount(RESOLVED_NAME_EVENT)).toBe(1);

    emitNative(RESOLVED_NAME_EVENT, 'Conference Room TV');
    emitNative(RESOLVED_NAME_EVENT, null);
    expect(seen).toEqual(['Conference Room TV', null]);

    off();
    expect(listenerCount(RESOLVED_NAME_EVENT)).toBe(0);
    emitNative(RESOLVED_NAME_EVENT, 'Lobby Display');
    expect(seen).toEqual(['Conference Room TV', null]);
  });

  it('each subscribes to its own event name — no crosstalk', () => {
    const codes: Array<string | null> = [];
    const names: Array<string | null> = [];
    const resolved: Array<string | null> = [];
    const offCode = onCode((c) => codes.push(c));
    const offName = onAttachedUserName((n) => names.push(n));
    const offResolved = onResolvedName((n) => resolved.push(n));

    emitNative(CODE_EVENT, 'TX-4821');
    expect(codes).toEqual(['TX-4821']);
    expect(names).toEqual([]);
    expect(resolved).toEqual([]);

    emitNative(ATTACHED_USER_NAME_EVENT, 'Dana Okafor');
    expect(codes).toEqual(['TX-4821']);
    expect(names).toEqual(['Dana Okafor']);
    expect(resolved).toEqual([]);

    emitNative(RESOLVED_NAME_EVENT, 'Conference Room TV');
    expect(codes).toEqual(['TX-4821']);
    expect(names).toEqual(['Dana Okafor']);
    expect(resolved).toEqual(['Conference Room TV']);

    offCode();
    offName();
    offResolved();
  });
});

// External review, finding N5 — RN events don't replay to a listener
// attached after they fired. `start()` installs a module-scope cache
// (mirrors `installAttachChallengeCache`'s idempotency shape, see
// `companion-attach-challenge.spec.ts`'s identical replay describe) that
// keeps the latest `resolvedName` payload around so a name resolved before a
// given `onResolvedName` subscriber (or a later-mounted `useCompanion()`)
// attaches is still visible to it.
//
// Deliberately its OWN top-level describe, placed last: `start()`'s cache
// listener is installed once (idempotent) and, once installed, is NEVER
// removed by these tests — running these after every other describe's own
// listener-count assertions keeps that persistent subscription from
// perturbing them (same placement reasoning as the attach-challenge file).
describe('resolvedName module cache — replay to late subscribers (finding N5)', () => {
  // Deliberately NO `listeners.clear()` here (unlike every describe above):
  // the module-scope cache listener `start()` installs is the persistent
  // subscription under test, and clearing the fake emitter's registry
  // between tests would rip it out from under `_resolvedNameSub`'s
  // idempotency guard — `installResolvedNameCache()` would then see a
  // stale non-null `_resolvedNameSub` and skip re-registering into the
  // fresh (cleared) map, silently breaking every later test in this
  // describe. `companion-attach-challenge.spec.ts`'s identical replay
  // describe has the same omission for the same reason. Each test below
  // uses its own distinct payload value so the assertions stay unambiguous
  // despite the shared, cumulative cache state.

  it('a resolvedName emitted before any subscriber attaches is delivered to a later onResolvedName subscription', () => {
    start(); // idempotent — safe to call more than once across this describe

    // No onResolvedName subscriber exists yet when this fires.
    emitNative(RESOLVED_NAME_EVENT, 'Conference Room TV');

    // A NEW subscription attaching now must still observe it via the cache,
    // even though the underlying RN event already came and went.
    const seen: Array<string | null> = [];
    const off = onResolvedName((n) => seen.push(n));
    expect(seen).toEqual(['Conference Room TV']);

    off();
  });

  it('a resolvedName emitted before mount is visible to a later-mounted useCompanion() on first render', () => {
    start(); // idempotent

    emitNative(RESOLVED_NAME_EVENT, 'Lobby Display');

    // Mounted AFTER the event fired — no effect has run yet on first render.
    const { latest, unmount } = renderCompanion();
    expect(latest().resolvedName).toBe('Lobby Display');

    unmount();
  });

  it('a null (clear) event updates the cache so a later subscriber gets no stale replay', () => {
    start(); // idempotent

    emitNative(RESOLVED_NAME_EVENT, 'Conference Room TV');
    emitNative(RESOLVED_NAME_EVENT, null);

    const seen: Array<string | null> = [];
    const off = onResolvedName((n) => seen.push(n));
    // No synchronous replay — the cache holds null, and `onResolvedName`
    // only replays a non-null cached value (mirrors `onAttachChallenge`).
    expect(seen).toEqual([]);

    const { latest, unmount } = renderCompanion();
    expect(latest().resolvedName).toBeNull();

    off();
    unmount();
  });
});
