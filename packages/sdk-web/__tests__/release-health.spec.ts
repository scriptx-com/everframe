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
});
