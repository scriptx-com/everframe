// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// The old manual producer remains removed. Page health is automatic, with
// a config opt-out; there is no manual handle API or IndexedDB producer.
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { init, type Everframe } from '../src/init.js';
import type { WebEverframeConfig } from '../src/internal/types.js';

let handles: Everframe[] = [];

beforeEach(() => {
  // As in init.spec.ts: a dev API listening on INGEST_URL must not change the outcome.
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ),
  );
});

afterEach(() => {
  handles.forEach((h) => h.destroy());
  handles = [];
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('legacy manual release health remains removed', () => {
  it('exports no release-health producer', async () => {
    const web = await import('../src/index.js');
    expect('setupReleaseHealth' in web).toBe(false);
  });

  it('returns a handle without releaseHealth', () => {
    const handle = init({ sdkKey: 'pk_test' });
    handles.push(handle);
    expect('releaseHealth' in handle).toBe(false);
  });

  it('supports a config opt-out without adding a manual handle API', () => {
    // Typecheck both the new config option and the unchanged handle contract.
    const config: WebEverframeConfig = { sdkKey: 'pk_test', releaseHealth: { enabled: false } };
    const handleHasNoKey: 'releaseHealth' extends keyof Everframe ? false : true = true;
    expect(config.releaseHealth?.enabled).toBe(false);
    expect(handleHasNoKey).toBe(true);
  });

  it('does not open IndexedDB for automatic page health', async () => {
    // Real Web Crypto, so the removed producer would have reached IndexedDB.
    vi.stubGlobal('crypto', webcrypto);
    const open = vi.fn(() => {
      throw new Error('IndexedDB must not be opened');
    });
    vi.stubGlobal('indexedDB', { open });
    const leftover = {
      sdkKey: 'pk_test',
      releaseHealth: { enabled: true },
    } as unknown as WebEverframeConfig;
    handles.push(init(leftover));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(open).not.toHaveBeenCalled();
  });
});
