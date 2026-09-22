// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
// @vitest-environment jsdom
//
// The defect Finding 5 fixed on the KILL path existed unchanged on the
// CONFIG-DISABLE path: `applyLiveConfig()`'s `!enabled && resourceRing` branch
// ran `stopResourceSampler?.()` / `resourceRing.clear()` /
// `resourceRing = undefined` / `__setActiveResources(undefined)` inside ONE
// shared try, with the THROWABLE call first —
// `startResourceSampler()`'s disposer calls `observer?.disconnect()` unguarded
// (`resources/sampler.ts:114`). A throw there skipped all three zeroizations,
// so `__getActiveResources()` still pointed at a live ring and reports kept
// being stamped with resource samples after the server had set
// `resources.enabled: false` — the feature stayed ON for a customer who had
// explicitly turned it OFF, which is strictly worse than the kill-path variant
// (that one only leaks from an adapter already dead).
//
// Mirrors adapter-kill.spec.ts, including its sanity precondition: the stamp
// box must be armed BEFORE the disable, so this cannot pass vacuously against
// a box that was never populated.
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

describe('applyLiveConfig() neuters the resources stamp on config-disable even when the sampler disposer throws', () => {
  it('clears __getActiveResources() despite stopResourceSampler() throwing', async () => {
    let resourcesEnabled = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (urlOf(input).includes('/api/config')) {
        return new Response(
          JSON.stringify({
            replayEnabled: false,
            replayDurationSec: 30,
            samplingRate: 1,
            resources: { enabled: resourcesEnabled, windowSec: 60 },
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
    };
    adapters.push(adapter);
    await adapter.__initReplay();
    // Forces applyLiveConfig() — see sdk-features.spec.ts's identical seam.
    await adapter.__testRefreshConfigNow();

    // Fixture sanity: the sampler wiring actually armed the stamp box, so the
    // assertion below pins a real clear, not a box that was already empty.
    expect(__getActiveResources()).toBeDefined();

    // The server turns the feature OFF. The mocked disposer throws on the way
    // out — the stamp box must be neutered regardless.
    resourcesEnabled = false;
    await expect(adapter.__testRefreshConfigNow()).resolves.toBeUndefined();

    expect(__getActiveResources()).toBeUndefined();
  });
});
