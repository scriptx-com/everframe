// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// The config field is `sdkKey`, but the wire did not change with it. Published
// clients (SDK 1.1.0 and earlier) and this one must look identical to the
// server: the key travels as `Authorization: Bearer <key>`, and on the vitals
// beacon, which cannot set headers, as the body field `apiKey` beside
// `payload`. Nothing sends a field called `sdkKey`. These tests pin that from
// the public config down to the request.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VitalsIngestRequest, type SessionSummary } from '@everframe/protocol';
import { init } from '../../src/init.js';
import type { Everframe } from '../../src/init.js';
import { createVitalsTransport } from '../../src/vitals/transport.js';

const KEY = 'evf_live_' + 'k'.repeat(32);

const SUMMARY: SessionSummary = {
  kind: 'summary',
  sessionId: '11111111-1111-4111-8111-111111111111',
  final: true,
  seq: 0,
  startedAt: 1_000,
  durationMs: 5_000,
  playtimeMs: 4_000,
  startupTimeMs: null,
  rebufferCount: 0,
  rebufferDurationMs: 0,
  bitrateMean: null,
  errorCount: 0,
  memPeak: 0,
  memAvg: 0,
  dims: { platform: 'web', appVersion: '1.0.0', sdkVersion: '1.0.0' },
};

type Call = { url: string; headers: Headers; body: unknown };

let calls: Call[];
let handles: Everframe[];

beforeEach(() => {
  calls = [];
  handles = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers), body: init?.body });
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
});

afterEach(() => {
  handles.forEach((h) => h.destroy());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('sdkKey on the wire', () => {
  it('init({ sdkKey }) authorizes the config request with the key as a Bearer token', async () => {
    handles.push(init({ sdkKey: KEY, appVersion: '1.0.0' }));
    await vi.waitFor(() => expect(calls.some((c) => c.url.includes('/api/config'))).toBe(true));
    const config = calls.find((c) => c.url.includes('/api/config'))!;
    expect(config.headers.get('Authorization')).toBe(`Bearer ${KEY}`);
    for (const call of calls) {
      expect(call.headers.has('sdkKey')).toBe(false);
      if (typeof call.body === 'string') expect(call.body).not.toContain('sdkKey');
    }
  });

  it('the vitals beacon body is exactly { apiKey, payload } and the server schema accepts it', async () => {
    const beaconFn = vi.fn().mockReturnValue(true);
    const send = createVitalsTransport({
      endpoint: 'https://ingest.example.test/api/ingest/vitals',
      sdkKey: KEY,
      isKilled: () => false,
      fetchFn: vi.fn(),
      beaconFn,
    });
    send(SUMMARY, { beacon: true });
    const [, blob] = beaconFn.mock.calls[0] as [string, Blob];
    const text = await blob.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['apiKey', 'payload']);
    expect(body.apiKey).toBe(KEY);
    expect(text.startsWith('{"apiKey":"')).toBe(true);
    expect(VitalsIngestRequest.parse(body).apiKey).toBe(KEY);
  });

  it('the vitals fetch path sends the key only in the Authorization header', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    const send = createVitalsTransport({
      endpoint: 'https://ingest.example.test/api/ingest/vitals',
      sdkKey: KEY,
      isKilled: () => false,
      fetchFn,
    });
    send(SUMMARY, { beacon: false });
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    const [, req] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(new Headers(req.headers).get('Authorization')).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(req.body as string)).toEqual({ payload: SUMMARY });
  });
});
