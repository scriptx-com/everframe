// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OutboxAdapter, OutboxItem, ReportDraft } from '@everframe/sdk-core';
import { submitReportFromDraft } from '../../src/transport/submit.js';
import {
  FINGERPRINT_METADATA_KEY,
  LINK_NONCE_HEADER,
  parseLinkPending,
} from '../../src/transport/device-link-upload.js';
import type { CaptureBundle } from '../../src/transport/draft-to-envelope.js';
import type { WebEverframeConfig } from '../../src/internal/types.js';

const TOKEN = 'evf_dev_' + 'K'.repeat(32);
const FP = '0123456789abcdef';
const NONCE = 'q'.repeat(40);
const ID = '0b7c2c3e-8f2a-4c1d-9e1b-3f6a5d4c2b1a';

const config: WebEverframeConfig = { sdkKey: 'sdk-key-1', appName: 'tv', appVersion: '1.0.0' };
const bundle: CaptureBundle = {
  screenshotBlob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
  screenshotSha256: 'a'.repeat(64),
  screenshotWidth: 1,
  screenshotHeight: 1,
  focused: null,
  logs: [],
  network: [],
  metadata: {
    os: 'Tizen',
    osVersion: '6.5',
    screenSize: { width: 1, height: 1 },
    pixelRatio: 1,
    locale: 'en',
    timezone: 'UTC',
  },
};
const draft: ReportDraft = {
  title: '',
  description: '',
  excludedArtifacts: [],
  annotations: [],
  redactions: [],
};
const BASE = { config, sdkVersion: '1.5.0', draft, bundle, retryScheduleMs: [] as number[] };

function fakeOutbox(): OutboxAdapter & { enqueue: ReturnType<typeof vi.fn> } {
  return {
    enqueue: vi.fn(async (_item: OutboxItem) => undefined),
    list: vi.fn(async () => []),
    delete: vi.fn(async () => undefined),
  };
}

type FetchSpy = ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>;
function fetchReturning(status: number, body: unknown): FetchSpy {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

async function envelopeOf(body: BodyInit | null | undefined): Promise<Record<string, unknown>> {
  return JSON.parse(await ((body as FormData).get('envelope') as Blob).text()) as Record<
    string,
    unknown
  >;
}

afterEach(() => vi.restoreAllMocks());

describe('quick-capture uploads with a device link', () => {
  it('a linked quick capture sends the token, a nonce, quickCapture:true and follows no redirects', async () => {
    const fetchSpy = fetchReturning(200, {});
    const out = await submitReportFromDraft({
      ...BASE,
      outbox: fakeOutbox(),
      fetch: fetchSpy as unknown as typeof fetch,
      quickCapture: true,
      deviceLink: { token: TOKEN, fingerprint: FP, nonce: NONCE },
    });
    expect(out.ok).toBe(true);
    const init = fetchSpy.mock.calls[0]![1];
    const h = new Headers(init.headers);
    expect(h.get('X-Everframe-Capture-Token')).toBe(TOKEN);
    expect(h.get('X-Everframe-Link-Nonce')).toBe(NONCE);
    expect(h.get('Authorization')).toBe('Bearer sdk-key-1');
    expect(init.redirect).toBe('error');
    expect(init.credentials).toBe('omit');
    expect(await envelopeOf(init.body)).toMatchObject({ quickCapture: true });
  });

  it('a normal report carries no quickCapture flag', async () => {
    const fetchSpy = fetchReturning(200, {});
    await submitReportFromDraft({
      ...BASE,
      outbox: fakeOutbox(),
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const env = await envelopeOf(fetchSpy.mock.calls[0]![1].body);
    expect('quickCapture' in env).toBe(false);
    expect(new Headers(fetchSpy.mock.calls[0]![1].headers).has('X-Everframe-Capture-Token')).toBe(
      false,
    );
  });

  it('a 200 with linkPending is returned on the outcome', async () => {
    const out = await submitReportFromDraft({
      ...BASE,
      outbox: fakeOutbox(),
      fetch: fetchReturning(200, {
        linkPending: { attemptId: ID, number: 47 },
      }) as unknown as typeof fetch,
      quickCapture: true,
      deviceLink: { token: TOKEN, fingerprint: FP, nonce: NONCE },
    });
    expect(out.ok).toBe(true);
    expect(out.linkPending).toEqual({ attemptId: ID, number: 47 });
  });

  it('a malformed linkPending is ignored', async () => {
    const out = await submitReportFromDraft({
      ...BASE,
      outbox: fakeOutbox(),
      fetch: fetchReturning(200, {
        linkPending: { attemptId: 'x', number: 47 },
      }) as unknown as typeof fetch,
      quickCapture: true,
      deviceLink: { token: TOKEN, fingerprint: FP, nonce: NONCE },
    });
    expect(out.ok).toBe(true);
    expect(out.linkPending).toBeUndefined();
  });

  it('parseLinkPending validates the id and the number', () => {
    expect(parseLinkPending({ linkPending: { attemptId: ID, number: 0 } })).toEqual({
      attemptId: ID,
      number: 0,
    });
    for (const body of [
      null,
      {},
      { linkPending: { attemptId: ID, number: 100 } },
      { linkPending: { attemptId: ID, number: 1.5 } },
      { linkPending: { attemptId: ID, number: '4' } },
      { linkPending: { attemptId: 'nope', number: 4 } },
    ]) {
      expect(parseLinkPending(body)).toBeNull();
    }
  });

  it('403 device_unlinked is not queued and reports deviceUnlinked', async () => {
    const outbox = fakeOutbox();
    const out = await submitReportFromDraft({
      ...BASE,
      outbox,
      fetch: fetchReturning(403, { error: 'device_unlinked' }) as unknown as typeof fetch,
      quickCapture: true,
      deviceLink: { token: TOKEN, fingerprint: FP, nonce: NONCE },
    });
    expect(out).toMatchObject({ ok: false, retryable: false, deviceUnlinked: true });
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('another 403 is not device_unlinked', async () => {
    const out = await submitReportFromDraft({
      ...BASE,
      outbox: fakeOutbox(),
      fetch: fetchReturning(403, { error: 'forbidden' }) as unknown as typeof fetch,
      quickCapture: true,
      deviceLink: { token: TOKEN, fingerprint: FP, nonce: NONCE },
    });
    expect(out.ok).toBe(false);
    expect(out.deviceUnlinked).toBeUndefined();
  });

  it('a transient failure queues the fingerprint and never the token or nonce', async () => {
    const outbox = fakeOutbox();
    const out = await submitReportFromDraft({
      ...BASE,
      retryScheduleMs: [0, 0],
      outbox,
      fetch: fetchReturning(503, {}) as unknown as typeof fetch,
      quickCapture: true,
      deviceLink: { token: TOKEN, fingerprint: FP, nonce: NONCE },
    });
    expect(out).toMatchObject({ ok: false, retryable: true });
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    const item = outbox.enqueue.mock.calls[0]![0] as OutboxItem;
    expect(item.metadata[FINGERPRINT_METADATA_KEY]).toBe(FP);
    expect(item.metadata['sdkKey']).toBe('sdk-key-1');
    expect(item.metadata['url']).toBe('http://localhost:8787/api/ingest');
    const raw = JSON.stringify({ ...item, payload: Array.from(item.payload) });
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain(NONCE);
    expect(new TextDecoder().decode(item.payload)).not.toContain(TOKEN);
  });

  it('a linked capture with no fingerprint is not queued', async () => {
    const outbox = fakeOutbox();
    const out = await submitReportFromDraft({
      ...BASE,
      outbox,
      fetch: fetchReturning(503, {}) as unknown as typeof fetch,
      quickCapture: true,
      deviceLink: { token: TOKEN, fingerprint: '', nonce: NONCE },
    });
    expect(out).toMatchObject({ ok: false, retryable: true, notQueued: true });
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('an unlinked debug capture sends no capture token and queues like any report', async () => {
    const outbox = fakeOutbox();
    const fetchSpy = fetchReturning(503, {});
    await submitReportFromDraft({
      ...BASE,
      outbox,
      fetch: fetchSpy as unknown as typeof fetch,
      quickCapture: true,
    });
    const h = new Headers(fetchSpy.mock.calls[0]![1].headers);
    expect(h.has('X-Everframe-Capture-Token')).toBe(false);
    expect(h.has(LINK_NONCE_HEADER)).toBe(false);
    expect(await envelopeOf(fetchSpy.mock.calls[0]![1].body)).toMatchObject({ quickCapture: true });
    const item = outbox.enqueue.mock.calls[0]![0] as OutboxItem;
    expect(item.metadata).toEqual({ url: 'http://localhost:8787/api/ingest', sdkKey: 'sdk-key-1' });
  });
});
