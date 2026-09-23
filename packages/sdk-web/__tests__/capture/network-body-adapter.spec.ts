// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { createClient, __internalClientState } from '@everframe/sdk-core';
import {
  createWebPlatformAdapter,
  computeBodyCaptureEnabled,
  createSessionSampler,
} from '../../src/adapter.js';

describe('computeBodyCaptureEnabled (gate)', () => {
  it('is OFF when the server disables, regardless of veto/sampling', () => {
    expect(computeBodyCaptureEnabled(false, false, /*sampledIn*/ true)).toBe(false);
  });
  it('is OFF when the client vetoes even if the server enables', () => {
    expect(computeBodyCaptureEnabled(true, /*vetoed*/ true, true)).toBe(false);
  });
  it('is OFF when sampled out', () => {
    expect(computeBodyCaptureEnabled(true, false, /*sampledIn*/ false)).toBe(false);
  });
  it('is ON only when server-enabled AND not vetoed AND sampled in', () => {
    expect(computeBodyCaptureEnabled(true, false, true)).toBe(true);
  });

  // ==================== Round-6 review Finding F28 ====================
  //
  // Bodies are meaningless without a correlating SHIPPED network breadcrumb
  // (the envelope builder drops any `ref` with no matching crumb) —
  // `networkBodiesConfig.captureBodies` was independently toggleable from
  // `breadcrumbsConfig`, so a server config with bodies ON but breadcrumbs
  // OFF (or `kinds` omitting `network`) silently captured, then silently
  // dropped, every body. `crumbsExcludeNetwork` closes that at the capture
  // gate itself.
  it('is OFF when breadcrumbs exclude the network kind, even if server/veto/sampling all pass', () => {
    expect(computeBodyCaptureEnabled(true, false, true, /*crumbsExcludeNetwork*/ true)).toBe(false);
  });
  it('is ON when breadcrumbs include the network kind (happy path not over-gated)', () => {
    expect(computeBodyCaptureEnabled(true, false, true, /*crumbsExcludeNetwork*/ false)).toBe(true);
  });
  it('defaults crumbsExcludeNetwork to false when the 4th arg is omitted (back-compat)', () => {
    expect(computeBodyCaptureEnabled(true, false, true)).toBe(true);
  });
});

describe('createSessionSampler (memoized, lazily-drawn per-session sampler)', () => {
  it('does not draw while server-disabled, so the first real draw uses the resolved rate', () => {
    const s = createSessionSampler(() => 0.5);
    // Server disabled: must NOT draw against this (default-ish) 1.0 rate.
    expect(s(1.0, false)).toBe(false);
    // First REAL draw happens now, at the resolved rate 0.0 → 0.5 < 0.0 is false → sampled OUT.
    // A draw-before-guard bug would have memoized `true` from the 1.0 call above and wrongly return true here.
    expect(s(0.0, true)).toBe(false);
  });

  it('memoizes the decision after the first server-enabled draw', () => {
    const values = [0.1];
    let i = 0;
    const rng = () => values[Math.min(i++, values.length - 1)]!;
    const s = createSessionSampler(rng);
    expect(s(1.0, true)).toBe(true); // draw: 0.1 < 1.0 → true
    // Rate changed to 0.0 (would be false if redrawn) — still true: memoized.
    expect(s(0.0, true)).toBe(true);
  });

  it('is OFF when sampled out', () => {
    const s = createSessionSampler(() => 0.5);
    expect(s(0.3, true)).toBe(false);
  });
});

describe('network body buffer lives in client state (privacy seam)', () => {
  // `disabled: true` keeps the adapter from patching global fetch/XHR — this
  // test only exercises the sdk-core client-state buffer + kill zeroization.
  const freshClient = () => createClient(createWebPlatformAdapter({ apiKey: 'k', disabled: true }));

  it('a fresh client exposes a dedicated, empty networkBodies buffer', () => {
    const client = freshClient();
    const state = __internalClientState.get(client)!;
    expect(state.networkBodies).toBeDefined();
    expect(state.networkBodies.size).toBe(0);
  });

  it('client.kill() zeroizes the body buffer (no captured bodies survive kill)', () => {
    const client = freshClient();
    const state = __internalClientState.get(client)!;
    state.networkBodies.add({ ref: 1, t: 1, resBody: 'x'.repeat(10) });
    expect(state.networkBodies.size).toBe(1);
    client.kill();
    expect(state.networkBodies.size).toBe(0);
  });

  // F17 (round-4 review): the reviewer's repro was buffer `size` going
  // 1 → 0 → 1 across capture → client.kill() → one post-kill fetch. The prior
  // fix only used `.clear()` (a one-time wipe); an add() that lands AFTER
  // kill() — exactly what an in-flight body read's `.then()` does when it
  // resolves post-kill — would repopulate the "empty" buffer. `client.kill()`
  // must call the buffer's PERMANENT `kill()`, not `clear()`, so this can
  // never happen regardless of when a stray add() lands.
  it('F17: an add() attempted after client.kill() is a no-op (in-flight body read resolving post-kill)', () => {
    const client = freshClient();
    const state = __internalClientState.get(client)!;
    client.kill();
    state.networkBodies.add({ ref: 1, t: 1, resBody: 'late-arriving body' });
    expect(state.networkBodies.size).toBe(0);
  });
});
