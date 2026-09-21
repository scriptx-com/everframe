// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it, vi } from 'vitest';
import type { OutboxAdapter, OutboxItem } from '@traceitx/sdk-core';
import { drainOutbox } from '../../src/transport/submit.js';

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
    payload: new TextEncoder().encode(JSON.stringify({ reportId })),
    metadata,
  };
}

describe('drainOutbox key binding', () => {
  it('drops an entry carrying no sdkKey instead of sending it under the mounted app', async () => {
    const fetchSpy = vi.fn();
    const outbox = fakeOutbox([item('r-legacy', { url: 'https://a.example.com/api/ingest' })]);

    const result = await drainOutbox({
      outbox,
      config: { apiKey: 'key-B' } as never,
      sdkVersion: 'test',
      fetch: fetchSpy as never,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(outbox.deleted).toEqual(['r-legacy']);
    expect(result.submitted).toBe(0);
  });

  // Characterisation test — this ALREADY passes before the change. It pins the
  // shipped web behaviour that iOS and Android are being ported to in Tasks 2
  // and 6, so a future refactor cannot quietly regress the reference
  // implementation while the natives still cite it.
  it('submits each queued entry with the key that queued it', async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fetchSpy = vi.fn(async (input: unknown, init?: { headers?: HeadersInit }) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), auth: headers.get('authorization') });
      return new Response('{}', { status: 200 });
    });

    const outbox = fakeOutbox([
      item('r-A', { url: 'https://a.example.com/api/ingest', sdkKey: 'key-A' }),
      item('r-B', { url: 'https://b.example.com/api/ingest', sdkKey: 'key-B' }),
    ]);

    await drainOutbox({
      outbox,
      config: { apiKey: 'key-B' } as never,
      sdkVersion: 'test',
      fetch: fetchSpy as never,
    });

    expect(calls).toEqual([
      { url: 'https://a.example.com/api/ingest', auth: 'Bearer key-A' },
      { url: 'https://b.example.com/api/ingest', auth: 'Bearer key-B' },
    ]);
  });
});
