// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
// @vitest-environment jsdom
//
// Round-review Finding 5 (2026-09-05) — `adapter.ts`'s `onKill()` used to run
// `stopResourceSampler?.()` / `stopResourceSampler = undefined` /
// `resourceRing = undefined` / `__setActiveResources(undefined)` inside ONE
// shared try/catch. `startResourceSampler()`'s returned disposer calls
// `observer?.disconnect()` unguarded (`resources/sampler.ts:114`) — a throw
// there would skip `__setActiveResources(undefined)` entirely, leaving the
// stamp box (`stamp.ts`'s `_active`) pointing at a ring this dead adapter no
// longer owns, so a report enqueued afterward could still get stamped with
// stale resource data. This pins that a throwing disposer still neuters the
// stamp — mirrors `capture/replay/adapter-kill-wiring.spec.ts`'s pattern of
// mocking the thing `onKill()` delegates to and observing the call.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/resources/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/resources/index.js')>();
  return {
    ...actual,
    startResourceSampler: () => () => {
      throw new Error('disconnect boom — simulates the unguarded observer?.disconnect() in resources/sampler.ts');
    },
  };
});

import { createWebPlatformAdapter } from '../../src/adapter.js';
import { __getActiveResources } from '../../src/resources/stamp.js';

const adapters: Array<{ __testCleanup: () => void }> = [];

afterEach(() => {
  while (adapters.length) adapters.pop()!.__testCleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

describe('adapter.onKill() neuters the resources stamp even when the sampler disposer throws', () => {
  it('clears __getActiveResources() despite stopResourceSampler() throwing', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (urlOf(input).includes('/api/config')) {
        return new Response(
          JSON.stringify({
            replayEnabled: false,
            replayDurationSec: 30,
            samplingRate: 1,
            resources: { enabled: true, windowSec: 60 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createWebPlatformAdapter({ apiKey: 'k' }) as unknown as {
      __initReplay(): Promise<void>;
      __testRefreshConfigNow(): Promise<void>;
      __testCleanup(): void;
      onKill?(): void;
    };
    adapters.push(adapter);
    await adapter.__initReplay();
    // Forces applyLiveConfig() — see sdk-features.spec.ts's identical seam.
    await adapter.__testRefreshConfigNow();

    // Fixture sanity: the sampler wiring actually armed the stamp box, so
    // the assertion below is pinning a real clear, not a box that was
    // already empty.
    expect(__getActiveResources()).toBeDefined();

    // The mocked disposer throws — onKill() must still neuter the stamp.
    expect(() => adapter.onKill?.()).not.toThrow();
    expect(__getActiveResources()).toBeUndefined();
  });
});
