// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVegaClient } from '../src/client.js';
import { CHECK_INTERVAL_MS } from '../src/device-link.js';
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
  } = {},
): Promise<Setup> {
  const storage = opts.storage ?? createStorage();
  if (opts.link) storedLink(storage, opts.link, opts.owner);
  const registry: AppRegistryLike = { setWrapperComponentProvider: () => undefined };
  const h = createEnv({ appRegistry: registry });
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
          link: { status: 'linked', owner: opts.owner ?? { kind: 'user', name: 'Aurimas' } },
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
    const { h, client } = await setup({ link: TOKEN_A });
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
    await vi.advanceTimersByTimeAsync(0);
    expect(link.current()?.token).toBe(TOKEN_B);
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
});
