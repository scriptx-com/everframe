// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classify, requestJson, sendReport, SEND_TIMEOUT_MS } from '../src/transport.js';
import { createFetch } from './fakes.js';

const deps = (fetch: Parameters<typeof sendReport>[0]['fetch']) => ({
  fetch,
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

afterEach(() => {
  vi.useRealTimers();
});

describe('transport', () => {
  it.each([
    [200, 'sent'],
    [202, 'sent'],
    [400, 'drop'],
    [401, 'drop'],
    [403, 'drop'],
    [413, 'drop'],
    [426, 'drop'],
    [301, 'drop'],
    [0, 'retry'],
    [408, 'retry'],
    [429, 'retry'],
    [500, 'retry'],
    [503, 'retry'],
  ] as const)('classifies %i as %s', (status, outcome) => {
    expect(classify(status)).toBe(outcome);
  });

  it('posts the envelope as JSON with the SDK key, never multipart', async () => {
    const fetch = createFetch([200]);
    const result = await sendReport(
      deps(fetch),
      'https://everframe.dev/api/ingest',
      'evf_live_key',
      '{"a":1}',
    );
    expect(result).toEqual({ outcome: 'sent', status: 200 });
    expect(fetch.requests[0]).toMatchObject({
      url: 'https://everframe.dev/api/ingest',
      headers: { Authorization: 'Bearer evf_live_key', 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });
  });

  it('retries after a network error', async () => {
    const fetch = createFetch([0]);
    expect(await sendReport(deps(fetch), 'https://x/api/ingest', 'k', '{}')).toEqual({
      outcome: 'retry',
      status: 0,
    });
  });

  it('gives up on a request that never answers', async () => {
    vi.useFakeTimers();
    const hanging = (() => new Promise<never>(() => undefined)) as unknown as Parameters<
      typeof sendReport
    >[0]['fetch'];
    const pending = sendReport(deps(hanging), 'https://x/api/ingest', 'k', '{}');
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);
    expect(await pending).toEqual({ outcome: 'retry', status: 0 });
  });

  it('sendReportReadsBodyOn403WhenAsked', async () => {
    const fetch = createFetch();
    fetch.route('POST', '/api/ingest', { status: 403, body: { error: 'device_unlinked' } });
    const result = await sendReport(deps(fetch), 'https://x.dev/api/ingest', 'k', '{}', {
      readBody: true,
    });
    expect(result).toEqual({ outcome: 'drop', status: 403, body: { error: 'device_unlinked' } });
    const plain = await sendReport(deps(fetch), 'https://x.dev/api/ingest', 'k', '{}');
    expect(plain).toEqual({ outcome: 'drop', status: 403 });
  });

  it('sendReportReadsBodyOn2xxOnly', async () => {
    const fetch = createFetch();
    fetch.route('POST', '/api/ingest', [
      { status: 200, body: { linkPending: { attemptId: 'a', number: 4 } } },
      { status: 400, body: { error: 'bad' } },
    ]);
    const ok = await sendReport(deps(fetch), 'https://x.dev/api/ingest', 'k', '{}', {
      readBody: true,
    });
    expect(ok.body).toEqual({ linkPending: { attemptId: 'a', number: 4 } });
    const bad = await sendReport(deps(fetch), 'https://x.dev/api/ingest', 'k', '{}', {
      readBody: true,
    });
    expect(bad).toEqual({ outcome: 'drop', status: 400 });
  });

  it('sendReportAddsExtraHeaders', async () => {
    const fetch = createFetch([200]);
    await sendReport(deps(fetch), 'https://x.dev/api/ingest', 'k', '{}', {
      headers: { 'X-Everframe-Link-Nonce': 'n'.repeat(40) },
    });
    expect(fetch.requests[0]!.headers).toEqual({
      Authorization: 'Bearer k',
      'Content-Type': 'application/json',
      'X-Everframe-Link-Nonce': 'n'.repeat(40),
    });
  });

  it('extraHeadersNeverReplaceAuthOrContentType', async () => {
    const fetch = createFetch([200]);
    await sendReport(deps(fetch), 'https://x.dev/api/ingest', 'k', '{}', {
      headers: { Authorization: 'Bearer other', 'Content-Type': 'text/plain' },
    });
    expect(fetch.requests[0]!.headers.Authorization).toBe('Bearer k');
    expect(fetch.requests[0]!.headers['Content-Type']).toBe('application/json');
  });

  it('sendReportTreatsARedirectAsRetryWithoutBody', async () => {
    const fetch = createFetch();
    fetch.route('POST', '/api/ingest', {
      status: 200,
      url: 'https://elsewhere.dev/api/ingest',
      body: { linkPending: { attemptId: 'a', number: 4 } },
    });
    const result = await sendReport(deps(fetch), 'https://x.dev/api/ingest', 'k', '{}', {
      readBody: true,
    });
    expect(result).toEqual({ outcome: 'retry', status: 0 });
  });

  it('aNormalizedFinalUrlIsNotARedirect', async () => {
    const fetch = createFetch();
    fetch.route('POST', '/api/ingest', { status: 200, url: 'https://x.dev/api/ingest' });
    const result = await sendReport(deps(fetch), 'https://X.dev:443/api/ingest', 'k', '{}');
    expect(result.outcome).toBe('sent');
  });

  it('requestJsonSendsRedirectError', async () => {
    const fetch = createFetch();
    fetch.route('GET', '/api/config', { status: 200, body: { a: 1 } });
    const result = await requestJson(deps(fetch), {
      url: 'https://x.dev/api/config',
      method: 'GET',
      headers: { Authorization: 'Bearer k' },
    });
    expect(result).toEqual({ status: 200, body: { a: 1 }, redirected: false });
    expect(fetch.all[0]!.redirect).toBe('error');
    expect(fetch.all[0]!.method).toBe('GET');
  });

  it('requestJsonDiscardsARedirectedResponse', async () => {
    const fetch = createFetch();
    fetch.route('POST', '/api/device-link/hello', {
      status: 200,
      url: 'https://evil.dev/hello',
      body: { status: 'pending' },
    });
    const result = await requestJson(deps(fetch), {
      url: 'https://x.dev/api/device-link/hello',
      method: 'POST',
      headers: {},
      body: '{}',
    });
    expect(result).toEqual({ status: 0, body: undefined, redirected: true });
  });

  it('requestJsonBoundsTheBody', async () => {
    const fetch = createFetch();
    fetch.route('GET', '/big', { status: 200, body: 'x'.repeat(5000) });
    fetch.route('GET', '/bad', { status: 200, body: '{' });
    const big = await requestJson(deps(fetch), {
      url: 'https://x.dev/big',
      method: 'GET',
      headers: {},
    });
    expect(big).toEqual({ status: 200, body: undefined, redirected: false });
    const bad = await requestJson(deps(fetch), {
      url: 'https://x.dev/bad',
      method: 'GET',
      headers: {},
    });
    expect(bad).toEqual({ status: 200, body: undefined, redirected: false });
  });

  it('requestJsonNetworkErrorAndTimeoutAreStatus0', async () => {
    const fetch = createFetch();
    fetch.route('GET', '/down', { status: 0 });
    expect(
      await requestJson(deps(fetch), { url: 'https://x.dev/down', method: 'GET', headers: {} }),
    ).toEqual({ status: 0, body: undefined, redirected: false });
    vi.useFakeTimers();
    fetch.route('GET', '/hang', { status: 200, gate: new Promise(() => undefined) });
    const pending = requestJson(deps(fetch), {
      url: 'https://x.dev/hang',
      method: 'GET',
      headers: {},
    });
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);
    expect(await pending).toEqual({ status: 0, body: undefined, redirected: false });
  });
});
