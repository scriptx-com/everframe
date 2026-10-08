// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthJournalError } from '../src/release-health/journal.js';
import { setupReleaseHealth } from '../src/release-health/runtime.js';

// Per-test journal double; unset keeps the real IndexedDB journal.
const journal = vi.hoisted(() => ({ double: undefined as unknown }));
vi.mock('../src/release-health/journal.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/release-health/journal.js')>();
  return { ...actual, openReleaseHealthJournal: (...args: Parameters<typeof actual.openReleaseHealthJournal>) =>
    journal.double ? Promise.resolve(journal.double) : actual.openReleaseHealthJournal(...args) };
});

afterEach(() => { vi.unstubAllGlobals(); journal.double = undefined; });
describe('release health readiness', () => {
  it('does not touch durable storage or network when not opted in', async () => {
    const open = vi.fn(() => { throw new Error('must not open'); });
    vi.stubGlobal('indexedDB', { open });
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const handle = setupReleaseHealth({ apiKey: 'pk_test' }, 'https://example.test', 'test');
    expect(await handle.ready).toMatchObject({ state: 'disabled', exposure: null, queued: 0 });
    await handle.flush(); expect(open).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('reports unavailable persistence instead of silently using memory', async () => {
    vi.stubGlobal('crypto', { subtle: { digest: async () => new Uint8Array(32).buffer } });
    vi.stubGlobal('indexedDB', { open() { throw new Error('disk unavailable'); } });
    const handle = setupReleaseHealth({ apiKey: 'pk_test', releaseHealth: { enabled: true } }, 'https://example.test', 'test');
    expect(await handle.ready).toMatchObject({ state: 'unavailable', exposure: null, error: 'disk unavailable' });
    await handle.flush(); expect((await handle.diagnostics()).state).toBe('unavailable');
  });
  it('erases without creating browser storage when opted out before any journal exists', async () => {
    vi.stubGlobal('crypto', { subtle: { digest: async () => new Uint8Array(32).buffer } });
    // IndexedDB open of a database that does not exist: completing the first
    // version change creates it, aborting that change leaves nothing behind.
    const created: string[] = []; let databases = 0;
    vi.stubGlobal('indexedDB', { open() {
      let aborted = false;
      const request: Record<string, unknown> & { onupgradeneeded?: (event: unknown) => void; onerror?: () => void; onsuccess?: () => void } = {
        result: { createObjectStore: (name: string) => created.push(name) },
        transaction: { abort: () => { aborted = true; } },
      };
      setTimeout(() => {
        request.onupgradeneeded?.({ oldVersion: 0, newVersion: 1 });
        if (aborted) { request.error = new DOMException('Version change aborted', 'AbortError'); request.onerror?.(); }
        else { databases++; request.onsuccess?.(); }
      });
      return request;
    } });
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const states: unknown[] = [];
    for (const config of [{ apiKey: 'pk_opt_out', disabled: true }, { apiKey: 'pk_opt_out', releaseHealth: { enabled: false } }]) {
      const handle = setupReleaseHealth(config, 'https://example.test', 'test');
      const { state, exposure, queued } = await handle.ready; states.push({ state, exposure, queued });
      await handle.flush();
    }
    const disabled = { state: 'disabled', exposure: null, queued: 0 };
    expect({ states, created, databases }).toEqual({ states: [disabled, disabled], created: [], databases: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps delivering a full queue that refuses the new start', async () => {
    vi.stubGlobal('crypto', { subtle: { digest: async () => new Uint8Array(32).buffer },
      randomUUID: () => '11111111-1111-4111-8111-111111111111' });
    let rows = [{ key: 'queued', record: { recordId: 'queued' } }];
    // The journal counts the refused start as a loss before rejecting it.
    journal.double = {
      activate: async () => ({ generation: 'current', losses: 0 }),
      list: async () => ({ rows: [...rows], losses: 1 }),
      append: async () => { throw new HealthJournalError('capacity'); },
      acknowledge: async (_route: string, _generation: string, key: string) => { rows = rows.filter(row => row.key !== key); },
      revoke: async () => undefined,
    };
    const fetch = vi.fn(async () => new Response('{}', { status: 201 })); vi.stubGlobal('fetch', fetch);
    const handle = setupReleaseHealth({ apiKey: 'pk_full', releaseHealth: { enabled: true } }, 'https://example.test', 'test');
    expect(await handle.ready).toMatchObject({ state: 'active', exposure: null, error: 'Release health journal: capacity' });
    await handle.flush();
    expect(fetch).toHaveBeenCalledTimes(1); expect(rows).toEqual([]);
    rows = [{ key: 'later', record: { recordId: 'later' } }];
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(rows).toEqual([]));
    expect(await handle.diagnostics()).toMatchObject({ state: 'active', exposure: null, queued: 0, priorQueueLosses: 1 });
    await handle.stop();
  });
});
