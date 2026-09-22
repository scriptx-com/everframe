// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect, vi } from 'vitest';
import { submitReport } from '../src/transport/http.js';

describe('AUTH-01: SDK-key authentication', () => {
  it('sets Authorization: Bearer <sdkKey> header', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const fd = new FormData();
    await submitReport('https://x.example/ingest', 'sdk_test_key_123', fd, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryScheduleMs: [],
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const callArgs = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit]);
    const init = callArgs[1];
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer sdk_test_key_123'
    );
  });
});

describe('HTTP retry decision matrix', () => {
  it('does NOT retry on 401 (auth failure surfaced once)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 401 }));
    const result = await submitReport('https://x.example/ingest', 'k', new FormData(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryScheduleMs: [10, 10],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('auth');
    expect(result.attempts).toBe(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('does NOT retry on 403 (auth failure)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 403 }));
    const result = await submitReport('https://x.example/ingest', 'k', new FormData(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryScheduleMs: [10, 10],
    });
    expect(result.reason).toBe('auth');
    expect(result.attempts).toBe(1);
  });

  it('does NOT retry on 426 (protocol mismatch)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 426 }));
    const result = await submitReport('https://x.example/ingest', 'k', new FormData(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryScheduleMs: [10, 10],
    });
    expect(result.reason).toBe('protocol-mismatch');
    expect(result.attempts).toBe(1);
  });

  it('retries up to 5 times on 5xx, then exhausts', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 503 }));
    const result = await submitReport('https://x.example/ingest', 'k', new FormData(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryScheduleMs: [1, 1, 1, 1, 1],
      jitter: false,
    });
    expect(result.reason).toBe('transient-exhausted');
    expect(result.attempts).toBe(6); // first call + 5 retries
    expect(result.retried).toBe(true);
  });

  it('retries on 408 + 429 then succeeds on 200', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response('', { status: 408 });
      if (calls === 2) return new Response('', { status: 429 });
      return new Response('', { status: 200 });
    });
    const result = await submitReport('https://x.example/ingest', 'k', new FormData(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryScheduleMs: [1, 1, 1, 1, 1],
      jitter: false,
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(3);
  });

  it('does NOT retry on 4xx other than 408/429 (e.g. 400)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 400 }));
    const result = await submitReport('https://x.example/ingest', 'k', new FormData(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryScheduleMs: [1, 1],
      jitter: false,
    });
    expect(result.reason).toBe('payload');
    expect(result.attempts).toBe(1);
  });
});
