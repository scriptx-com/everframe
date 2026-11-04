// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTicketClient, TicketApiError } from '../src/tickets/client.js';

const TOKEN = 'efk_secret_token_value';
const ticket = {
  id: '12',
  title: 'T',
  projectId: 'p',
  boardId: 'b',
  columnId: 'c',
  createdAt: '2026-11-03T00:00:00.000Z',
  url: 'https://everframe.dev/t/12',
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

type Call = { url: string; init: RequestInit };
function harness(responses: Array<Response | Error>, now?: () => number) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const queue = [...responses];
  const fetchFn = (async (url: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = queue.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  const client = createTicketClient({
    apiUrl: 'https://api.test/api/v1',
    token: TOKEN,
    fetch: fetchFn,
    ...(now ? { now } : {}),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { client, calls, sleeps };
}
const header = (c: Call, name: string) => new Headers(c.init.headers).get(name);

describe('ticket client', () => {
  afterEach(() => vi.restoreAllMocks());

  it('retries a 503 and a network error, then succeeds', async () => {
    // Jitter is Math.floor(random * 251): 0 at random=0, 250 at random just under 1.
    const random = vi.spyOn(Math, 'random');
    random.mockReturnValueOnce(0).mockReturnValueOnce(0.999999);
    const h = harness([
      json(503, { error: 'unavailable' }),
      new TypeError('fetch failed'),
      json(201, ticket),
    ]);
    const result = await h.client.createTicket({ title: 'T' }, 'key-1');
    expect(result.id).toBe('12');
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps).toHaveLength(2);
    expect(h.sleeps).toEqual([1000, 2250]);
  });

  it('reuses the same Idempotency-Key on every attempt of createTicket', async () => {
    const h = harness([json(500, { error: 'x' }), json(502, { error: 'x' }), json(201, ticket)]);
    await h.client.createTicket({ title: 'T' }, 'key-abc');
    expect(h.calls.map((c) => header(c, 'idempotency-key'))).toEqual([
      'key-abc',
      'key-abc',
      'key-abc',
    ]);
    expect(header(h.calls[0]!, 'authorization')).toBe(`Bearer ${TOKEN}`);
    expect(h.calls[0]!.url).toBe('https://api.test/api/v1/tickets');
    expect(JSON.parse(String(h.calls[0]!.init.body))).toEqual({ title: 'T' });
  });

  it('waits Retry-After seconds on 429', async () => {
    const h = harness([
      json(429, { error: 'rate_limit_exceeded' }, { 'Retry-After': '7' }),
      json(201, ticket),
    ]);
    await h.client.createTicket({ title: 'T' }, 'k');
    expect(h.sleeps).toEqual([7000]);
  });

  it('caps Retry-After at 60 seconds', async () => {
    const h = harness([
      json(429, { error: 'rate_limit_exceeded' }, { 'Retry-After': '3600' }),
      json(201, ticket),
    ]);
    await h.client.createTicket({ title: 'T' }, 'k');
    expect(h.sleeps).toEqual([60000]);
  });

  it('waits until an HTTP-date Retry-After', async () => {
    const now = Date.parse('2026-11-04T12:00:00Z');
    const h = harness(
      [
        json(429, {}, { 'Retry-After': 'Wed, 04 Nov 2026 12:00:09 GMT' }),
        json(429, {}, { 'Retry-After': 'Wed, 04 Nov 2026 11:00:00 GMT' }),
        json(429, {}, { 'Retry-After': 'Wed, 04 Nov 2026 14:00:00 GMT' }),
        json(201, ticket),
      ],
      () => now,
    );
    await h.client.createTicket({ title: 'T' }, 'k');
    expect(h.sleeps).toEqual([9000, 0, 60000]);
  });

  it.each([
    ['empty object', {}],
    ['error body', { error: 'x' }],
  ])('treats a 2xx %s on create as invalid_server_response and retries', async (_n, body) => {
    const h = harness([json(201, body), json(201, ticket)]);
    await expect(h.client.createTicket({ title: 'T' }, 'k')).resolves.toMatchObject({ id: '12' });
    expect(h.calls).toHaveLength(2);
    const bad = harness(Array.from({ length: 4 }, () => json(201, body)));
    await expect(bad.client.createTicket({ title: 'T' }, 'k')).rejects.toMatchObject({
      step: 'create',
      code: 'invalid_server_response',
    });
  });

  it.each([
    ['empty object', {}],
    ['error body', { error: 'x' }],
  ])('fails fast on a 2xx %s upload', async (_n, body) => {
    const h = harness([json(201, body), json(201, { id: 'a' })]);
    const err = await h.client
      .upload({ path: 'x', name: 'x.png', bytes: Buffer.from([1]) })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ step: 'upload', code: 'invalid_server_response' });
    expect(h.calls).toHaveLength(1);
  });

  it('retries an unparseable 2xx on a keyed write with the same key', async () => {
    const h = harness([new Response('<html>proxy</html>', { status: 200 }), json(201, ticket)]);
    await expect(h.client.createTicket({ title: 'T' }, 'same')).resolves.toMatchObject({
      id: '12',
    });
    expect(h.calls).toHaveLength(2);
    expect(header(h.calls[0]!, 'idempotency-key')).toBe('same');
    expect(header(h.calls[1]!, 'idempotency-key')).toBe('same');
  });

  it('fails fast on an unparseable 2xx upload', async () => {
    const h = harness([new Response('nope', { status: 201 }), json(201, { id: 'a' })]);
    const err = await h.client
      .upload({ path: 'x', name: 'x.png', bytes: Buffer.from([1]) })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ step: 'upload', code: 'invalid_server_response' });
    expect(h.calls).toHaveLength(1);
  });

  it('treats a general-limiter 429 body as retryable with rate_limit_exceeded', async () => {
    const body = { statusCode: 429, error: 'Too Many Requests', message: 'slow down' };
    const h = harness(Array.from({ length: 4 }, () => json(429, body)));
    const err = await h.client.createTicket({ title: 'T' }, 'k').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TicketApiError);
    expect((err as TicketApiError).code).toBe('rate_limit_exceeded');
    expect((err as TicketApiError).status).toBe(429);
    expect(h.calls).toHaveLength(4);
  });

  it('does not retry a 400 and throws TicketApiError with the API code and step', async () => {
    const h = harness([json(400, { error: 'project_required' })]);
    const err = await h.client.createTicket({ title: 'T' }, 'k').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TicketApiError);
    expect(err).toMatchObject({ step: 'create', status: 400, code: 'project_required' });
    expect(h.calls).toHaveLength(1);
    const up = harness([json(413, { error: 'file_too_large' })]);
    await expect(
      up.client.upload({ path: '/x', name: 'a.png', bytes: Buffer.from('a') }),
    ).rejects.toMatchObject({ step: 'upload', status: 413, code: 'file_too_large' });
  });

  it('gives up after maxAttempts with the last status', async () => {
    const h = harness([json(503, { error: 'a' }), json(500, { error: 'b' }), json(502, {})]);
    const client = createTicketClient({
      apiUrl: 'https://api.test/api/v1',
      token: TOKEN,
      maxAttempts: 3,
      sleep: async () => {},
      fetch: (async (u: unknown, i: RequestInit) => {
        h.calls.push({ url: String(u), init: i });
        return [json(503, { error: 'a' }), json(500, { error: 'b' }), json(502, {})][
          h.calls.length - 1
        ]!;
      }) as unknown as typeof fetch,
    });
    const err = await client.attach('12', ['a'], undefined, 'k').catch((e: unknown) => e);
    expect(err).toMatchObject({ step: 'attach', status: 502 });
    expect(h.calls).toHaveLength(3);
  });

  it('reports a persistent network failure with status null', async () => {
    const h = harness([new Error('x'), new Error('x'), new Error('x'), new Error('x')]);
    const err = await h.client
      .comment('12', { body: 'hi' }, undefined, 'k')
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ step: 'comment', status: null, code: 'network_error' });
  });

  it('retries an upload only when the connection was never made', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    });
    const ok = { id: 'a1', filename: 'a.png', contentType: 'image/png', sizeBytes: 3 };
    const file = { path: 'a.png', name: 'a.png', bytes: Buffer.from([1]) };
    const h = harness([refused, json(201, ok)]);
    expect((await h.client.upload(file)).id).toBe('a1');
    expect(h.calls).toHaveLength(2);
    const reset = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    const h2 = harness([reset, json(201, ok)]);
    await expect(h2.client.upload(file)).rejects.toMatchObject({ code: 'network_error' });
    expect(h2.calls).toHaveLength(1);
    const h3 = harness([new Error('socket hang up'), json(201, ok)]);
    await expect(h3.client.upload(file)).rejects.toMatchObject({ code: 'network_error' });
    expect(h3.calls).toHaveLength(1);
  });

  it('retries a keyed write after a generic socket error', async () => {
    const h = harness([new Error('socket hang up'), json(201, ticket)]);
    await h.client.createTicket({ title: 'T' }, 'k');
    expect(h.calls).toHaveLength(2);
  });

  it('sends the upload as multipart with the original filename', async () => {
    const name = 'Screenshot 2026-11-03 at 10.15.42 ą.png';
    const h = harness([
      json(201, { id: 'a1', filename: name, contentType: 'image/png', sizeBytes: 3 }),
    ]);
    const res = await h.client.upload({ path: '/tmp/x.png', name, bytes: Buffer.from([1, 2, 3]) });
    expect(res.id).toBe('a1');
    const body = h.calls[0]!.init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    const file = body.get('file') as File;
    expect(file.name).toBe(name);
    expect(file.size).toBe(3);
    expect(header(h.calls[0]!, 'content-type')).toBeNull();
    expect(h.calls[0]!.url).toBe('https://api.test/api/v1/attachments');
  });

  it('puts projectId in the query when given', async () => {
    const h = harness([
      json(201, { id: 'a', filename: 'a', contentType: 'image/png', sizeBytes: 1 }),
      json(200, { ...ticket, attachmentCount: 1 }),
      json(201, { id: 'c', ticketId: '12', createdAt: 'x', url: 'u' }),
    ]);
    await h.client.upload({ path: '/x', name: 'a.png', bytes: Buffer.from('a') }, 'proj-1');
    await h.client.attach('a/b 1', ['a'], 'proj-1', 'k');
    await h.client.comment('12', { body: 'x' }, 'proj-1', 'k2');
    expect(h.calls[0]!.url).toBe('https://api.test/api/v1/attachments?projectId=proj-1');
    expect(h.calls[1]!.url).toBe(
      'https://api.test/api/v1/tickets/a%2Fb%201/attachments?projectId=proj-1',
    );
    expect(h.calls[2]!.url).toBe('https://api.test/api/v1/tickets/12/comments?projectId=proj-1');
  });

  it('never includes the token in an error message', async () => {
    const h = harness([json(400, { error: `bad ${TOKEN}` })]);
    const err = (await h.client
      .createTicket({ title: 'T' }, 'k')
      .catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(TOKEN);
    expect(String((err as TicketApiError).code)).not.toContain(TOKEN);
    const n = harness([
      new Error(`connect failed with ${TOKEN}`),
      new Error(TOKEN),
      new Error(TOKEN),
      new Error(TOKEN),
    ]);
    const e2 = (await n.client.createTicket({ title: 'T' }, 'k').catch((e: unknown) => e)) as Error;
    expect(e2.message).not.toContain(TOKEN);
  });

  it('does not follow a redirect: a 307 fails with no second request', async () => {
    const h = harness([
      new Response(null, { status: 307, headers: { location: 'https://evil.test/x' } }),
      json(201, ticket),
    ]);
    const err = await h.client.createTicket({ title: 'T' }, 'k').catch((e: unknown) => e);
    expect(err).toMatchObject({ step: 'create', status: 307, code: 'unexpected_redirect' });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.init.redirect).toBe('manual');
  });

  it('rejects a non-loopback http API URL before any request', () => {
    const fetchFn = vi.fn();
    for (const apiUrl of ['http://example.com/api/v1', 'ftp://x/api/v1', 'not a url']) {
      expect(() =>
        createTicketClient({ apiUrl, token: TOKEN, fetch: fetchFn as unknown as typeof fetch }),
      ).toThrow('invalid_api_url');
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('allows http on loopback hosts', () => {
    for (const apiUrl of [
      'http://127.0.0.1:4000/api/v1',
      'http://localhost:4000/api/v1',
      'http://[::1]:4000/api/v1',
    ])
      expect(() => createTicketClient({ apiUrl, token: TOKEN })).not.toThrow();
  });
});
