// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGestureRecording,
  RECORDING_MAX_EVENTS,
  RECORDING_MS,
  RECORDING_POST_TIMEOUT_MS,
  type RecordedKey,
} from '../src/gesture-recording.js';
import { createLinkClient, type RecordingClient } from '../src/link-client.js';
import { RECORDING_SENT, RECORDING_STARTED } from '../src/link-copy.js';
import type { GestureKey } from '../src/remote-keys.js';
import { createFetch } from './fakes.js';

const TOKEN_A = 'evf_dev_' + 'a1B2'.repeat(8);
const TOKEN_B = 'evf_dev_' + 'Z9y8'.repeat(8);
const ID = '0b9f1e2a-3c4d-4e5f-8a6b-7c8d9e0f1a2b';
const ID_2 = '1c0a2f3b-4d5e-4f6a-9b7c-8d9e0f1a2b3c';

interface FakeRecordingClient extends RecordingClient {
  posts: Array<{ id: string; token: string; events: RecordedKey[] }>;
  reply: () => Promise<boolean>;
}

function fakeClient(): FakeRecordingClient {
  const c: FakeRecordingClient = {
    posts: [],
    reply: async () => true,
    postRecording(id, token, events) {
      c.posts.push({ id, token, events: events.map((e) => ({ ...e })) });
      return c.reply();
    },
  };
  return c;
}

function setup(opts: { client?: RecordingClient; token?: string | null } = {}) {
  const link = {
    token: opts.token === undefined ? TOKEN_A : opts.token,
    gen: 1,
  };
  const toasts: string[] = [];
  const client = opts.client ?? fakeClient();
  const recording = createGestureRecording({
    client,
    deviceLink: {
      current: () => (link.token ? { token: link.token, owner: { kind: 'team' } } : null),
      generation: () => link.gen,
    },
    presenter: { toast: (text) => toasts.push(text) },
    now: () => Date.now(),
    wallNow: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  return { recording, client: client as FakeRecordingClient, toasts, link };
}

const soon = () => Date.now() + 60_000;

async function press(
  recording: ReturnType<typeof setup>['recording'],
  key: GestureKey | null,
  heldMs: number,
  gapMs = 0,
) {
  recording.onKey(key, 'down');
  await vi.advanceTimersByTimeAsync(heldMs);
  recording.onKey(key, 'up');
  await vi.advanceTimersByTimeAsync(gapMs);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-24T10:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('record on device', () => {
  it('startsWithAToastAndStaysActiveFor10s', async () => {
    const { recording, toasts, client } = setup();
    expect(recording.active()).toBe(false);
    recording.onRequest({ id: ID, expiresAt: soon() });
    expect(recording.active()).toBe(true);
    expect(toasts).toEqual([RECORDING_STARTED]);
    expect(RECORDING_STARTED).toBe('Recording remote keys for 10 seconds');
    await vi.advanceTimersByTimeAsync(RECORDING_MS - 1);
    expect(recording.active()).toBe(true);
    expect(client.posts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(recording.active()).toBe(false);
    expect(client.posts).toHaveLength(1);
  });

  it('recordsRelativeTimes', async () => {
    const { recording, client } = setup();
    recording.onRequest({ id: ID, expiresAt: soon() });
    // Times start at the first key down, not at the request.
    await vi.advanceTimersByTimeAsync(1200);
    await press(recording, 'DPAD_UP', 80, 220);
    await press(recording, 'DPAD_UP', 80, 220);
    await press(recording, 'MEDIA_PLAY_PAUSE', 1600);
    await vi.advanceTimersByTimeAsync(RECORDING_MS);
    expect(client.posts[0]!.events).toEqual([
      { key: 'DPAD_UP', downMs: 0, upMs: 80 },
      { key: 'DPAD_UP', downMs: 300, upMs: 380 },
      { key: 'MEDIA_PLAY_PAUSE', downMs: 600, upMs: 2200 },
    ]);
  });

  it('ignoresRepeatsAndUnmapped', async () => {
    const { recording, client } = setup();
    recording.onRequest({ id: ID, expiresAt: soon() });
    recording.onKey('DPAD_DOWN', 'down');
    for (let t = 530; t < 1500; t += 200) {
      await vi.advanceTimersByTimeAsync(t === 530 ? 530 : 200);
      recording.onKey('DPAD_DOWN', 'down');
    }
    await vi.advanceTimersByTimeAsync(70);
    recording.onKey('DPAD_DOWN', 'up');
    await press(recording, null, 50);
    recording.onKey('BACK', 'up');
    await vi.advanceTimersByTimeAsync(RECORDING_MS);
    expect(client.posts[0]!.events).toEqual([{ key: 'DPAD_DOWN', downMs: 0, upMs: 1400 }]);
  });

  it('capsAt32', async () => {
    const { recording, client } = setup();
    recording.onRequest({ id: ID, expiresAt: soon() });
    for (let i = 0; i < 40; i++) await press(recording, 'DPAD_RIGHT', 20, 20);
    await vi.advanceTimersByTimeAsync(RECORDING_MS);
    expect(RECORDING_MAX_EVENTS).toBe(32);
    expect(client.posts[0]!.events).toHaveLength(32);
    expect(client.posts[0]!.events[31]).toEqual({ key: 'DPAD_RIGHT', downMs: 1240, upMs: 1260 });
  });

  it('heldKeyClosedAtEnd', async () => {
    const { recording, client } = setup();
    recording.onRequest({ id: ID, expiresAt: soon() });
    await vi.advanceTimersByTimeAsync(2000);
    recording.onKey('MEDIA_PLAY_PAUSE', 'down');
    await vi.advanceTimersByTimeAsync(RECORDING_MS);
    expect(client.posts[0]!.events).toEqual([
      { key: 'MEDIA_PLAY_PAUSE', downMs: 0, upMs: RECORDING_MS - 2000 },
    ]);
    // Keys after the end are not recorded.
    recording.onKey('MEDIA_PLAY_PAUSE', 'up');
    expect(client.posts).toHaveLength(1);
  });

  it('emptyRecordingPostsNoEvents', async () => {
    const { recording, client, toasts } = setup();
    recording.onRequest({ id: ID, expiresAt: soon() });
    await vi.advanceTimersByTimeAsync(RECORDING_MS);
    expect(client.posts).toEqual([{ id: ID, token: TOKEN_A, events: [] }]);
    expect(toasts).toEqual([RECORDING_STARTED, RECORDING_SENT]);
  });

  it('postsAfter10sWithToken', async () => {
    const fetch = createFetch();
    fetch.route('POST', `/api/device-link/recordings/${ID}`, { status: 204 });
    const client = createLinkClient(
      {
        fetch,
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      },
      'https://everframe.dev',
      'evf_live_k',
    );
    const { recording, toasts } = setup({ client });
    recording.onRequest({ id: ID, expiresAt: soon() });
    await press(recording, 'DPAD_CENTER', 100);
    await vi.advanceTimersByTimeAsync(RECORDING_MS);
    expect(fetch.all).toHaveLength(1);
    const req = fetch.all[0]!;
    expect(req.url).toBe(`https://everframe.dev/api/device-link/recordings/${ID}`);
    expect(req.headers['X-Everframe-Capture-Token']).toBe(TOKEN_A);
    expect(req.headers.Authorization).toBe('Bearer evf_live_k');
    expect(JSON.parse(req.body)).toStrictEqual({
      events: [{ key: 'DPAD_CENTER', downMs: 0, upMs: 100 }],
    });
    expect(toasts).toEqual([RECORDING_STARTED, RECORDING_SENT]);
    expect(RECORDING_SENT).toBe('Keys sent to Everframe');
  });

  it('failedPostShowsNoSentToast', async () => {
    const { recording, client, toasts } = setup();
    client.reply = async () => false;
    recording.onRequest({ id: ID, expiresAt: soon() });
    await vi.advanceTimersByTimeAsync(RECORDING_MS);
    expect(client.posts).toHaveLength(1);
    expect(toasts).toEqual([RECORDING_STARTED]);
  });

  it('expiredOrDuplicateIgnored', async () => {
    const { recording, client, toasts } = setup();
    recording.onRequest({ id: ID, expiresAt: Date.now() - 1 });
    recording.onRequest({ id: ID, expiresAt: Date.now() });
    expect(recording.active()).toBe(false);
    recording.onRequest({ id: ID_2, expiresAt: soon() });
    await vi.advanceTimersByTimeAsync(RECORDING_MS);
    // The same request comes back with every config until the server sees the upload.
    recording.onRequest({ id: ID_2, expiresAt: soon() });
    expect(recording.active()).toBe(false);
    expect(client.posts.map((p) => p.id)).toEqual([ID_2]);
    expect(toasts.filter((t) => t === RECORDING_STARTED)).toHaveLength(1);
  });

  it('aRequestWhileActiveIsIgnored', async () => {
    const { recording, client } = setup();
    recording.onRequest({ id: ID, expiresAt: soon() });
    await vi.advanceTimersByTimeAsync(3000);
    recording.onRequest({ id: ID_2, expiresAt: soon() });
    await vi.advanceTimersByTimeAsync(RECORDING_MS);
    expect(client.posts.map((p) => p.id)).toEqual([ID]);
  });

  it('relinkedBeforeEndPostsNothing', async () => {
    const { recording, client, toasts, link } = setup();
    recording.onRequest({ id: ID, expiresAt: soon() });
    await press(recording, 'DPAD_UP', 80);
    // Taken over by another teammate (a new token) during the window.
    link.token = TOKEN_B;
    link.gen++;
    await vi.advanceTimersByTimeAsync(RECORDING_MS);
    expect(client.posts).toEqual([]);
    expect(toasts).toEqual([RECORDING_STARTED]);
    expect(recording.active()).toBe(false);
  });

  it('unlinkedBeforeEndPostsNothing', async () => {
    const { recording, client, link } = setup();
    recording.onRequest({ id: ID, expiresAt: soon() });
    link.token = null;
    link.gen++;
    await vi.advanceTimersByTimeAsync(RECORDING_MS);
    expect(client.posts).toEqual([]);
  });

  it('sentToastIsFencedToTheLink', async () => {
    const { recording, client, toasts, link } = setup();
    let release: (ok: boolean) => void = () => undefined;
    client.reply = () => new Promise<boolean>((resolve) => (release = resolve));
    recording.onRequest({ id: ID, expiresAt: soon() });
    await vi.advanceTimersByTimeAsync(RECORDING_MS);
    expect(client.posts).toHaveLength(1);
    link.token = null;
    link.gen++;
    release(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(toasts).toEqual([RECORDING_STARTED]);
  });

  it('unlinkedIgnoresRequest', async () => {
    const { recording, client, toasts } = setup({ token: null });
    recording.onRequest({ id: ID, expiresAt: soon() });
    expect(recording.active()).toBe(false);
    await vi.advanceTimersByTimeAsync(RECORDING_MS);
    expect(client.posts).toEqual([]);
    expect(toasts).toEqual([]);
  });

  it('hungPostGivesUpAt30s', async () => {
    const fetch = createFetch();
    fetch.route('POST', `/api/device-link/recordings/${ID}`, {
      status: 204,
      gate: new Promise(() => undefined),
    });
    const client = createLinkClient(
      {
        fetch,
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      },
      'https://everframe.dev',
      'evf_live_k',
    );
    const { recording, toasts } = setup({ client });
    recording.onRequest({ id: ID, expiresAt: soon() });
    await vi.advanceTimersByTimeAsync(RECORDING_MS);
    expect(fetch.all).toHaveLength(1);
    // The window is over while the upload hangs: keys and gestures are free again.
    expect(recording.active()).toBe(false);
    await vi.advanceTimersByTimeAsync(RECORDING_POST_TIMEOUT_MS);
    expect(toasts).toEqual([RECORDING_STARTED]);
    // A later request still runs.
    recording.onRequest({ id: ID_2, expiresAt: soon() });
    expect(recording.active()).toBe(true);
  });

  it('nothingThrowsIntoTheCaller', async () => {
    const { recording, client } = setup();
    client.reply = () => Promise.reject(new Error('down'));
    recording.onRequest({ id: ID, expiresAt: soon() });
    await vi.advanceTimersByTimeAsync(RECORDING_MS);
    expect(client.posts).toHaveLength(1);
    for (const bad of [null, undefined, {}, { id: 3, expiresAt: 'x' }])
      expect(() => recording.onRequest(bad as never)).not.toThrow();
  });
});
