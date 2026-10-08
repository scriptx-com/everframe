// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupReleaseHealth } from '../src/release-health/runtime.js';

afterEach(() => vi.unstubAllGlobals());
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
});
