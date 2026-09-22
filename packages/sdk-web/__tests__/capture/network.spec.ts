// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFetchPatcher, installXHRPatcher } from '../../src/capture/network.js';
import {
  networkBuffer,
  DEFAULT_NETWORK_CAP,
  __claimCaptureBuffers,
} from '../../src/capture/buffers.js';
import { RingBuffer } from '../../src/internal/ring-buffer.js';
import type { NetworkEntry } from '@traceitx/sdk-core';

describe('network buffer capacity', () => {
  it('defaults to the last 100 requests (memory-bounded)', () => {
    expect(DEFAULT_NETWORK_CAP).toBe(100);
  });

  it('evicts oldest-first once 100 is exceeded — never accumulates', () => {
    const buf = new RingBuffer<NetworkEntry>(DEFAULT_NETWORK_CAP);
    for (let i = 0; i < 300; i++) {
      buf.push({ method: 'GET', url: `https://example.com/${i}` } as unknown as NetworkEntry);
    }
    const snap = buf.snapshot();
    expect(snap.length).toBe(100);
    expect((snap[0] as { url: string }).url).toBe('https://example.com/200');
    expect((snap[snap.length - 1] as { url: string }).url).toBe('https://example.com/299');
  });
});

describe('installFetchPatcher', () => {
  let uninstall: () => void = () => undefined;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    __claimCaptureBuffers(250, 100);
    networkBuffer.clear();
    originalFetch = globalThis.fetch;
    // Mock fetch to return a controllable Response with headers
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      const headers = new Headers({
        'content-type': 'application/json',
        authorization: 'Bearer secret',
        'x-api-key': 'sk_live_123',
        'x-request-id': 'public-id',
      });
      return new Response('{}', { status: 200, headers });
    }) as typeof globalThis.fetch;
  });
  afterEach(() => {
    uninstall();
    uninstall = () => undefined;
    globalThis.fetch = originalFetch;
    networkBuffer.clear();
  });

  it('captures method/url/status/durationMs/startedAt for a fetch() call', async () => {
    uninstall = installFetchPatcher();
    await fetch('https://api.example.com/users', { method: 'GET' });
    const snap = networkBuffer.snapshot();
    expect(snap.length).toBe(1);
    expect(snap[0].method).toBe('GET');
    expect(snap[0].url).toBe('https://api.example.com/users');
    expect(snap[0].status).toBe(200);
    expect(typeof snap[0].durationMs).toBe('number');
    expect(typeof snap[0].startedAt).toBe('number');
  });

  it('redacts sensitive headers; pass-through for others', async () => {
    uninstall = installFetchPatcher();
    await fetch('https://api.example.com');
    const e = networkBuffer.snapshot()[0];
    expect(e.headers).toBeDefined();
    expect(e.headers!['authorization']).toBe('[REDACTED]');
    expect(e.headers!['x-api-key']).toBe('[REDACTED]');
    expect(e.headers!['x-request-id']).toBe('public-id');
    expect(e.headers!['content-type']).toBe('application/json');
  });

  it('captures errored fetch (re-throws + entry without status)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('network');
    }) as typeof globalThis.fetch;
    uninstall = installFetchPatcher();
    await expect(fetch('https://offline.example.com')).rejects.toThrow(/network/);
    const e = networkBuffer.snapshot()[0];
    expect(e.url).toBe('https://offline.example.com');
    expect(e.status).toBeUndefined();
    expect(typeof e.durationMs).toBe('number');
  });

  it('idempotent — second install no-ops, only one entry per call', async () => {
    const u1 = installFetchPatcher();
    const u2 = installFetchPatcher();
    await fetch('https://api.example.com');
    expect(networkBuffer.size()).toBe(1);
    u2();
    u1();
  });

  it('NetworkEntry never carries a body field', async () => {
    uninstall = installFetchPatcher();
    await fetch('https://api.example.com', {
      method: 'POST',
      body: JSON.stringify({ secret: 'xyz' }),
    });
    const e = networkBuffer.snapshot()[0]!;
    expect(Object.keys(e)).not.toContain('body');
    expect(Object.keys(e)).not.toContain('requestBody');
  });
});

describe('installXHRPatcher', () => {
  let uninstall: () => void = () => undefined;
  beforeEach(() => {
    __claimCaptureBuffers(250, 100);
    networkBuffer.clear();
  });
  afterEach(() => {
    uninstall();
    uninstall = () => undefined;
    networkBuffer.clear();
  });

  it('captures method/url/status on XHR completion', async () => {
    uninstall = installXHRPatcher();
    await new Promise<void>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.addEventListener('readystatechange', () => {
        if (xhr.readyState === 4) resolve();
      });
      xhr.open('GET', 'https://api.example.com/xhr');
      // jsdom XHR won't actually do network — simulate a completed transition.
      Object.defineProperty(xhr, 'readyState', { configurable: true, get: () => 4 });
      Object.defineProperty(xhr, 'status', { configurable: true, get: () => 201 });
      // Fire send to install our patched listener; then dispatch event.
      xhr.send(null);
      xhr.dispatchEvent(new Event('readystatechange'));
    });
    const snap = networkBuffer.snapshot();
    expect(snap.some((e) => e.url === 'https://api.example.com/xhr' && e.status === 201)).toBe(
      true,
    );
  });

  it('idempotent — second install no-ops', () => {
    const u1 = installXHRPatcher();
    const u2 = installXHRPatcher();
    u2();
    u1();
    const slot = globalThis as unknown as Record<symbol, unknown>;
    expect(slot[Symbol.for('__traceitx_patched_xhr__')]).toBeUndefined();
  });
});
