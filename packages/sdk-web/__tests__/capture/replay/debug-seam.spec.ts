// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// The `config.debug` seam — the only way a device-attached debugger can read
// live replay state, since the lifecycle is reachable from nothing global.
// Absent unless the host opts in, and gone again when the adapter is killed.
import { describe, it, expect, afterEach } from 'vitest';
import { __getReplayTrace, __isReplayTraceEnabled, __resetReplayTrace } from '@everframe/sdk-core';
import { createWebPlatformAdapter, type WebPlatformAdapter } from '../../../src/adapter.js';
import { DEBUG_GLOBAL_KEY, type ReplayDebugSeam } from '../../../src/debug/seam.js';

const BASE = { apiKey: 'txx_test_key', appName: 'test', appVersion: '1.0.0' } as const;

const seam = (): ReplayDebugSeam | undefined =>
  (globalThis as Record<string, unknown>)[DEBUG_GLOBAL_KEY] as ReplayDebugSeam | undefined;

const adapters: WebPlatformAdapter[] = [];

function makeAdapter(debug?: boolean) {
  const adapter = createWebPlatformAdapter({ ...BASE, ...(debug === undefined ? {} : { debug }) });
  adapters.push(adapter);
  return adapter;
}

afterEach(() => {
  for (const a of adapters) a.__testCleanup?.();
  adapters.length = 0;
  // Redefine before delete: a spec may have installed a non-configurable-ish
  // property to exercise the hostile-global path.
  Object.defineProperty(globalThis, DEBUG_GLOBAL_KEY, {
    value: undefined,
    writable: true,
    configurable: true,
  });
  delete (globalThis as Record<string, unknown>)[DEBUG_GLOBAL_KEY];
  __resetReplayTrace();
});

describe('replay debug seam', () => {
  it('installs no global without config.debug', () => {
    makeAdapter();
    expect(seam()).toBeUndefined();
  });

  it('leaves the trace ring disarmed without config.debug', () => {
    makeAdapter();
    expect(__isReplayTraceEnabled()).toBe(false);
  });

  it('installs the global when config.debug is on', () => {
    makeAdapter(true);
    expect(typeof seam()?.replayState).toBe('function');
  });

  it('arms the trace ring when config.debug is on', () => {
    makeAdapter(true);
    expect(__isReplayTraceEnabled()).toBe(true);
  });

  it('reports the lifecycle state through the seam', () => {
    makeAdapter(true);
    expect(seam()?.replayState().lifecycle).toBe('IDLE');
  });

  it('reports recorder diagnostics through the seam', () => {
    makeAdapter(true);
    expect(seam()?.replayState().recorder).toMatchObject({ disabled: false, frames: 0 });
  });

  // Lifecycle state alone cannot distinguish "the server says off" from "the
  // config read never landed" — the pair is what makes a device read decisive.
  it('reports the config the SDK is actually gating on', () => {
    makeAdapter(true);
    expect(seam()?.replayState().config).toMatchObject({ replayEnabled: false });
  });

  it('reads back trace entries recorded by the lifecycle', () => {
    const adapter = makeAdapter(true);
    adapter.__replayLifecycle?.freeze(); // guarded no-op from IDLE — still traced
    expect(seam()?.replayTrace().map((e) => e.ev)).toContain('lifecycle.freeze');
  });

  // The seam handed back `configProvider.get()` by reference, so a page script
  // could flip replayEnabled / samplingRate / captureBodies on the live gate and
  // bypass the validated-200 requirement and the remote kill switch outright.
  it('hands back a config a caller cannot mutate', () => {
    makeAdapter(true);
    const cfg = seam()!.replayState().config as Record<string, unknown>;

    expect(() => {
      cfg['replayEnabled'] = true;
    }).toThrow();
  });

  it('does not let a mutation attempt reach the live gate', () => {
    const adapter = makeAdapter(true);
    const cfg = seam()!.replayState().config as Record<string, unknown>;
    try {
      cfg['replayEnabled'] = true;
    } catch {
      /* frozen in strict mode */
    }

    adapter.__replayLifecycle?.tryStart();

    expect(adapter.__replayLifecycle?.state).toBe('IDLE');
  });

  it('freezes nested config blocks too', () => {
    makeAdapter(true);
    const cfg = seam()!.replayState().config as { networkBodies?: Record<string, unknown> };
    if (cfg.networkBodies) {
      expect(Object.isFrozen(cfg.networkBodies)).toBe(true);
    }
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  // React StrictMode builds two adapters and commits the FIRST while the SECOND
  // installed last (provider.tsx documents this exact hazard — field bug
  // 2026-07-10 shipped 0 breadcrumbs through it). The DISCARDED adapter never
  // gets an effect cleanup, so ownership cannot be "whoever wrote the global
  // last"; it is whoever actually mounted.
  it("a discarded adapter's teardown leaves the live seam working", () => {
    const first = makeAdapter(true); // committed
    makeAdapter(true); // discarded, but installed last
    const discardedCleanup = adapters[1]!.__testCleanup;

    discardedCleanup();

    expect(seam()).toBeDefined();
    expect(__isReplayTraceEnabled()).toBe(true);
    expect(seam()!.replayState().lifecycle).toBe(first.__replayLifecycle?.state ?? null);
  });

  // A debug option must never stop the SDK mounting — that would lose every
  // report on the page, which is strictly worse than having no diagnostics.
  it('still constructs when the page owns a non-writable global of that name', () => {
    Object.defineProperty(globalThis, DEBUG_GLOBAL_KEY, {
      value: 'taken',
      writable: false,
      configurable: true,
    });

    expect(() => makeAdapter(true)).not.toThrow();
  });

  it('leaves the page\'s own property intact when it cannot install', () => {
    Object.defineProperty(globalThis, DEBUG_GLOBAL_KEY, {
      value: 'taken',
      writable: false,
      configurable: true,
    });

    const adapter = makeAdapter(true);
    adapter.onKill?.();

    expect((globalThis as Record<string, unknown>)[DEBUG_GLOBAL_KEY]).toBe('taken');
  });

  it('removes the global and disarms the ring when the adapter is killed', () => {
    const adapter = makeAdapter(true);
    adapter.onKill?.();
    expect(seam()).toBeUndefined();
    expect(__isReplayTraceEnabled()).toBe(false);
    expect(__getReplayTrace()).toEqual([]);
  });

  // Round-4 latch audit (alongside codex finding 2). `onKill()` DELETES the
  // global, and `adoptReplayDebugSeam()` — all `__initReplay()` does on a
  // remount — only re-points the sources behind it. So React StrictMode's
  // simulated unmount took `window.__everframeDebug` away for the life of the
  // page, in the one environment the seam exists to serve. Same revive
  // doctrine as `reportingKilled` and the recorder: only `__rebindCrumbHooks()`
  // brings it back, and a host that genuinely killed the client never calls it.
  it('comes back on a StrictMode remount (kill → rebind)', () => {
    const adapter = makeAdapter(true);
    adapter.onKill?.();
    expect(seam()).toBeUndefined();

    adapter.__rebindCrumbHooks();

    expect(typeof seam()?.replayState).toBe('function');
    expect(__isReplayTraceEnabled()).toBe(true);
  });

  it('stays gone after a genuine kill, and for a host that never asked for it', () => {
    const killed = makeAdapter(true);
    killed.onKill?.();
    expect(seam()).toBeUndefined();

    // No rebind for the killed one; a debug-less adapter rebinding must not
    // install a seam its host never opted into.
    const plain = makeAdapter();
    plain.__rebindCrumbHooks();

    expect(seam()).toBeUndefined();
  });
});
