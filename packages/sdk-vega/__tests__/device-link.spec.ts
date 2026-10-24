// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHECK_DEADLINE_MS,
  CHECK_INTERVAL_MS,
  createDeviceLink,
  HELLO_DEBOUNCE_MS,
  type DeviceLink,
  type Presenter,
} from '../src/device-link.js';
import type { CheckResult, HelloResult, LinkClient } from '../src/link-client.js';
import { helloDevice } from '../src/link-client.js';
import { bannerTitle, BANNER_SUBLINE } from '../src/link-copy.js';
import { createLinkStore, LINK_STORAGE_KEY, type LinkStore } from '../src/link-store.js';
import type { RemoteConfig } from '../src/remote-config.js';
import { createStorage, type FakeStorage } from './fakes.js';

const SCOPE = 's'.repeat(64);
const TOKEN_A = 'evf_dev_' + 'a1B2'.repeat(8);
const TOKEN_B = 'evf_dev_' + 'Z9y8'.repeat(8);
const NONCE = 'N0nce'.repeat(8);
const ATTEMPT = '7d0c3b8e-2f1a-4c5d-9e8f-0a1b2c3d4e5f';
const ON: RemoteConfig = { quickCapture: true, linkingEnabled: true };

interface RecordingPresenter extends Presenter {
  events: string[];
  banner: { owner: object; text: string } | null;
  texts: string[];
}

function recordingPresenter(): RecordingPresenter {
  const p: RecordingPresenter = {
    events: [],
    banner: null,
    texts: [],
    showBanner(owner, number) {
      const text = `${bannerTitle(number)} | ${BANNER_SUBLINE}`;
      p.banner = { owner, text };
      p.texts.push(text);
      p.events.push(`banner:${number}`);
    },
    hideBanner(owner) {
      if (p.banner?.owner === owner) {
        p.banner = null;
        p.events.push('hide');
      }
    },
    toast(text) {
      p.texts.push(text);
      p.events.push(`toast:${text}`);
    },
  };
  return p;
}

interface FakeClient extends LinkClient {
  hellos: Array<{ nonce: string }>;
  checks: Array<{ attemptId: string; nonce: string; at: number }>;
  helloReply: HelloResult | (() => Promise<HelloResult>);
  checkReplies: CheckResult[];
}

function fakeClient(): FakeClient {
  const c: FakeClient = {
    hellos: [],
    checks: [],
    helloReply: { kind: 'pending', attemptId: ATTEMPT, number: 47 },
    checkReplies: [{ kind: 'pending' }],
    async hello(nonce) {
      c.hellos.push({ nonce });
      return typeof c.helloReply === 'function' ? c.helloReply() : c.helloReply;
    },
    async check(attemptId, nonce) {
      c.checks.push({ attemptId, nonce, at: Date.now() });
      return c.checkReplies.length > 1 ? c.checkReplies.shift()! : c.checkReplies[0]!;
    },
  };
  return c;
}

interface Setup {
  link: DeviceLink;
  client: FakeClient;
  presenter: RecordingPresenter;
  storage: FakeStorage;
  store: LinkStore;
  refreshes: number;
  warnings: string[];
}

async function setup(
  opts: {
    stored?: string;
    storage?: FakeStorage;
    scope?: string | null;
    store?: LinkStore;
    recordings?: Array<{ id: string; expiresAt: number }>;
  } = {},
): Promise<Setup> {
  const storage = opts.storage ?? createStorage();
  const store = opts.store ?? createLinkStore(storage);
  if (opts.stored)
    await store.save({
      token: opts.stored,
      owner: { kind: 'user', name: 'Aurimas' },
      scope: SCOPE,
    });
  const client = fakeClient();
  const presenter = recordingPresenter();
  const warnings: string[] = [];
  const s: Setup = {
    link: undefined as never,
    client,
    presenter,
    storage,
    store,
    refreshes: 0,
    warnings,
  };
  s.link = createDeviceLink({
    store,
    client,
    scope: opts.scope === undefined ? SCOPE : opts.scope,
    presenter,
    device: helloDevice({}),
    nonce: () => NONCE,
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    refreshConfig: () => {
      s.refreshes++;
    },
    debug: (m) => warnings.push(m),
    ...(opts.recordings ? { onRecording: (req) => opts.recordings!.push(req) } : {}),
  });
  return s;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-24T10:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('device link', () => {
  it('loadsStoredLinkForScope', async () => {
    const { link } = await setup({ stored: TOKEN_A });
    await link.ready;
    expect(link.isLoaded()).toBe(true);
    expect(link.current()).toEqual({ token: TOKEN_A, owner: { kind: 'user', name: 'Aurimas' } });
    expect(link.tokenForRequest()).toBe(TOKEN_A);
  });

  it('noTokenForRequestBeforeLoad', async () => {
    const storage = createStorage({ deferLoad: true });
    storage.data.set(
      LINK_STORAGE_KEY,
      JSON.stringify({ v: 1, s: SCOPE, t: TOKEN_A, o: { kind: 'team' } }),
    );
    const s = await setup({ storage });
    await vi.advanceTimersByTimeAsync(10);
    expect(s.link.isLoaded()).toBe(false);
    expect(s.link.tokenForRequest()).toBeNull();
    expect(s.link.current()).toBeNull();
    s.link.applyConfig(null, ON);
    s.link.sendHello();
    s.link.beginAttempt(ATTEMPT, 1, NONCE);
    expect(s.client.hellos).toHaveLength(0);
    expect(s.presenter.events).toEqual([]);
    storage.releaseLoad();
    await s.link.ready;
    expect(s.link.tokenForRequest()).toBe(TOKEN_A);
  });

  it('noScopeMeansNoTokenAndNoHello', async () => {
    const s = await setup({ stored: TOKEN_A, scope: null });
    await s.link.ready;
    expect(s.link.tokenForRequest()).toBeNull();
    expect(s.link.current()).toBeNull();
    s.link.applyConfig(null, ON);
    s.link.sendHello();
    expect(s.client.hellos).toHaveLength(0);
  });

  it('helloShowsBannerAndPolls', async () => {
    const s = await setup();
    await s.link.ready;
    s.link.applyConfig(null, ON);
    s.link.sendHello();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.client.hellos).toEqual([{ nonce: NONCE }]);
    expect(s.presenter.banner?.text).toBe(
      "Linking to Everframe · 47 | A teammate is linking a device. If that's not you, ignore this.",
    );
    await vi.advanceTimersByTimeAsync(9_000);
    const start = new Date('2026-10-24T10:00:00Z').getTime();
    expect(s.client.checks.map((c) => c.at - start)).toEqual([3000, 6000, 9000]);
    expect(s.client.checks.every((c) => c.attemptId === ATTEMPT && c.nonce === NONCE)).toBe(true);
  });

  it('secondGestureDuringAttemptIsIgnored', async () => {
    const s = await setup();
    await s.link.ready;
    s.link.applyConfig(null, ON);
    s.link.sendHello();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(HELLO_DEBOUNCE_MS + 1);
    s.link.sendHello();
    s.link.beginAttempt(ATTEMPT, 12, NONCE);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(s.client.hellos).toHaveLength(1);
    expect(s.presenter.events.filter((e) => e.startsWith('banner'))).toEqual(['banner:47']);
    // One loop: checks keep the 3 s cadence.
    const gaps = s.client.checks.slice(1).map((c, i) => c.at - s.client.checks[i]!.at);
    expect(gaps.every((g) => g === CHECK_INTERVAL_MS)).toBe(true);
  });

  it('helloWhileHelloInFlightIsIgnored', async () => {
    const s = await setup();
    await s.link.ready;
    s.link.applyConfig(null, ON);
    let release: (r: HelloResult) => void = () => undefined;
    s.client.helloReply = () => new Promise<HelloResult>((r) => (release = r));
    s.link.sendHello();
    await vi.advanceTimersByTimeAsync(HELLO_DEBOUNCE_MS + 1);
    s.link.sendHello();
    expect(s.client.hellos).toHaveLength(1);
    release({ kind: 'none' });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.presenter.events).toEqual([]);
  });

  it('helloDebounced', async () => {
    const s = await setup();
    await s.link.ready;
    s.link.applyConfig(null, ON);
    s.client.helloReply = { kind: 'none' };
    s.link.sendHello();
    await vi.advanceTimersByTimeAsync(1000);
    s.link.sendHello();
    expect(s.client.hellos).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(HELLO_DEBOUNCE_MS);
    s.link.sendHello();
    expect(s.client.hellos).toHaveLength(2);
  });

  it('linkedSavesThenToasts', async () => {
    const s = await setup();
    await s.link.ready;
    s.link.applyConfig(null, ON);
    const gen = s.link.generation();
    let changes = 0;
    s.link.onChange(() => changes++);
    s.client.checkReplies = [
      { kind: 'linked', token: TOKEN_A, owner: { kind: 'user', name: 'Aurimas' } },
    ];
    const origToast = s.presenter.toast;
    let storedAtToast: string | undefined;
    s.presenter.toast = (text) => {
      storedAtToast = s.storage.data.get(LINK_STORAGE_KEY);
      origToast(text);
    };
    s.link.sendHello();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(storedAtToast).toContain(TOKEN_A);
    expect(s.presenter.events).toEqual(['banner:47', 'hide', 'toast:Linked to Aurimas']);
    expect(s.link.generation()).toBe(gen + 1);
    expect(s.link.current()?.token).toBe(TOKEN_A);
    expect(s.refreshes).toBe(1);
    expect(changes).toBeGreaterThanOrEqual(1);
    // The loop ended.
    const checks = s.client.checks.length;
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3);
    expect(s.client.checks).toHaveLength(checks);
  });

  it('teamToast', async () => {
    const s = await setup();
    await s.link.ready;
    s.link.applyConfig(null, ON);
    s.client.checkReplies = [{ kind: 'linked', token: TOKEN_A, owner: { kind: 'team' } }];
    s.link.sendHello();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(s.presenter.events).toContain('toast:Linked as team device');
  });

  it('linkedNameIsSanitized', async () => {
    const s = await setup();
    await s.link.ready;
    s.link.applyConfig(null, ON);
    s.client.checkReplies = [
      { kind: 'linked', token: TOKEN_A, owner: { kind: 'user', name: ' Ann\nLee ' } },
    ];
    s.link.sendHello();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(s.presenter.events).toContain('toast:Linked to Ann Lee');
  });

  it('failedSaveKeepsTheLinkInMemory', async () => {
    const storage = createStorage();
    const s = await setup({ storage });
    await s.link.ready;
    s.link.applyConfig(null, ON);
    storage.failWrites = true;
    s.client.checkReplies = [{ kind: 'linked', token: TOKEN_A, owner: { kind: 'team' } }];
    s.link.sendHello();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(s.link.current()?.token).toBe(TOKEN_A);
    expect(s.presenter.events).toContain('toast:Linked as team device');
  });

  it('expiredHidesBanner', async () => {
    const s = await setup();
    await s.link.ready;
    s.link.applyConfig(null, ON);
    s.client.checkReplies = [{ kind: 'pending' }, { kind: 'expired' }];
    s.link.sendHello();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(s.presenter.banner).toBeNull();
    expect(s.presenter.events).toEqual(['banner:47', 'hide']);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(s.client.checks).toHaveLength(2);
  });

  it('deadlineStopsAt150s', async () => {
    const s = await setup();
    await s.link.ready;
    s.link.applyConfig(null, ON);
    s.link.sendHello();
    await vi.advanceTimersByTimeAsync(CHECK_DEADLINE_MS - 1);
    expect(s.presenter.banner).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.presenter.banner).toBeNull();
    const start = new Date('2026-10-24T10:00:00Z').getTime();
    expect(s.client.checks.every((c) => c.at - start < CHECK_DEADLINE_MS)).toBe(true);
    const n = s.client.checks.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.client.checks).toHaveLength(n);
  });

  it('retryKeepsPolling', async () => {
    const s = await setup();
    await s.link.ready;
    s.link.applyConfig(null, ON);
    s.client.checkReplies = [{ kind: 'retry' }, { kind: 'retry' }, { kind: 'pending' }];
    s.link.sendHello();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 4);
    expect(s.client.checks).toHaveLength(4);
    expect(s.presenter.banner).not.toBeNull();
  });

  it('stopEndsAttempt', async () => {
    const s = await setup();
    await s.link.ready;
    s.link.applyConfig(null, ON);
    s.client.checkReplies = [{ kind: 'stop' }];
    s.link.sendHello();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3);
    expect(s.client.checks).toHaveLength(1);
    expect(s.presenter.banner).toBeNull();
  });

  it('helloNoneOrStopShowsNothing', async () => {
    for (const reply of [{ kind: 'none' }, { kind: 'stop' }] as HelloResult[]) {
      const s = await setup();
      await s.link.ready;
      s.link.applyConfig(null, ON);
      s.client.helloReply = reply;
      s.link.sendHello();
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
      expect(s.presenter.events).toEqual([]);
      expect(s.client.checks).toHaveLength(0);
    }
  });

  it('staleConfigCannotForgetNewToken', async () => {
    const s = await setup({ stored: TOKEN_A });
    await s.link.ready;
    s.link.applyConfig(TOKEN_A, ON);
    s.client.checkReplies = [{ kind: 'linked', token: TOKEN_B, owner: { kind: 'team' } }];
    s.link.beginAttempt(ATTEMPT, 5, NONCE);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(s.link.current()?.token).toBe(TOKEN_B);
    s.link.applyConfig(TOKEN_A, { ...ON, link: { status: 'unlinked' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.link.current()?.token).toBe(TOKEN_B);
    expect(s.storage.data.get(LINK_STORAGE_KEY)).toContain(TOKEN_B);
  });

  it('configUnlinkedForgetsSentToken', async () => {
    const s = await setup({ stored: TOKEN_A });
    await s.link.ready;
    const gen = s.link.generation();
    s.link.applyConfig(TOKEN_A, { ...ON, link: { status: 'unlinked' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.link.current()).toBeNull();
    expect(s.link.generation()).toBe(gen + 1);
    expect(s.storage.data.get(LINK_STORAGE_KEY)).toBe('');
    expect(s.link.tokenForRequest()).toBeNull();
  });

  it('configLinkedUpdatesOwner', async () => {
    const s = await setup({ stored: TOKEN_A });
    await s.link.ready;
    s.link.applyConfig(TOKEN_A, { ...ON, link: { status: 'linked', owner: { kind: 'team' } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.link.current()).toEqual({ token: TOKEN_A, owner: { kind: 'team' } });
    expect(JSON.parse(s.storage.data.get(LINK_STORAGE_KEY)!).o).toEqual({ kind: 'team' });
  });

  it('configWithoutTokenNeverTouchesLink', async () => {
    const s = await setup({ stored: TOKEN_A });
    await s.link.ready;
    s.link.applyConfig(null, { ...ON, link: { status: 'unlinked' } });
    s.link.applyConfig(null, { ...ON, link: { status: 'linked', owner: { kind: 'team' } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.link.current()).toEqual({ token: TOKEN_A, owner: { kind: 'user', name: 'Aurimas' } });
    expect(s.link.linkingEnabled()).toBe(true);
    s.link.applyConfig(null, { quickCapture: true, linkingEnabled: false });
    expect(s.link.linkingEnabled()).toBe(false);
  });

  it('forgetOnlyClearsTheGivenToken', async () => {
    const s = await setup({ stored: TOKEN_A });
    await s.link.ready;
    await s.link.forget(TOKEN_B);
    expect(s.link.current()?.token).toBe(TOKEN_A);
    await s.link.forget(TOKEN_A);
    expect(s.link.current()).toBeNull();
  });

  it('takeoverReplacesToken', async () => {
    const s = await setup({ stored: TOKEN_A });
    await s.link.ready;
    s.client.checkReplies = [
      { kind: 'linked', token: TOKEN_B, owner: { kind: 'user', name: 'Bea' } },
    ];
    s.link.beginAttempt(ATTEMPT, 9, 'T4keover'.repeat(5));
    expect(s.presenter.events).toEqual(['banner:9']);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(s.client.checks[0]!.nonce).toBe('T4keover'.repeat(5));
    expect(s.link.current()).toEqual({ token: TOKEN_B, owner: { kind: 'user', name: 'Bea' } });
    const raw = s.storage.data.get(LINK_STORAGE_KEY)!;
    expect(raw).toContain(TOKEN_B);
    expect(raw).not.toContain(TOKEN_A);
    expect(s.presenter.events).toContain('toast:Linked to Bea');
  });

  it('pendingAttemptSurvivesAForget', async () => {
    const s = await setup({ stored: TOKEN_A });
    await s.link.ready;
    s.client.checkReplies = [
      { kind: 'pending' },
      { kind: 'linked', token: TOKEN_B, owner: { kind: 'team' } },
    ];
    s.link.beginAttempt(ATTEMPT, 9, NONCE);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    await s.link.forget(TOKEN_A);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(s.link.current()?.token).toBe(TOKEN_B);
  });

  it('forgetDuringASaveDoesNotLoseTheNewToken', async () => {
    const s = await setup({ stored: TOKEN_A });
    await s.link.ready;
    s.client.checkReplies = [{ kind: 'linked', token: TOKEN_B, owner: { kind: 'team' } }];
    s.link.beginAttempt(ATTEMPT, 9, NONCE);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - 1);
    // The check resolves and the save starts; a late device_unlinked for A arrives.
    const tick = vi.advanceTimersByTimeAsync(1);
    void s.link.forget(TOKEN_A);
    await tick;
    await vi.advanceTimersByTimeAsync(0);
    expect(s.link.current()?.token).toBe(TOKEN_B);
    expect(s.storage.data.get(LINK_STORAGE_KEY)).toContain(TOKEN_B);
  });

  it('beginAttemptNeedsLoadAndScope', async () => {
    const s = await setup({ scope: null });
    await s.link.ready;
    s.link.beginAttempt(ATTEMPT, 9, NONCE);
    expect(s.presenter.events).toEqual([]);
  });

  it('noHelloWhenLinkingDisabledOrLinked', async () => {
    const off = await setup();
    await off.link.ready;
    off.link.applyConfig(null, { quickCapture: true, linkingEnabled: false });
    off.link.sendHello();
    const linked = await setup({ stored: TOKEN_A });
    await linked.link.ready;
    linked.link.applyConfig(TOKEN_A, ON);
    linked.link.sendHello();
    const noConfig = await setup();
    await noConfig.link.ready;
    noConfig.link.sendHello();
    expect(
      off.client.hellos.length + linked.client.hellos.length + noConfig.client.hellos.length,
    ).toBe(0);
  });

  it('noTokenOrNonceInAnyPresenterTextOrWarning', async () => {
    const storage = createStorage();
    const s = await setup({ storage });
    await s.link.ready;
    s.link.applyConfig(null, ON);
    storage.failWrites = true;
    s.client.checkReplies = [
      { kind: 'pending' },
      { kind: 'linked', token: TOKEN_A, owner: { kind: 'user', name: 'Aurimas' } },
    ];
    s.link.sendHello();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    storage.failWrites = false;
    s.client.checkReplies = [{ kind: 'linked', token: TOKEN_B, owner: { kind: 'team' } }];
    s.link.beginAttempt(ATTEMPT, 3, NONCE);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    s.link.applyConfig(TOKEN_B, { ...ON, link: { status: 'unlinked' } });
    await vi.advanceTimersByTimeAsync(0);
    const seen = [...s.presenter.texts, ...s.warnings].join('\n');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain('evf_dev_');
    expect(seen).not.toContain(NONCE);
  });

  it('listenersCanUnsubscribeAndNeverThrowIntoTheMachine', async () => {
    const s = await setup({ stored: TOKEN_A });
    await s.link.ready;
    let calls = 0;
    const off = s.link.onChange(() => {
      calls++;
      throw new Error('listener');
    });
    await s.link.forget(TOKEN_A);
    off();
    s.client.checkReplies = [{ kind: 'linked', token: TOKEN_B, owner: { kind: 'team' } }];
    s.link.beginAttempt(ATTEMPT, 1, NONCE);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(calls).toBe(1);
    expect(s.link.current()?.token).toBe(TOKEN_B);
  });
});

describe('recording requests', () => {
  const REQUEST = { id: '0b9f1e2a-3c4d-4e5f-8a6b-7c8d9e0f1a2b', expiresAt: 1_800_000_000_000 };
  const linkedWith = (recording?: typeof REQUEST): RemoteConfig => ({
    ...ON,
    link: {
      status: 'linked',
      owner: { kind: 'user', name: 'Aurimas' },
      ...(recording ? { recording } : {}),
    },
  });

  it('recordingHandedOnForTheTokenItWasSentWith', async () => {
    const recordings: Array<{ id: string; expiresAt: number }> = [];
    const s = await setup({ stored: TOKEN_A, recordings });
    await s.link.ready;
    s.link.applyConfig(TOKEN_A, linkedWith(REQUEST));
    expect(recordings).toEqual([REQUEST]);
  });

  it('recordingIgnoredForAnotherTokenOrNoToken', async () => {
    const recordings: Array<{ id: string; expiresAt: number }> = [];
    const s = await setup({ stored: TOKEN_A, recordings });
    await s.link.ready;
    s.link.applyConfig(TOKEN_B, linkedWith(REQUEST));
    s.link.applyConfig(null, linkedWith(REQUEST));
    expect(recordings).toEqual([]);
  });

  it('recordingIgnoredWhenUnlinked', async () => {
    const recordings: Array<{ id: string; expiresAt: number }> = [];
    const s = await setup({ recordings });
    await s.link.ready;
    s.link.applyConfig(TOKEN_A, linkedWith(REQUEST));
    expect(recordings).toEqual([]);
  });

  it('noRecordingNoCall', async () => {
    const recordings: Array<{ id: string; expiresAt: number }> = [];
    const s = await setup({ stored: TOKEN_A, recordings });
    await s.link.ready;
    s.link.applyConfig(TOKEN_A, linkedWith());
    expect(recordings).toEqual([]);
  });

  it('aThrowingRecordingHandlerLeavesTheLinkAlone', async () => {
    const s = await setup({ stored: TOKEN_A });
    await s.link.ready;
    const link = createDeviceLink({
      store: s.store,
      client: s.client,
      scope: SCOPE,
      presenter: s.presenter,
      device: helloDevice({}),
      nonce: () => NONCE,
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      refreshConfig: () => undefined,
      onRecording: () => {
        throw new Error('boom');
      },
    });
    await link.ready;
    expect(() => link.applyConfig(TOKEN_A, linkedWith(REQUEST))).not.toThrow();
    expect(link.current()?.token).toBe(TOKEN_A);
  });
});
