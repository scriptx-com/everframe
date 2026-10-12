// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, expect, it, vi } from 'vitest';
import { createLocalStorageOutbox } from '../../src/outbox/localStorage.js';

const metadata = { sdkKey: 'key-A' };
const replay = { format: 'rrweb' as const, bytes: new Uint8Array([1, 2]), contentType: 'application/octet-stream', durationMs: 1000 };
async function tab() {
  vi.resetModules();
  const parts = await import('../../src/transport/error-replay-parts.js');
  const { drainOutbox } = await import('../../src/transport/submit.js');
  return { parts, drainOutbox };
}
async function enqueue(parts: Awaited<ReturnType<typeof tab>>['parts']) {
  const outbox = createLocalStorageOutbox()!;
  const hold = parts.markErrorReplayPending('shared');
  await outbox.enqueue({ reportId: 'shared', enqueuedAt: Date.now(), attempts: 0,
    payload: new TextEncoder().encode(JSON.stringify({ reportId: 'shared', source: 'error', attachments: [], captureControl: {} })),
    metadata: { ...metadata, ...(hold as unknown as Record<string, string>) } });
  return outbox;
}
const request = (outbox: ReturnType<typeof createLocalStorageOutbox>, fetch: typeof globalThis.fetch) =>
  ({ outbox: outbox!, config: { sdkKey: 'key-A' }, sdkVersion: 'test', retryScheduleMs: [], fetch });
afterEach(() => { localStorage.clear(); vi.useRealTimers(); });

it('another isolated page cannot steal a shared error while the owner exports its replay', async () => {
  const a = await tab();
  await enqueue(a.parts);
  const b = await tab();
  const sent: FormData[] = [];
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    sent.push(init!.body as FormData); return new Response('{}', { status: 200 });
  });
  const bOutbox = createLocalStorageOutbox()!;
  await b.drainOutbox(request(bOutbox, fetch));
  expect(sent).toEqual([]);
  expect(await bOutbox.list()).toHaveLength(1);
  a.parts.settleErrorReplay('shared', { kind: 'attach', capture: replay });
  await a.drainOutbox(request(createLocalStorageOutbox(), fetch));
  expect(sent).toHaveLength(1);
  expect(sent[0]!.get('session-replay')).not.toBeNull();
  expect(await bOutbox.list()).toEqual([]);
});

it('a reloaded page wakes at the persisted deadline after the recording page dies', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const a = await tab();
  await enqueue(a.parts);
  const b = await tab();
  const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
  const outbox = createLocalStorageOutbox()!;
  await b.drainOutbox(request(outbox, fetch));
  await b.drainOutbox(request(outbox, fetch));
  expect(fetch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(3_001);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await outbox.list()).toEqual([]);
});

it.each(['Infinity', 'NaN', String(Date.now() + 100_000)])('does not honor an invalid or extended persisted hold %s', async until => {
  const b = await tab();
  const outbox = createLocalStorageOutbox()!;
  await outbox.enqueue({ reportId: 'invalid-hold', enqueuedAt: Date.now(), attempts: 0,
    payload: new TextEncoder().encode(JSON.stringify({ reportId: 'invalid-hold', source: 'error', attachments: [], captureControl: {} })),
    metadata: { ...metadata, errorReplayOwner: 'dead-owner', errorReplayUntil: until } });
  const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
  await b.drainOutbox(request(outbox, fetch));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await outbox.list()).toEqual([]);
});
