// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHECK_INTERVAL_MS,
  CHECK_WINDOW_MS,
  HELLO_DEBOUNCE_MS,
  HELLO_SILENCE_AFTER_429_MS,
  createDeviceLinkController,
  type DeviceLinkController,
  type DeviceLinkDeps,
} from '../../src/quickcapture/device-link.js';
import { createDeviceLinkStore, type DeviceLinkStore } from '../../src/devicelink/store.js';
import { deviceLinkScope, tokenFingerprint } from '../../src/devicelink/token.js';
import type { CheckResult, HelloResult } from '../../src/quickcapture/link-client.js';
import type { HelloDevice } from '../../src/devicelink/tv-platform.js';

const SCOPE = deviceLinkScope('https://everframe.dev', 'k')!;
const ID = '0b7c2c3e-8f2a-4c1d-9e1b-3f6a5d4c2b1a';
const ID2 = '1b7c2c3e-8f2a-4c1d-9e1b-3f6a5d4c2b1a';
const TOKEN = 'evf_dev_' + 'A'.repeat(32);
const TOKEN_B = 'evf_dev_' + 'B'.repeat(32);
const NONCE = 'N'.repeat(40);
const DEVICE: HelloDevice = {
  model: 'QE55',
  os: 'Tizen',
  osVersion: '6.5',
  appVersion: '1',
  sdk: 'web/1.5.0',
  formFactor: 'tv',
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let clock = 1_000_000;
let store: DeviceLinkStore;
let client: {
  hello: ReturnType<typeof vi.fn<(n: string, d: HelloDevice) => Promise<HelloResult>>>;
  check: ReturnType<typeof vi.fn<(id: string, n: string) => Promise<CheckResult>>>;
};
type VoidMock = ReturnType<typeof vi.fn<() => void>>;
let overlay: {
  showBanner: ReturnType<typeof vi.fn<(n: number) => void>>;
  hideBanner: VoidMock;
  toast: ReturnType<typeof vi.fn<(t: string) => void>>;
  destroy: VoidMock;
};
let deps: DeviceLinkDeps & {
  onLinkChanged: VoidMock;
  refreshConfig: VoidMock;
};
let ctl: DeviceLinkController;

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
async function advance(ms: number): Promise<void> {
  clock += ms;
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  clock = 1_000_000;
  store = createDeviceLinkStore(SCOPE);
  client = {
    hello: vi.fn(async () => ({ kind: 'none' }) as HelloResult),
    check: vi.fn(async () => ({ kind: 'pending' }) as CheckResult),
  };
  overlay = {
    showBanner: vi.fn<(n: number) => void>(),
    hideBanner: vi.fn<() => void>(),
    toast: vi.fn<(t: string) => void>(),
    destroy: vi.fn<() => void>(),
  };
  deps = {
    store,
    client,
    overlay,
    device: async () => DEVICE,
    nonce: () => NONCE,
    now: () => clock,
    timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as number) },
    onLinkChanged: vi.fn<() => void>(),
    refreshConfig: vi.fn<() => void>(),
  };
  ctl = createDeviceLinkController(deps);
});
afterEach(() => {
  ctl.teardown();
  vi.useRealTimers();
  localStorage.clear();
});

describe('device-link controller', () => {
  it('exposes the contract timings', () => {
    expect([
      HELLO_DEBOUNCE_MS,
      HELLO_SILENCE_AFTER_429_MS,
      CHECK_INTERVAL_MS,
      CHECK_WINDOW_MS,
    ]).toEqual([5_000, 60_000, 3_000, 150_000]);
  });

  it('a hello with no open window does nothing more', async () => {
    ctl.applyConfig({ enabled: true }, null);
    ctl.sendHello();
    await flush();
    expect(client.hello).toHaveBeenCalledWith(NONCE, DEVICE);
    expect(overlay.showBanner).not.toHaveBeenCalled();
    await advance(10_000);
    expect(client.check).not.toHaveBeenCalled();
  });

  it('pending shows the banner and checks every 3 s until linked', async () => {
    client.hello.mockResolvedValue({ kind: 'pending', attemptId: ID, number: 47 });
    client.check
      .mockResolvedValueOnce({ kind: 'pending' })
      .mockResolvedValueOnce({ kind: 'pending' })
      .mockResolvedValueOnce({
        kind: 'linked',
        token: TOKEN,
        owner: { kind: 'user', name: 'Aurimas' },
      });
    ctl.applyConfig({ enabled: true }, null);
    ctl.sendHello();
    await flush();
    expect(overlay.showBanner).toHaveBeenCalledWith(47);
    await advance(9_000);
    expect(client.check).toHaveBeenCalledTimes(3);
    expect(client.check).toHaveBeenCalledWith(ID, NONCE);
    expect(store.load()?.token).toBe(TOKEN);
    expect(ctl.owner).toEqual({ kind: 'user', name: 'Aurimas' });
    expect(ctl.snapshot()).toEqual({
      token: TOKEN,
      owner: { kind: 'user', name: 'Aurimas' },
      fingerprint: tokenFingerprint(TOKEN),
    });
    expect(overlay.hideBanner).toHaveBeenCalled();
    expect(overlay.toast).toHaveBeenCalledWith('Linked to Aurimas');
    expect(deps.onLinkChanged).toHaveBeenCalledTimes(1);
    expect(deps.refreshConfig).toHaveBeenCalledTimes(1);
    await advance(9_000);
    expect(client.check).toHaveBeenCalledTimes(3);
  });

  it('a team link toasts Linked as team device', async () => {
    client.hello.mockResolvedValue({ kind: 'pending', attemptId: ID, number: 3 });
    client.check.mockResolvedValue({ kind: 'linked', token: TOKEN, owner: { kind: 'team' } });
    ctl.applyConfig({ enabled: true }, null);
    ctl.sendHello();
    await flush();
    await advance(3_000);
    expect(overlay.toast).toHaveBeenCalledWith('Linked as team device');
  });

  it('expired hides the banner and stops checking', async () => {
    client.hello.mockResolvedValue({ kind: 'pending', attemptId: ID, number: 3 });
    client.check.mockResolvedValue({ kind: 'expired' });
    ctl.applyConfig({ enabled: true }, null);
    ctl.sendHello();
    await flush();
    await advance(3_000);
    expect(overlay.hideBanner).toHaveBeenCalledTimes(1);
    await advance(30_000);
    expect(client.check).toHaveBeenCalledTimes(1);
    expect(store.load()).toBeNull();
  });

  it('stop hides the banner and stops checking; retry keeps checking', async () => {
    client.hello.mockResolvedValue({ kind: 'pending', attemptId: ID, number: 3 });
    client.check.mockResolvedValueOnce({ kind: 'retry' }).mockResolvedValueOnce({ kind: 'stop' });
    ctl.applyConfig({ enabled: true }, null);
    ctl.sendHello();
    await flush();
    await advance(6_000);
    expect(client.check).toHaveBeenCalledTimes(2);
    expect(overlay.hideBanner).toHaveBeenCalledTimes(1);
    await advance(30_000);
    expect(client.check).toHaveBeenCalledTimes(2);
  });

  it('checking stops after 150 s', async () => {
    client.hello.mockResolvedValue({ kind: 'pending', attemptId: ID, number: 3 });
    ctl.applyConfig({ enabled: true }, null);
    ctl.sendHello();
    await flush();
    for (let i = 0; i < 60; i++) await advance(3_000);
    expect(client.check).toHaveBeenCalledTimes(49);
    expect(overlay.hideBanner).toHaveBeenCalledTimes(1);
  });

  it('checking stops after 150 s even when timers were suspended', async () => {
    client.hello.mockResolvedValue({ kind: 'pending', attemptId: ID, number: 3 });
    ctl.applyConfig({ enabled: true }, null);
    ctl.sendHello();
    await flush();
    await advance(3_000);
    expect(client.check).toHaveBeenCalledTimes(1);
    clock += 200_000; // standby: wall clock moves, no timer fires
    await vi.advanceTimersByTimeAsync(3_000);
    await flush();
    expect(client.check).toHaveBeenCalledTimes(1);
    expect(overlay.hideBanner).toHaveBeenCalledTimes(1);
    // A new hello can start a fresh attempt afterwards.
    ctl.sendHello();
    await flush();
    expect(overlay.showBanner).toHaveBeenCalledTimes(2);
  });

  it('a second hello within 5 s is not sent; one after 5 s is', async () => {
    ctl.applyConfig({ enabled: true }, null);
    ctl.sendHello();
    await flush();
    await advance(4_999);
    ctl.sendHello();
    await flush();
    expect(client.hello).toHaveBeenCalledTimes(1);
    await advance(1);
    ctl.sendHello();
    await flush();
    expect(client.hello).toHaveBeenCalledTimes(2);
  });

  it('a hello in flight blocks another', async () => {
    const d = deferred<HelloResult>();
    client.hello.mockReturnValue(d.promise);
    ctl.applyConfig({ enabled: true }, null);
    ctl.sendHello();
    await flush();
    await advance(6_000);
    ctl.sendHello();
    await flush();
    expect(client.hello).toHaveBeenCalledTimes(1);
    d.resolve({ kind: 'none' });
    await flush();
    ctl.sendHello();
    await flush();
    expect(client.hello).toHaveBeenCalledTimes(2);
  });

  it('a 429 hello silences hellos for 60 s', async () => {
    client.hello.mockResolvedValue({ kind: 'stop', rateLimited: true });
    ctl.applyConfig({ enabled: true }, null);
    ctl.sendHello();
    await flush();
    await advance(59_000);
    ctl.sendHello();
    await flush();
    expect(client.hello).toHaveBeenCalledTimes(1);
    await advance(1_000);
    ctl.sendHello();
    await flush();
    expect(client.hello).toHaveBeenCalledTimes(2);
  });

  it('no nonce means no hello', async () => {
    deps.nonce = () => null;
    ctl = createDeviceLinkController(deps);
    ctl.applyConfig({ enabled: true }, null);
    ctl.sendHello();
    await flush();
    expect(client.hello).not.toHaveBeenCalled();
  });

  it('a linked device sends no hello', async () => {
    store.save(TOKEN, { kind: 'team' });
    ctl.applyConfig({ enabled: true }, null);
    ctl.sendHello();
    await flush();
    expect(client.hello).not.toHaveBeenCalled();
  });

  it('only one attempt runs at a time', async () => {
    ctl.beginAttempt(ID, 1, NONCE);
    ctl.beginAttempt(ID2, 2, 'M'.repeat(40));
    expect(overlay.showBanner).toHaveBeenCalledTimes(1);
    await advance(3_000);
    expect(client.check).toHaveBeenCalledTimes(1);
    expect(client.check).toHaveBeenCalledWith(ID, NONCE);
    // A hello is not sent during an attempt either.
    ctl.applyConfig({ enabled: true }, null);
    ctl.sendHello();
    await flush();
    expect(client.hello).not.toHaveBeenCalled();
  });

  it('a reply that lands after teardown changes nothing', async () => {
    const d = deferred<CheckResult>();
    client.check.mockReturnValue(d.promise);
    ctl.beginAttempt(ID, 1, NONCE);
    await advance(3_000);
    ctl.teardown();
    expect(overlay.hideBanner).toHaveBeenCalled();
    d.resolve({ kind: 'linked', token: TOKEN, owner: { kind: 'team' } });
    await flush();
    expect(store.load()).toBeNull();
    expect(overlay.toast).not.toHaveBeenCalled();
    expect(deps.onLinkChanged).not.toHaveBeenCalled();
    // And nothing restarts after teardown.
    ctl.applyConfig({ enabled: true }, null);
    ctl.sendHello();
    ctl.beginAttempt(ID2, 2, NONCE);
    await flush();
    expect(client.hello).not.toHaveBeenCalled();
    expect(overlay.showBanner).toHaveBeenCalledTimes(1);
  });

  it('a hello reply that lands after a takeover linked the device is dropped', async () => {
    const hello = deferred<HelloResult>();
    client.hello.mockReturnValue(hello.promise);
    client.check.mockResolvedValue({ kind: 'linked', token: TOKEN, owner: { kind: 'team' } });
    ctl.applyConfig({ enabled: true }, null);
    ctl.sendHello();
    await flush();
    // A takeover (from an ingest reply) links the device first.
    ctl.beginAttempt(ID2, 9, 'M'.repeat(40));
    await advance(3_000);
    expect(store.load()?.token).toBe(TOKEN);
    hello.resolve({ kind: 'pending', attemptId: ID, number: 47 });
    await flush();
    expect(overlay.showBanner).not.toHaveBeenCalledWith(47);
  });

  it('config unlinked forgets only the token the request carried', async () => {
    store.save(TOKEN_B, { kind: 'team' });
    expect(ctl.applyConfig({ enabled: true, link: { status: 'unlinked' } }, TOKEN)).toBeNull();
    expect(store.load()?.token).toBe(TOKEN_B);
    expect(overlay.toast).not.toHaveBeenCalled();
    ctl.applyConfig({ enabled: true, link: { status: 'unlinked' } }, TOKEN_B);
    expect(store.load()).toBeNull();
    expect(overlay.toast).toHaveBeenCalledWith('This device was unlinked');
    expect(deps.onLinkChanged).toHaveBeenCalledTimes(1);
    expect(deps.refreshConfig).toHaveBeenCalledTimes(1);
  });

  it('config without a carried token never forgets', () => {
    store.save(TOKEN, { kind: 'team' });
    ctl.applyConfig({ enabled: true, link: { status: 'unlinked' } }, null);
    expect(store.load()?.token).toBe(TOKEN);
  });

  it('config linked with a new owner name updates the owner without a toast', () => {
    store.save(TOKEN, { kind: 'user', name: 'Old' });
    const rec = ctl.applyConfig(
      {
        enabled: true,
        link: {
          status: 'linked',
          owner: { kind: 'user', name: 'New' },
          recording: { id: 'r-1', expiresAt: '2030-01-01T00:00:00.000Z' },
        },
      },
      TOKEN,
    );
    expect(store.load()?.owner).toEqual({ kind: 'user', name: 'New' });
    expect(overlay.toast).not.toHaveBeenCalled();
    expect(deps.onLinkChanged).not.toHaveBeenCalled();
    expect(rec).toEqual({ id: 'r-1', expiresAt: '2030-01-01T00:00:00.000Z' });
  });

  it('config linked without an owner is ignored and returns no recording', () => {
    store.save(TOKEN, { kind: 'user', name: 'Old' });
    expect(
      ctl.applyConfig(
        { enabled: true, link: { status: 'linked', recording: { id: 'r', expiresAt: 'x' } } },
        TOKEN,
      ),
    ).toBeNull();
    expect(store.load()?.owner).toEqual({ kind: 'user', name: 'Old' });
  });

  it('linking disabled in config sends no hello', async () => {
    ctl.applyConfig({ enabled: false }, null);
    expect(ctl.linkingEnabled).toBe(false);
    ctl.sendHello();
    ctl.applyConfig(undefined, null);
    ctl.sendHello();
    await flush();
    expect(client.hello).not.toHaveBeenCalled();
  });

  it('forget(onlyIfToken) reports whether it removed the link', () => {
    store.save(TOKEN, { kind: 'team' });
    expect(ctl.forget(TOKEN_B)).toBe(false);
    expect(overlay.toast).not.toHaveBeenCalled();
    expect(ctl.forget(TOKEN)).toBe(true);
    expect(overlay.toast).toHaveBeenCalledWith('This device was unlinked');
    expect(ctl.forget(TOKEN)).toBe(false);
  });

  it('throwing deps never reach the host', async () => {
    deps.onLinkChanged.mockImplementation(() => {
      throw new Error('host bug');
    });
    deps.refreshConfig.mockImplementation(() => {
      throw new Error('host bug');
    });
    overlay.toast.mockImplementation(() => {
      throw new Error('dom');
    });
    client.check.mockResolvedValue({ kind: 'linked', token: TOKEN, owner: { kind: 'team' } });
    ctl.beginAttempt(ID, 1, NONCE);
    await advance(3_000);
    expect(store.load()?.token).toBe(TOKEN);
    expect(() => ctl.forget()).not.toThrow();
  });

  it('no token or nonce reaches the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    client.hello.mockResolvedValue({ kind: 'pending', attemptId: ID, number: 47 });
    client.check.mockResolvedValue({ kind: 'linked', token: TOKEN, owner: { kind: 'team' } });
    ctl.applyConfig({ enabled: true }, null);
    ctl.sendHello();
    await flush();
    await advance(3_000);
    ctl.applyConfig({ enabled: true, link: { status: 'unlinked' } }, TOKEN);
    for (const spy of spies) {
      const text = JSON.stringify(spy.mock.calls);
      expect(text).not.toContain('evf_dev_');
      expect(text).not.toContain(NONCE);
      spy.mockRestore();
    }
  });
});
