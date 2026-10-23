// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, __internalClientState } from '@everframe/sdk-core';
import { createWebPlatformAdapter, type WebPlatformAdapter } from '../../src/adapter.js';
import { createDeviceLinkStore } from '../../src/devicelink/store.js';
import { deviceLinkScope } from '../../src/devicelink/token.js';
import { INGEST_URL } from '../../src/constants.js';
import { installQuickCapture } from '../../src/quickcapture/install.js';
import { init, type InternalHandle } from '../../src/init.js';

const TIZEN =
  'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko) 85.0.4183.93/6.5 TV Safari/537.36';
const TOKEN = 'evf_dev_' + 'L'.repeat(32);
const ID = '0b7c2c3e-8f2a-4c1d-9e1b-3f6a5d4c2b1a';
const DESKTOP_FEATURES =
  'replies, networkbodies, identity, companionbadge, branding, vitals, resources, reporthotkey, screenshotrender, crashonly';

const adapters: WebPlatformAdapter[] = [];

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const BASE = { replayEnabled: false, replayDurationSec: 30, samplingRate: 0 };
const ARMED = {
  ...BASE,
  captureHotkey: { enabled: true, binding: 'Shift+B', replay: true },
  deviceLinking: { enabled: true },
};

type Route = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
function stubFetch(route: Route) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    route(urlOf(input), init),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function headersOf(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers);
}

function storeFor(sdkKey: string) {
  return createDeviceLinkStore(deviceLinkScope(INGEST_URL, sdkKey)!);
}

function makeAdapter(sdkKey = 'k'): WebPlatformAdapter {
  const adapter = createWebPlatformAdapter({ sdkKey });
  adapters.push(adapter);
  return adapter;
}

async function boot(adapter: WebPlatformAdapter): Promise<void> {
  await adapter.__initReplay();
  adapter.__applyBreadcrumbsConfig();
}

async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});
afterEach(() => {
  while (adapters.length) adapters.pop()!.__testCleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('adapter wiring for web-TV device linking', () => {
  it('a TV adapter declares capturehotkey, devicelinking and capturegesture; a desktop adapter does not', async () => {
    const fetchMock = stubFetch(() => json(BASE));
    await boot(makeAdapter());
    const desktop = headersOf(fetchMock.mock.calls[0]![1]).get('X-Everframe-SDK-Features');
    expect(desktop).toBe(DESKTOP_FEATURES);
    expect(headersOf(fetchMock.mock.calls[0]![1]).has('X-Everframe-Capture-Token')).toBe(false);

    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(TIZEN);
    fetchMock.mockClear();
    const tv = makeAdapter();
    expect(tv.__tvPlatform).toBe('tizen');
    await boot(tv);
    expect(headersOf(fetchMock.mock.calls[0]![1]).get('X-Everframe-SDK-Features')).toBe(
      `${DESKTOP_FEATURES}, capturehotkey, devicelinking, capturegesture`,
    );
  });

  it('a desktop adapter has no device-link store and reads no token', () => {
    stubFetch(() => json(BASE));
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const adapter = makeAdapter();
    expect(adapter.__tvPlatform).toBeNull();
    expect(adapter.__deviceLinkStore).toBeNull();
    expect(adapter.__deviceLinkDrain()).toBeUndefined();
    expect(getItem.mock.calls.some(([k]) => String(k).startsWith('everframe.deviceLink'))).toBe(
      false,
    );
  });

  it('the stored device token rides the first config fetch, through no redirect', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(TIZEN);
    storeFor('k').save(TOKEN, { kind: 'team' });
    const fetchMock = stubFetch(() => json(BASE));
    await boot(makeAdapter());
    const init = fetchMock.mock.calls[0]![1];
    expect(headersOf(init).get('X-Everframe-Capture-Token')).toBe(TOKEN);
    expect(init?.redirect).toBe('error');
  });

  it('a token stored for another SDK key is never sent', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(TIZEN);
    storeFor('other-key').save(TOKEN, { kind: 'team' });
    const fetchMock = stubFetch(() => json(BASE));
    await boot(makeAdapter('k'));
    expect(headersOf(fetchMock.mock.calls[0]![1]).has('X-Everframe-Capture-Token')).toBe(false);
    // ...and it is left in place for its own app.
    expect(storeFor('other-key').load()?.token).toBe(TOKEN);
  });

  it('a linked TV with captureHotkey.replay forces replay with the server replay off', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(TIZEN);
    storeFor('k').save(TOKEN, { kind: 'user', name: 'A' });
    stubFetch(() =>
      json({
        ...ARMED,
        deviceLinking: {
          enabled: true,
          link: { status: 'linked', owner: { kind: 'user', name: 'A' } },
        },
      }),
    );
    const adapter = makeAdapter();
    await boot(adapter);
    expect(adapter.__replayLifecycle?.state).toBe('BUFFERING');
  });

  it('a debug TV forces replay too, but only when the app says debugBuild', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(TIZEN);
    stubFetch(() => json(ARMED));
    const debug = createWebPlatformAdapter({ sdkKey: 'k', debugBuild: true });
    adapters.push(debug);
    await boot(debug);
    expect(debug.__replayLifecycle?.state).toBe('BUFFERING');
  });

  it('an unlinked release TV never forces replay', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(TIZEN);
    stubFetch(() => json(ARMED));
    const adapter = makeAdapter();
    await boot(adapter);
    expect(adapter.__replayLifecycle?.state).toBe('IDLE');
  });

  it('captureHotkey.replay false never forces replay', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(TIZEN);
    storeFor('k').save(TOKEN, { kind: 'team' });
    stubFetch(() =>
      json({ ...ARMED, captureHotkey: { enabled: true, binding: 'x', replay: false } }),
    );
    const adapter = makeAdapter();
    await boot(adapter);
    expect(adapter.__replayLifecycle?.state).toBe('IDLE');
  });

  it('a config saying unlinked stops forced replay at the same apply', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(TIZEN);
    storeFor('k').save(TOKEN, { kind: 'team' });
    let status = 'linked';
    stubFetch(() =>
      json({
        ...ARMED,
        deviceLinking: {
          enabled: true,
          link: status === 'linked' ? { status, owner: { kind: 'team' } } : { status },
        },
      }),
    );
    const adapter = makeAdapter();
    await boot(adapter);
    expect(adapter.__replayLifecycle?.state).toBe('BUFFERING');
    status = 'unlinked';
    await adapter.__testRefreshConfigNow();
    expect(adapter.__replayLifecycle?.state).toBe('IDLE');
  });

  it('live config subscribers get the committed config and the token it carried, replayed on subscribe', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(TIZEN);
    storeFor('k').save(TOKEN, { kind: 'team' });
    stubFetch(() => json(ARMED));
    const adapter = makeAdapter();
    await boot(adapter);
    const seen: Array<[boolean, string | null]> = [];
    const off = adapter.__subscribeLiveConfig((cfg, token) =>
      seen.push([cfg.captureHotkey?.enabled === true, token]),
    );
    expect(seen).toEqual([[true, TOKEN]]);
    await adapter.__testRefreshConfigNow();
    expect(seen).toHaveLength(2);
    off();
    await adapter.__testRefreshConfigNow();
    expect(seen).toHaveLength(2);
  });

  it('a drain resends a fingerprinted capture with the stored token', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(TIZEN);
    storeFor('k').save(TOKEN, { kind: 'team' });
    stubFetch(() => json(BASE));
    const adapter = makeAdapter();
    const drain = adapter.__deviceLinkDrain();
    expect(drain?.current()?.token).toBe(TOKEN);
    expect(drain?.current()?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    drain?.forget('evf_dev_' + 'x'.repeat(32));
    expect(storeFor('k').load()?.token).toBe(TOKEN);
    drain?.forget(TOKEN);
    expect(storeFor('k').load()).toBeNull();
  });

  it('kill() tears the runtime down: banner hidden, attempt cancelled', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(TIZEN);
    const fetchMock = stubFetch((url) => {
      if (url.includes('/api/config')) return json(ARMED);
      if (url.endsWith('/api/device-link/hello'))
        return json({ status: 'pending', attemptId: ID, number: 47 });
      if (url.includes('/check')) return json({ status: 'pending' });
      return json({});
    });
    const adapter = makeAdapter();
    const client = createClient(adapter);
    client.init({ sdkKey: 'k' });
    const install = installQuickCapture({
      config: { sdkKey: 'k' },
      adapter,
      sdkName: 'everframe-web',
      sdkVersion: '1.5.0',
      getUser: () => null,
      getExtra: () => undefined,
      isKilled: () => __internalClientState.get(client)?.killed === true,
    });
    await boot(adapter);
    const decision = await install.__onGestureForTesting();
    expect(decision).toEqual({ capture: false, sendHello: true, swallowKeys: false });
    await vi.advanceTimersByTimeAsync(1_500);
    await flush();
    expect(document.getElementById('everframe-quick-capture')?.textContent).toContain(
      'Linking to Everframe · 47',
    );
    await vi.advanceTimersByTimeAsync(3_000);
    await flush();
    const checks = (): number =>
      fetchMock.mock.calls.filter(([u]) => urlOf(u).includes('/check')).length;
    expect(checks()).toBe(1);
    client.kill();
    expect(document.getElementById('everframe-quick-capture')).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(checks()).toBe(1);
    expect(await install.__onGestureForTesting()).toBeNull();
    install.dispose();
  });

  it('the capture gate sees a reporter opened by any path, with replay disabled', async () => {
    stubFetch(() => json(BASE));
    const adapter = makeAdapter();
    const client = createClient(adapter);
    client.init({ sdkKey: 'k' });
    const state = __internalClientState.get(client)!;
    adapter.__setBreadcrumbBuffer(() => state.breadcrumbs);
    adapter.__setNetworkBodiesBuffer(() => state.networkBodies);
    expect(adapter.__replayLifecycle?.state).toBe('IDLE');
    expect(adapter.__isReporterOpen()).toBe(false);
    // The dashboard hotkey and the inbox's "New report" call the host's open
    // directly: it freezes the evidence and shows the dialog, never touching
    // __openReporter.
    state.breadcrumbs.freeze();
    state.networkBodies.freeze();
    expect(adapter.__isReporterOpen()).toBe(true);
    // Until the reporter takes (or discards) what it froze.
    state.breadcrumbs.takeFrozen();
    expect(adapter.__isReporterOpen()).toBe(true);
    state.networkBodies.takeFrozen();
    expect(adapter.__isReporterOpen()).toBe(false);
  });

  it('showReporterUI() through init() marks the reporter open', async () => {
    stubFetch(() => json(BASE));
    const handle = init({ sdkKey: 'k', appVersion: '1.0.0' }) as InternalHandle;
    handle.__setShowModal(() => undefined);
    try {
      expect(handle.__adapter.__isReporterOpen()).toBe(false);
      void handle.__adapter.showReporterUI({
        title: '',
        description: '',
        excludedArtifacts: [],
        annotations: [],
        redactions: [],
      });
      expect(handle.__adapter.__isReporterOpen()).toBe(true);
    } finally {
      handle.destroy();
    }
  });

  it('every reporter open path bumps the reporter-open sequence', async () => {
    stubFetch(() => json(BASE));
    const handle = init({ sdkKey: 'k', appVersion: '1.0.0' }) as InternalHandle;
    handle.__setShowModal(() => undefined);
    try {
      const before = handle.__adapter.__reporterOpenSeq();
      void handle.__adapter.showReporterUI({
        title: '',
        description: '',
        excludedArtifacts: [],
        annotations: [],
        redactions: [],
      });
      expect(handle.__adapter.__reporterOpenSeq()).toBe(before + 1);
      void handle.open();
      expect(handle.__adapter.__reporterOpenSeq()).toBe(before + 2);
    } finally {
      handle.destroy();
    }
  });
});
