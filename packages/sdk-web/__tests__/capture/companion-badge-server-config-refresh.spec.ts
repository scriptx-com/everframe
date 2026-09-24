// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Codex round-1 fix wave (2026-08-25) — findings 2 and 3 against the
// companion-badge dashboard-config feature (packages/sdk-react/src/adapter.ts):
//
//   Fix B (finding 2, partial by ruling — no owner/generation-aware writes):
//     `applyLiveConfig()` must bail once the adapter is killed, and
//     `onKill()` must clear the shared companion-badge box, so a dead
//     adapter's last-read server override never outlives it (a fresh
//     Provider mount otherwise inherited a killed instance's stale value
//     forever).
//   Fix C (finding 3): the thread-client's `refreshGate` (wired from a
//     visibility/wake refresh) re-resolves the shared config provider but,
//     before this fix, never called `applyLiveConfig()` — so a successful
//     wake-triggered refresh left the companion badge (and breadcrumb/body
//     budgets) stale until the next periodic tick (≤5 min away).
//
// Both exercised at the adapter level, mirroring
// capture/config-periodic-refresh.spec.ts's own direct-adapter style (no
// Provider/DOM needed — `adapter.__applyBreadcrumbsConfig()` and
// `adapter.threads` are both plain adapter-surface seams).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createClient } from '@everframe/sdk-core';
import { createWebPlatformAdapter, type WebPlatformAdapter } from '../../src/adapter.js';
import {
  __getCompanionBadgeServerConfig,
  __setCompanionBadgeServerConfig,
} from '../../src/companion/server-config.js';

const adapters: WebPlatformAdapter[] = [];
afterEach(() => {
  while (adapters.length) adapters.pop()!.__testCleanup();
  __setCompanionBadgeServerConfig(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function configResponse(companionBadgeEnabled: boolean): Response {
  return new Response(
    JSON.stringify({
      replayEnabled: false,
      replayDurationSec: 30,
      samplingRate: 1,
      companionBadge: { enabled: companionBadgeEnabled },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('Fix C: refreshGate() applies the live config immediately', () => {
  it('a wake()-triggered refresh updates the companion badge box without waiting for the periodic tick', async () => {
    vi.useFakeTimers();
    let companionBadgeEnabled = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (urlOf(input).includes('/api/config')) return configResponse(companionBadgeEnabled);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createWebPlatformAdapter({ apiKey: 'k' });
    adapters.push(adapter);
    const client = createClient(adapter);
    client.init({ apiKey: 'k' });

    await adapter.__initReplay();
    // Mirrors provider.tsx's real sequencing (initReplayPromiseRef's .then()):
    // __initReplay() alone does NOT call applyLiveConfig() — only the
    // periodic tick and refreshGate (Fix C) do. This one-shot post-init call
    // is what actually populates the box the first time.
    adapter.__applyBreadcrumbsConfig();
    expect(__getCompanionBadgeServerConfig()?.enabled).toBe(true); // precondition: box populated

    // Dashboard flips the badge off server-side.
    companionBadgeEnabled = false;
    expect(adapter.threads).toBeDefined(); // sanity: the thread client (and its refreshGate) exists

    // A deliberate wake — e.g. the Provider's visibilitychange listener —
    // must re-resolve config AND re-apply it, with NO fake-timer advance
    // (i.e. no periodic tick could possibly have fired).
    adapter.threads!.wake();
    await vi.waitFor(() => {
      expect(__getCompanionBadgeServerConfig()?.enabled).toBe(false);
    });
  });
});

describe('Fix B: killed-adapter guard + box clear on kill', () => {
  it('onKill() clears the companion badge box so a dead adapter\'s override never outlives it', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (urlOf(input).includes('/api/config')) return configResponse(true);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createWebPlatformAdapter({ apiKey: 'k' });
    const client = createClient(adapter);
    client.init({ apiKey: 'k' });

    await adapter.__initReplay();
    adapter.__applyBreadcrumbsConfig(); // mirrors provider.tsx's post-init one-shot apply — populates the box
    expect(__getCompanionBadgeServerConfig()).toBeDefined(); // precondition: box populated

    client.kill(); // routes to adapter.onKill()

    expect(__getCompanionBadgeServerConfig()).toBeUndefined();
    // Not registered in `adapters` — already killed, __testCleanup() would be redundant.
  });

  it('a killed adapter\'s applyLiveConfig() (__applyBreadcrumbsConfig) is a no-op — it must not resurrect the box', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (urlOf(input).includes('/api/config')) return configResponse(true);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createWebPlatformAdapter({ apiKey: 'k' });
    const client = createClient(adapter);
    client.init({ apiKey: 'k' });

    await adapter.__initReplay();
    adapter.__applyBreadcrumbsConfig(); // mirrors provider.tsx's post-init one-shot apply — populates the box
    client.kill(); // flips `killed`; onKill() also clears the box (asserted above)

    // Simulate a stale in-flight call landing after kill(): directly set a
    // sentinel the box must NOT be disturbed away from.
    __setCompanionBadgeServerConfig({ enabled: false });
    adapter.__applyBreadcrumbsConfig(); // -> applyLiveConfig(); must bail on `killed` before touching anything

    expect(__getCompanionBadgeServerConfig()).toEqual({ enabled: false });
  });
});
