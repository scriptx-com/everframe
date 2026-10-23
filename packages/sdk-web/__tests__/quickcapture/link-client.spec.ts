// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeviceLinkClient, UUID_RE } from '../../src/quickcapture/link-client.js';
import { installFetchPatcher } from '../../src/capture/network.js';
import { getNetworkSnapshot, networkBuffer } from '../../src/capture/buffers.js';
import type { HelloDevice } from '../../src/devicelink/tv-platform.js';

const INGEST = 'https://ingest.example';
const NONCE = 'N'.repeat(40);
const ID = '0b7c2c3e-8f2a-4c1d-9e1b-3f6a5d4c2b1a';
const TOKEN = 'evf_dev_' + 'Z'.repeat(32);
const DEVICE: HelloDevice = {
  model: 'QE55Q80B',
  os: 'Tizen',
  osVersion: '6.5',
  appVersion: '1.0.0',
  sdk: 'web/1.5.0',
  formFactor: 'tv',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type FetchSpy = ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>;

function client(fetchSpy: FetchSpy, timeoutMs?: number) {
  return createDeviceLinkClient({
    ingestUrl: `${INGEST}/`,
    sdkKey: 'sdk-key-1',
    fetch: fetchSpy as unknown as typeof fetch,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('device-link client', () => {
  it('UUID_RE accepts an 8-4-4-4-12 hex id in either case', () => {
    expect(UUID_RE.test(ID)).toBe(true);
    expect(UUID_RE.test(ID.toUpperCase())).toBe(true);
    expect(UUID_RE.test('x')).toBe(false);
    expect(UUID_RE.test(`${ID}/x`)).toBe(false);
  });

  it('hello posts the nonce and device with the SDK key and follows no redirects', async () => {
    const fetchSpy: FetchSpy = vi.fn(async () => json(200, { status: 'none' }));
    await client(fetchSpy).hello(NONCE, DEVICE);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(`${INGEST}/api/device-link/hello`);
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
    });
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer sdk-key-1');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ attemptNonce: NONCE, device: DEVICE });
  });

  it('hello maps none, pending, 429 and malformed replies', async () => {
    const cases: Array<[Response, unknown]> = [
      [json(200, { status: 'none' }), { kind: 'none' }],
      [
        json(200, { status: 'pending', attemptId: ID, number: 47 }),
        { kind: 'pending', attemptId: ID, number: 47 },
      ],
      [
        json(200, { status: 'pending', attemptId: ID, number: 0 }),
        { kind: 'pending', attemptId: ID, number: 0 },
      ],
      [json(429, { error: 'rate_limited' }), { kind: 'stop', rateLimited: true }],
      [
        json(200, { status: 'pending', attemptId: ID, number: 100 }),
        { kind: 'stop', rateLimited: false },
      ],
      [
        json(200, { status: 'pending', attemptId: ID, number: 4.5 }),
        { kind: 'stop', rateLimited: false },
      ],
      [
        json(200, { status: 'pending', attemptId: ID, number: true }),
        { kind: 'stop', rateLimited: false },
      ],
      [
        json(200, { status: 'pending', attemptId: 'x', number: 4 }),
        { kind: 'stop', rateLimited: false },
      ],
      [json(200, { status: 'weird' }), { kind: 'stop', rateLimited: false }],
      [new Response('not json', { status: 200 }), { kind: 'stop', rateLimited: false }],
      [json(500, {}), { kind: 'stop', rateLimited: false }],
      [json(401, {}), { kind: 'stop', rateLimited: false }],
    ];
    for (const [res, expected] of cases) {
      const fetchSpy: FetchSpy = vi.fn(async () => res);
      expect(await client(fetchSpy).hello(NONCE, DEVICE)).toEqual(expected);
    }
    const rejecting: FetchSpy = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await client(rejecting).hello(NONCE, DEVICE)).toEqual({
      kind: 'stop',
      rateLimited: false,
    });
  });

  it('check posts the nonce to the attempt and maps pending, linked, expired, 429, 500 and 404', async () => {
    const ok: FetchSpy = vi.fn(async () => json(200, { status: 'pending' }));
    expect(await client(ok).check(ID, NONCE)).toEqual({ kind: 'pending' });
    const [url, init] = ok.mock.calls[0]!;
    expect(url).toBe(`${INGEST}/api/device-link/attempts/${ID}/check`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' });
    expect(JSON.parse(init.body as string)).toEqual({ attemptNonce: NONCE });

    const cases: Array<[Response, unknown]> = [
      [
        json(200, { status: 'linked', token: TOKEN, owner: { kind: 'user', name: 'Aurimas' } }),
        { kind: 'linked', token: TOKEN, owner: { kind: 'user', name: 'Aurimas' } },
      ],
      [
        json(200, { status: 'linked', token: TOKEN, owner: { kind: 'team' } }),
        { kind: 'linked', token: TOKEN, owner: { kind: 'team' } },
      ],
      [json(200, { status: 'expired' }), { kind: 'expired' }],
      [json(429, {}), { kind: 'stop' }],
      [json(500, {}), { kind: 'retry' }],
      [json(503, {}), { kind: 'retry' }],
      [json(404, {}), { kind: 'expired' }],
      [json(400, {}), { kind: 'expired' }],
      [new Response('<html>portal</html>', { status: 200 }), { kind: 'retry' }],
    ];
    for (const [res, expected] of cases) {
      const fetchSpy: FetchSpy = vi.fn(async () => res);
      expect(await client(fetchSpy).check(ID, NONCE)).toEqual(expected);
    }
    const rejecting: FetchSpy = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await client(rejecting).check(ID, NONCE)).toEqual({ kind: 'retry' });
  });

  it('a malformed attempt id is expired without a request', async () => {
    const fetchSpy: FetchSpy = vi.fn(async () => json(200, { status: 'pending' }));
    expect(await client(fetchSpy).check('../../config', NONCE)).toEqual({ kind: 'expired' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a linked reply with a malformed token or owner reads as expired', async () => {
    for (const body of [
      { status: 'linked', token: 'evf_cap_' + 'a'.repeat(32), owner: { kind: 'team' } },
      { status: 'linked', token: TOKEN.slice(0, 20), owner: { kind: 'team' } },
      { status: 'linked', token: TOKEN, owner: { kind: 'nobody' } },
      { status: 'linked', token: TOKEN },
    ]) {
      const fetchSpy: FetchSpy = vi.fn(async () => json(200, body));
      expect(await client(fetchSpy).check(ID, NONCE)).toEqual({ kind: 'expired' });
    }
  });

  it('a body over 4096 characters is refused', async () => {
    const big = { status: 'none', pad: 'p'.repeat(5000) };
    const hello: FetchSpy = vi.fn(async () => json(200, big));
    expect(await client(hello).hello(NONCE, DEVICE)).toEqual({ kind: 'stop', rateLimited: false });
    const check: FetchSpy = vi.fn(async () =>
      json(200, { status: 'pending', pad: 'p'.repeat(5000) }),
    );
    expect(await client(check).check(ID, NONCE)).toEqual({ kind: 'retry' });
  });

  it('a hung request resolves at the timeout', async () => {
    vi.useFakeTimers();
    const hung: FetchSpy = vi.fn(() => new Promise<Response>(() => undefined));
    const c = client(hung);
    let hello: unknown = null;
    let check: unknown = null;
    void c.hello(NONCE, DEVICE).then((r) => (hello = r));
    void c.check(ID, NONCE).then((r) => (check = r));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(hello).toBeNull();
    expect(check).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(hello).toEqual({ kind: 'stop', rateLimited: false });
    expect(check).toEqual({ kind: 'retry' });
  });

  it('without any fetch, hello and check stop', async () => {
    const c = createDeviceLinkClient({ ingestUrl: INGEST, sdkKey: 'k', fetch: null });
    vi.stubGlobal('fetch', undefined);
    expect(await c.hello(NONCE, DEVICE)).toEqual({ kind: 'stop', rateLimited: false });
    expect(await c.check(ID, NONCE)).toEqual({ kind: 'stop' });
  });

  describe('with the network patcher installed', () => {
    beforeEach(() => networkBuffer.clear());

    it('requests bypass the network patcher', async () => {
      const original = vi.fn(async () =>
        json(200, { status: 'linked', token: TOKEN, owner: { kind: 'team' } }),
      );
      vi.stubGlobal('fetch', original);
      const crumbSink = vi.fn();
      const uninstall = installFetchPatcher({ crumbSink });
      try {
        const c = createDeviceLinkClient({ ingestUrl: INGEST, sdkKey: 'k' });
        expect((await c.check(ID, NONCE)).kind).toBe('linked');
        expect(original).toHaveBeenCalledTimes(1);
        expect(crumbSink).not.toHaveBeenCalled();
        expect(getNetworkSnapshot()).toHaveLength(0);
      } finally {
        uninstall();
      }
    });
  });

  it('no token or nonce reaches the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const fetchSpy: FetchSpy = vi.fn(async () =>
      json(200, { status: 'linked', token: TOKEN, owner: { kind: 'team' } }),
    );
    await client(fetchSpy).check(ID, NONCE);
    await client(vi.fn(async () => json(500, {}))).hello(NONCE, DEVICE);
    for (const spy of spies) {
      const text = JSON.stringify(spy.mock.calls);
      expect(text).not.toContain('evf_dev_');
      expect(text).not.toContain(NONCE);
    }
  });
});
