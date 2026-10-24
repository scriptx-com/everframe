// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVegaClient } from '../src/client.js';
import { CHECK_INTERVAL_MS } from '../src/device-link.js';
import { RECORDING_MS } from '../src/gesture-recording.js';
import { RECORDING_SENT, RECORDING_STARTED } from '../src/link-copy.js';
import { TOAST_MS } from '../src/overlay.js';
import { LINK_STORAGE_KEY } from '../src/link-store.js';
import { linkScope, tokenFingerprint } from '../src/link-token.js';
import { OUTBOX_KEY } from '../src/outbox.js';
import {
  CAPTURE_COOLDOWN_MS,
  decide,
  isArmed,
  isDeviceUnlinked,
  parseLinkPending,
  type GestureInput,
} from '../src/quick-capture.js';
import type { AppRegistryLike } from '../src/overlay.js';
import type { AppStateLike } from '../src/release-health.js';
import {
  createEnv,
  createStorage,
  expectValidEnvelope,
  type FakeStorage,
  type Harness,
} from './fakes.js';

const KEY = 'evf_live_quick';
const ENDPOINT = 'http://127.0.0.1:8790';
const TOKEN_A = 'evf_dev_' + 'a1B2'.repeat(8);
const TOKEN_B = 'evf_dev_' + 'Z9y8'.repeat(8);
const ATTEMPT = '7d0c3b8e-2f1a-4c5d-9e8f-0a1b2c3d4e5f';
const CONFIG = {
  captureHotkey: { enabled: true, binding: 'Shift+B', replay: false },
  deviceLinking: { enabled: true },
};

function storedLink(
  storage: FakeStorage,
  token: string,
  owner: object = { kind: 'user', name: 'Aurimas' },
) {
  storage.data.set(
    LINK_STORAGE_KEY,
    JSON.stringify({ v: 1, s: linkScope(ENDPOINT, KEY), t: token, o: owner }),
  );
}

interface Setup {
  h: Harness;
  client: ReturnType<typeof createVegaClient>;
  storage: FakeStorage;
  toasts: string[];
}

async function setup(
  opts: {
    debug?: boolean;
    link?: string;
    owner?: object;
    config?: unknown;
    storage?: FakeStorage;
    model?: string;
    dev?: boolean;
    /** Read on every config request: extra fields of a linked status. */
    linkExtra?: Record<string, unknown>;
    appState?: AppStateLike;
  } = {},
): Promise<Setup> {
  const storage = opts.storage ?? createStorage();
  if (opts.link) storedLink(storage, opts.link, opts.owner);
  const registry: AppRegistryLike = { setWrapperComponentProvider: () => undefined };
  const h = createEnv({
    appRegistry: registry,
    dev: opts.dev ?? false,
    ...(opts.appState ? { appState: opts.appState } : {}),
  });
  h.fetch.route('GET', '/api/config', (req) => {
    const token = req.headers['X-Everframe-Capture-Token'];
    const base = (opts.config ?? CONFIG) as Record<string, any>;
    if (!token) return { status: 200, body: base };
    return {
      status: 200,
      body: {
        ...base,
        deviceLinking: {
          ...(base.deviceLinking ?? {}),
          link: {
            status: 'linked',
            owner: opts.owner ?? { kind: 'user', name: 'Aurimas' },
            ...(opts.linkExtra ?? {}),
          },
        },
      },
    };
  });
  h.fetch.route('POST', '/api/device-link/hello', { status: 200, body: { status: 'none' } });
  const client = createVegaClient(h.env);
  client.init({
    sdkKey: KEY,
    endpoint: ENDPOINT,
    storage,
    debugBuild: opts.debug ?? false,
    appVersion: '1.0.0',
    ...(opts.model ? { device: { model: opts.model } } : {}),
  });
  const parts = client.quickCaptureParts();
  parts.overlay?.setMounted(true);
  const toasts: string[] = [];
  parts.overlay?.subscribe(() => {
    const t = parts.overlay!.snapshot().toast;
    if (t && toasts[toasts.length - 1] !== t) toasts.push(t);
  });
  await vi.advanceTimersByTimeAsync(0);
  return { h, client, storage, toasts };
}

const ingest = (h: Harness) => h.fetch.all.filter((r) => r.url.endsWith('/api/ingest'));
const hellos = (h: Harness) => h.fetch.all.filter((r) => r.url.endsWith('/api/device-link/hello'));
const configs = (h: Harness) => h.fetch.all.filter((r) => r.url.endsWith('/api/config'));
const outboxItems = (storage: FakeStorage) => JSON.parse(storage.data.get(OUTBOX_KEY) ?? '[]');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-24T10:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('quick capture mode', () => {
  it('modeTable', () => {
    const row = (linked: boolean, debugBuild: boolean, linkingEnabled = true): GestureInput => ({
      quickCaptureEnabled: true,
      linkingEnabled,
      linked,
      debugBuild,
    });
    expect(decide(row(true, false))).toEqual({ capture: true, sendHello: false });
    expect(decide(row(true, true))).toEqual({ capture: true, sendHello: false });
    expect(decide(row(false, true))).toEqual({ capture: true, sendHello: true });
    expect(decide(row(false, false))).toEqual({ capture: false, sendHello: true });
    expect(decide(row(false, false, false))).toEqual({ capture: false, sendHello: false });
    expect(decide(row(false, true, false))).toEqual({ capture: true, sendHello: false });
    for (const linked of [true, false])
      for (const debugBuild of [true, false]) {
        const off = { ...row(linked, debugBuild), quickCaptureEnabled: false };
        expect(decide(off)).toEqual({ capture: false, sendHello: false });
        expect(isArmed(off)).toBe(false);
      }
    expect(isArmed(row(false, false, false))).toBe(false);
    expect(isArmed(row(false, false, true))).toBe(true);
  });

  it('readsIngestReplies', () => {
    expect(parseLinkPending({ linkPending: { attemptId: ATTEMPT, number: 47 } })).toEqual({
      attemptId: ATTEMPT,
      number: 47,
    });
    expect(parseLinkPending({ linkPending: { attemptId: 'a/b', number: 47 } })).toBeNull();
    expect(parseLinkPending({ linkPending: { attemptId: ATTEMPT, number: 100 } })).toBeNull();
    expect(parseLinkPending(undefined)).toBeNull();
    expect(isDeviceUnlinked(403, { error: 'device_unlinked' })).toBe(true);
    expect(isDeviceUnlinked(403, { error: 'forbidden' })).toBe(false);
    expect(isDeviceUnlinked(401, { error: 'device_unlinked' })).toBe(false);
  });
});

describe('quick capture on a device', () => {
  it('envelopeIsValidManualQuickCapture', async () => {
    const { h, client } = await setup({ link: TOKEN_A });
    client.addBreadcrumb({ kind: 'navigation', message: 'Home → Player' });
    client.onGesture();
    await vi.advanceTimersByTimeAsync(0);
    const env = ingest(h)[0]!.envelope;
    expectValidEnvelope(env);
    expect(env.quickCapture).toBe(true);
    expect(env.source).toBeUndefined();
    expect(env.payload.crash).toBeUndefined();
    expect(env.captureControl.excluded).toEqual(['screenshot', 'uiTree', 'focus']);
    expect(env.captures.screenshot).toBe(false);
    expect(env.attachments).toEqual([]);
    expect(env.reporter.title).toBe('');
    expect(JSON.stringify(env.payload.breadcrumbs)).toContain('Home → Player');
  });

  it('linkedCaptureSendsTokenAndNonce', async () => {
    const { h, client, toasts } = await setup({ link: TOKEN_A });
    let release: () => void = () => undefined;
    h.fetch.route('POST', '/api/ingest', {
      status: 200,
      body: {},
      gate: new Promise((r) => (release = r)),
    });
    client.onGesture();
    await vi.advanceTimersByTimeAsync(0);
    expect(toasts).toEqual(['Captured · Aurimas']);
    expect(ingest(h)).toHaveLength(1);
    const headers = ingest(h)[0]!.headers;
    expect(headers['X-Everframe-Capture-Token']).toBe(TOKEN_A);
    expect(headers['X-Everframe-Link-Nonce']).toMatch(/^[0-9A-Za-z]{40}$/);
    expect(headers['X-Everframe-Replies-Opt-Out']).toBe('1');
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(hellos(h)).toHaveLength(0);
  });

  it('teamLinkToast', async () => {
    const { client, toasts } = await setup({ link: TOKEN_A, owner: { kind: 'team' } });
    client.onGesture();
    await vi.advanceTimersByTimeAsync(0);
    expect(toasts).toEqual(['Captured · team device']);
  });

  it('unlinkedDebugCaptureHasNoTokenAndAlsoHello', async () => {
    const { h, client, toasts } = await setup({ debug: true });
    client.onGesture();
    await vi.advanceTimersByTimeAsync(0);
    expect(toasts).toEqual(['Captured · Vega device']);
    expect(ingest(h)).toHaveLength(1);
    expect(ingest(h)[0]!.headers).not.toHaveProperty('X-Everframe-Capture-Token');
    expect(ingest(h)[0]!.headers).not.toHaveProperty('X-Everframe-Link-Nonce');
    expect(hellos(h)).toHaveLength(1);
  });

  it('unlinkedDebugToastUsesTheConfiguredModel', async () => {
    const { client, toasts } = await setup({ debug: true, model: 'AFTCA002' });
    client.onGesture();
    await vi.advanceTimersByTimeAsync(0);
    expect(toasts).toEqual(['Captured · AFTCA002']);
  });

  it('unlinkedReleaseDoesNothingVisibleAndSendsHello', async () => {
    const { h, client, toasts } = await setup();
    client.onGesture();
    await vi.advanceTimersByTimeAsync(0);
    expect(ingest(h)).toHaveLength(0);
    expect(toasts).toEqual([]);
    expect(hellos(h)).toHaveLength(1);
  });

  it('linkingOffSendsNoHello', async () => {
    const { h, client } = await setup({
      debug: true,
      config: { captureHotkey: { enabled: true }, deviceLinking: { enabled: false } },
    });
    client.onGesture();
    await vi.advanceTimersByTimeAsync(0);
    expect(hellos(h)).toHaveLength(0);
    expect(ingest(h)).toHaveLength(1);
  });

  it('quickCaptureOffOnTheServerDoesNothing', async () => {
    const { h, client, toasts } = await setup({
      debug: true,
      link: TOKEN_A,
      config: { captureHotkey: { enabled: false }, deviceLinking: { enabled: true } },
    });
    client.onGesture();
    await vi.advanceTimersByTimeAsync(0);
    expect(ingest(h)).toHaveLength(0);
    expect(hellos(h)).toHaveLength(0);
    expect(toasts).toEqual([]);
  });

  it('gestureBeforeLinkLoadsDoesNothing', async () => {
    const storage = createStorage({ deferLoad: true });
    storedLink(storage, TOKEN_A);
    const { h, client, toasts } = await setup({ storage, debug: true });
    client.onGesture();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ingest(h)).toHaveLength(0);
    expect(hellos(h)).toHaveLength(0);
    expect(toasts).toEqual([]);
    expect(configs(h)).toHaveLength(0);
  });

  it('gestureBeforeWrapperMountsDoesNothing', async () => {
    const { h, client } = await setup({ link: TOKEN_A });
    client.quickCaptureParts().overlay!.setMounted(false);
    client.onGesture();
    await vi.advanceTimersByTimeAsync(0);
    expect(ingest(h)).toHaveLength(0);
  });

  it('linkPendingStartsTakeover', async () => {
    const { h, client } = await setup({ link: TOKEN_A });
    h.fetch.route('POST', '/api/ingest', {
      status: 200,
      body: { eventId: 'e', linkPending: { attemptId: ATTEMPT, number: 47 } },
    });
    h.fetch.route('POST', `/api/device-link/attempts/${ATTEMPT}/check`, {
      status: 200,
      body: { status: 'linked', token: TOKEN_B, owner: { kind: 'user', name: 'Bea' } },
    });
    client.onGesture();
    await vi.advanceTimersByTimeAsync(0);
    const overlay = client.quickCaptureParts().overlay!;
    expect(overlay.snapshot().banner?.title).toBe('Linking to Everframe · 47');
    const nonce = ingest(h)[0]!.headers['X-Everframe-Link-Nonce'];
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    const check = h.fetch.all.find((r) => r.url.endsWith('/check'))!;
    expect(JSON.parse(check.body)).toEqual({ attemptNonce: nonce });
    expect(client.quickCaptureParts().deviceLink!.current()?.token).toBe(TOKEN_B);
  });

  it('linkPendingIgnoredAfterRelink', async () => {
    const { h, client } = await setup({ link: TOKEN_A });
    let release: () => void = () => undefined;
    h.fetch.route('POST', '/api/ingest', {
      status: 200,
      body: { linkPending: { attemptId: ATTEMPT, number: 47 } },
      gate: new Promise((r) => (release = r)),
    });
    client.onGesture();
    await vi.advanceTimersByTimeAsync(0);
    await client.quickCaptureParts().deviceLink!.forget(TOKEN_A);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.quickCaptureParts().overlay!.snapshot().banner).toBeNull();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(h.fetch.all.some((r) => r.url.endsWith('/check'))).toBe(false);
  });

  it('deviceUnlinkedForgetsAndToasts', async () => {
    const { h, client, storage, toasts } = await setup({ link: TOKEN_A });
    h.fetch.route('POST', '/api/ingest', { status: 403, body: { error: 'device_unlinked' } });
    client.onGesture();
    await vi.advanceTimersByTimeAsync(TOAST_MS);
    expect(outboxItems(storage)).toEqual([]);
    expect(storage.data.get(LINK_STORAGE_KEY)).toBe('');
    expect(toasts).toEqual(['Captured · Aurimas', 'This device was unlinked']);
    client.refreshConfig();
    await vi.advanceTimersByTimeAsync(0);
    expect(configs(h).at(-1)!.headers).not.toHaveProperty('X-Everframe-Capture-Token');
  });

  it('deviceUnlinkedForReplacedTokenKeepsNewLink', async () => {
    const { h, client, toasts } = await setup({ link: TOKEN_A });
    let release: () => void = () => undefined;
    h.fetch.route('POST', '/api/ingest', {
      status: 403,
      body: { error: 'device_unlinked' },
      gate: new Promise((r) => (release = r)),
    });
    client.onGesture();
    await vi.advanceTimersByTimeAsync(0);
    // A takeover completes before the 403 for the old token arrives.
    const link = client.quickCaptureParts().deviceLink!;
    h.fetch.route('POST', `/api/device-link/attempts/${ATTEMPT}/check`, {
      status: 200,
      body: { status: 'linked', token: TOKEN_B, owner: { kind: 'team' } },
    });
    link.beginAttempt(ATTEMPT, 3, 'T4keover'.repeat(5));
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(link.current()?.token).toBe(TOKEN_B);
    release();
    await vi.advanceTimersByTimeAsync(TOAST_MS * 3);
    expect(link.current()?.token).toBe(TOKEN_B);
    // The late 403 was for a token the device no longer holds: no unlink toast.
    expect(toasts).not.toContain('This device was unlinked');
    expect(toasts).toContain('Linked as team device');
  });

  it('transientFailureQueuesFingerprintNotToken', async () => {
    const { h, client, storage } = await setup({ link: TOKEN_A });
    h.fetch.route('POST', '/api/ingest', { status: 503 });
    client.onGesture();
    await vi.advanceTimersByTimeAsync(0);
    const raw = storage.data.get(OUTBOX_KEY)!;
    expect(raw).not.toContain('evf_dev_');
    const [item] = JSON.parse(raw);
    expect(item.linkFingerprint).toBe(tokenFingerprint(TOKEN_A));
    expect(item.quickCapture).toBe(true);
    expect(raw).not.toContain(ingest(h)[0]!.headers['X-Everframe-Link-Nonce']);
  });

  it('retrySendsOnlyWhileFingerprintMatches', async () => {
    const { h, client, storage } = await setup({ link: TOKEN_A });
    let release: () => void = () => undefined;
    h.fetch.route('POST', '/api/ingest', [
      { status: 503, gate: new Promise((r) => (release = r)) },
      { status: 200, body: {} },
    ]);
    client.onGesture();
    await vi.advanceTimersByTimeAsync(0);
    // Relinked (takeover to TOKEN_B) while the first upload is still out.
    const link = client.quickCaptureParts().deviceLink!;
    h.fetch.route('POST', `/api/device-link/attempts/${ATTEMPT}/check`, {
      status: 200,
      body: { status: 'linked', token: TOKEN_B, owner: { kind: 'team' } },
    });
    link.beginAttempt(ATTEMPT, 3, 'T4keover'.repeat(5));
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(link.current()?.token).toBe(TOKEN_B);
    release();
    await vi.advanceTimersByTimeAsync(0);
    await client.flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ingest(h)).toHaveLength(1);
    expect(ingest(h)[0]!.headers['X-Everframe-Capture-Token']).toBe(TOKEN_A);
    expect(outboxItems(storage)).toEqual([]);
  });

  it('retryAfterUnlinkIsDroppedNotFiledShared', async () => {
    const { h, client, storage } = await setup({ link: TOKEN_A });
    h.fetch.route('POST', '/api/ingest', [{ status: 503 }, { status: 200, body: {} }]);
    client.onGesture();
    await vi.advanceTimersByTimeAsync(0);
    await client.quickCaptureParts().deviceLink!.forget(TOKEN_A);
    await client.flush();
    expect(ingest(h)).toHaveLength(1);
    expect(outboxItems(storage)).toEqual([]);
  });

  it('retryOmitsNonce', async () => {
    const { h, client } = await setup({ link: TOKEN_A });
    h.fetch.route('POST', '/api/ingest', [{ status: 503 }, { status: 200, body: {} }]);
    client.onGesture();
    await vi.advanceTimersByTimeAsync(0);
    await client.flush();
    expect(ingest(h)).toHaveLength(2);
    expect(ingest(h)[0]!.headers['X-Everframe-Link-Nonce']).toBeDefined();
    expect(ingest(h)[1]!.headers['X-Everframe-Link-Nonce']).toBeUndefined();
    expect(ingest(h)[1]!.headers['X-Everframe-Capture-Token']).toBe(TOKEN_A);
    expect(ingest(h)[1]!.body).toBe(ingest(h)[0]!.body);
  });

  it('queuedLinkedCaptureWaitsForTheLinkOnTheNextLaunch', async () => {
    const first = await setup({ link: TOKEN_A });
    first.h.fetch.route('POST', '/api/ingest', { status: 503 });
    first.client.onGesture();
    await vi.advanceTimersByTimeAsync(0);
    const storage = createStorage({ deferLoad: true });
    for (const [k, v] of first.storage.data) storage.data.set(k, v);
    const next = await setup({ storage });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ingest(next.h)).toHaveLength(0);
    storage.releaseLoad();
    await vi.advanceTimersByTimeAsync(0);
    await next.client.flush();
    expect(ingest(next.h)).toHaveLength(1);
    expect(ingest(next.h)[0]!.headers['X-Everframe-Capture-Token']).toBe(TOKEN_A);
    expect(ingest(next.h)[0]!.headers['X-Everframe-Link-Nonce']).toBeUndefined();
  });

  it('queuedLinkedCaptureWithoutQuickCaptureIsDropped', async () => {
    const first = await setup({ link: TOKEN_A });
    first.h.fetch.route('POST', '/api/ingest', { status: 503 });
    first.client.onGesture();
    await vi.advanceTimersByTimeAsync(0);
    const h = createEnv();
    const client = createVegaClient(h.env);
    client.init({ sdkKey: KEY, endpoint: ENDPOINT, storage: first.storage, appVersion: '1.0.0' });
    await client.flush();
    expect(h.fetch.requests).toHaveLength(0);
    expect(outboxItems(first.storage)).toEqual([]);
  });

  it('cooldownOneCapturePerHold', async () => {
    const { h, client } = await setup({ link: TOKEN_A });
    client.onGesture();
    await vi.advanceTimersByTimeAsync(500);
    client.onGesture();
    await vi.advanceTimersByTimeAsync(0);
    expect(ingest(h)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(CAPTURE_COOLDOWN_MS);
    client.onGesture();
    await vi.advanceTimersByTimeAsync(0);
    expect(ingest(h)).toHaveLength(2);
  });

  it('rejectedUploadToastsDidntUpload', async () => {
    const { h, client, toasts } = await setup({ link: TOKEN_A });
    h.fetch.route('POST', '/api/ingest', { status: 400, body: { error: 'invalid' } });
    client.onGesture();
    await vi.advanceTimersByTimeAsync(TOAST_MS);
    expect(toasts).toEqual(['Captured · Aurimas', "Capture didn't upload"]);
  });

  it('redirectedUploadIsNotTakenAsSent', async () => {
    const { h, client, storage } = await setup({ link: TOKEN_A });
    h.fetch.route('POST', '/api/ingest', {
      status: 200,
      url: 'https://elsewhere.dev/api/ingest',
      body: { linkPending: { attemptId: ATTEMPT, number: 47 } },
    });
    client.onGesture();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.quickCaptureParts().overlay!.snapshot().banner).toBeNull();
    expect(outboxItems(storage)).toHaveLength(1);
  });

  it('noTokenInStatusOrWarnings', async () => {
    const { h, client } = await setup({ link: TOKEN_A, debug: true });
    h.fetch.route('POST', '/api/ingest', { status: 403, body: { error: 'device_unlinked' } });
    client.onGesture();
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(client.getStatus())).not.toContain('evf_dev_');
    expect(h.warnings.join('\n')).not.toContain('evf_dev_');
  });

  it('longPressPlayPauseTakesACapture', async () => {
    const { h, client } = await setup({ link: TOKEN_A });
    client.onRemoteKey({ eventType: 'playpause', eventKeyAction: 0 });
    for (let t = 530; t < 2000; t += 200) {
      await vi.advanceTimersByTimeAsync(t === 530 ? 530 : 200);
      client.onRemoteKey({ eventType: 'playpause', eventKeyAction: 0 });
    }
    client.onRemoteKey({ eventType: 'playpause', eventKeyAction: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(ingest(h)).toHaveLength(1);
  });

  it('tapsAndHeldDpadTakeNoCapture', async () => {
    const { h, client } = await setup({ link: TOKEN_A });
    client.onRemoteKey({ eventType: 'playpause', eventKeyAction: 0 });
    await vi.advanceTimersByTimeAsync(150);
    client.onRemoteKey({ eventType: 'playpause', eventKeyAction: 1 });
    client.onRemoteKey({ eventType: 'down', eventKeyAction: 0 });
    for (let i = 0; i < 15; i++) {
      await vi.advanceTimersByTimeAsync(200);
      client.onRemoteKey({ eventType: 'down', eventKeyAction: 0 });
    }
    client.onRemoteKey({ eventType: 'down', eventKeyAction: 1 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(ingest(h)).toHaveLength(0);
  });

  it('disarmedDeviceDoesNoWorkPerKey', async () => {
    const storage = createStorage();
    const registry: AppRegistryLike = { setWrapperComponentProvider: () => undefined };
    let timers = 0;
    const h = createEnv({
      appRegistry: registry,
      setTimeout: (fn, ms) => {
        timers++;
        return setTimeout(fn, ms);
      },
    });
    // An end user's release build: not linked, linking off.
    h.fetch.route('GET', '/api/config', {
      status: 200,
      body: { captureHotkey: { enabled: true }, deviceLinking: { enabled: false } },
    });
    const client = createVegaClient(h.env);
    client.init({
      sdkKey: KEY,
      endpoint: ENDPOINT,
      storage,
      debugBuild: false,
      appVersion: '1.0.0',
    });
    client.quickCaptureParts().overlay!.setMounted(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.armed()).toBe(false);
    const before = timers;
    for (let i = 0; i < 20; i++) {
      client.onRemoteKey({ eventType: 'playpause', eventKeyAction: 0 });
      client.onRemoteKey({ eventType: 'down', eventKeyAction: 0 });
    }
    await vi.advanceTimersByTimeAsync(3000);
    expect(timers).toBe(before);
    expect(h.fetch.all.filter((r) => !r.url.endsWith('/api/config'))).toEqual([]);
  });

  it('aHoldThatFiresAfterDisarmDoesNothing', async () => {
    const { h, client } = await setup({ link: TOKEN_A });
    client.onRemoteKey({ eventType: 'playpause', eventKeyAction: 0 });
    await vi.advanceTimersByTimeAsync(1000);
    client.quickCaptureParts().overlay!.setMounted(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ingest(h)).toHaveLength(0);
  });

  it('onRemoteKeyNeverThrows', async () => {
    const { client } = await setup({ link: TOKEN_A });
    const garbage: unknown[] = [
      undefined,
      null,
      42,
      'playpause',
      {},
      { eventType: {}, eventKeyAction: 'x' },
      { eventType: 'playpause', eventKeyAction: 7 },
      Object.create(null),
      {
        get eventType() {
          throw new Error('getter');
        },
      },
    ];
    for (const event of garbage) expect(() => client.onRemoteKey(event as never)).not.toThrow();
  });
});

/** Vega's shape of a held key: one down, repeated downs from ~530 ms every 200 ms, one up. */
async function holdKey(client: Setup['client'], eventType: string, ms: number) {
  client.onRemoteKey({ eventType, eventKeyAction: 0 });
  let t = 0;
  for (let next = 530; next < ms; next += 200) {
    await vi.advanceTimersByTimeAsync(next - t);
    t = next;
    client.onRemoteKey({ eventType, eventKeyAction: 0 });
  }
  await vi.advanceTimersByTimeAsync(ms - t);
  client.onRemoteKey({ eventType, eventKeyAction: 1 });
}

async function tapKey(client: Setup['client'], eventType: string, gapMs = 200) {
  client.onRemoteKey({ eventType, eventKeyAction: 0 });
  await vi.advanceTimersByTimeAsync(60);
  client.onRemoteKey({ eventType, eventKeyAction: 1 });
  await vi.advanceTimersByTimeAsync(gapMs);
}

const UNSUPPORTED_WARNING =
  '[everframe] the capture gesture uses keys a Vega remote does not have; quick capture is off on this device';
const KONAMI = {
  kind: 'sequence',
  keys: ['DPAD_UP', 'DPAD_UP', 'DPAD_DOWN', 'DPAD_DOWN'],
  windowMs: 1000,
};

describe('capture gesture binding on a device', () => {
  it('sequenceBindingTakesACapture', async () => {
    const { h, client } = await setup({
      link: TOKEN_A,
      config: { ...CONFIG, captureGesture: { tv: KONAMI } },
    });
    // The default long press no longer captures.
    await holdKey(client, 'playpause', 2000);
    await vi.advanceTimersByTimeAsync(CAPTURE_COOLDOWN_MS);
    expect(ingest(h)).toHaveLength(0);
    for (const key of ['up', 'up', 'down', 'down']) await tapKey(client, key);
    await vi.advanceTimersByTimeAsync(0);
    expect(ingest(h)).toHaveLength(1);
  });

  it('invalidBindingFallsBackToDefault', async () => {
    const { h, client } = await setup({
      link: TOKEN_A,
      config: {
        ...CONFIG,
        captureGesture: { tv: { kind: 'longPress', keys: ['MEDIA_PLAY_PAUSE'], holdMs: 99 } },
      },
    });
    expect(client.armed()).toBe(true);
    await holdKey(client, 'playpause', 1600);
    await vi.advanceTimersByTimeAsync(0);
    expect(ingest(h)).toHaveLength(1);
  });

  it('letterBindingDisarmsWithOneDevWarning', async () => {
    const { h, client } = await setup({
      link: TOKEN_A,
      dev: true,
      debug: true,
      config: { ...CONFIG, captureGesture: { tv: { kind: 'chord', keys: ['SHIFT', 'B'] } } },
    });
    expect(client.armed()).toBe(false);
    client.refreshConfig();
    await vi.advanceTimersByTimeAsync(0);
    client.refreshConfig();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.warnings.filter((w) => w === UNSUPPORTED_WARNING)).toHaveLength(1);
    await holdKey(client, 'playpause', 2000);
    for (const key of ['up', 'up', 'down', 'down']) await tapKey(client, key);
    await vi.advanceTimersByTimeAsync(3000);
    expect(ingest(h)).toHaveLength(0);
    expect(hellos(h)).toHaveLength(0);
  });

  it('unsupportedBindingWarnsNothingInRelease', async () => {
    const { h } = await setup({
      link: TOKEN_A,
      config: { ...CONFIG, captureGesture: { tv: { kind: 'chord', keys: ['SHIFT', 'B'] } } },
    });
    expect(h.warnings).toEqual([]);
  });

  it('equalBindingKeepsDetector', async () => {
    const { h, client } = await setup({
      link: TOKEN_A,
      config: {
        ...CONFIG,
        captureGesture: { tv: { kind: 'longPress', keys: ['MEDIA_PLAY_PAUSE'], holdMs: 1500 } },
      },
    });
    const start = Date.now();
    client.onRemoteKey({ eventType: 'playpause', eventKeyAction: 0 });
    await vi.advanceTimersByTimeAsync(1000);
    // A routine refresh with the same binding mid-press.
    client.refreshConfig();
    await vi.advanceTimersByTimeAsync(499);
    expect(ingest(h)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(ingest(h)).toHaveLength(1);
    expect(Date.now() - start).toBe(1500);
  });

  it('aPendingHoldDoesNotFireAfterTheBindingChanges', async () => {
    const config: Record<string, unknown> = { ...CONFIG };
    const { h, client } = await setup({ link: TOKEN_A, config });
    client.onRemoteKey({ eventType: 'playpause', eventKeyAction: 0 });
    await vi.advanceTimersByTimeAsync(1000);
    config.captureGesture = { tv: KONAMI };
    client.refreshConfig();
    await vi.advanceTimersByTimeAsync(2000);
    expect(ingest(h)).toHaveLength(0);
  });

  it('aPendingHoldDoesNotFireOnceTheBindingIsUnsupported', async () => {
    const config: Record<string, unknown> = { ...CONFIG };
    const { h, client } = await setup({ link: TOKEN_A, config });
    client.onRemoteKey({ eventType: 'playpause', eventKeyAction: 0 });
    await vi.advanceTimersByTimeAsync(1000);
    config.captureGesture = { tv: { kind: 'longPress', keys: ['PROG_RED'], holdMs: 1500 } };
    client.refreshConfig();
    await vi.advanceTimersByTimeAsync(2000);
    expect(ingest(h)).toHaveLength(0);
    expect(client.armed()).toBe(false);
  });

  it('featuresHeaderOnTheDeviceHasCapturegesture', async () => {
    const { h } = await setup({ link: TOKEN_A });
    expect(configs(h)[0]!.headers['X-Everframe-SDK-Features']).toBe(
      'capturehotkey, devicelinking, capturegesture',
    );
  });
});

describe('record on device on a device', () => {
  const RECORDING = '0b9f1e2a-3c4d-4e5f-8a6b-7c8d9e0f1a2b';
  const pending = () => ({
    recording: { id: RECORDING, expiresAt: new Date(Date.now() + 60_000).toISOString() },
  });
  const posts = (h: Harness) =>
    h.fetch.all.filter((r) => r.url.includes('/api/device-link/recordings/'));

  it('recordingRequestRecordsKeysAndPosts', async () => {
    const opts = { link: TOKEN_A, linkExtra: pending() };
    const { h, client, toasts } = await setup(opts);
    h.fetch.route('POST', `/api/device-link/recordings/${RECORDING}`, { status: 204 });
    expect(toasts).toEqual([RECORDING_STARTED]);
    await tapKey(client, 'up', 240);
    await tapKey(client, 'colorbutton', 100);
    await holdKey(client, 'playpause', 2000);
    await vi.advanceTimersByTimeAsync(RECORDING_MS);
    expect(posts(h)).toHaveLength(1);
    expect(posts(h)[0]!.headers['X-Everframe-Capture-Token']).toBe(TOKEN_A);
    expect(JSON.parse(posts(h)[0]!.body)).toEqual({
      events: [
        { key: 'DPAD_UP', downMs: 0, upMs: 60 },
        { key: 'MEDIA_PLAY_PAUSE', downMs: 460, upMs: 2460 },
      ],
    });
    // The 2 s hold during the window was a recorded key, not a capture.
    expect(ingest(h)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(toasts).toContain(RECORDING_SENT);
  });

  it('noGestureFiresWhileRecording', async () => {
    const opts: { link: string; linkExtra: Record<string, unknown> } = {
      link: TOKEN_A,
      linkExtra: pending(),
    };
    const { h, client } = await setup(opts);
    h.fetch.route('POST', `/api/device-link/recordings/${RECORDING}`, { status: 204 });
    await holdKey(client, 'playpause', 3000);
    await vi.advanceTimersByTimeAsync(0);
    expect(ingest(h)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(RECORDING_MS);
    // After the window the gesture works again (and the handled request is not rerun).
    opts.linkExtra = {};
    await holdKey(client, 'playpause', 1600);
    await vi.advanceTimersByTimeAsync(0);
    expect(ingest(h)).toHaveLength(1);
  });

  it('aPendingHoldDoesNotFireOnceARecordingStarts', async () => {
    const opts: { link: string; linkExtra: Record<string, unknown> } = {
      link: TOKEN_A,
      linkExtra: {},
    };
    const { h, client, toasts } = await setup(opts);
    client.onRemoteKey({ eventType: 'playpause', eventKeyAction: 0 });
    await vi.advanceTimersByTimeAsync(1000);
    opts.linkExtra = pending();
    client.refreshConfig();
    await vi.advanceTimersByTimeAsync(0);
    expect(toasts).toContain(RECORDING_STARTED);
    await vi.advanceTimersByTimeAsync(2000);
    expect(ingest(h)).toHaveLength(0);
  });

  it('recordingWorksWithQuickCaptureOffOnTheServer', async () => {
    const opts = {
      link: TOKEN_A,
      linkExtra: pending(),
      config: { captureHotkey: { enabled: false }, deviceLinking: { enabled: true } },
    };
    const { h, client } = await setup(opts);
    h.fetch.route('POST', `/api/device-link/recordings/${RECORDING}`, { status: 204 });
    expect(client.armed()).toBe(false);
    await tapKey(client, 'select');
    await vi.advanceTimersByTimeAsync(RECORDING_MS);
    expect(JSON.parse(posts(h)[0]!.body).events).toEqual([
      { key: 'DPAD_CENTER', downMs: 0, upMs: 60 },
    ]);
  });

  it('unlinkedDeviceNeverRecords', async () => {
    const { h, toasts } = await setup({ debug: true, linkExtra: pending() });
    await vi.advanceTimersByTimeAsync(RECORDING_MS);
    expect(toasts).toEqual([]);
    expect(posts(h)).toEqual([]);
  });
});

describe('recording boundaries on a device', () => {
  const RECORDING = '0b9f1e2a-3c4d-4e5f-8a6b-7c8d9e0f1a2b';
  const pending = () => ({
    recording: { id: RECORDING, expiresAt: new Date(Date.now() + 60_000).toISOString() },
  });

  it('aKeyHeldAcrossTheRecordingEndTakesNoCapture', async () => {
    const { h, client } = await setup({ link: TOKEN_A, linkExtra: pending() });
    h.fetch.route('POST', `/api/device-link/recordings/${RECORDING}`, { status: 204 });
    expect(client.quickCaptureParts().overlay!.snapshot().toast).toBe(RECORDING_STARTED);
    await vi.advanceTimersByTimeAsync(9000);
    // Play/Pause held from 9 s to 12 s, across the 10 s end of the window.
    await holdKey(client, 'playpause', 3000);
    await vi.advanceTimersByTimeAsync(CAPTURE_COOLDOWN_MS);
    expect(ingest(h)).toHaveLength(0);
    // Once released, a new long press captures again.
    await holdKey(client, 'playpause', 1600);
    await vi.advanceTimersByTimeAsync(0);
    expect(ingest(h)).toHaveLength(1);
  });

  it('theWindowWaitsForTheOverlay', async () => {
    const opts: { link: string; linkExtra: Record<string, unknown> } = {
      link: TOKEN_A,
      linkExtra: {},
    };
    const { h, client, toasts } = await setup(opts);
    h.fetch.route('POST', `/api/device-link/recordings/${RECORDING}`, { status: 204 });
    const overlay = client.quickCaptureParts().overlay!;
    overlay.setMounted(false);
    opts.linkExtra = pending();
    client.refreshConfig();
    await vi.advanceTimersByTimeAsync(12_000);
    // Nothing on screen yet: the window has not started, so no upload, and a
    // key pressed now is not recorded.
    expect(h.fetch.all.filter((r) => r.url.includes('/recordings/'))).toHaveLength(0);
    await tapKey(client, 'up');
    overlay.setMounted(true);
    expect(toasts).toContain(RECORDING_STARTED);
    await tapKey(client, 'select');
    await vi.advanceTimersByTimeAsync(RECORDING_MS);
    const posts = h.fetch.all.filter((r) => r.url.includes('/recordings/'));
    expect(JSON.parse(posts[0]!.body).events).toEqual([
      { key: 'DPAD_CENTER', downMs: 0, upMs: 60 },
    ]);
  });
});

/** A multi-component Vega app's AppState: `change` can describe one component. */
function moduleAppState() {
  const listeners = new Map<string, Array<(value: unknown) => void>>();
  const state = {
    currentState: 'active' as unknown,
    currentModuleStates: [
      { module_name: 'main', module_state: 'active' },
      { module_name: 'player', module_state: 'active' },
    ] as unknown,
    addEventListener(event: 'change' | 'moduleChange', listener: (value: unknown) => void) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return { remove: () => undefined };
    },
    /** One component goes to the background; another stays active. */
    componentToBackground() {
      state.currentModuleStates = [
        { module_name: 'main', module_state: 'active' },
        { module_name: 'player', module_state: 'background' },
      ];
      state.currentState = 'background';
      listeners.get('moduleChange')?.forEach((l) => l(state.currentModuleStates));
      listeners.get('change')?.forEach((l) => l('background'));
    },
    /** Every component in one state. */
    all(moduleState: 'active' | 'background') {
      state.currentModuleStates = [
        { module_name: 'main', module_state: moduleState },
        { module_name: 'player', module_state: moduleState },
      ];
      state.currentState = moduleState;
      listeners.get('moduleChange')?.forEach((l) => l(state.currentModuleStates));
      listeners.get('change')?.forEach((l) => l(moduleState));
    },
  };
  return state;
}

describe('recording with Vega module states', () => {
  const RECORDING = '0b9f1e2a-3c4d-4e5f-8a6b-7c8d9e0f1a2b';
  const pending = () => ({
    recording: { id: RECORDING, expiresAt: new Date(Date.now() + 60_000).toISOString() },
  });
  const posts = (h: Harness) =>
    h.fetch.all.filter((r) => r.url.includes('/api/device-link/recordings/'));

  it('promptStartsWhileAnotherComponentIsInTheBackground', async () => {
    const appState = moduleAppState();
    const opts: { link: string; linkExtra: Record<string, unknown>; appState: AppStateLike } = {
      link: TOKEN_A,
      linkExtra: {},
      appState,
    };
    const { h, client, toasts } = await setup(opts);
    h.fetch.route('POST', `/api/device-link/recordings/${RECORDING}`, { status: 204 });
    appState.componentToBackground();
    opts.linkExtra = pending();
    client.refreshConfig();
    await vi.advanceTimersByTimeAsync(0);
    expect(toasts).toContain(RECORDING_STARTED);
    await tapKey(client, 'select');
    await vi.advanceTimersByTimeAsync(RECORDING_MS);
    expect(posts(h)).toHaveLength(1);
    expect(JSON.parse(posts(h)[0]!.body).events).toEqual([
      { key: 'DPAD_CENTER', downMs: 0, upMs: 60 },
    ]);
  });

  it('heldKeyStaysSuppressedWhileAnotherComponentGoesBackground', async () => {
    const appState = moduleAppState();
    const { h, client } = await setup({ link: TOKEN_A, linkExtra: pending(), appState });
    h.fetch.route('POST', `/api/device-link/recordings/${RECORDING}`, { status: 204 });
    await vi.advanceTimersByTimeAsync(9000);
    // Play/Pause held from 9 s to 14 s; at 10.5 s another component goes to
    // the background while this one stays on screen.
    client.onRemoteKey({ eventType: 'playpause', eventKeyAction: 0 });
    for (let t = 9200; t < 14_000; t += 200) {
      await vi.advanceTimersByTimeAsync(200);
      if (t === 10_600) appState.componentToBackground();
      client.onRemoteKey({ eventType: 'playpause', eventKeyAction: 0 });
    }
    await vi.advanceTimersByTimeAsync(200);
    client.onRemoteKey({ eventType: 'playpause', eventKeyAction: 1 });
    await vi.advanceTimersByTimeAsync(CAPTURE_COOLDOWN_MS);
    expect(ingest(h)).toHaveLength(0);
  });

  it('promptWaitsWhileEveryComponentIsInTheBackground', async () => {
    const appState = moduleAppState();
    const opts: { link: string; linkExtra: Record<string, unknown>; appState: AppStateLike } = {
      link: TOKEN_A,
      linkExtra: {},
      appState,
    };
    const { h, client } = await setup(opts);
    h.fetch.route('POST', `/api/device-link/recordings/${RECORDING}`, { status: 204 });
    appState.all('background');
    opts.linkExtra = pending();
    client.refreshConfig();
    await vi.advanceTimersByTimeAsync(RECORDING_MS + 2000);
    expect(posts(h)).toHaveLength(0);
    appState.all('active');
    await vi.advanceTimersByTimeAsync(0);
    await tapKey(client, 'select');
    await vi.advanceTimersByTimeAsync(RECORDING_MS);
    expect(JSON.parse(posts(h)[0]!.body).events).toEqual([
      { key: 'DPAD_CENTER', downMs: 0, upMs: 60 },
    ]);
  });
});
