// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Report Resource Window (spec 2026-09-05) — capability negotiation. The
// server only emits the `resources` config block (the ingest API's
// config-route.ts) when the request declares `resources` in
// `X-TX-SDK-Features`. Missing this token means `resources.enabled` is
// always undefined and the whole feature is permanently, SILENTLY off —
// every other test in this suite would still pass. Mirrors
// `__tests__/reporter/identity-sdk-features.spec.ts`'s pattern for the
// `identity` token.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createWebPlatformAdapter } from '../../src/adapter.js';

const adapters: Array<{ __testCleanup: () => void }> = [];

afterEach(() => {
  while (adapters.length) adapters.pop()!.__testCleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

describe('web adapter — resources capability negotiation', () => {
  it('declares resources (alongside vitals/identity/etc.) on the shared /api/config fetch', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (urlOf(input).includes('/api/config')) {
        return new Response(
          JSON.stringify({ replayEnabled: false, replayDurationSec: 30, samplingRate: 1 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createWebPlatformAdapter({ apiKey: 'k' });
    adapters.push(adapter);
    await adapter.__initReplay();

    const configCall = fetchMock.mock.calls.find((c) => urlOf(c[0] as RequestInfo | URL).includes('/api/config'));
    expect(configCall).toBeDefined();
    const headers = configCall![1]?.headers as Record<string, string>;
    const features = headers['X-TX-SDK-Features']!.split(',').map((s) => s.trim());
    expect(features).toContain('resources');
  });

  it('starts the resource sampler once the server serves an enabled block, and stamps a report envelope with it', async () => {
    // Fake timers from the START — the sampler's own setInterval must be
    // registered against the SAME fake clock `vi.advanceTimersByTime` below
    // drives, or advancing it never ticks a sampler whose interval was
    // created against the real clock.
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
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
    };
    adapters.push(adapter);
    await adapter.__initReplay();
    // __initReplay() itself only fetches + attempts a replay start — it does
    // NOT call applyLiveConfig() (that's the periodic tick / refreshGate's
    // job). __testRefreshConfigNow() is the test-only hook every other
    // capability-gated-config spec in this package uses to force that same
    // apply (see e.g. __tests__/capture/replay-start-retry.spec.ts).
    await adapter.__testRefreshConfigNow();

    // One sample tick — RESOURCE_SAMPLE_INTERVAL_MS (2000ms).
    vi.advanceTimersByTime(2_000);

    const { stampResources } = await import('../../src/resources/stamp.js');
    const { buildEnvelope } = await import('@traceitx/sdk-core');
    const envelope = buildEnvelope({
      reportId: '00000000-0000-4000-8000-000000000000',
      submittedAt: new Date(0).toISOString(),
      sdk: { name: 'traceitx-web', version: '0.1.0', platform: 'web', formFactor: 'desktop' },
      reporter: { title: 'X', description: 'Y' },
      draft: { title: 'X', description: 'Y', excludedArtifacts: [], annotations: [], redactions: [] },
      device: {
        os: 'macOS',
        osVersion: '14.0',
        screenSize: { width: 1, height: 1 },
        pixelRatio: 1,
        locale: 'en',
        timezone: 'UTC',
      },
      app: { name: 'test-app', version: '1.0.0' },
      attachments: [],
    });
    stampResources(envelope);
    expect(envelope.payload.resources).toBeDefined();
    expect(envelope.payload.resources!.length).toBeGreaterThan(0);

    vi.useRealTimers();
  });
});
