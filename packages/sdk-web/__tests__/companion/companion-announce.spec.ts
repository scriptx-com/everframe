// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it, vi } from 'vitest';
import { announce } from '../../src/companion/announce.js';

describe('announce', () => {
  it('returns the ticket and code on success', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
      JSON.stringify({ ticket: 'tkt', code: '7K2Q', expiresInMs: 60_000 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const res = await announce({
      endpoint: 'https://api.example.com', sdkKey: 'txx_live_x',
      label: 'Lab TV', fetchImpl: fetchMock as never,
    });
    expect(res).toEqual({ ticket: 'tkt', code: '7K2Q', resolvedName: null });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/api/companion/announce');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer txx_live_x',
    });
    expect(JSON.parse(init!.body as string)).toEqual({ label: 'Lab TV' });
  });

  it('puts supportsAttachPin: true in the body when requested', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
      JSON.stringify({ ticket: 'tkt', code: '7K2Q' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    await announce({
      endpoint: 'https://api.example.com', sdkKey: 'txx_live_x',
      label: 'Lab TV', supportsAttachPin: true, fetchImpl: fetchMock as never,
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init!.body as string)).toEqual({
      label: 'Lab TV',
      supportsAttachPin: true,
    });
  });

  it('omits supportsAttachPin from the body when false or unset', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
      JSON.stringify({ ticket: 'tkt', code: '7K2Q' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    await announce({
      endpoint: 'https://api.example.com', sdkKey: 'txx_live_x',
      supportsAttachPin: false, fetchImpl: fetchMock as never,
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init!.body as string)).toEqual({});
  });

  it('returns null on 401 rather than throwing', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 401 }));
    expect(await announce({
      endpoint: 'https://api.example.com', sdkKey: 'bad', fetchImpl: fetchMock as never,
    })).toBeNull();
  });

  it('returns null when the endpoint does not exist (older server)', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 404 }));
    expect(await announce({
      endpoint: 'https://api.example.com', sdkKey: 'k', fetchImpl: fetchMock as never,
    })).toBeNull();
  });

  it('returns null when the network is down', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('offline'); });
    expect(await announce({
      endpoint: 'https://api.example.com', sdkKey: 'k', fetchImpl: fetchMock as never,
    })).toBeNull();
  });

  it('returns null when the 2xx body is not valid JSON', async () => {
    const fetchMock = vi.fn(async () => new Response('not-json{', { status: 200 }));
    expect(await announce({
      endpoint: 'https://api.example.com', sdkKey: 'k', fetchImpl: fetchMock as never,
    })).toBeNull();
  });

  it('returns null when the 2xx body is missing ticket/code', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ expiresInMs: 60_000 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    expect(await announce({
      endpoint: 'https://api.example.com', sdkKey: 'k', fetchImpl: fetchMock as never,
    })).toBeNull();
  });

  // A present-but-blank ticket is the dangerous case: it passes the `typeof`
  // checks, so without an explicit guard the caller composes `/relay/tv/` — a
  // path the relay answers with a 4004 TERMINAL close, which costs the device
  // its reporting outright rather than falling through to the ticketless
  // socket every other failure above takes. Ported from the Android guard in
  // `packages/sdk-android/.../companion/CompanionAnnounce.kt`; iOS's
  // `CompanionAnnounce.swift` carries the same guard.
  it.each([
    ['a blank ticket', { ticket: '', code: '7K2Q' }],
    ['a blank code', { ticket: 'tkt', code: '' }],
    ['a whitespace-only ticket', { ticket: '   ', code: '7K2Q' }],
  ])('returns null on %s', async (_label, body) => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify(body),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    expect(await announce({
      endpoint: 'https://api.example.com', sdkKey: 'k', fetchImpl: fetchMock as never,
    })).toBeNull();
  });

  it('sends the device block when provided and surfaces resolvedName', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
      JSON.stringify({ ticket: 't1', code: 'AAAA', resolvedName: 'Samsung TV · Tizen 7.0' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const res = await announce({
      endpoint: 'https://api.example.com', sdkKey: 'k',
      device: {
        id: '11111111-2222-4333-8444-555555555555', platform: 'web',
        model: 'Samsung TV', osName: 'Tizen', osVersion: '7.0',
      },
      fetchImpl: fetchMock as never,
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init!.body as string).device).toEqual({
      id: '11111111-2222-4333-8444-555555555555', platform: 'web',
      model: 'Samsung TV', osName: 'Tizen', osVersion: '7.0',
    });
    expect(res?.resolvedName).toBe('Samsung TV · Tizen 7.0');
  });

  it('omits the device key entirely when not provided; old servers (no resolvedName) yield null', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
      JSON.stringify({ ticket: 't1', code: 'AAAA' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const res = await announce({
      endpoint: 'https://api.example.com', sdkKey: 'k', fetchImpl: fetchMock as never,
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect('device' in JSON.parse(init!.body as string)).toBe(false);
    expect(res?.resolvedName).toBeNull();
  });

  it('drops null device fact fields on the wire (server schema wants absent, not null)', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
      JSON.stringify({ ticket: 't1', code: 'AAAA' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    await announce({
      endpoint: 'https://api.example.com', sdkKey: 'k',
      device: { id: 'dev-1', platform: 'web', model: null, osName: null, osVersion: null },
      fetchImpl: fetchMock as never,
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init!.body as string).device).toEqual({ id: 'dev-1', platform: 'web' });
  });

  it('returns null rather than hanging forever', async () => {
    const fetchMock = vi.fn((_u: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }));
    vi.useFakeTimers();
    const promise = announce({
      endpoint: 'https://api.example.com', sdkKey: 'k',
      fetchImpl: fetchMock as never, timeoutMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await promise).toBeNull();
    vi.useRealTimers();
  });
});
