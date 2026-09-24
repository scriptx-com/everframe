// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Round-6 review Finding F28 (P1) — a valid admin configuration silently
// disabled the feature: `networkBodiesConfig.captureBodies` is independently
// toggleable from `breadcrumbsConfig`, so an operator could turn Network
// bodies ON while breadcrumbs are OFF (or `kinds` omits `network`). Every
// captured body was then silently dropped at encode time (the F14 fix
// filters `payload.networkBodies` down to entries matching a SHIPPED network
// crumb's `data.reqId`) — the dashboard showed the feature ON and uploaded
// nothing, with no diagnostic anywhere.
//
// Fixed by making `bodyCapture.enabled()` (adapter.ts) also require the live
// breadcrumbs config to have `network` in its kinds — see
// `computeBodyCaptureEnabled`'s doc comment. These specs drive the REAL
// adapter + REAL client wiring (same seams provider.tsx wires up), mirroring
// network-body-kill.spec.ts, so nothing is ever captured in the first place
// (rather than captured then silently dropped at encode time).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createClient, __internalClientState } from '@everframe/sdk-core';
import { createWebPlatformAdapter, type WebPlatformAdapter } from '../../src/adapter.js';

const adapters: WebPlatformAdapter[] = [];
afterEach(() => {
  while (adapters.length) adapters.pop()!.__testCleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

/** Flush pending microtasks (background body-capture `.then()` chains). */
async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** Build a wired adapter + client exactly like provider.tsx does, with the
 * config route answering the given `networkBodies`/`breadcrumbs` blocks so
 * real captures (or their absence) happen through production wiring.
 * `appFetchImpl` answers every non-config URL. */
function wireClient(
  configBody: Record<string, unknown>,
  appFetchImpl: (input: RequestInfo | URL) => Promise<Response>,
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (urlOf(input).includes('/api/config')) {
        return new Response(JSON.stringify(configBody), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return appFetchImpl(input);
    }),
  );
  const adapter = createWebPlatformAdapter({ apiKey: 'k' });
  adapters.push(adapter);
  const client = createClient(adapter);
  client.init({ apiKey: 'k' });
  adapter.__setNetworkBodiesBuffer(() => __internalClientState.get(client)?.networkBodies);
  return { adapter, client, buf: () => __internalClientState.get(client)!.networkBodies };
}

const jsonResponse = async () =>
  new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });

describe('F28: network body capture requires network breadcrumbs (end-to-end)', () => {
  it('server bodies ON + breadcrumbs disabled ⇒ nothing captured', async () => {
    const { adapter, buf } = wireClient(
      {
        replayEnabled: false,
        replayDurationSec: 30,
        samplingRate: 1,
        breadcrumbs: { enabled: false, kinds: ['network'], maxCount: 100, byteBudget: 16384, consoleEntryCap: 1024 },
        networkBodies: { captureBodies: true },
      },
      jsonResponse,
    );
    await adapter.__initReplay();

    await fetch('https://api.test/x');
    await flushMicrotasks();
    expect(buf().size).toBe(0);
  });

  it('server bodies ON + breadcrumbs enabled but kinds omit network ⇒ nothing captured', async () => {
    const { adapter, buf } = wireClient(
      {
        replayEnabled: false,
        replayDurationSec: 30,
        samplingRate: 1,
        breadcrumbs: { enabled: true, kinds: ['console', 'tap'], maxCount: 100, byteBudget: 16384, consoleEntryCap: 1024 },
        networkBodies: { captureBodies: true },
      },
      jsonResponse,
    );
    await adapter.__initReplay();

    await fetch('https://api.test/x');
    await flushMicrotasks();
    expect(buf().size).toBe(0);
  });

  it('server bodies ON + breadcrumbs enabled with network kind ⇒ captures (happy path not over-gated)', async () => {
    const { adapter, buf } = wireClient(
      {
        replayEnabled: false,
        replayDurationSec: 30,
        samplingRate: 1,
        breadcrumbs: { enabled: true, kinds: ['console', 'network'], maxCount: 100, byteBudget: 16384, consoleEntryCap: 1024 },
        networkBodies: { captureBodies: true },
      },
      jsonResponse,
    );
    await adapter.__initReplay();

    await fetch('https://api.test/x');
    await flushMicrotasks();
    expect(buf().size).toBe(1);
  });

  it('server bodies ON + breadcrumbs block absent ⇒ captures (matches BREADCRUMBS_CONFIG_DEFAULT: enabled + all kinds)', async () => {
    const { adapter, buf } = wireClient(
      {
        replayEnabled: false,
        replayDurationSec: 30,
        samplingRate: 1,
        networkBodies: { captureBodies: true },
      },
      jsonResponse,
    );
    await adapter.__initReplay();

    await fetch('https://api.test/x');
    await flushMicrotasks();
    expect(buf().size).toBe(1);
  });
});
