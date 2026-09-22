// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// A failed config refresh is the quietest failure in the SDK: it fails closed,
// keeps replay OFF, and leaves a clean 200 in the network trace either way.
// Every distinct way it can fail names itself in the flight recorder.
//
// Status codes and reasons only — never the response body, never the API key.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createConfigProvider } from '../../src/types/replay/config-provider.js';
import {
  __enableReplayTrace,
  __getReplayTrace,
  __resetReplayTrace,
} from '../../src/debug/replay-trace.js';

const VALID = {
  replayEnabled: true,
  replayDurationSec: 30,
  samplingRate: 1,
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function providerWith(fetchImpl: typeof fetch) {
  return createConfigProvider({ fetchImpl, configUrl: 'https://x.test/api/config', apiKey: 'k' });
}

const last = (): Record<string, unknown> | undefined =>
  __getReplayTrace().filter((e) => e.ev === 'config.refresh').pop();

describe('config refresh tracing', () => {
  beforeEach(() => {
    __resetReplayTrace();
    __enableReplayTrace(true);
  });
  afterEach(() => {
    __resetReplayTrace();
  });

  it('records nothing while the trace is disarmed', async () => {
    __enableReplayTrace(false);
    await providerWith(async () => jsonResponse(VALID)).refresh();
    expect(__getReplayTrace()).toEqual([]);
  });

  it('records a validated success', async () => {
    await providerWith(async () => jsonResponse(VALID)).refresh();
    expect(last()).toMatchObject({ ok: true, reason: 'ok', replayEnabled: true });
  });

  it('records the status code of a non-200', async () => {
    await providerWith(async () => jsonResponse({}, 503)).refresh();
    expect(last()).toMatchObject({ ok: false, reason: 'http_error', status: 503 });
  });

  it('records a response that failed validation', async () => {
    await providerWith(async () => jsonResponse({ replayEnabled: 'yes' })).refresh();
    expect(last()).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('records a network rejection', async () => {
    await providerWith(async () => {
      throw new TypeError('Failed to fetch');
    }).refresh();
    expect(last()).toMatchObject({ ok: false, reason: 'threw' });
  });

  it('records a refresh skipped by the TTL window', async () => {
    const provider = providerWith(async () => jsonResponse(VALID));
    await provider.refresh();
    await provider.refresh();
    expect(last()).toMatchObject({ ok: true, reason: 'ttl_fresh' });
  });

  it('records a response superseded by a newer in-flight refresh', async () => {
    let resolveFirst: ((r: Response) => void) | undefined;
    let call = 0;
    const provider = providerWith(async () => {
      call += 1;
      if (call === 1) return new Promise<Response>((r) => (resolveFirst = r));
      return jsonResponse(VALID);
    });
    const first = provider.refresh({ force: true });
    const second = provider.refresh({ force: true });
    await second;
    resolveFirst!(jsonResponse(VALID));
    await first;
    expect(last()).toMatchObject({ ok: false, reason: 'superseded' });
  });
});
