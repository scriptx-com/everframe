// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { createLinkClient, helloDevice, type HelloDevice } from '../src/link-client.js';
import { SDK_VERSION } from '../src/version.js';
import { createFetch, type FakeFetch } from './fakes.js';

const API = 'https://everframe.dev';
const NONCE = 'N0nce'.repeat(8);
const TOKEN = 'evf_dev_' + 'a1B2'.repeat(8);
const ATTEMPT = '7d0c3b8e-2f1a-4c5d-9e8f-0a1b2c3d4e5f';
const DEVICE: HelloDevice = helloDevice({
  model: 'AFTCA002',
  osVersion: '1.1',
  appVersion: '2.0.0',
});

const deps = (fetch: FakeFetch) => ({
  fetch,
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

function client(fetch: FakeFetch) {
  return createLinkClient(deps(fetch), API, 'evf_live_k');
}

describe('link client', () => {
  it('helloBodyShape', async () => {
    const fetch = createFetch();
    fetch.route('POST', '/api/device-link/hello', { status: 200, body: { status: 'none' } });
    await client(fetch).hello(NONCE, DEVICE);
    const req = fetch.all[0]!;
    expect(req.url).toBe('https://everframe.dev/api/device-link/hello');
    expect(req.headers.Authorization).toBe('Bearer evf_live_k');
    expect(req.headers['Content-Type']).toBe('application/json');
    expect(req.redirect).toBe('error');
    expect(JSON.parse(req.body)).toEqual({
      attemptNonce: NONCE,
      device: {
        model: 'AFTCA002',
        os: 'Vega OS',
        osVersion: '1.1',
        appVersion: '2.0.0',
        sdk: `vega/${SDK_VERSION}`,
        formFactor: 'tv',
      },
    });
  });

  it('helloDeviceDefaultsAndLimits', () => {
    expect(helloDevice({})).toEqual({
      model: 'Vega device',
      os: 'Vega OS',
      osVersion: 'unknown',
      appVersion: '0.0.0',
      sdk: `vega/${SDK_VERSION}`,
      formFactor: 'tv',
    });
    const long = helloDevice({
      model: 'm'.repeat(200),
      osVersion: 'o'.repeat(80),
      appVersion: 'a'.repeat(99),
    });
    expect(long.model).toHaveLength(100);
    expect(long.osVersion).toHaveLength(40);
    expect(long.appVersion).toHaveLength(64);
    expect(helloDevice({ model: '   ', osVersion: '' }).model).toBe('Vega device');
  });

  it('helloNone', async () => {
    const fetch = createFetch();
    fetch.route('POST', '/api/device-link/hello', { status: 200, body: { status: 'none' } });
    expect(await client(fetch).hello(NONCE, DEVICE)).toEqual({ kind: 'none' });
  });

  it('helloPending', async () => {
    const fetch = createFetch();
    fetch.route('POST', '/api/device-link/hello', {
      status: 200,
      body: { status: 'pending', attemptId: ATTEMPT, number: 47 },
    });
    expect(await client(fetch).hello(NONCE, DEVICE)).toEqual({
      kind: 'pending',
      attemptId: ATTEMPT,
      number: 47,
    });
  });

  it('helloBadNumberIsStop', async () => {
    for (const number of [100, 4.5, '47', -1, null]) {
      const fetch = createFetch();
      fetch.route('POST', '/api/device-link/hello', {
        status: 200,
        body: { status: 'pending', attemptId: ATTEMPT, number },
      });
      expect(await client(fetch).hello(NONCE, DEVICE)).toEqual({ kind: 'stop' });
    }
  });

  it('helloBadAttemptIdIsStop', async () => {
    for (const attemptId of ['a/b', '', 'x'.repeat(65), 42]) {
      const fetch = createFetch();
      fetch.route('POST', '/api/device-link/hello', {
        status: 200,
        body: { status: 'pending', attemptId, number: 3 },
      });
      expect(await client(fetch).hello(NONCE, DEVICE)).toEqual({ kind: 'stop' });
    }
  });

  it('hello429IsStop', async () => {
    for (const status of [429, 400, 401, 500, 0]) {
      const fetch = createFetch();
      fetch.route('POST', '/api/device-link/hello', { status, body: { status: 'none' } });
      expect(await client(fetch).hello(NONCE, DEVICE)).toEqual({ kind: 'stop' });
    }
  });

  it('helloRedirectIsStop', async () => {
    const fetch = createFetch();
    fetch.route('POST', '/api/device-link/hello', {
      status: 200,
      url: 'https://evil.dev/hello',
      body: { status: 'pending', attemptId: ATTEMPT, number: 3 },
    });
    expect(await client(fetch).hello(NONCE, DEVICE)).toEqual({ kind: 'stop' });
  });

  const CHECK = `/api/device-link/attempts/${ATTEMPT}/check`;

  it('checkBodyShape', async () => {
    const fetch = createFetch();
    fetch.route('POST', CHECK, { status: 200, body: { status: 'pending' } });
    expect(await client(fetch).check(ATTEMPT, NONCE)).toEqual({ kind: 'pending' });
    expect(fetch.all[0]!.url).toBe(`${API}${CHECK}`);
    expect(JSON.parse(fetch.all[0]!.body)).toEqual({ attemptNonce: NONCE });
    expect(fetch.all[0]!.headers.Authorization).toBe('Bearer evf_live_k');
  });

  it('checkLinked', async () => {
    const fetch = createFetch();
    fetch.route('POST', CHECK, {
      status: 200,
      body: { status: 'linked', token: TOKEN, owner: { kind: 'user', name: 'Aurimas' } },
    });
    expect(await client(fetch).check(ATTEMPT, NONCE)).toEqual({
      kind: 'linked',
      token: TOKEN,
      owner: { kind: 'user', name: 'Aurimas' },
    });
  });

  it('checkLinkedWithBadTokenIsExpired', async () => {
    for (const body of [
      { status: 'linked', token: 'evf_dev_short', owner: { kind: 'team' } },
      { status: 'linked', token: 'evf_cap_' + 'a'.repeat(32), owner: { kind: 'team' } },
      { status: 'linked', token: TOKEN, owner: { kind: 'user' } },
      { status: 'linked', token: TOKEN },
    ]) {
      const fetch = createFetch();
      fetch.route('POST', CHECK, { status: 200, body });
      expect(await client(fetch).check(ATTEMPT, NONCE)).toEqual({ kind: 'expired' });
    }
  });

  it('checkExpiredAndUnknownBodies', async () => {
    for (const body of [{ status: 'expired' }, { status: 'weird' }, 'not json', undefined]) {
      const fetch = createFetch();
      fetch.route('POST', CHECK, { status: 200, body });
      expect(await client(fetch).check(ATTEMPT, NONCE)).toEqual({ kind: 'expired' });
    }
  });

  it('check5xxIsRetry', async () => {
    for (const status of [0, 500, 502, 503]) {
      const fetch = createFetch();
      fetch.route('POST', CHECK, { status });
      expect(await client(fetch).check(ATTEMPT, NONCE)).toEqual({ kind: 'retry' });
    }
  });

  it('check429IsStop', async () => {
    const fetch = createFetch();
    fetch.route('POST', CHECK, { status: 429 });
    expect(await client(fetch).check(ATTEMPT, NONCE)).toEqual({ kind: 'stop' });
  });

  it('check404IsExpired', async () => {
    for (const status of [400, 401, 403, 404]) {
      const fetch = createFetch();
      fetch.route('POST', CHECK, { status });
      expect(await client(fetch).check(ATTEMPT, NONCE)).toEqual({ kind: 'expired' });
    }
  });

  it('checkRedirectIsStopAndTokenIgnored', async () => {
    const fetch = createFetch();
    fetch.route('POST', CHECK, {
      status: 200,
      url: 'https://evil.dev/check',
      body: { status: 'linked', token: TOKEN, owner: { kind: 'team' } },
    });
    const result = await client(fetch).check(ATTEMPT, NONCE);
    expect(result).toEqual({ kind: 'stop' });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('attemptIdIsOnePathSegment', async () => {
    const fetch = createFetch();
    for (const id of ['a/b', '../x', 'a?b', '', 'x'.repeat(65)]) {
      expect(await client(fetch).check(id, NONCE)).toEqual({ kind: 'expired' });
    }
    expect(fetch.all).toHaveLength(0);
  });

  it('neverPutsNonceInUrl', async () => {
    const fetch = createFetch();
    fetch.route('POST', '/api/device-link/hello', {
      status: 200,
      body: { status: 'pending', attemptId: ATTEMPT, number: 1 },
    });
    fetch.route('POST', CHECK, { status: 200, body: { status: 'pending' } });
    const c = client(fetch);
    await c.hello(NONCE, DEVICE);
    await c.check(ATTEMPT, NONCE);
    for (const req of fetch.all) expect(req.url).not.toContain(NONCE);
  });
});
