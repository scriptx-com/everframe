// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Reporter identity recognition (spec 2026-08-06) — capability negotiation.
// The server only emits the `identity` config block (Task 7) when the
// request declares `identity` in `X-TX-SDK-Features`. Missing this token
// means `identity.enabled` is always undefined and the whole feature looks
// broken client-side with nothing in the logs to explain why — see the
// task-14 brief's "Capability negotiation — do not miss this" section.
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

describe('web adapter — identity capability negotiation', () => {
  it('declares identity (alongside replies/networkbodies) on the shared /api/config fetch', async () => {
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
    expect(features).toContain('identity');
  });
});
