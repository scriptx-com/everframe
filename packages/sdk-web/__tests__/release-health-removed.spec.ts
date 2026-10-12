// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// Web release health is gone. The package exports no producer, the handle
// `init()` returns has no `releaseHealth`, and a JavaScript caller that still
// passes the old option starts the SDK without opening IndexedDB.
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { init, type Everframe } from '../src/init.js';
import type { WebEverframeConfig } from '../src/internal/types.js';

let handles: Everframe[] = [];

beforeEach(() => {
  // As in init.spec.ts: a dev API listening on INGEST_URL must not change the outcome.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })),
  );
});

afterEach(() => {
  handles.forEach((h) => h.destroy());
  handles = [];
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('web release health is removed', () => {
  it('exports no release-health producer', async () => {
    const web = await import('../src/index.js');
    expect('setupReleaseHealth' in web).toBe(false);
  });

  it('returns a handle without releaseHealth', () => {
    const handle = init({ sdkKey: 'pk_test' });
    handles.push(handle);
    expect('releaseHealth' in handle).toBe(false);
  });

  it('has no releaseHealth on the config or handle types', () => {
    // Each declaration stops compiling under `tsc -p tsconfig.test.json` if the key comes back.
    const configHasNoKey: 'releaseHealth' extends keyof WebEverframeConfig ? false : true = true;
    const handleHasNoKey: 'releaseHealth' extends keyof Everframe ? false : true = true;
    expect([configHasNoKey, handleHasNoKey]).toEqual([true, true]);
  });

  it('ignores a leftover releaseHealth option without opening IndexedDB', async () => {
    // Real Web Crypto, so the removed producer would have reached IndexedDB.
    vi.stubGlobal('crypto', webcrypto);
    const open = vi.fn(() => {
      throw new Error('IndexedDB must not be opened');
    });
    vi.stubGlobal('indexedDB', { open });
    const leftover = { sdkKey: 'pk_test', releaseHealth: { enabled: true } } as unknown as WebEverframeConfig;
    handles.push(init(leftover));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(open).not.toHaveBeenCalled();
  });
});
