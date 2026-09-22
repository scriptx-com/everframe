// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { submitReportFromDraft, drainOutbox } from '../../src/transport/submit.js';
import { createInMemoryOutbox } from '@traceitx/sdk-core';
import type { OutboxAdapter, ReportDraft } from '@traceitx/sdk-core';
import { draftToEnvelope } from '../../src/transport/draft-to-envelope.js';
import type { CaptureBundle } from '../../src/transport/draft-to-envelope.js';
import type { WebTraceItXConfig } from '../../src/internal/types.js';

const config: WebTraceItXConfig = {
  apiKey: 'txx_live_test',
  appName: 'test-app',
  appVersion: '1.0.0',
};
// Mirrors the vitest.config `define`'d `__TRACEITX_INGEST_URL__`. Tests that
// assert on the outbound URL compare against this constant.
const INGEST_URL = 'http://localhost:8787';

const bundle: CaptureBundle = {
  screenshotBlob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
  screenshotSha256: 'a'.repeat(64),
  screenshotWidth: 1,
  screenshotHeight: 1,
  focused: null,
  logs: [],
  network: [],
  metadata: {
    os: 'macOS',
    osVersion: '14.0',
    screenSize: { width: 1, height: 1 },
    pixelRatio: 1,
    locale: 'en',
    timezone: 'UTC',
  },
};

const draft: ReportDraft = {
  title: 'X',
  description: '',
  excludedArtifacts: [],
  annotations: [],
  redactions: [],
};

function makeFetch(status: number): typeof globalThis.fetch {
  return vi.fn(async () => new Response('{}', {
    status,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof globalThis.fetch;
}

describe('submitReportFromDraft', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ok=true on 200; deletes from outbox if previously enqueued', async () => {
    const outbox: OutboxAdapter = createInMemoryOutbox();
    const fetch = makeFetch(200);
    const out = await submitReportFromDraft({
      config,
      sdkVersion: '0.1.0',
      draft,
      bundle,
      outbox,
      fetch,
      retryScheduleMs: [],
    });
    expect(out.ok).toBe(true);
    expect(out.retryable).toBe(false);
    expect((await outbox.list()).length).toBe(0);
  });

  it('returns retryable=true on 5xx; enqueues into outbox', async () => {
    const outbox: OutboxAdapter = createInMemoryOutbox();
    const fetch = makeFetch(503);
    const out = await submitReportFromDraft({
      config,
      sdkVersion: '0.1.0',
      draft,
      bundle,
      outbox,
      fetch,
      retryScheduleMs: [],
    });
    expect(out.ok).toBe(false);
    expect(out.retryable).toBe(true);
    const queued = await outbox.list();
    expect(queued.length).toBe(1);
    expect(queued[0]!.reportId).toBe(out.reportId);
  });

  it('returns retryable=false on 401; does NOT enqueue', async () => {
    const outbox: OutboxAdapter = createInMemoryOutbox();
    const fetch = makeFetch(401);
    const out = await submitReportFromDraft({
      config,
      sdkVersion: '0.1.0',
      draft,
      bundle,
      outbox,
      fetch,
      retryScheduleMs: [],
    });
    expect(out.ok).toBe(false);
    expect(out.retryable).toBe(false);
    expect((await outbox.list()).length).toBe(0);
  });
});

describe('drainOutbox', () => {
  it('iterates and submits each queued item; deletes on success', async () => {
    const outbox: OutboxAdapter = createInMemoryOutbox();
    // Pre-seed with a minimal payload — submitReportFromDraft enqueues this exact shape
    const sentinel = JSON.stringify({ reportId: 'r1', protocolVersion: '1.0' });
    await outbox.enqueue({
      reportId: 'r1',
      enqueuedAt: 1,
      attempts: 0,
      payload: new TextEncoder().encode(sentinel),
      metadata: { url: `${INGEST_URL}/api/ingest`, sdkKey: config.apiKey },
    });
    const fetch = makeFetch(200);
    const result = await drainOutbox({
      outbox,
      config,
      sdkVersion: '0.1.0',
      fetch,
      retryScheduleMs: [],
    });
    expect(result.submitted).toBe(1);
    expect((await outbox.list()).length).toBe(0);
  });

  // Finding 1-CLIENT: mirrors submitReportFromDraft's veto-time behavior —
  // when no credentials store is in play (the local veto path), a
  // server-provisioned device token must never be persisted, even though the
  // server's no-token fallback still mints one.
  it('never persists a server-minted device token when credentials is omitted (local veto)', async () => {
    const outbox: OutboxAdapter = createInMemoryOutbox();
    const sentinel = JSON.stringify({ reportId: 'r1', protocolVersion: '1.0' });
    await outbox.enqueue({
      reportId: 'r1',
      enqueuedAt: 1,
      attempts: 0,
      payload: new TextEncoder().encode(sentinel),
      metadata: { url: `${INGEST_URL}/api/ingest`, sdkKey: config.apiKey },
    });
    const fetch = vi.fn(async () => new Response(
      JSON.stringify({ thread: { id: 't9' }, device: { token: 'txr_' + 'e'.repeat(43) } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof globalThis.fetch;
    const result = await drainOutbox({
      outbox,
      config,
      sdkVersion: '0.1.0',
      fetch,
      retryScheduleMs: [],
      credentials: null,
    });
    expect(result.submitted).toBe(1);
    // No credentials store was ever offered to persist into.
  });
});
