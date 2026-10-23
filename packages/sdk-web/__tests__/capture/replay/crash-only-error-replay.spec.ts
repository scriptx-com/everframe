// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
// @vitest-environment jsdom
//
// Crash-only sessions (spec 2026-10-12): error replays follow recording. A
// crash-only session at the default rate records nothing, so its errors carry
// no replay. Same harness as
// error-replay-adapter.spec.ts: only rrweb and gzip are doubled.
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

vi.mock('../../../src/capture/replay/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/capture/replay/index.js')>();
  return {
    ...actual,
    createReplayRecorder: (deps: Record<string, unknown> = {}) =>
      actual.createReplayRecorder({
        ...deps,
        importRrweb,
        gzip: async (input: Uint8Array) => new Uint8Array(gzipSync(Buffer.from(input))),
        yieldToHost: () => Promise.resolve(),
      }),
  };
});

import { createWebPlatformAdapter, type WebPlatformAdapter } from '../../../src/adapter.js';
import { __resetErrorReplayBudgetForTesting } from '../../../src/capture/replay/error-replay.js';
import { __resetErrorReplayPartsForTesting } from '../../../src/transport/error-replay-parts.js';
import { readBlobArrayBuffer } from '../../../src/internal/blob.js';

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

let ingest: FormData[] = [];
const adapters: WebPlatformAdapter[] = [];

function stubServer(config: Record<string, unknown>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.includes('/api/config')) {
        return new Response(JSON.stringify(config), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/api/ingest')) ingest.push(init?.body as FormData);
      return new Response(JSON.stringify({ status: 'received' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

async function envelopeOf(body: FormData): Promise<Record<string, any>> {
  const raw = new Uint8Array(await readBlobArrayBuffer(body.get('envelope') as Blob));
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

function crashOnlyAdapter(): WebPlatformAdapter {
  const adapter = createWebPlatformAdapter({ sdkKey: 'pk_test', reporter: { disabled: true } });
  adapters.push(adapter);
  return adapter;
}

function fireFrames(): void {
  const now = Date.now();
  rrweb.fire(now - 2_000, 2);
  rrweb.fire(now - 1_000, 3);
}

beforeEach(() => {
  localStorage.clear();
  ingest = [];
  __resetErrorReplayBudgetForTesting();
  __resetErrorReplayPartsForTesting();
});

afterEach(() => {
  while (adapters.length) adapters.pop()!.__testCleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('error replays in crash-only sessions', () => {
  it('attaches no replay to an error in a crash-only session at the default rate', async () => {
    stubServer({ replayEnabled: true, replayDurationSec: 30, samplingRate: 1 });
    const adapter = crashOnlyAdapter();
    await adapter.__initReplay();
    await flush();
    expect(adapter.__replayLifecycle?.state).toBe('IDLE');

    adapter.captureException?.(errorWithStack('crash-only'));
    await vi.waitFor(() => expect(ingest).toHaveLength(1));
    expect(ingest[0]!.get('session-replay')).toBeNull();
    const envelope = await envelopeOf(ingest[0]!);
    expect(envelope.source).toBe('error');
    expect(envelope.attachments).toEqual([]);
    expect(envelope.captureControl.replayOmitted).toBeUndefined();
  });

  it('attaches a replay in a crash-only session the crash-only rate admitted', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.01);
    stubServer({
      replayEnabled: true,
      replayDurationSec: 30,
      samplingRate: 0,
      crashOnlySamplingRate: 0.05,
    });
    const adapter = crashOnlyAdapter();
    await adapter.__initReplay();
    await flush();
    expect(adapter.__replayLifecycle?.state).toBe('BUFFERING');
    fireFrames();

    adapter.captureException?.(errorWithStack('sampled-in'));
    await vi.waitFor(() => expect(ingest).toHaveLength(1));
    expect(ingest[0]!.get('session-replay')).not.toBeNull();
  });
});
