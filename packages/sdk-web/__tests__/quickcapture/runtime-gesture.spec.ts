// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, __internalClientState } from '@everframe/sdk-core';
import { createWebPlatformAdapter, type WebPlatformAdapter } from '../../src/adapter.js';
import { createDeviceLinkStore } from '../../src/devicelink/store.js';
import { deviceLinkScope } from '../../src/devicelink/token.js';
import { INGEST_URL } from '../../src/constants.js';
import { installQuickCapture, type QuickCaptureInstall } from '../../src/quickcapture/install.js';
import type { QuickCaptureHost } from '../../src/quickcapture/host.js';

const TIZEN =
  'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko) 85.0.4183.93/6.5 TV Safari/537.36';
const TOKEN = 'evf_dev_' + 'R'.repeat(32);

const ARMED = {
  replayEnabled: false,
  replayDurationSec: 30,
  samplingRate: 0,
  captureHotkey: { enabled: true, binding: 'Shift+B', replay: false },
  deviceLinking: { enabled: true },
  captureGesture: { tv: { kind: 'longPress', keys: ['MEDIA_PLAY_PAUSE'], holdMs: 1500 } },
};

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Call {
  url: string;
  token: boolean;
  nonce: boolean;
}

const adapters: WebPlatformAdapter[] = [];
const installs: QuickCaptureInstall[] = [];

function tizenStub() {
  const supported = [
    { name: 'MediaPlayPause', code: 10252 },
    { name: 'MediaPlay', code: 415 },
    { name: 'MediaPause', code: 19 },
    { name: 'ColorF0Red', code: 403 },
  ];
  return {
    getSupportedKeys: vi.fn(() => supported),
    getKey: vi.fn((n: string) => supported.find((k) => k.name === n) ?? null),
    registerKey: vi.fn(),
    registerKeyBatch: vi.fn((_n: string[], ok?: () => void) => ok?.()),
    unregisterKey: vi.fn(),
  };
}

function makeHost(adapter: WebPlatformAdapter): QuickCaptureHost {
  const client = createClient(adapter);
  client.init({ sdkKey: 'k' });
  return {
    config: { sdkKey: 'k', appVersion: '1.0.0' },
    adapter,
    sdkName: 'everframe-web',
    sdkVersion: '1.5.0',
    getUser: () => null,
    getExtra: () => undefined,
    isKilled: () => __internalClientState.get(client)?.killed === true,
  };
}

function press(type: 'keydown' | 'keyup', code: number, repeat = false): KeyboardEvent {
  const ev = new KeyboardEvent(type, { bubbles: true, cancelable: true, repeat });
  Object.defineProperty(ev, 'keyCode', { get: () => code });
  Object.defineProperty(ev, 'which', { get: () => code });
  document.body.dispatchEvent(ev);
  return ev;
}

/** Shifts performance.now() so a hold can be simulated without waiting. */
function shiftableClock() {
  let offset = 0;
  const real = performance.now.bind(performance);
  vi.spyOn(performance, 'now').mockImplementation(() => real() + offset);
  return (ms: number) => {
    offset += ms;
  };
}

async function start(calls: Call[]) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(TIZEN);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      const h = new Headers(init?.headers);
      calls.push({
        url,
        token: h.has('X-Everframe-Capture-Token'),
        nonce: h.has('X-Everframe-Link-Nonce'),
      });
      if (url.includes('/api/config')) return json(ARMED);
      if (url.endsWith('/api/device-link/hello')) return json({ status: 'none' });
      return json({});
    }),
  );
  const add = vi.spyOn(window, 'addEventListener');
  const adapter = createWebPlatformAdapter({ sdkKey: 'k' });
  adapters.push(adapter);
  const install = installQuickCapture(makeHost(adapter));
  installs.push(install);
  await adapter.__initReplay();
  adapter.__applyBreadcrumbsConfig();
  // The runtime chunk loaded and armed the remote listener.
  await vi.waitFor(() =>
    expect(add.mock.calls.some(([type, , opts]) => type === 'keydown' && opts === true)).toBe(true),
  );
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<div id="tile" tabindex="0"></div>';
});
afterEach(() => {
  while (installs.length) installs.pop()!.dispose();
  while (adapters.length) adapters.pop()!.__testCleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('TV remote gesture through the runtime', () => {
  it('a long press on a linked Tizen TV files a capture with the token and registers MediaPlayPause', async () => {
    const tizen = tizenStub();
    vi.stubGlobal('tizen', { tvinputdevice: tizen });
    createDeviceLinkStore(deviceLinkScope(INGEST_URL, 'k')!).save(TOKEN, {
      kind: 'user',
      name: 'Aurimas',
    });
    const calls: Call[] = [];
    await start(calls);
    expect(tizen.registerKeyBatch).toHaveBeenCalledTimes(1);
    expect(tizen.registerKeyBatch.mock.calls[0]![0]).toEqual(['MediaPlayPause']);

    const advance = shiftableClock();
    const first = press('keydown', 10252);
    advance(800);
    const early = press('keydown', 10252, true);
    advance(800);
    const firing = press('keydown', 10252, true);
    advance(100);
    const late = press('keydown', 10252, true);
    const keyup = press('keyup', 10252);
    expect([first, early, firing, late, keyup].map((e) => e.defaultPrevented)).toEqual([
      false,
      false,
      true,
      true,
      false,
    ]);

    await vi.waitFor(() => expect(calls.some((c) => c.url.endsWith('/api/ingest'))).toBe(true), {
      timeout: 8_000,
    });
    expect(calls.filter((c) => c.url.endsWith('/api/ingest'))).toHaveLength(1);
    expect(calls.find((c) => c.url.endsWith('/api/ingest'))).toMatchObject({
      token: true,
      nonce: true,
    });
    expect(calls.some((c) => c.url.endsWith('/hello'))).toBe(false);
    await vi.waitFor(() =>
      expect(document.getElementById('everframe-quick-capture')?.textContent).toContain(
        'Captured · Aurimas',
      ),
    );
    expect(tizen.unregisterKey).not.toHaveBeenCalled();
  }, 15_000);

  it('the same long press on an unlinked release TV sends only a hello and registers nothing', async () => {
    const tizen = tizenStub();
    vi.stubGlobal('tizen', { tvinputdevice: tizen });
    const calls: Call[] = [];
    await start(calls);

    const advance = shiftableClock();
    const events = [press('keydown', 10252)];
    for (let i = 0; i < 20; i++) {
      advance(100);
      events.push(press('keydown', 10252, true));
    }
    events.push(press('keyup', 10252));
    expect(events.some((e) => e.defaultPrevented)).toBe(false);

    await vi.waitFor(() => expect(calls.some((c) => c.url.endsWith('/hello'))).toBe(true));
    expect(calls.filter((c) => c.url.endsWith('/hello'))).toHaveLength(1);
    expect(calls.find((c) => c.url.endsWith('/hello'))).toMatchObject({ token: false });
    expect(calls.some((c) => c.url.endsWith('/api/ingest'))).toBe(false);
    expect(tizen.registerKeyBatch).not.toHaveBeenCalled();
    expect(tizen.registerKey).not.toHaveBeenCalled();
  });

  it('a debug build registers the binding keys while unlinked', async () => {
    const tizen = tizenStub();
    vi.stubGlobal('tizen', { tvinputdevice: tizen });
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(TIZEN);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(ARMED)),
    );
    const adapter = createWebPlatformAdapter({ sdkKey: 'k' });
    adapters.push(adapter);
    const host = makeHost(adapter);
    const install = installQuickCapture({ ...host, config: { ...host.config, debugBuild: true } });
    installs.push(install);
    await adapter.__initReplay();
    adapter.__applyBreadcrumbsConfig();
    await vi.waitFor(() => expect(tizen.registerKeyBatch).toHaveBeenCalledTimes(1));
    expect(tizen.registerKeyBatch.mock.calls[0]![0]).toEqual(['MediaPlayPause']);
  });
});
