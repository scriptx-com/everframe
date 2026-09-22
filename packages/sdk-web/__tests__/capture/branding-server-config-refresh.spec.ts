// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Branding box wiring (spec 2026-08-25) — the adapter negotiates the
// `branding` feature token, applyLiveConfig writes the shared box on every
// successful config read, and onKill clears it (the companion-badge Fix B
// doctrine: a dead adapter's last-read value must never outlive it).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createClient } from '@traceitx/sdk-core';
import { createWebPlatformAdapter, type WebPlatformAdapter } from '../../src/adapter.js';
import {
  __getBrandingServerConfig,
  __setBrandingServerConfig,
  __subscribeBrandingServerConfig,
} from '../../src/branding/server-config.js';

const adapters: WebPlatformAdapter[] = [];
afterEach(() => {
  while (adapters.length) adapters.pop()!.__testCleanup();
  __setBrandingServerConfig(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function configResponse(): Response {
  return new Response(
    JSON.stringify({
      replayEnabled: false,
      replayDurationSec: 30,
      samplingRate: 1,
      branding: { watermark: false, theme: { accent: '#336699' } },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('branding server-config box', () => {
  it('negotiates the branding feature token and populates the box after init', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (urlOf(input).includes('/api/config')) return configResponse();
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createWebPlatformAdapter({ apiKey: 'k' });
    adapters.push(adapter);
    const client = createClient(adapter);
    client.init({ apiKey: 'k' });

    await adapter.__initReplay();
    // Mirrors provider.tsx's real sequencing: the post-init one-shot
    // __applyBreadcrumbsConfig() call is what populates the boxes.
    adapter.__applyBreadcrumbsConfig();

    expect(__getBrandingServerConfig()).toEqual({
      watermark: false,
      theme: { accent: '#336699' },
    });

    const call = fetchMock.mock.calls.find((c) =>
      urlOf(c[0] as RequestInfo | URL).includes('/api/config'),
    );
    const headers = (call![1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-TX-SDK-Features']).toContain('branding');
  });

  it('a subscriber is notified when the box value changes, and not on an identical rewrite', () => {
    // Direct box unit-test (no adapter): Task 6's useSyncExternalStore hook depends on this.
    const calls: number[] = [];
    const unsub = __subscribeBrandingServerConfig(() => calls.push(1));
    __setBrandingServerConfig({ watermark: true });
    __setBrandingServerConfig({ watermark: true }); // identical — no notify
    __setBrandingServerConfig({ watermark: false });
    unsub();
    __setBrandingServerConfig(undefined);
    expect(calls.length).toBe(2);
  });

  it('onKill() clears the box so a dead adapter never outlives it', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (urlOf(input).includes('/api/config')) return configResponse();
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createWebPlatformAdapter({ apiKey: 'k' });
    const client = createClient(adapter);
    client.init({ apiKey: 'k' });
    await adapter.__initReplay();
    adapter.__applyBreadcrumbsConfig();
    expect(__getBrandingServerConfig()).toBeDefined();

    client.kill();
    expect(__getBrandingServerConfig()).toBeUndefined();
  });
});
