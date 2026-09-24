// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect, vi } from 'vitest';
import { createReporterApi, ReporterApiError } from '../src/reporter/api.js';

const TOKEN = 'evr_' + 'a'.repeat(43);
const THREAD = { id: '11111111-1111-4111-8111-111111111111', status: 'open', reportTitle: 'Crash', createdAt: '2026-08-01T00:00:00.000Z', lastMessageAt: null, unreadCount: 2 };

function apiWith(fetchImpl: ReturnType<typeof vi.fn>) {
  return createReporterApi({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    baseUrl: 'https://x.test', apiKey: 'txx_live_k',
  });
}

describe('createReporterApi', () => {
  it('listThreads sends both credentials plus If-None-Match, returns threads and etag', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ threads: [THREAD] }), {
      status: 200, headers: { ETag: '"abc"' },
    }));
    const res = await apiWith(fetchImpl).listThreads(TOKEN, '"old"');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://x.test/api/reporter/threads');
    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer txx_live_k');
    expect(headers['X-Everframe-Device-Token']).toBe(TOKEN);
    expect(headers['If-None-Match']).toBe('"old"');
    expect(res).toEqual({ kind: 'ok', threads: [THREAD], etag: '"abc"' });
  });

  it('listThreads maps 304 to not-modified', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 304, headers: { ETag: '"abc"' } }));
    expect(await apiWith(fetchImpl).listThreads(TOKEN, '"abc"')).toEqual({ kind: 'not-modified' });
  });

  it('tolerates additive server fields on a thread row', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ threads: [{ ...THREAD, futureField: 1 }] }), { status: 200 }));
    const res = await apiWith(fetchImpl).listThreads(TOKEN, null);
    expect(res.kind).toBe('ok');
  });

  it('maps the error catalogue to typed codes', async () => {
    const cases: Array<[number, string, string]> = [
      [401, 'invalid_device_token', 'invalid_device_token'],
      [401, 'replies_disabled', 'replies_disabled'],
      [404, 'thread_not_found', 'thread_not_found'],
      [409, 'thread_closed', 'thread_closed'],
      [400, 'invalid_input', 'invalid_input'],
    ];
    for (const [status, wire, code] of cases) {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: wire }), { status }));
      await expect(apiWith(fetchImpl).postMessage(TOKEN, THREAD.id, 'hi'))
        .rejects.toMatchObject({ code, status });
    }
  });

  it('carries retryAfter on 429', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: 'rate_limit_exceeded', retryAfter: 42 }),
      { status: 429, headers: { 'Retry-After': '42' } },
    ));
    await expect(apiWith(fetchImpl).listThreads(TOKEN, null))
      .rejects.toMatchObject({ code: 'rate_limit_exceeded', retryAfter: 42 });
  });

  it('wraps a thrown fetch as network_error', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('offline'); });
    await expect(apiWith(fetchImpl).listThreads(TOKEN, null))
      .rejects.toMatchObject({ code: 'network_error', status: null });
  });

  it('postMessage 201 returns the id; markRead and deleteThread resolve on 204', async () => {
    const post = vi.fn(async () => new Response(JSON.stringify({ id: 'm1' }), { status: 201 }));
    expect(await apiWith(post).postMessage(TOKEN, THREAD.id, 'hello')).toEqual({ id: 'm1' });
    const [, postInit] = post.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(postInit.body as string);
    expect(body).toEqual({ body: 'hello' });

    const noContent = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(apiWith(noContent).markRead(TOKEN, THREAD.id)).resolves.toBeUndefined();
    await expect(apiWith(noContent).deleteThread(TOKEN, THREAD.id)).resolves.toBeUndefined();
    const [, deleteInit] = noContent.mock.calls[1] as unknown as [string, RequestInit];
    expect(deleteInit.method).toBe('DELETE');
  });

  it('listMessages passes the cursor through opaquely', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      status: 'open', messages: [], nextCursor: null, hasMore: false,
    }), { status: 200 }));
    await apiWith(fetchImpl).listMessages(TOKEN, THREAD.id, 'Y3Vyc29y');
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      `https://x.test/api/reporter/threads/${THREAD.id}/messages?cursor=Y3Vyc29y`,
    );
  });
});
