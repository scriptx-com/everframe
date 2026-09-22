// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// @vitest-environment jsdom
//
// Attach-PIN challenge bridging (spec 2026-08-19) — JS half of the chain
//
//     native observable → bridge emit → JS listener → hook state
//
// for `CompanionAttachChallenge`, mirroring `companion-code.spec.ts`'s
// harness for the sibling `code`/`attachedUserName` values.
//
// WHAT THIS FILE ACTUALLY EXERCISES
// The `react-native` mock below stands in for RN's `NativeEventEmitter` ONLY.
// Every other link is real: the real `src/companion.ts`, the real
// `useCompanion()` hook, real React state, real effect teardown. A payload
// pushed through the fake emitter under the event name travels exactly the
// path a native `sendEvent` / `emitter.emit` payload travels, so deleting
// the subscription in `useCompanion` — or renaming the event constant on one
// side only — turns these tests red.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
  onAttachChallenge,
  start,
  useCompanion,
  type CompanionAttachChallenge,
} from '../src/companion.js';

const ATTACH_CHALLENGE_EVENT = 'traceitx.companion.attachChallenge';

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

const SAMPLE_CHALLENGE: CompanionAttachChallenge = {
  code: '0427',
  requestedByName: 'Aurimas',
  ttlMs: 60000,
};

describe('onAttachChallenge — standalone, outside the hook', () => {
  beforeEach(() => {
    listeners.clear();
  });

  it('receives the challenge object when the native side emits it', () => {
    const seen: Array<CompanionAttachChallenge | null> = [];
    const off = onAttachChallenge((c) => seen.push(c));
    expect(listenerCount(ATTACH_CHALLENGE_EVENT)).toBe(1);

    emitNative(ATTACH_CHALLENGE_EVENT, SAMPLE_CHALLENGE);
    expect(seen).toEqual([SAMPLE_CHALLENGE]);

    off();
  });

  it('receives null when the native side emits null (clear)', () => {
    const seen: Array<CompanionAttachChallenge | null> = [];
    const off = onAttachChallenge((c) => seen.push(c));

    emitNative(ATTACH_CHALLENGE_EVENT, SAMPLE_CHALLENGE);
    emitNative(ATTACH_CHALLENGE_EVENT, null);
    expect(seen).toEqual([SAMPLE_CHALLENGE, null]);

    off();
  });

  it('unsubscribe stops delivery', () => {
    const seen: Array<CompanionAttachChallenge | null> = [];
    const off = onAttachChallenge((c) => seen.push(c));

    off();
    expect(listenerCount(ATTACH_CHALLENGE_EVENT)).toBe(0);
    emitNative(ATTACH_CHALLENGE_EVENT, SAMPLE_CHALLENGE);
    expect(seen).toEqual([]);
  });
});

describe('useCompanion() — attachChallenge', () => {
  beforeEach(() => {
    listeners.clear();
  });

  it('starts with attachChallenge === null', () => {
    const { latest, unmount } = renderCompanion();
    expect(latest().attachChallenge).toBeNull();
    unmount();
  });

  it('updates on the native event, including the flip back to null', () => {
    const { latest, unmount } = renderCompanion();

    emitNative(ATTACH_CHALLENGE_EVENT, SAMPLE_CHALLENGE);
    expect(latest().attachChallenge).toEqual(SAMPLE_CHALLENGE);

    emitNative(ATTACH_CHALLENGE_EVENT, null);
    expect(latest().attachChallenge).toBeNull();

    unmount();
  });

  it('is independent of the other four hook values', () => {
    const { latest, unmount } = renderCompanion();

    emitNative('traceitx.companion.code', 'TX-4821');
    emitNative(ATTACH_CHALLENGE_EVENT, SAMPLE_CHALLENGE);

    expect(latest().code).toBe('TX-4821');
    expect(latest().attachChallenge).toEqual(SAMPLE_CHALLENGE);

    unmount();
  });

  it('unmount removes the listener', () => {
    const { unmount } = renderCompanion();
    expect(listenerCount(ATTACH_CHALLENGE_EVENT)).toBe(1);

    unmount();
    expect(listenerCount(ATTACH_CHALLENGE_EVENT)).toBe(0);
  });
});

// Review finding 4 (2026-08-19 fix wave) — RN events don't replay to a
// listener attached after they fired. `start()` installs a module-scope
// cache (mirrors `installReportRequestedHandler`'s idempotency shape) that
// keeps the latest `attachChallenge` payload around so a challenge emitted
// before a custom-UI host's `onAttachChallenge` subscriber (or a
// later-mounted `useCompanion()`) attaches is still visible to it.
//
// Deliberately its OWN top-level describe, placed last: `start()`'s cache
// listener is installed once (idempotent) and, once installed, is NEVER
// removed by these tests — it should survive for the file's lifetime, the
// same way it survives for a real app's lifetime. Running these after every
// other describe's own listener-count assertions keeps that persistent
// subscription from perturbing them.
describe('attach-challenge module cache — replay to late subscribers (finding 4)', () => {
  // Round-2 review finding 4 made the cache's replay value a function of
  // `Date.now()` (time remaining until a stored deadline), so every test in
  // this describe now runs under fake timers — a real-clock run would still
  // pass in practice (the synchronous gap between caching and replaying is
  // microseconds), but pinning the clock makes the ttlMs assertions below
  // exact instead of merely "usually exact".
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a challenge emitted before any subscriber attaches is delivered to a later onAttachChallenge subscription', () => {
    // start() installs the cache listener (idempotent — safe to call more
    // than once across this describe's tests).
    start();

    // No onAttachChallenge subscriber exists yet when this fires.
    emitNative(ATTACH_CHALLENGE_EVENT, SAMPLE_CHALLENGE);

    // A NEW subscription attaching now must still observe it via the cache,
    // even though the underlying RN event already came and went. No time
    // has elapsed, so the replayed ttlMs is unchanged from the original.
    const seen: Array<CompanionAttachChallenge | null> = [];
    const off = onAttachChallenge((c) => seen.push(c));
    expect(seen).toEqual([SAMPLE_CHALLENGE]);

    off();
  });

  it('a challenge emitted before mount is visible to a later-mounted useCompanion() on first render', () => {
    start(); // idempotent

    const other: CompanionAttachChallenge = {
      code: '9911',
      requestedByName: 'Bob',
      ttlMs: 30_000,
    };
    emitNative(ATTACH_CHALLENGE_EVENT, other);

    // Mounted AFTER the event fired — no effect has run yet on first render.
    const { latest, unmount } = renderCompanion();
    expect(latest().attachChallenge).toEqual(other);

    unmount();
  });

  it('a null (clear) event updates the cache so a later subscriber sees null, not a stale challenge', () => {
    start(); // idempotent

    emitNative(ATTACH_CHALLENGE_EVENT, SAMPLE_CHALLENGE);
    emitNative(ATTACH_CHALLENGE_EVENT, null);

    const seen: Array<CompanionAttachChallenge | null> = [];
    const off = onAttachChallenge((c) => seen.push(c));
    // No synchronous replay call — the cache holds null, and `onAttachChallenge`
    // only replays a non-null cached value.
    expect(seen).toEqual([]);

    const { latest, unmount } = renderCompanion();
    expect(latest().attachChallenge).toBeNull();

    off();
    unmount();
  });

  // Round-2 review finding 4 — the fix itself: a late subscriber must see
  // time REMAINING until the cached deadline, never the original ttlMs a
  // stale replay would silently hand it.
  it('a subscriber attaching partway through a live challenge replays the REMAINING ttl, not the original', () => {
    start(); // idempotent

    emitNative(ATTACH_CHALLENGE_EVENT, SAMPLE_CHALLENGE); // ttlMs: 60_000
    vi.advanceTimersByTime(55_000); // 55s pass before anyone subscribes

    const seen: Array<CompanionAttachChallenge | null> = [];
    const off = onAttachChallenge((c) => seen.push(c));
    expect(seen).toEqual([{ ...SAMPLE_CHALLENGE, ttlMs: 5_000 }]);

    // useCompanion()'s seed goes through the same replay helper.
    const { latest, unmount } = renderCompanion();
    expect(latest().attachChallenge).toEqual({ ...SAMPLE_CHALLENGE, ttlMs: 5_000 });

    off();
    unmount();
  });

  it('a subscriber attaching after the deadline sees null, never a dead code', () => {
    start(); // idempotent

    emitNative(ATTACH_CHALLENGE_EVENT, SAMPLE_CHALLENGE); // ttlMs: 60_000
    // Past the deadline — this also fires the module-level expiry timer,
    // which nulls the cache outright (belt, alongside the inline
    // remaining<=0 check in `attachChallengeReplayValue()`, the suspenders).
    vi.advanceTimersByTime(60_000);

    const seen: Array<CompanionAttachChallenge | null> = [];
    const off = onAttachChallenge((c) => seen.push(c));
    // No synchronous replay — the cache is empty, same as it never having
    // held a challenge at all.
    expect(seen).toEqual([]);

    const { latest, unmount } = renderCompanion();
    expect(latest().attachChallenge).toBeNull();

    off();
    unmount();
  });
});
