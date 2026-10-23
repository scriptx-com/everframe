// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyInput } from '../../src/quickcapture/gesture-detector.js';
import type { DeviceLinkController, LinkSnapshot } from '../../src/quickcapture/device-link.js';
import type { RecordingClient } from '../../src/quickcapture/link-client.js';
import type { Overlay } from '../../src/quickcapture/overlay.js';
import { createGestureRecording, type GestureRecording } from '../../src/quickcapture/recording.js';
import type { GestureKeyName } from '../../src/quickcapture/remote-keys.js';

const TOKEN = 'evf_dev_' + 'Q'.repeat(32);
const OTHER = 'evf_dev_' + 'P'.repeat(32);
const WALL = Date.parse('2026-10-24T12:00:00.000Z');
const FUTURE = '2026-10-24T12:05:00.000Z';
const PAST = '2026-10-24T11:59:59.000Z';

const NAMES: { [code: number]: GestureKeyName } = { 38: 'DPAD_UP', 415: 'MEDIA_PLAY_PAUSE' };
const down = (code: number, atMs: number): KeyInput => ({
  type: 'down',
  name: NAMES[code] ?? null,
  code,
  shift: false,
  atMs,
});
const up = (code: number, atMs: number): KeyInput => ({
  type: 'up',
  name: NAMES[code] ?? null,
  code,
  shift: false,
  atMs,
});

let t: number;
let queue: Map<number, { fn: () => void; at: number }>;
let seq: number;
let snapshot: LinkSnapshot | null;
let client: { postRecording: ReturnType<typeof vi.fn> };
let overlay: { toast: ReturnType<typeof vi.fn> };
let onActiveChanged: ReturnType<typeof vi.fn<() => void>>;
let registerAllKeys: ReturnType<typeof vi.fn<() => void>>;
let rec: GestureRecording;

async function advance(ms: number): Promise<void> {
  const to = t + ms;
  for (;;) {
    let next: [number, { fn: () => void; at: number }] | null = null;
    for (const e of queue) if (e[1].at <= to && (!next || e[1].at < next[1].at)) next = e;
    if (!next) break;
    queue.delete(next[0]);
    t = next[1].at;
    next[1].fn();
  }
  t = to;
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function feed(...events: KeyInput[]): void {
  for (const e of events) rec.active?.onKey({ ...e, atMs: e.atMs + 1000 });
}

function linked(token = TOKEN): LinkSnapshot {
  return { token, owner: { kind: 'user', name: 'Aurimas' }, fingerprint: 'f'.repeat(16) };
}

beforeEach(() => {
  t = 0;
  seq = 0;
  queue = new Map();
  snapshot = linked();
  client = { postRecording: vi.fn(async () => true) };
  overlay = { toast: vi.fn() };
  onActiveChanged = vi.fn<() => void>();
  registerAllKeys = vi.fn<() => void>();
  rec = createGestureRecording({
    client: client as unknown as RecordingClient,
    link: { snapshot: () => snapshot } as unknown as DeviceLinkController,
    overlay: overlay as unknown as Overlay,
    now: () => t,
    wallNow: () => WALL + t,
    timers: {
      set: (fn: () => void, ms: number) => {
        const id = ++seq;
        queue.set(id, { fn, at: t + ms });
        return id;
      },
      clear: (h: unknown) => {
        queue.delete(h as number);
      },
    },
    onActiveChanged,
    registerAllKeys,
  });
});

describe('createGestureRecording', () => {
  it('a request starts a 10 s recording with a toast and posts the keys', async () => {
    rec.onRequest({ id: 'r-1', expiresAt: FUTURE });
    expect(overlay.toast).toHaveBeenCalledWith('Recording remote keys for 10 seconds');
    expect(rec.active).not.toBeNull();
    expect(onActiveChanged).toHaveBeenCalledTimes(1);
    feed(down(38, 0), up(38, 80), down(415, 1578), up(415, 3180));
    await advance(9_999);
    expect(client.postRecording).not.toHaveBeenCalled();
    await advance(1);
    expect(rec.active).toBeNull();
    expect(onActiveChanged).toHaveBeenCalledTimes(2);
    expect(client.postRecording).toHaveBeenCalledWith('r-1', TOKEN, [
      { key: 'DPAD_UP', downMs: 0, upMs: 80 },
      { key: 'MEDIA_PLAY_PAUSE', downMs: 1578, upMs: 3180 },
    ]);
    expect(overlay.toast).toHaveBeenLastCalledWith('Keys sent to Everframe');
  });

  it('an expired, malformed or already handled request is ignored', async () => {
    rec.onRequest(null);
    rec.onRequest({ id: 'r-1', expiresAt: PAST });
    rec.onRequest({ id: 'r-1', expiresAt: 'not a date' });
    rec.onRequest({ id: '../x', expiresAt: FUTURE });
    rec.onRequest({ id: 'x'.repeat(65), expiresAt: FUTURE });
    rec.onRequest({ id: '', expiresAt: FUTURE });
    rec.onRequest({ id: 7 as unknown as string, expiresAt: FUTURE });
    expect(rec.active).toBeNull();
    expect(overlay.toast).not.toHaveBeenCalled();

    rec.onRequest({ id: 'r-2', expiresAt: FUTURE });
    await advance(10_000);
    expect(client.postRecording).toHaveBeenCalledTimes(1);
    // The next config still carries it until the server sees the upload.
    rec.onRequest({ id: 'r-2', expiresAt: FUTURE });
    expect(rec.active).toBeNull();
    await advance(10_000);
    expect(client.postRecording).toHaveBeenCalledTimes(1);
  });

  it('a request while one is active is ignored', async () => {
    rec.onRequest({ id: 'r-1', expiresAt: FUTURE });
    const first = rec.active;
    rec.onRequest({ id: 'r-2', expiresAt: FUTURE });
    expect(rec.active).toBe(first);
    await advance(10_000);
    expect(client.postRecording).toHaveBeenCalledTimes(1);
    expect(client.postRecording.mock.calls[0]![0]).toBe('r-1');
  });

  it('a request while unlinked is ignored', async () => {
    snapshot = null;
    rec.onRequest({ id: 'r-1', expiresAt: FUTURE });
    expect(rec.active).toBeNull();
    expect(registerAllKeys).not.toHaveBeenCalled();
    await advance(10_000);
    expect(client.postRecording).not.toHaveBeenCalled();
    // Linked later: the same request can still start.
    snapshot = linked();
    rec.onRequest({ id: 'r-1', expiresAt: FUTURE });
    expect(rec.active).not.toBeNull();
  });

  it('a link that changed before the end posts nothing', async () => {
    rec.onRequest({ id: 'r-1', expiresAt: FUTURE });
    snapshot = linked(OTHER);
    await advance(10_000);
    expect(client.postRecording).not.toHaveBeenCalled();
    expect(overlay.toast).toHaveBeenCalledTimes(1);

    rec.onRequest({ id: 'r-2', expiresAt: '2026-10-24T13:00:00.000Z' });
    snapshot = null;
    await advance(10_000);
    expect(client.postRecording).not.toHaveBeenCalled();
  });

  it('an empty recording is posted', async () => {
    rec.onRequest({ id: 'r-1', expiresAt: FUTURE });
    await advance(10_000);
    expect(client.postRecording).toHaveBeenCalledWith('r-1', TOKEN, []);
    expect(overlay.toast).toHaveBeenLastCalledWith('Keys sent to Everframe');
  });

  it('a failed upload shows nothing', async () => {
    client.postRecording.mockResolvedValue(false);
    rec.onRequest({ id: 'r-1', expiresAt: FUTURE });
    await advance(10_000);
    expect(client.postRecording).toHaveBeenCalledTimes(1);
    expect(overlay.toast).toHaveBeenCalledTimes(1);
    client.postRecording.mockRejectedValue(new Error('x'));
    rec.onRequest({ id: 'r-2', expiresAt: '2026-10-24T13:00:00.000Z' });
    await advance(10_000);
    expect(overlay.toast).toHaveBeenCalledTimes(2);
  });

  it('teardown cancels the timer and posts nothing', async () => {
    rec.onRequest({ id: 'r-1', expiresAt: FUTURE });
    rec.teardown();
    expect(rec.active).toBeNull();
    await advance(20_000);
    expect(client.postRecording).not.toHaveBeenCalled();
    rec.onRequest({ id: 'r-2', expiresAt: FUTURE });
    expect(rec.active).toBeNull();
  });

  it('teardown during the upload drops the success toast', async () => {
    let resolve!: (v: boolean) => void;
    client.postRecording.mockImplementation(() => new Promise<boolean>((r) => (resolve = r)));
    rec.onRequest({ id: 'r-1', expiresAt: FUTURE });
    await advance(10_000);
    rec.teardown();
    resolve(true);
    await advance(0);
    expect(overlay.toast).toHaveBeenCalledTimes(1);
  });

  it('Tizen registers every registrable contract key while recording', () => {
    rec.onRequest({ id: 'r-1', expiresAt: FUTURE });
    expect(registerAllKeys).toHaveBeenCalledTimes(1);
  });

  it('a throwing dependency never reaches the host', async () => {
    registerAllKeys.mockImplementation(() => {
      throw new Error('boom');
    });
    overlay.toast.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => rec.onRequest({ id: 'r-1', expiresAt: FUTURE })).not.toThrow();
    await advance(10_000);
    expect(client.postRecording).toHaveBeenCalledTimes(1);
  });
});
