// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect, vi } from 'vitest';
import { submitReport } from '../src/transport/http.js';

describe('submitReport device token', () => {
  it('sends X-TX-Device-Token when provided and parses thread/device from the response', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      status: 'received', eventId: 'e1', deliveryCount: 0, idempotent: false,
      thread: { id: 't1' }, device: { token: 'txr_' + 'a'.repeat(43) },
    }), { status: 200 }));
    const res = await submitReport('https://x.test/api/ingest', 'txx_live_k', new FormData(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryScheduleMs: [],
      deviceToken: 'txr_' + 'b'.repeat(43),
    });
    const headers = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]!.headers as Record<string, string>;
    expect(headers['X-TX-Device-Token']).toBe('txr_' + 'b'.repeat(43));
    expect(res.ok).toBe(true);
    expect(res.thread).toEqual({ id: 't1' });
    expect(res.device).toEqual({ token: 'txr_' + 'a'.repeat(43) });
  });

  it('omits the header without a token and tolerates a body with no thread block', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      status: 'received', eventId: 'e1', deliveryCount: 0, idempotent: false,
    }), { status: 200 }));
    const res = await submitReport('https://x.test/api/ingest', 'txx_live_k', new FormData(), {
      fetchImpl: fetchImpl as unknown as typeof fetch, retryScheduleMs: [],
    });
    expect('X-TX-Device-Token' in ((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]!.headers as Record<string, string>)).toBe(false);
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
  it('sends X-TX-Replies-Opt-Out: 1 when repliesOptOut is true', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      status: 'received', eventId: 'e1', deliveryCount: 0, idempotent: false,
    }), { status: 200 }));
    await submitReport('https://x.test/api/ingest', 'txx_live_k', new FormData(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryScheduleMs: [],
      repliesOptOut: true,
    });
    const headers = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]!.headers as Record<string, string>;
    expect(headers['X-TX-Replies-Opt-Out']).toBe('1');
  });

  it('omits X-TX-Replies-Opt-Out when repliesOptOut is false or absent', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      status: 'received', eventId: 'e1', deliveryCount: 0, idempotent: false,
    }), { status: 200 }));
    await submitReport('https://x.test/api/ingest', 'txx_live_k', new FormData(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryScheduleMs: [],
    });
    const headers = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]!.headers as Record<string, string>;
    expect('X-TX-Replies-Opt-Out' in headers).toBe(false);
  });
});
