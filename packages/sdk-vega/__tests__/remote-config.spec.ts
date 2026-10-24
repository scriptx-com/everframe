// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchRemoteConfig,
  parseRemoteConfig,
  SDK_FEATURES,
  type RemoteConfig,
} from '../src/remote-config.js';
import { SEND_TIMEOUT_MS } from '../src/transport.js';
import { createFetch, type FakeFetch } from './fakes.js';

const TOKEN = 'evf_dev_' + 'a1B2'.repeat(8);
const API = 'https://everframe.dev';
const RECORDING_ID = '0b9f1e2a-3c4d-4e5f-8a6b-7c8d9e0f1a2b';
const EXPIRES = '2026-10-24T10:00:10.000Z';

const deps = (fetch: FakeFetch) => ({
  fetch,
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

const FULL = {
  replay: { enabled: false },
  captureHotkey: { enabled: true, binding: 'Shift+B', replay: true },
  deviceLinking: {
    enabled: true,
    link: {
      status: 'linked',
      owner: { kind: 'user', name: 'Aurimas' },
      recording: { id: RECORDING_ID, expiresAt: EXPIRES },
    },
  },
  captureGesture: { tv: { kind: 'longPress', keys: ['MEDIA_PLAY_PAUSE'], holdMs: 1500 } },
};

afterEach(() => {
  vi.useRealTimers();
});

describe('remote config', () => {
  it('featuresHeaderIsExact', async () => {
    expect(SDK_FEATURES).toEqual(['capturehotkey', 'devicelinking']);
    const fetch = createFetch();
    fetch.route('GET', '/api/config', { status: 200, body: FULL });
    await fetchRemoteConfig(deps(fetch), API, 'evf_live_k', null);
    expect(fetch.all[0]!.url).toBe('https://everframe.dev/api/config');
    expect(fetch.all[0]!.headers['X-Everframe-SDK-Features']).toBe('capturehotkey, devicelinking');
    expect(fetch.all[0]!.headers.Authorization).toBe('Bearer evf_live_k');
    expect(fetch.all[0]!.redirect).toBe('error');
  });

  it('configCarriesTokenOnlyWhenValid', async () => {
    for (const token of [null, 'evf_cap_' + 'a'.repeat(32), 'evf_dev_short', '']) {
      const fetch = createFetch();
      fetch.route('GET', '/api/config', { status: 200, body: FULL });
      await fetchRemoteConfig(deps(fetch), API, 'k', token);
      expect(fetch.all[0]!.headers).not.toHaveProperty('X-Everframe-Capture-Token');
    }
    const fetch = createFetch();
    fetch.route('GET', '/api/config', { status: 200, body: FULL });
    await fetchRemoteConfig(deps(fetch), API, 'k', TOKEN);
    expect(fetch.all[0]!.headers['X-Everframe-Capture-Token']).toBe(TOKEN);
  });

  it('configSendsExactlyTheGivenToken', async () => {
    const other = 'evf_dev_' + 'Z9y8'.repeat(8);
    const fetch = createFetch();
    fetch.route('GET', '/api/config', { status: 200, body: FULL });
    await fetchRemoteConfig(deps(fetch), API, 'k', other);
    expect(fetch.all).toHaveLength(1);
    expect(fetch.all[0]!.headers['X-Everframe-Capture-Token']).toBe(other);
    expect(fetch.all[0]!.url).not.toContain(other);
  });

  it('parsesBlocks', () => {
    expect(parseRemoteConfig(FULL)).toEqual<RemoteConfig>({
      quickCapture: true,
      linkingEnabled: true,
      link: {
        status: 'linked',
        owner: { kind: 'user', name: 'Aurimas' },
        recording: { id: RECORDING_ID, expiresAt: Date.parse(EXPIRES) },
      },
    });
    expect(
      parseRemoteConfig({
        captureHotkey: { enabled: true },
        deviceLinking: { enabled: true, link: { status: 'linked', owner: { kind: 'team' } } },
      }),
    ).toEqual({
      quickCapture: true,
      linkingEnabled: true,
      link: { status: 'linked', owner: { kind: 'team' } },
    });
  });

  it('missingBlocksAreOff', () => {
    expect(parseRemoteConfig({})).toEqual({ quickCapture: false, linkingEnabled: false });
    expect(parseRemoteConfig({ captureHotkey: { enabled: 'yes' }, deviceLinking: 1 })).toEqual({
      quickCapture: false,
      linkingEnabled: false,
    });
    expect(parseRemoteConfig(null)).toBeNull();
    expect(parseRemoteConfig([])).toBeNull();
    expect(parseRemoteConfig('x')).toBeNull();
  });

  it('linkedWithBadOwnerDropsLink', () => {
    const parsed = parseRemoteConfig({
      captureHotkey: { enabled: true },
      deviceLinking: { enabled: true, link: { status: 'linked', owner: { kind: 'user' } } },
    });
    expect(parsed).toEqual({ quickCapture: true, linkingEnabled: true });
  });

  it('unknownStatusIsUnlinked', () => {
    for (const status of ['unlinked', 'revoked', 42, undefined]) {
      const parsed = parseRemoteConfig({
        deviceLinking: { enabled: true, link: { status, owner: { kind: 'team' } } },
      });
      expect(parsed?.link).toEqual({ status: 'unlinked' });
    }
  });

  it('recordingKeptOnlyWhenValidAndLinked', () => {
    const base = (recording: unknown, status = 'linked') =>
      parseRemoteConfig({
        deviceLinking: { enabled: true, link: { status, owner: { kind: 'team' }, recording } },
      })?.link;
    expect(base({ id: 'a/b', expiresAt: EXPIRES })).toEqual({
      status: 'linked',
      owner: { kind: 'team' },
    });
    expect(base({ id: RECORDING_ID, expiresAt: 'soon' })).toEqual({
      status: 'linked',
      owner: { kind: 'team' },
    });
    expect(base({ id: RECORDING_ID, expiresAt: EXPIRES }, 'unlinked')).toEqual({
      status: 'unlinked',
    });
  });

  it('redirectedResponseIsIgnored', async () => {
    const fetch = createFetch();
    fetch.route('GET', '/api/config', {
      status: 200,
      body: FULL,
      url: 'https://evil.dev/api/config',
    });
    expect(await fetchRemoteConfig(deps(fetch), API, 'k', TOKEN)).toBeNull();
  });

  it('non200IsNull', async () => {
    for (const status of [204, 401, 404, 500]) {
      const fetch = createFetch();
      fetch.route('GET', '/api/config', { status, body: FULL });
      expect(await fetchRemoteConfig(deps(fetch), API, 'k', null)).toBeNull();
    }
  });

  it('oversizeBodyIsNull', async () => {
    const fetch = createFetch();
    fetch.route('GET', '/api/config', {
      status: 200,
      body: { ...FULL, padding: 'x'.repeat(70_000) },
    });
    expect(await fetchRemoteConfig(deps(fetch), API, 'k', null)).toBeNull();
    const ok = createFetch();
    ok.route('GET', '/api/config', { status: 200, body: { ...FULL, padding: 'x'.repeat(10_000) } });
    expect(await fetchRemoteConfig(deps(ok), API, 'k', null)).not.toBeNull();
  });

  it('networkErrorAndTimeoutAreNull', async () => {
    const down = createFetch();
    down.route('GET', '/api/config', { status: 0 });
    expect(await fetchRemoteConfig(deps(down), API, 'k', null)).toBeNull();
    vi.useFakeTimers();
    const hang = createFetch();
    hang.route('GET', '/api/config', {
      status: 200,
      body: FULL,
      gate: new Promise(() => undefined),
    });
    const pending = fetchRemoteConfig(deps(hang), API, 'k', null);
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);
    expect(await pending).toBeNull();
  });
});
