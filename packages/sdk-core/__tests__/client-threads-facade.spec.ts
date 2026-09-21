// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { createFakePlatformAdapter } from '../src/__test-helpers__/fake-platform-adapter.js';
import { createThreadClient } from '../src/reporter/thread-client.js';
import { ReporterApiError } from '../src/reporter/api.js';
import type { ThreadClient } from '../src/reporter/thread-client.js';
import type { ReporterApi, ThreadSummary } from '../src/reporter/api.js';

function fakeThreads(): ThreadClient {
  return {
    getState: vi.fn(() => ({ enabled: true, readOnly: false, threads: [], unreadCount: 5, pending: [], cooldownUntilMs: null })),
    list: vi.fn(() => []), unreadCount: vi.fn(() => 5),
    subscribe: vi.fn(() => () => {}), refresh: vi.fn(async () => {}),
    wake: vi.fn(), startPolling: vi.fn(), stopPolling: vi.fn(),
    get: vi.fn(async () => null), reply: vi.fn(async () => {}), retryMessage: vi.fn(async () => {}),
    markRead: vi.fn(async () => {}), deleteThread: vi.fn(async () => {}),
    shutdown: vi.fn(),
  } as unknown as ThreadClient;
}

describe('tx.threads facade', () => {
  it('delegates to the adapter thread client after init', async () => {
    const threads = fakeThreads();
    const adapter = { ...createFakePlatformAdapter(), threads };
    const client = createClient(adapter);
    client.init({ apiKey: 'txx_live_k' });
    expect(client.threads.unreadCount()).toBe(5);
    await client.threads.reply('t1', 'hi');
    expect(threads.reply).toHaveBeenCalledWith('t1', 'hi');
    const deleted = await client.threads.delete('t1');
    expect(threads.deleteThread).toHaveBeenCalledWith('t1');
    // Finding 5 (round 6, PR review): `true` is the documented contract only
    // for a genuine local removal — assert it explicitly here (the wired,
    // happy-path case), not just that deleteThread() was invoked.
    expect(deleted).toBe(true);
  });

  it('kill() terminally shuts down the adapter thread client (finding I1 / finding 6)', () => {
    // stopPolling() alone is reversible (wake()/startPolling() re-arm it) —
    // kill() must reach for the irreversible shutdown() instead, so nothing
    // holding a direct reference to the adapter's ThreadClient (e.g. the
    // Provider's visibilitychange listener) can resurrect traffic after
    // kill() returns.
    const threads = fakeThreads();
    const adapter = { ...createFakePlatformAdapter(), threads };
    const client = createClient(adapter);
    client.init({ apiKey: 'txx_live_k' });
    threads.startPolling();
    expect(threads.shutdown).not.toHaveBeenCalled();
    client.kill();
    expect(threads.shutdown).toHaveBeenCalledTimes(1);
  });

  // Finding 6: the exact escape path from the review — a caller that reaches
  // the adapter's real ThreadClient directly (the Provider's
  // visibilitychange listener does exactly this: `threads.wake()` on the
  // adapter, not through tx.threads.*) must not be able to resurrect
  // traffic after kill(). Uses the REAL createThreadClient, not a mock, so
  // this exercises the actual wake()→startPolling() reversibility path the
  // finding described.
  it('kill() then a direct adapter threads.wake()/refresh() call produces no traffic (finding 6 escape path)', async () => {
    const listThreads = vi.fn(async () => ({ kind: 'ok' as const, threads: [], etag: null }));
    const api = {
      listThreads,
      listMessages: vi.fn(),
      postMessage: vi.fn(),
      markRead: vi.fn(),
      deleteThread: vi.fn(),
    } as unknown as ReporterApi;
    const credentials = {
      randomBytes: (n: number) => new Uint8Array(n),
      load: async () => 'txr_' + 'a'.repeat(43),
      save: async () => {},
      clear: async () => {},
    };
    const threads = createThreadClient({ api, credentials, isEnabled: () => true });
    const adapter = { ...createFakePlatformAdapter(), threads };
    const client = createClient(adapter);
    client.init({ apiKey: 'txx_live_k' });

    client.kill();
    // Bypasses the tx.threads.* facade entirely — this is the direct adapter
    // access the finding flagged (Provider visibilitychange + stale FAB).
    adapter.threads.wake();
    await adapter.threads.refresh();
    expect(listThreads).not.toHaveBeenCalled();
    expect(adapter.threads.getState()).toEqual({
      enabled: false, readOnly: false, threads: [], unreadCount: 0, pending: [], cooldownUntilMs: null,
    });
  });

  // Finding 4 (round 5): against the REAL facade + REAL thread client (not
  // the mocked fakeThreads() above), a replies_disabled delete must resolve
  // `false` — not `true` — because the thread is still there locally. The
  // documented contract (see the `threads.delete` handler above) is `true`
  // only on genuine success/404; a `true` here would make the built-in
  // read-only inbox navigate back as if the delete worked while list()
  // still shows the same conversation.
  it('delete() resolves false when the server latches replies_disabled instead of deleting, and the thread stays listed', async () => {
    const t1: ThreadSummary = { id: 't1', status: 'open', reportTitle: 'Crash', createdAt: '2026-08-01T00:00:00.000Z', lastMessageAt: null, unreadCount: 0 };
    const api = {
      listThreads: vi.fn(async () => ({ kind: 'ok' as const, threads: [t1], etag: null })),
      listMessages: vi.fn(),
      postMessage: vi.fn(),
      markRead: vi.fn(),
      deleteThread: vi.fn(async () => { throw new ReporterApiError('replies_disabled', 401); }),
    } as unknown as ReporterApi;
    const credentials = {
      randomBytes: (n: number) => new Uint8Array(n),
      load: async () => 'txr_' + 'a'.repeat(43),
      save: async () => {},
      clear: async () => {},
    };
    const threads = createThreadClient({ api, credentials, isEnabled: () => true });
    const adapter = { ...createFakePlatformAdapter(), threads };
    const client = createClient(adapter);
    client.init({ apiKey: 'txx_live_k' });
    await threads.refresh();
    expect(client.threads.list().map((t) => t.id)).toEqual(['t1']);

    const deleted = await client.threads.delete('t1');
    expect(deleted).toBe(false);
    expect(client.threads.list().map((t) => t.id)).toEqual(['t1']);   // still there
  });

  // Finding 2 (round 7, PR review): against the REAL facade + REAL thread
  // client, a delete attempted while the credential is momentarily
  // unreadable (cleared by another tab, storage access unavailable) must
  // resolve `false` — not `true` — and must not remove the cached row. The
  // documented contract is `true` only when the conversation is really gone
  // locally; a `true` here would navigate the built-in inbox back as though
  // the delete succeeded while list() still shows the same conversation.
  it('delete() resolves false when no reporter credential is available, and the thread stays listed', async () => {
    const t1: ThreadSummary = { id: 't1', status: 'open', reportTitle: 'Crash', createdAt: '2026-08-01T00:00:00.000Z', lastMessageAt: null, unreadCount: 0 };
    const deleteThread = vi.fn(async () => undefined);
    const api = {
      listThreads: vi.fn(async () => ({ kind: 'ok' as const, threads: [t1], etag: null })),
      listMessages: vi.fn(),
      postMessage: vi.fn(),
      markRead: vi.fn(),
      deleteThread,
    } as unknown as ReporterApi;
    let token: string | null = 'txr_' + 'a'.repeat(43);
    const credentials = {
      randomBytes: (n: number) => new Uint8Array(n),
      load: async () => token,
      save: async (t: string) => { token = t; },
      clear: async () => { token = null; },
    };
    const threads = createThreadClient({ api, credentials, isEnabled: () => true });
    const adapter = { ...createFakePlatformAdapter(), threads };
    const client = createClient(adapter);
    client.init({ apiKey: 'txx_live_k' });
    await threads.refresh();
    expect(client.threads.list().map((t) => t.id)).toEqual(['t1']);

    token = null; // credential becomes unavailable (e.g. cleared by another tab)
    const deleted = await client.threads.delete('t1');
    expect(deleted).toBe(false);
    expect(deleteThread).not.toHaveBeenCalled();
    expect(client.threads.list().map((t) => t.id)).toEqual(['t1']); // still there
  });

  it('is inert before init, after kill, and without an adapter client', async () => {
    const adapter = { ...createFakePlatformAdapter(), threads: fakeThreads() };
    const client = createClient(adapter);
    expect(client.threads.list()).toEqual([]);           // pre-init
    expect(client.threads.unreadCount()).toBe(0);
    // Finding 5 (round 6, PR review): threads.delete() previously
    // optional-chained `threadsOrNull()?.deleteThread(id)` and then
    // *unconditionally* returned `true`, so it resolved `true` even when no
    // delete happened at all (facade inert). `true` must be reserved for a
    // genuine local removal.
    expect(await client.threads.delete('t1')).toBe(false); // pre-init
    client.init({ apiKey: 'txx_live_k' });
    client.kill();
    expect(client.threads.unreadCount()).toBe(0);        // killed
    expect(await client.threads.delete('t1')).toBe(false); // killed

    const bare = createClient(createFakePlatformAdapter());
    bare.init({ apiKey: 'txx_live_k' });
    expect(bare.threads.list()).toEqual([]);             // no platform thread client
    expect(typeof bare.threads.subscribe(() => {})).toBe('function');
    expect(await bare.threads.delete('t1')).toBe(false); // no adapter thread client
  });
});
