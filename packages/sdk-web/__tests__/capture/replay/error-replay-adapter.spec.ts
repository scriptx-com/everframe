// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
// @vitest-environment jsdom
//
// Replays on errors (spec 2026-10-11), end to end through the REAL adapter,
// lifecycle, recorder and outbox. Only rrweb and gzip are doubled (the same
// harness as strictmode-replay-restart.spec.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gunzipSync, gzipSync } from 'node:zlib';

const rrweb = { fire: (_ts: number, _type?: number): void => undefined };
const importRrweb = async (): Promise<{ record: (o: Record<string, unknown>) => () => void }> => ({
  record: (options: Record<string, unknown>) => {
    const emit = options['emit'] as (e: unknown, isCheckout?: boolean) => void;
    rrweb.fire = (ts: number, type = 2): void => {
      emit(
        { type, timestamp: ts, data: { node: { type: 3, textContent: `frame ${ts}`, id: 1 } } },
        type === 2,
      );
    };
    return () => undefined;
  },
});
const testGzip = async (input: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(gzipSync(Buffer.from(input)));
const gz: { impl: (input: Uint8Array) => Promise<Uint8Array> } = { impl: testGzip };
const recorders: unknown[] = [];

vi.mock('../../../src/capture/replay/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/capture/replay/index.js')>();
  return {
    ...actual,
    createReplayRecorder: (deps: Record<string, unknown> = {}) => {
      const rec = actual.createReplayRecorder({
        ...deps,
        importRrweb,
        gzip: (input: Uint8Array) => gz.impl(input),
        yieldToHost: () => Promise.resolve(),
      });
      recorders.push(rec);
      return rec;
    },
  };
});

import type { ReplayRecorder } from '../../../src/capture/replay/recorder.js';
import { createWebPlatformAdapter, type WebPlatformAdapter } from '../../../src/adapter.js';
import { __resetErrorReplayBudgetForTesting } from '../../../src/capture/replay/error-replay.js';
import {
  __resetErrorReplayPartsForTesting,
  isErrorReplayPending,
} from '../../../src/transport/error-replay-parts.js';
import { drainOutbox } from '../../../src/transport/submit.js';
import { REPLAY_BYTE_CAP } from '../../../src/transport/draft-to-envelope.js';
import { readBlobArrayBuffer } from '../../../src/internal/blob.js';

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

let ingest: FormData[] = [];
let ingestStatus = 200;
const adapters: WebPlatformAdapter[] = [];

function stubServer(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.includes('/api/config')) {
        return new Response(
          JSON.stringify({ replayEnabled: true, replayDurationSec: 30, samplingRate: 1 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/ingest')) ingest.push(init?.body as FormData);
      return new Response(JSON.stringify({ status: 'received' }), {
        status: ingestStatus,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await readBlobArrayBuffer(blob));
}

async function envelopeOf(body: FormData): Promise<Record<string, any>> {
  const raw = await bytesOf(body.get('envelope') as Blob);
  const json =
    raw[0] === 0x1f && raw[1] === 0x8b
      ? gunzipSync(Buffer.from(raw)).toString('utf8')
      : new TextDecoder().decode(raw);
  return JSON.parse(json) as Record<string, any>;
}

function errorWithStack(name: string): Error {
  const err = new Error(name);
  err.stack = `Error: ${name}\n    at ${name} (${name}.ts:1:1)`;
  return err;
}

function adapterOf(): WebPlatformAdapter {
  const adapter = createWebPlatformAdapter({ sdkKey: 'pk_test' });
  adapters.push(adapter);
  return adapter;
}

/** An adapter whose replay window is recording a full snapshot and one change. */
async function recordingAdapter(): Promise<WebPlatformAdapter> {
  const adapter = adapterOf();
  await adapter.__initReplay();
  await flush();
  expect(adapter.__replayLifecycle?.state).toBe('BUFFERING');
  const now = Date.now();
  rrweb.fire(now - 2_000, 2);
  rrweb.fire(now - 1_000, 3);
  return adapter;
}

beforeEach(() => {
  localStorage.clear();
  ingest = [];
  ingestStatus = 200;
  recorders.length = 0;
  gz.impl = testGzip;
  __resetErrorReplayBudgetForTesting();
  __resetErrorReplayPartsForTesting();
  stubServer();
});

afterEach(() => {
  while (adapters.length) adapters.pop()!.__testCleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('replays on web errors', () => {
  it('attaches the replay to an error captured while the page records, and keeps recording', async () => {
    const adapter = await recordingAdapter();
    adapter.captureException?.(errorWithStack('first'));
    await vi.waitFor(() => expect(ingest).toHaveLength(1));
    const body = ingest[0]!;
    const envelope = await envelopeOf(body);
    expect(envelope.source).toBe('error');
    expect(envelope.attachments).toEqual([
      expect.objectContaining({
        partName: 'session-replay',
        kind: 'session-replay',
        format: 'rrweb',
        contentType: 'application/octet-stream',
      }),
    ]);
    const part = await bytesOf(body.get('session-replay') as Blob);
    expect(envelope.attachments[0].byteLength).toBe(part.byteLength);
    const events = JSON.parse(gunzipSync(Buffer.from(part)).toString('utf8')) as Array<{
      type: number;
    }>;
    expect(events.map((e) => e.type)).toEqual([2, 3, 5]);
    // Non-destructive: same window, still recording, lifecycle untouched.
    expect((recorders[recorders.length - 1] as ReplayRecorder).__diagnostics()).toMatchObject({
      recording: true,
      frozen: false,
      frames: 2,
    });
    expect(adapter.__replayLifecycle?.state).toBe('BUFFERING');
  });

  it('sends at most 2 error replays per page session', async () => {
    const adapter = await recordingAdapter();
    const names = ['one', 'two', 'three'];
    for (let i = 0; i < names.length; i++) {
      adapter.captureException?.(errorWithStack(names[i]!));
      await vi.waitFor(() => expect(ingest).toHaveLength(i + 1));
    }
    const counts = await Promise.all(
      ingest.map(async (body) => (await envelopeOf(body)).attachments.length),
    );
    expect(counts).toEqual([1, 1, 0]);
    expect(ingest[2]!.get('session-replay')).toBeNull();
    expect((await envelopeOf(ingest[2]!)).captureControl.replayOmitted).toBeUndefined();
  });

  it('revokes settled retry bytes on kill while preserving the durable error', async () => {
    const adapter = await recordingAdapter();
    ingestStatus = 503;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    adapter.captureException?.(errorWithStack('offline-settled'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ingest.length).toBeGreaterThan(0);
    expect(ingest[0]!.get('session-replay')).not.toBeNull();
    expect(await adapter.outbox!.list()).toHaveLength(1);
    adapter.onKill?.();
    expect(await adapter.outbox!.list()).toHaveLength(1);
    const replacement = createWebPlatformAdapter({
      sdkKey: 'pk_test',
      sessionReplay: { disabled: true },
    });
    adapters.push(replacement);
    ingestStatus = 200;
    await drainOutbox({
      outbox: replacement.outbox!,
      config: { sdkKey: 'pk_test', sessionReplay: { disabled: true } },
      sdkVersion: 'test',
    });
    expect(ingest.at(-1)!.get('session-replay')).toBeNull();
    expect((await envelopeOf(ingest.at(-1)!)).attachments).toEqual([]);
    expect(await replacement.outbox!.list()).toEqual([]);
  });

  it('takes no replay while a bug report has frozen the window', async () => {
    const adapter = await recordingAdapter();
    adapter.__replayLifecycle!.freeze();
    adapter.captureException?.(errorWithStack('during-report'));
    await vi.waitFor(() => expect(ingest).toHaveLength(1));
    expect(ingest[0]!.get('session-replay')).toBeNull();
    const envelope = await envelopeOf(ingest[0]!);
    expect(envelope.attachments).toEqual([]);
    expect(envelope.captureControl.replayOmitted).toBeUndefined();
    adapter.__replayLifecycle!.cancel();
  });

  it('sends the error flagged, without a replay over the size limit', async () => {
    gz.impl = async () => new Uint8Array(REPLAY_BYTE_CAP + 1);
    const adapter = await recordingAdapter();
    adapter.captureException?.(errorWithStack('too-big'));
    await vi.waitFor(() => expect(ingest).toHaveLength(1));
    expect(ingest[0]!.get('session-replay')).toBeNull();
    const envelope = await envelopeOf(ingest[0]!);
    expect(envelope.attachments).toEqual([]);
    expect(envelope.captureControl.replayOmitted).toBe(true);
  });

  it('keeps the replay of an uncaught React render error when the provider unmounts in the same commit', async () => {
    const adapter = await recordingAdapter();
    adapter.__captureUncaughtReactError(
      errorWithStack('render'),
      '\n    at Widget (Widget.tsx:3:7)',
    );
    adapter.onKill?.('release'); // React unmounts the provider; the recorder is killed
    await vi.waitFor(() => expect(ingest).toHaveLength(1));
    const envelope = await envelopeOf(ingest[0]!);
    expect(envelope.source).toBe('crash');
    expect(envelope.payload.crash.fatal).toBe(true);
    expect(envelope.attachments).toHaveLength(1);
    expect(ingest[0]!.get('session-replay')).not.toBeNull();
  });

  it('takes no replay on an engine without CompressionStream, flags nothing and uses no slot', async () => {
    const adapter = await recordingAdapter();
    const original = globalThis.CompressionStream;
    vi.stubGlobal('CompressionStream', undefined); // same pattern as sdk-core compression.spec.ts
    adapter.captureException?.(errorWithStack('old-engine'));
    await vi.waitFor(() => expect(ingest).toHaveLength(1));
    expect(ingest[0]!.get('session-replay')).toBeNull();
    const envelope = await envelopeOf(ingest[0]!);
    expect(envelope.attachments).toEqual([]);
    expect(envelope.captureControl.replayOmitted).toBeUndefined();
    // With CompressionStream defined the replay is attached, and both slots are still free.
    vi.stubGlobal('CompressionStream', original);
    adapter.captureException?.(errorWithStack('modern-one'));
    await vi.waitFor(() => expect(ingest).toHaveLength(2));
    adapter.captureException?.(errorWithStack('modern-two'));
    await vi.waitFor(() => expect(ingest).toHaveLength(3));
    expect(ingest[1]!.get('session-replay')).not.toBeNull();
    expect(ingest[2]!.get('session-replay')).not.toBeNull();
  });

  it('persists the original JSON before export, skips other drains, and sends at the deadline', async () => {
    const adapter = await recordingAdapter();
    let finish!: (bytes: Uint8Array) => void;
    gz.impl = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    adapter.captureException?.(errorWithStack('deadline'));
    await flush();
    const items = await adapter.outbox!.list();
    expect(items).toHaveLength(1);
    const original = new TextDecoder().decode(items[0]!.payload);
    expect(JSON.parse(original).attachments).toEqual([]);
    expect(JSON.parse(original).captureControl.replayOmitted).toBeUndefined();
    expect(isErrorReplayPending(items[0]!.reportId)).toBe(true);
    await drainOutbox({
      outbox: adapter.outbox!,
      config: { sdkKey: 'pk_test' },
      sdkVersion: 'test',
    });
    expect(ingest).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3_000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(ingest).toHaveLength(1));
    expect((await envelopeOf(ingest[0]!)).captureControl.replayOmitted).toBe(true);
    expect(ingest[0]!.get('session-replay')).toBeNull();
    finish(new Uint8Array([1, 2, 3]));
    await flush();
    expect(ingest).toHaveLength(1);
    expect(await adapter.outbox!.list()).toEqual([]);
  });

  it('forgets a pending replay when outbox admission fails', async () => {
    const adapter = await recordingAdapter();
    const enqueue = vi
      .spyOn(adapter.outbox!, 'enqueue')
      .mockRejectedValue(new Error('storage failed'));
    adapter.captureException?.(errorWithStack('enqueue-failed'));
    const reportId = enqueue.mock.calls[0]![0].reportId;
    expect(isErrorReplayPending(reportId)).toBe(true);
    await flush();
    expect(isErrorReplayPending(reportId)).toBe(false);
    expect(ingest).toHaveLength(0);
  });

  it('discards the error and replay when consent is withdrawn during export', async () => {
    const adapter = await recordingAdapter();
    let finish!: (bytes: Uint8Array) => void;
    gz.impl = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    adapter.captureException?.(errorWithStack('withdraw'));
    await flush();
    const items = await adapter.outbox!.list();
    expect(items).toHaveLength(1);
    adapter.onKill?.();
    finish(new Uint8Array([1, 2, 3]));
    await flush(40);
    expect(await adapter.outbox!.list()).toEqual([]);
    expect(isErrorReplayPending(items[0]!.reportId)).toBe(false);
    expect(ingest).toHaveLength(0);
  });

  it.each(['onerror', 'unhandledrejection'])(
    'attaches replay through the %s browser hook',
    async (mechanism) => {
      await recordingAdapter();
      const error = errorWithStack(mechanism);
      if (mechanism === 'onerror') window.onerror?.(error.message, 'app.ts', 1, 1, error);
      else {
        const event = new Event('unhandledrejection');
        Object.defineProperty(event, 'reason', { value: error });
        window.dispatchEvent(event);
      }
      await vi.waitFor(() => expect(ingest).toHaveLength(1));
      const envelope = await envelopeOf(ingest[0]!);
      expect(envelope.source).toBe('error');
      expect(envelope.payload.crash.mechanism).toBe(mechanism);
      expect(ingest[0]!.get('session-replay')).not.toBeNull();
    },
  );

  it('takes no extra snapshot for duplicate or throttled errors', async () => {
    const adapter = await recordingAdapter();
    const snapshot = vi.spyOn(recorders[recorders.length - 1] as ReplayRecorder, 'snapshot');
    const error = errorWithStack('duplicate');
    adapter.captureException?.(error);
    adapter.captureException?.(error);
    adapter.captureException?.(errorWithStack('duplicate'));
    await vi.waitFor(() => expect(ingest).toHaveLength(1));
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it('takes no replay while the page is not recording', async () => {
    const adapter = adapterOf();
    adapter.captureException?.(errorWithStack('idle'));
    await vi.waitFor(() => expect(ingest).toHaveLength(1));
    expect(ingest[0]!.get('session-replay')).toBeNull();
    expect((await envelopeOf(ingest[0]!)).attachments).toEqual([]);
  });
});
