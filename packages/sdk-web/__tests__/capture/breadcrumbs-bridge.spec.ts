// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { BreadcrumbInput } from '@traceitx/sdk-core';
import { installConsolePatcher } from '../../src/capture/logs.js';
import { installFetchPatcher, installXHRPatcher } from '../../src/capture/network.js';
import { __claimCaptureBuffers, consoleBuffer, networkBuffer } from '../../src/capture/buffers.js';

const collect = () => {
  const crumbs: BreadcrumbInput[] = [];
  const sink = (i: BreadcrumbInput) => crumbs.push(i);
  return { crumbs, sink };
};

const uninstalls: Array<() => void> = [];
afterEach(() => {
  while (uninstalls.length) uninstalls.pop()!();
  __claimCaptureBuffers(100, 100);
  consoleBuffer.clear();
  networkBuffer.clear();
  vi.restoreAllMocks();
});

describe('console → crumb bridge', () => {
  it('dual-writes console calls as console crumbs with mapped levels', () => {
    const { crumbs, sink } = collect();
    uninstalls.push(installConsolePatcher({ crumbSink: sink, crumbGate: () => true }));
    console.log('hello %s', 'world');
    console.warn('low stock');
    expect(crumbs).toEqual([
      expect.objectContaining({ kind: 'console', level: 'info', message: 'hello world' }),
      expect.objectContaining({ kind: 'console', level: 'warn', message: 'low stock' }),
    ]);
    // the legacy log buffer still gets both entries (dual-write, not re-route)
    expect(consoleBuffer.snapshot()).toHaveLength(2);
  });

  it('routes uncaught errors to kind error with a stackDigest', () => {
    const { crumbs, sink } = collect();
    uninstalls.push(installConsolePatcher({ crumbSink: sink, crumbGate: () => true }));
    const err = new Error('boom');
    window.onerror!.call(window, 'boom', 'app.js', 1, 1, err);
    const errorCrumbs = crumbs.filter((c) => c.kind === 'error');
    expect(errorCrumbs).toHaveLength(1);
    expect(errorCrumbs[0]).toMatchObject({ level: 'error', message: 'boom' });
    expect((errorCrumbs[0]!.data as { stackDigest?: string }).stackDigest).toContain('boom');
  });

  it('gate=false suppresses crumbs but not log-buffer writes', () => {
    const { crumbs, sink } = collect();
    uninstalls.push(installConsolePatcher({ crumbSink: sink, crumbGate: () => false }));
    console.info('quiet');
    expect(crumbs).toHaveLength(0);
    expect(consoleBuffer.snapshot()).toHaveLength(1);
  });
});

describe('fetch → crumb bridge', () => {
  it('dual-writes a network crumb with method/url/status/durationMs', async () => {
    const { crumbs, sink } = collect();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok', { status: 500 })),
    );
    uninstalls.push(installFetchPatcher({ crumbSink: sink, crumbGate: () => true }));
    await fetch('/api/x', { method: 'POST' });
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0]).toMatchObject({
      kind: 'network',
      level: 'error',
      message: 'POST /api/x 500',
    });
    expect(crumbs[0]!.data).toMatchObject({ method: 'POST', url: '/api/x', status: 500 });
    expect(networkBuffer.snapshot()).toHaveLength(1); // legacy buffer untouched
  });

  it('failed fetch reports the SAME durationMs in the buffer entry and the crumb', async () => {
    const { crumbs, sink } = collect();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );
    uninstalls.push(installFetchPatcher({ crumbSink: sink, crumbGate: () => true }));
    await expect(fetch('/api/x', { method: 'GET' })).rejects.toThrow('network down');
    expect(crumbs).toHaveLength(1);
    const entry = networkBuffer.snapshot()[0]!;
    expect((crumbs[0]!.data as { durationMs: number }).durationMs).toBe(entry.durationMs);
  });
});

describe('XHR → crumb bridge', () => {
  it('network failure (status 0) crumbs at level error with a failed message', () => {
    const { crumbs, sink } = collect();
    uninstalls.push(installXHRPatcher({ crumbSink: sink, crumbGate: () => true }));
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'http://127.0.0.1:9/unreachable');
    // jsdom drives a network failure through XMLHttpRequest-impl's requestErrorSteps:
    // it fully dispatches `readystatechange` (readyState→4, status 0) to ALL of its
    // listeners first, then fires `error`. Our own `readystatechange` listener here
    // would be registered (in this test, above) BEFORE the patcher's — since the
    // patcher's own `readystatechange` listener is only added inside its patched
    // `send()`, called after this listener is already attached — so asserting from
    // a `readystatechange` listener here is a listener-order race against the
    // patcher's. Asserting from `error` instead is safe: `error` fires strictly
    // after the `readystatechange` dispatch (to all listeners, patcher included)
    // has fully completed, per jsdom's requestErrorSteps.
    return new Promise<void>((resolve, reject) => {
      xhr.addEventListener('error', () => {
        try {
          expect(xhr.readyState).toBe(4);
          expect(crumbs).toHaveLength(1);
          expect(crumbs[0]).toMatchObject({
            kind: 'network',
            level: 'error',
            message: 'GET http://127.0.0.1:9/unreachable failed',
          });
          const entry = networkBuffer.snapshot()[0]!;
          expect((crumbs[0]!.data as { durationMs: number }).durationMs).toBe(
            entry.durationMs,
          );
          resolve();
        } catch (e) {
          reject(e as Error);
        }
      });
      xhr.send();
    });
  });
});
