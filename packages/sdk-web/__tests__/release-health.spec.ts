// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { webcrypto } from 'node:crypto';
import { ReleaseHealthRecordSchema } from '@everframe/protocol';
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


describe('frozen launch session subjects', () => {
  function queued() {
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('fetch', async () => { throw new Error('offline'); });
    const records: any[] = [];
    journal.double = {
      activate: async () => ({ generation: 'current', losses: 0 }),
      list: async () => ({ rows: records.map((record, i) => ({ key: String(i), record })), losses: 0 }),
      // A plain store: refusing an invalid subject is the SDK's job, not this double's.
      append: async (_route: string, _generation: string, record: unknown) => { records.push(record); },
      acknowledge: async () => undefined,
      revoke: async () => { records.length = 0; },
    };
    return records;
  }
  it('emits v2 anonymous sessions by default without inventing a user', async () => {
    const rows = queued();
    const handle = setupReleaseHealth({ apiKey: 'pk_anonymous', releaseHealth: { enabled: true } }, 'https://example.test', 'test');
    await handle.ready; await handle.stop();
    expect(rows).toHaveLength(2);
    expect(rows.map(row => ReleaseHealthRecordSchema.parse(row))).toEqual(rows);
    expect(rows[0]).toMatchObject({ schemaVersion: 2, exposure: { sessionPolicy: 'launch-v1', subject: { kind: 'anonymous' } } });
    expect(rows[1].exposure).toEqual(rows[0].exposure);
  });
  it('freezes identity before awaits and preserves launch across account and bundle rotation', async () => {
    const rows = queued();
    const config = { apiKey: 'pk_subject', releaseHealth: { enabled: true, loadedBuildId: 'bundle-a', userId: 'opaque-a' } };
    const first = setupReleaseHealth(config, 'https://example.test', 'test');
    config.releaseHealth.userId = 'mutated'; config.releaseHealth.loadedBuildId = 'mutated';
    await first.ready; await first.stop();
    const next = setupReleaseHealth({ ...config, releaseHealth: { enabled: true, userId: 'opaque-b', loadedBuildId: 'bundle-b' } }, 'https://example.test', 'test');
    await next.ready;
    expect(rows).toHaveLength(3);
    expect(rows.map(row => ReleaseHealthRecordSchema.parse(row))).toEqual(rows);
    expect(rows[0].exposure.subject).toEqual({ kind: 'provided', id: 'opaque-a' });
    expect(rows[1].exposure).toEqual(rows[0].exposure);
    expect(rows[2].exposure).toMatchObject({ pageLaunchId: rows[0].exposure.pageLaunchId, loadedBuildId: 'bundle-b', subject: { kind: 'provided', id: 'opaque-b' } });
    expect(rows[2].exposure.exposureId).not.toBe(rows[0].exposure.exposureId);
    await next.revoke(); expect(rows).toEqual([]);
  });
  it('treats a null user ID as anonymous and keeps delivering earlier rows', async () => {
    const rows = queued(); rows.push({ recordId: 'earlier' });
    const sent: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response('{}', { status: 201 }); });
    // Untyped hosts can pass null; like Android and iOS, it means no supplied ID.
    const handle = setupReleaseHealth({ apiKey: 'pk_null_subject', releaseHealth: { enabled: true, userId: null as unknown as string } }, 'https://example.test', 'test');
    expect(await handle.ready).toMatchObject({ state: 'active', exposure: { subject: { kind: 'anonymous' } } });
    await handle.flush();
    expect(sent).toContainEqual({ recordId: 'earlier' });
    expect(ReleaseHealthRecordSchema.parse(rows[1])).toMatchObject({ schemaVersion: 2, exposure: { subject: { kind: 'anonymous' } } });
    await handle.stop();
  });
  it.each(['', ' ', 'x'.repeat(129), 'a\u0000', '\ud800'])('refuses invalid subject %j before publishing readiness', async userId => {
    const rows = queued();
    const config = { apiKey: 'pk_invalid', releaseHealth: { enabled: true, userId } };
    const handle = setupReleaseHealth(config, 'https://example.test', 'test');
    expect(await handle.ready).toMatchObject({ state: 'unavailable', exposure: null });
    expect(rows).toEqual([]); await handle.stop();
  });
});
