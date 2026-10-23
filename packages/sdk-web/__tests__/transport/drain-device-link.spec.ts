// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OutboxAdapter, OutboxItem } from '@everframe/sdk-core';
import { drainOutbox, drainOutboxWhileOwned } from '../../src/transport/submit.js';
import type { DrainDeviceLinks } from '../../src/transport/device-link-upload.js';

const TOKEN = 'evf_dev_' + 'K'.repeat(32);
const FP = '0123456789abcdef';
const OTHER_FP = 'fedcba9876543210';
const URL_ = 'https://ingest.example/api/ingest';

function fakeOutbox(items: OutboxItem[]): OutboxAdapter & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    async enqueue() {},
    async list() {
      return items;
    },
    async delete(reportId: string) {
      deleted.push(reportId);
    },
  };
}

function item(reportId: string, metadata: Record<string, string>): OutboxItem {
  return {
    reportId,
    enqueuedAt: 1,
    attempts: 0,
    payload: new TextEncoder().encode(JSON.stringify({ reportId, quickCapture: true })),
    metadata,
  };
}

type FetchSpy = ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>;
function fetchReturning(status: number, body: unknown = {}): FetchSpy {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

function links(current: { token: string; fingerprint: string } | null): DrainDeviceLinks & {
  forget: ReturnType<typeof vi.fn<(t: string) => void>>;
} {
  return { current: () => current, forget: vi.fn<(t: string) => void>() };
}

const config = { sdkKey: 'key-1' } as never;

afterEach(() => vi.restoreAllMocks());

describe('draining fingerprinted quick captures', () => {
  it('a fingerprinted entry is sent with the stored token when the fingerprint matches', async () => {
    const fetchSpy = fetchReturning(200);
    const outbox = fakeOutbox([
      item('r1', { url: URL_, sdkKey: 'key-1', deviceLinkFingerprint: FP }),
    ]);
    const result = await drainOutbox({
      outbox,
      config,
      sdkVersion: 't',
      fetch: fetchSpy as unknown as typeof fetch,
      deviceLinks: links({ token: TOKEN, fingerprint: FP }),
    });
    expect(result.submitted).toBe(1);
    expect(outbox.deleted).toEqual(['r1']);
    const init = fetchSpy.mock.calls[0]![1];
    const h = new Headers(init.headers);
    expect(h.get('X-Everframe-Capture-Token')).toBe(TOKEN);
    expect(h.has('X-Everframe-Link-Nonce')).toBe(false);
    expect(init.redirect).toBe('error');
    expect(init.credentials).toBe('omit');
  });

  it('a fingerprinted entry is deleted unsent when the token changed or is gone', async () => {
    for (const current of [null, { token: TOKEN, fingerprint: OTHER_FP }]) {
      const fetchSpy = fetchReturning(200);
      const outbox = fakeOutbox([
        item('r1', { url: URL_, sdkKey: 'key-1', deviceLinkFingerprint: FP }),
      ]);
      await drainOutbox({
        outbox,
        config,
        sdkVersion: 't',
        fetch: fetchSpy as unknown as typeof fetch,
        deviceLinks: links(current),
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(outbox.deleted).toEqual(['r1']);
    }
  });

  it('a drain without deviceLinks leaves fingerprinted entries queued', async () => {
    const fetchSpy = fetchReturning(200);
    const outbox = fakeOutbox([
      item('r1', { url: URL_, sdkKey: 'key-1', deviceLinkFingerprint: FP }),
      item('r2', { url: URL_, sdkKey: 'key-1' }),
    ]);
    const result = await drainOutbox({
      outbox,
      config,
      sdkVersion: 't',
      fetch: fetchSpy as unknown as typeof fetch,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(outbox.deleted).toEqual(['r2']);
    expect(result).toMatchObject({ submitted: 1, failed: 0 });
  });

  it('403 device_unlinked on drain deletes the entry and forgets that token', async () => {
    const fetchSpy = fetchReturning(403, { error: 'device_unlinked' });
    const outbox = fakeOutbox([
      item('r1', { url: URL_, sdkKey: 'key-1', deviceLinkFingerprint: FP }),
    ]);
    const dl = links({ token: TOKEN, fingerprint: FP });
    await drainOutbox({
      outbox,
      config,
      sdkVersion: 't',
      fetch: fetchSpy as unknown as typeof fetch,
      deviceLinks: dl,
    });
    expect(outbox.deleted).toEqual(['r1']);
    expect(dl.forget).toHaveBeenCalledWith(TOKEN);
  });

  it('a transient failure keeps the fingerprinted entry for the next drain', async () => {
    const fetchSpy = fetchReturning(503);
    const outbox = fakeOutbox([
      item('r1', { url: URL_, sdkKey: 'key-1', deviceLinkFingerprint: FP }),
    ]);
    const dl = links({ token: TOKEN, fingerprint: FP });
    await drainOutbox({
      outbox,
      config,
      sdkVersion: 't',
      retryScheduleMs: [],
      fetch: fetchSpy as unknown as typeof fetch,
      deviceLinks: dl,
    });
    expect(outbox.deleted).toEqual([]);
    expect(dl.forget).not.toHaveBeenCalled();
  });

  it('entries without a fingerprint never carry a token', async () => {
    const fetchSpy = fetchReturning(200);
    const outbox = fakeOutbox([item('r2', { url: URL_, sdkKey: 'key-1' })]);
    await drainOutbox({
      outbox,
      config,
      sdkVersion: 't',
      fetch: fetchSpy as unknown as typeof fetch,
      deviceLinks: links({ token: TOKEN, fingerprint: FP }),
    });
    const h = new Headers(fetchSpy.mock.calls[0]![1].headers);
    expect(h.has('X-Everframe-Capture-Token')).toBe(false);
  });

  it('an owned drain stops before sending once ownership is lost', async () => {
    const fetchSpy = fetchReturning(200);
    let owned = true;
    const outbox = fakeOutbox([
      item('r1', { url: URL_, sdkKey: 'key-1', deviceLinkFingerprint: FP }),
    ]);
    const dl: DrainDeviceLinks = {
      current: () => {
        owned = false; // lost between the fingerprint check and the send
        return { token: TOKEN, fingerprint: FP };
      },
      forget: vi.fn(),
    };
    await drainOutboxWhileOwned(
      {
        outbox,
        config,
        sdkVersion: 't',
        fetch: fetchSpy as unknown as typeof fetch,
        deviceLinks: dl,
      },
      () => owned,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(outbox.deleted).toEqual([]);
  });
});
