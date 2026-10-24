// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLinkClient, helloDevice, type HelloDevice } from '../src/link-client.js';
import { RECORDING_POST_TIMEOUT_MS } from '../src/gesture-recording.js';
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

const RECORDING = '0b9f1e2a-3c4d-4e5f-8a6b-7c8d9e0f1a2b';
const EVENTS = [
  { key: 'DPAD_UP' as const, downMs: 0, upMs: 80 },
  { key: 'MEDIA_PLAY_PAUSE' as const, downMs: 300, upMs: 1900 },
];

describe('recording upload', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('postRecordingBodyAndHeaders', async () => {
    const fetch = createFetch();
    fetch.route('POST', `/api/device-link/recordings/${RECORDING}`, { status: 204 });
    expect(await client(fetch).postRecording(RECORDING, TOKEN, EVENTS)).toBe(true);
    const req = fetch.all[0]!;
    expect(req.url).toBe(`https://everframe.dev/api/device-link/recordings/${RECORDING}`);
    expect(req.method).toBe('POST');
    expect(req.headers.Authorization).toBe('Bearer evf_live_k');
    expect(req.headers['X-Everframe-Capture-Token']).toBe(TOKEN);
    expect(req.headers['Content-Type']).toBe('application/json');
    expect(req.redirect).toBe('error');
    expect(JSON.parse(req.body)).toEqual({ events: EVENTS });
    expect(req.url).not.toContain(TOKEN);
  });

  it('postRecording204True404False', async () => {
    for (const [status, ok] of [
      [204, true],
      [200, false],
      [404, false],
      [401, false],
      [500, false],
      [0, false],
    ] as const) {
      const fetch = createFetch();
      fetch.route('POST', `/api/device-link/recordings/${RECORDING}`, { status });
      expect(await client(fetch).postRecording(RECORDING, TOKEN, [])).toBe(ok);
    }
  });

  it('postRecordingRedirectFalse', async () => {
    const fetch = createFetch();
    fetch.route('POST', `/api/device-link/recordings/${RECORDING}`, {
      status: 204,
      url: 'https://evil.dev/collect',
    });
    expect(await client(fetch).postRecording(RECORDING, TOKEN, EVENTS)).toBe(false);
  });

  it('postRecordingIdIsOnePathSegmentAndTokenMustBeValid', async () => {
    const fetch = createFetch();
    fetch.route('POST', /recordings/, { status: 204 });
    for (const id of ['a/b', '../config', '', 'x'.repeat(65), 'a?b=1'])
      expect(await client(fetch).postRecording(id, TOKEN, [])).toBe(false);
    for (const token of ['', 'evf_cap_' + 'a'.repeat(32), 'evf_dev_short'])
      expect(await client(fetch).postRecording(RECORDING, token, [])).toBe(false);
    expect(fetch.all).toEqual([]);
  });

  it('hungPostRecordingGivesUpAt30s', async () => {
    vi.useFakeTimers();
    const fetch = createFetch();
    fetch.route('POST', `/api/device-link/recordings/${RECORDING}`, {
      status: 204,
      gate: new Promise(() => undefined),
    });
    let done: boolean | undefined;
    void client(fetch)
      .postRecording(RECORDING, TOKEN, EVENTS)
      .then((ok) => (done = ok));
    // Longer than the 10 s request timeout of the other link calls.
    await vi.advanceTimersByTimeAsync(RECORDING_POST_TIMEOUT_MS - 1);
    expect(done).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(false);
  });
});
