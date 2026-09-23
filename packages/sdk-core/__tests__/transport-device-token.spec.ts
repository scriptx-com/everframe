// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect, vi } from 'vitest';
import {
  DEVICE_TOKEN_HEADER,
  REPLIES_OPT_OUT_HEADER,
  submitReport,
} from '../src/transport/http.js';

describe('submitReport device token', () => {
  it('uses Everframe header names', () => {
    expect(DEVICE_TOKEN_HEADER).toBe('X-Everframe-Device-Token');
    expect(REPLIES_OPT_OUT_HEADER).toBe('X-Everframe-Replies-Opt-Out');
  });

  it('sends X-Everframe-Device-Token when provided and parses thread/device from the response', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      status: 'received', eventId: 'e1', deliveryCount: 0, idempotent: false,
      thread: { id: 't1' }, device: { token: 'evr_' + 'a'.repeat(43) },
    }), { status: 200 }));
    const res = await submitReport('https://x.test/api/ingest', 'txx_live_k', new FormData(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryScheduleMs: [],
      deviceToken: 'evr_' + 'b'.repeat(43),
    });
    const headers = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]!.headers as Record<string, string>;
    expect(headers[DEVICE_TOKEN_HEADER]).toBe('evr_' + 'b'.repeat(43));
    expect(res.ok).toBe(true);
    expect(res.thread).toEqual({ id: 't1' });
    expect(res.device).toEqual({ token: 'evr_' + 'a'.repeat(43) });
  });

  it('omits the header without a token and tolerates a body with no thread block', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      status: 'received', eventId: 'e1', deliveryCount: 0, idempotent: false,
    }), { status: 200 }));
    const res = await submitReport('https://x.test/api/ingest', 'txx_live_k', new FormData(), {
      fetchImpl: fetchImpl as unknown as typeof fetch, retryScheduleMs: [],
    });
    expect(DEVICE_TOKEN_HEADER in ((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]!.headers as Record<string, string>)).toBe(false);
    expect(res.thread).toBeUndefined();
    expect(res.device).toBeUndefined();
  });

  it('never fails a submit over an unparseable response body', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json', { status: 200 }));
    const res = await submitReport('https://x.test/api/ingest', 'txx_live_k', new FormData(), {
      fetchImpl: fetchImpl as unknown as typeof fetch, retryScheduleMs: [],
    });
    expect(res.ok).toBe(true);
    expect(res.thread).toBeUndefined();
  });

  // Round-5 PR-review item 6 — a client with the local replies veto active
  // must tell the server not to provision a thread/device it would never be
  // able to present again (no token is being sent). See route.ts's
  // REPLIES_OPT_OUT_HEADER doc-comment for the server side of this contract.
  it('sends X-Everframe-Replies-Opt-Out: 1 when repliesOptOut is true', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      status: 'received', eventId: 'e1', deliveryCount: 0, idempotent: false,
    }), { status: 200 }));
    await submitReport('https://x.test/api/ingest', 'txx_live_k', new FormData(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryScheduleMs: [],
      repliesOptOut: true,
    });
    const headers = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]!.headers as Record<string, string>;
    expect(headers[REPLIES_OPT_OUT_HEADER]).toBe('1');
  });

  it('omits X-Everframe-Replies-Opt-Out when repliesOptOut is false or absent', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      status: 'received', eventId: 'e1', deliveryCount: 0, idempotent: false,
    }), { status: 200 }));
    await submitReport('https://x.test/api/ingest', 'txx_live_k', new FormData(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryScheduleMs: [],
    });
    const headers = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]!.headers as Record<string, string>;
    expect(REPLIES_OPT_OUT_HEADER in headers).toBe(false);
  });
});
