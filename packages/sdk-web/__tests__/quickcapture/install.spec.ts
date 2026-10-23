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
import type { QuickCaptureHost } from '../../src/quickcapture/host.js';
import { init, type InternalHandle } from '../../src/init.js';

const TIZEN =
  'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko) 85.0.4183.93/6.5 TV Safari/537.36';
const TOKEN = 'evf_dev_' + 'I'.repeat(32);
const ID = '0b7c2c3e-8f2a-4c1d-9e1b-3f6a5d4c2b1a';

const BASE = { replayEnabled: false, replayDurationSec: 30, samplingRate: 0 };
const ARMED = {
  ...BASE,
  captureHotkey: { enabled: true, binding: 'Shift+B', replay: false },
  deviceLinking: { enabled: true },
};

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const adapters: WebPlatformAdapter[] = [];
const handles: Array<{ destroy(): void }> = [];

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

function makeAdapter(): WebPlatformAdapter {
  const adapter = createWebPlatformAdapter({ sdkKey: 'k' });
  adapters.push(adapter);
  return adapter;
}

async function boot(adapter: WebPlatformAdapter): Promise<void> {
  await adapter.__initReplay();
  adapter.__applyBreadcrumbsConfig();
}

async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

type RuntimeModule = typeof import('../../src/quickcapture/quick-capture-runtime.js');
function fakeModule() {
  const runtime = { applyConfig: vi.fn(), onGesture: vi.fn(), teardown: vi.fn() };
  const start = vi.fn(() => runtime);
  return {
    runtime,
    start,
    module: { startQuickCaptureRuntime: start } as unknown as RuntimeModule,
  };
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});
afterEach(() => {
  while (handles.length) handles.pop()!.destroy();
  while (adapters.length) adapters.pop()!.__testCleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('installQuickCapture', () => {
  it('nothing loads on a desktop browser', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => json(ARMED));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = makeAdapter();
    const load = vi.fn(async () => fakeModule().module);
    const install = installQuickCapture(makeHost(adapter), load);
    await boot(adapter);
    await flush();
    expect(load).not.toHaveBeenCalled();
    expect(await install.__onGestureForTesting()).toBeNull();
    // No request beyond the config fetch, and none to device-link endpoints.
    expect(fetchMock.mock.calls.every(([u]) => urlOf(u).includes('/api/config'))).toBe(true);
    install.dispose();
  });

  it('nothing loads when a local switch turns quick capture off', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(TIZEN);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(ARMED)),
    );
    const adapter = makeAdapter();
    const load = vi.fn(async () => fakeModule().module);
    const host = makeHost(adapter);
    const install = installQuickCapture(
      { ...host, config: { ...host.config, quickCapture: { disabled: true } } },
      load,
    );
    await boot(adapter);
    await flush();
    expect(load).not.toHaveBeenCalled();
    install.dispose();
  });

  it('the runtime loads only once the config arms the gesture', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(TIZEN);
    let config: unknown = {
      ...BASE,
      captureHotkey: { enabled: false, binding: 'x', replay: false },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(config)),
    );
    const adapter = makeAdapter();
    const fake = fakeModule();
    const load = vi.fn(async () => fake.module);
    const install = installQuickCapture(makeHost(adapter), load);
    await boot(adapter);
    await flush();
    expect(load).not.toHaveBeenCalled();
    // Linking off and unlinked release: still not armed.
    config = { ...ARMED, deviceLinking: { enabled: false } };
    await adapter.__testRefreshConfigNow();
    await flush();
    expect(load).not.toHaveBeenCalled();
    config = ARMED;
    await adapter.__testRefreshConfigNow();
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(fake.start).toHaveBeenCalledTimes(1);
    expect(fake.runtime.applyConfig).toHaveBeenCalledTimes(1);
    await adapter.__testRefreshConfigNow();
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(fake.runtime.applyConfig).toHaveBeenCalledTimes(2);
    install.dispose();
    expect(fake.runtime.teardown).toHaveBeenCalledTimes(1);
  });

  it('dispose() before the runtime chunk resolves never starts it', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(TIZEN);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(ARMED)),
    );
    const adapter = makeAdapter();
    const fake = fakeModule();
    const chunk = deferred<RuntimeModule>();
    const load = vi.fn(() => chunk.promise);
    const install = installQuickCapture(makeHost(adapter), load);
    await boot(adapter);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    install.dispose();
    chunk.resolve(fake.module);
    await flush();
    expect(fake.start).not.toHaveBeenCalled();
  });

  it('a failed chunk load is retried on the next armed config', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(TIZEN);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(ARMED)),
    );
    const adapter = makeAdapter();
    const fake = fakeModule();
    const load = vi
      .fn<() => Promise<RuntimeModule>>()
      .mockRejectedValueOnce(new Error('chunk 404'))
      .mockResolvedValue(fake.module);
    const install = installQuickCapture(makeHost(adapter), load);
    await boot(adapter);
    await flush();
    expect(fake.start).not.toHaveBeenCalled();
    await adapter.__testRefreshConfigNow();
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(fake.start).toHaveBeenCalledTimes(1);
    install.dispose();
  });

  it('a gesture on a linked TV captures; on an unlinked release TV it sends only the hello', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(TIZEN);
    const calls: Array<{ url: string; token: boolean; nonce: boolean }> = [];
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

    // Unlinked release TV: the gesture sends a hello, nothing else.
    const unlinked = makeAdapter();
    const a = installQuickCapture(makeHost(unlinked));
    await boot(unlinked);
    expect(await a.__onGestureForTesting()).toEqual({
      capture: false,
      sendHello: true,
      swallowKeys: false,
    });
    await vi.waitFor(() => expect(calls.some((c) => c.url.endsWith('/hello'))).toBe(true));
    expect(calls.some((c) => c.url.endsWith('/api/ingest'))).toBe(false);
    expect(calls.find((c) => c.url.endsWith('/hello'))).toMatchObject({ token: false });
    a.dispose();
    unlinked.__testCleanup();
    adapters.length = 0;

    // Linked TV: the gesture files a quick capture with the token and a nonce.
    calls.length = 0;
    createDeviceLinkStore(deviceLinkScope(INGEST_URL, 'k')!).save(TOKEN, {
      kind: 'user',
      name: 'Aurimas',
    });
    const linked = makeAdapter();
    const b = installQuickCapture(makeHost(linked));
    await boot(linked);
    expect(await b.__onGestureForTesting()).toEqual({
      capture: true,
      sendHello: false,
      swallowKeys: true,
    });
    await vi.waitFor(() => expect(calls.some((c) => c.url.endsWith('/api/ingest'))).toBe(true), {
      timeout: 8_000,
    });
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
    b.dispose();
  }, 15_000);

  it('init() on a TV installs quick capture and destroy() removes the overlay', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(TIZEN);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes('/api/config')) return json(ARMED);
        if (url.endsWith('/api/device-link/hello'))
          return json({ status: 'pending', attemptId: ID, number: 47 });
        if (url.includes('/check')) return json({ status: 'pending' });
        return json({});
      }),
    );
    const handle = init({ sdkKey: 'k', appVersion: '1.0.0' }) as InternalHandle;
    handles.push(handle);
    await vi.waitFor(async () => {
      expect(await handle.__quickCapture.__onGestureForTesting()).not.toBeNull();
    });
    await vi.waitFor(() =>
      expect(document.getElementById('everframe-quick-capture')?.textContent).toContain(
        'Linking to Everframe · 47',
      ),
    );
    handle.destroy();
    handles.length = 0;
    expect(document.getElementById('everframe-quick-capture')).toBeNull();
  });

  it('init() on a desktop browser installs nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(ARMED)),
    );
    const handle = init({ sdkKey: 'k', appVersion: '1.0.0' }) as InternalHandle;
    handles.push(handle);
    await flush();
    expect(await handle.__quickCapture.__onGestureForTesting()).toBeNull();
  });
});
