// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Reporter identity recognition (spec 2026-08-06) — the two transport
// surfaces (ingest submit + /api/reporter/*) attach `X-Everframe-Identity-Token`
// when an `IdentityTokenHolder` is supplied and resolves a token. Both
// surfaces `await holder.get(Date.now())` internally and never fail the
// underlying call over identity work.
import { describe, it, expect, vi } from 'vitest';
import { submitReport } from '../../src/transport/http.js';
import { createReporterApi } from '../../src/reporter/api.js';
import { IdentityTokenHolder, IDENTITY_TOKEN_HEADER } from '../../src/reporter/identity-token.js';

const mkJwt = (expSec: number): string => {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', exp: expSec })}.sig`;
};

const TOKEN = 'evr_' + 'a'.repeat(43);

describe('submitReport identity token', () => {
  it('uses the Everframe identity header name', () => {
    expect(IDENTITY_TOKEN_HEADER).toBe('X-Everframe-Identity-Token');
  });

  it('sends X-Everframe-Identity-Token when the holder resolves a token', async () => {
    const jwt = mkJwt(Date.now() / 1000 + 300);
    const holder = new IdentityTokenHolder();
    holder.set(jwt);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      status: 'received', eventId: 'e1', deliveryCount: 0, idempotent: false,
    }), { status: 200 }));
    await submitReport('https://x.test/api/ingest', 'txx_live_k', new FormData(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryScheduleMs: [],
      identityToken: holder,
    });
    const headers = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]!.headers as Record<string, string>;
    expect(headers[IDENTITY_TOKEN_HEADER]).toBe(jwt);
  });

  it('omits the header when no holder is supplied', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      status: 'received', eventId: 'e1', deliveryCount: 0, idempotent: false,
    }), { status: 200 }));
    await submitReport('https://x.test/api/ingest', 'txx_live_k', new FormData(), {
      fetchImpl: fetchImpl as unknown as typeof fetch, retryScheduleMs: [],
    });
    const headers = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]!.headers as Record<string, string>;
    expect(IDENTITY_TOKEN_HEADER in headers).toBe(false);
  });

  it('omits the header when the holder resolves null, and the submit still succeeds', async () => {
    const holder = new IdentityTokenHolder(); // never set() — no source
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      status: 'received', eventId: 'e1', deliveryCount: 0, idempotent: false,
    }), { status: 200 }));
    const res = await submitReport('https://x.test/api/ingest', 'txx_live_k', new FormData(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryScheduleMs: [],
      identityToken: holder,
    });
    const headers = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]!.headers as Record<string, string>;
    expect(IDENTITY_TOKEN_HEADER in headers).toBe(false);
    expect(res.ok).toBe(true);
  });

  it('never fails the submit when the provider throws', async () => {
    const holder = new IdentityTokenHolder();
    holder.set(() => {
      throw new Error('no session');
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      status: 'received', eventId: 'e1', deliveryCount: 0, idempotent: false,
    }), { status: 200 }));
    const res = await submitReport('https://x.test/api/ingest', 'txx_live_k', new FormData(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryScheduleMs: [],
      identityToken: holder,
    });
    expect(res.ok).toBe(true);
    const headers = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]!.headers as Record<string, string>;
    expect(IDENTITY_TOKEN_HEADER in headers).toBe(false);
  });
});

describe('createReporterApi identity token', () => {
  function apiWith(fetchImpl: ReturnType<typeof vi.fn>, holder?: IdentityTokenHolder) {
    return createReporterApi({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseUrl: 'https://x.test',
      apiKey: 'txx_live_k',
      ...(holder ? { identityToken: holder } : {}),
    });
  }

  it('sends X-Everframe-Identity-Token alongside the device token when the holder resolves', async () => {
    const jwt = mkJwt(Date.now() / 1000 + 300);
    const holder = new IdentityTokenHolder();
    holder.set(jwt);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ threads: [] }), { status: 200 }));
    await apiWith(fetchImpl, holder).listThreads(TOKEN, null);
    const headers = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]!.headers as Record<string, string>;
    expect(headers['X-Everframe-Device-Token']).toBe(TOKEN);
    expect(headers[IDENTITY_TOKEN_HEADER]).toBe(jwt);
  });

  it('omits the header when no holder is supplied', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ threads: [] }), { status: 200 }));
    await apiWith(fetchImpl).listThreads(TOKEN, null);
    const headers = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]!.headers as Record<string, string>;
    expect(IDENTITY_TOKEN_HEADER in headers).toBe(false);
  });

  it('never fails the call when the provider hangs past the timeout', async () => {
    vi.useFakeTimers();
    const holder = new IdentityTokenHolder();
    holder.set(() => new Promise<string>(() => {}));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ threads: [] }), { status: 200 }));
    const resultPromise = apiWith(fetchImpl, holder).listThreads(TOKEN, null);
    await vi.advanceTimersByTimeAsync(3_000);
    const res = await resultPromise;
    expect(res.kind).toBe('ok');
    const headers = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]!.headers as Record<string, string>;
    expect(IDENTITY_TOKEN_HEADER in headers).toBe(false);
    vi.useRealTimers();
  });
});
