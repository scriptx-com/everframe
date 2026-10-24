// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchRemoteConfig,
  parseBinding,
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
  it('featuresHeaderHasCapturegesture', async () => {
    expect(SDK_FEATURES).toEqual(['capturehotkey', 'devicelinking', 'capturegesture']);
    const fetch = createFetch();
    fetch.route('GET', '/api/config', { status: 200, body: FULL });
    await fetchRemoteConfig(deps(fetch), API, 'evf_live_k', null);
    expect(fetch.all[0]!.url).toBe('https://everframe.dev/api/config');
    expect(fetch.all[0]!.headers['X-Everframe-SDK-Features']).toBe(
      'capturehotkey, devicelinking, capturegesture',
    );
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
      tvBinding: { kind: 'longPress', keys: ['MEDIA_PLAY_PAUSE'], holdMs: 1500 },
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

describe('capture gesture binding', () => {
  it('parsesEachKind', () => {
    expect(parseBinding({ kind: 'longPress', keys: ['DPAD_CENTER'], holdMs: 2000 })).toEqual({
      kind: 'longPress',
      keys: ['DPAD_CENTER'],
      holdMs: 2000,
    });
    expect(
      parseBinding({
        kind: 'sequence',
        keys: ['DPAD_UP', 'DPAD_UP', 'DPAD_DOWN', 'DPAD_DOWN'],
        windowMs: 1000,
        extra: true,
      }),
    ).toEqual({
      kind: 'sequence',
      keys: ['DPAD_UP', 'DPAD_UP', 'DPAD_DOWN', 'DPAD_DOWN'],
      windowMs: 1000,
    });
    expect(parseBinding({ kind: 'chord', keys: ['SHIFT', 'B'] })).toEqual({
      kind: 'chord',
      keys: ['SHIFT', 'B'],
    });
    // The bounds themselves are inside the server's ranges.
    expect(parseBinding({ kind: 'longPress', keys: ['BACK'], holdMs: 500 })).not.toBeNull();
    expect(parseBinding({ kind: 'longPress', keys: ['BACK'], holdMs: 5000 })).not.toBeNull();
    expect(parseBinding({ kind: 'sequence', keys: ['1', '2'], windowMs: 300 })).not.toBeNull();
    expect(
      parseBinding({ kind: 'sequence', keys: Array(8).fill('DPAD_UP'), windowMs: 5000 }),
    ).not.toBeNull();
    expect(
      parseBinding({ kind: 'chord', keys: ['DPAD_UP', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_RIGHT'] }),
    ).not.toBeNull();
    // The config carries the parsed binding.
    expect(
      parseRemoteConfig({
        captureGesture: { tv: { kind: 'chord', keys: ['DPAD_UP', 'BACK'] } },
      })?.tvBinding,
    ).toEqual({ kind: 'chord', keys: ['DPAD_UP', 'BACK'] });
  });

  it('rejectsOutOfRange', () => {
    const bad: unknown[] = [
      { kind: 'longPress', keys: ['MEDIA_PLAY_PAUSE'], holdMs: 499 },
      { kind: 'longPress', keys: ['MEDIA_PLAY_PAUSE'], holdMs: 5001 },
      { kind: 'longPress', keys: ['MEDIA_PLAY_PAUSE'], holdMs: 1500.5 },
      { kind: 'longPress', keys: ['MEDIA_PLAY_PAUSE'], holdMs: '1500' },
      { kind: 'longPress', keys: ['MEDIA_PLAY_PAUSE', 'BACK'], holdMs: 1500 },
      { kind: 'longPress', keys: [], holdMs: 1500 },
      { kind: 'sequence', keys: ['DPAD_UP', 'DPAD_DOWN'], windowMs: 299 },
      { kind: 'sequence', keys: ['DPAD_UP', 'DPAD_DOWN'], windowMs: 5001 },
      { kind: 'sequence', keys: Array(9).fill('DPAD_UP'), windowMs: 1000 },
      { kind: 'sequence', keys: ['DPAD_UP'], windowMs: 1000 },
      { kind: 'chord', keys: ['DPAD_UP', 'DPAD_UP'] },
      { kind: 'chord', keys: ['DPAD_UP'] },
      { kind: 'chord', keys: ['DPAD_UP', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_RIGHT', 'BACK'] },
      { kind: 'chord', keys: ['DPAD_UP', 'HOME'] },
      { kind: 'longPress', keys: ['playpause'], holdMs: 1500 },
      { kind: 'tap', keys: ['BACK'] },
      { kind: 'chord', keys: 'DPAD_UP,BACK' },
      null,
      'longPress',
      [],
    ];
    for (const raw of bad) expect(parseBinding(raw)).toBeNull();
  });

  it('invalidOrMissingBindingIsAbsent', () => {
    expect(parseRemoteConfig({ captureGesture: { tv: { kind: 'tap' } } })).toEqual({
      quickCapture: false,
      linkingEnabled: false,
    });
    expect(parseRemoteConfig({ captureGesture: 'x' })).not.toHaveProperty('tvBinding');
    expect(parseRemoteConfig({})).not.toHaveProperty('tvBinding');
  });
});
