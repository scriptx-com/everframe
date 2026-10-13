// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, expect, it, vi } from 'vitest';
import { acquireWebHealth, type WebHealthLease } from '../../src/release-health/runtime.js';
const leases: WebHealthLease[] = [];
afterEach(() => {
  leases.forEach((x) => x.revoke());
  leases.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
  vi.unstubAllGlobals();
});
it('preserves a page session across reownership and bfcache; stale leases cannot fail or revoke it', async () => {
  const records: any[] = [];
  vi.stubGlobal('fetch', async (_u: string, i: RequestInit) => {
    records.push(JSON.parse(String(i.body)));
    return new Response('{}', { status: 201 });
  });
  const opts = {
    endpoint: 'https://example.test',
    sdkKey: crypto.randomUUID(),
    app: { version: '12.3.5-12-web', build: null, debug: false },
    sdkVersion: '1.2.2',
    platform: 'web' as const,
    subject: { kind: 'anonymous' as const },
  };
  const a = acquireWebHealth(opts);
  leases.push(a);
  a.release();
  const b = acquireWebHealth(opts);
  leases.push(b);
  a.revoke();
  a.fail('onerror');
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  document.dispatchEvent(new Event('visibilitychange'));
  await new Promise((r) => setTimeout(r, 0));
  expect(records.map((r) => r.phase)).toEqual(['start']);
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
  b.fail('unhandledrejection');
  await new Promise((r) => setTimeout(r, 20));
  expect(records.map((r) => r.phase)).toEqual(['start', 'failure']);
  expect(new Set(records.map((r) => r.exposure.exposureId)).size).toBe(1);
});
it('revokes retries from every version interval when storage is blocked', async () => {
  vi.useFakeTimers();
  const storage = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
    throw Error('blocked');
  });
  const fetcher = vi.fn(async () => {
    throw Error('offline');
  });
  vi.stubGlobal('fetch', fetcher);
  const opts = {
    endpoint: 'https://example.test',
    sdkKey: crypto.randomUUID(),
    app: { version: '1', build: null, debug: false },
    sdkVersion: '1.2.2',
    platform: 'web' as const,
    subject: { kind: 'anonymous' as const },
  };
  const first = acquireWebHealth(opts);
  leases.push(first);
  await vi.advanceTimersByTimeAsync(0);
  first.release();
  const second = acquireWebHealth({ ...opts, app: { ...opts.app, version: '2' } });
  leases.push(second);
  await vi.advanceTimersByTimeAsync(0);
  second.revoke();
  const before = fetcher.mock.calls.length;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fetcher).toHaveBeenCalledTimes(before);
  storage.mockRestore();
  vi.useRealTimers();
});

it.each([false, true])(
  'supersedes unsent completion during exit (blocked storage: %s)',
  async (blocked) => {
    if (blocked)
      vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
        throw Error('blocked');
      });
    const sent: string[] = [];
    let acknowledgeStart!: (response: Response) => void;
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      const record = JSON.parse(String(init.body));
      sent.push(record.phase);
      if (record.phase === 'start')
        return new Promise<Response>((resolve) => {
          acknowledgeStart = resolve;
        });
      return Promise.resolve(new Response('{}', { status: 201 }));
    });
    const lease = acquireWebHealth({
      endpoint: 'https://example.test',
      sdkKey: crypto.randomUUID(),
      app: { version: '1', build: null, debug: false },
      sdkVersion: '1.2.2',
      platform: 'web',
      subject: { kind: 'anonymous' },
    });
    leases.push(lease);
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
    lease.fail('onerror');
    acknowledgeStart(new Response('{}', { status: 201 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toEqual(['start', 'failure']);
  },
);

it('uses keepalive for an exit failure when start is already acknowledged', async () => {
  const sent: { phase: string; keepalive?: boolean }[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    sent.push({ phase: JSON.parse(String(init.body)).phase, keepalive: init.keepalive });
    return new Response('{}', { status: 201 });
  });
  const lease = acquireWebHealth({
    endpoint: 'https://example.test',
    sdkKey: crypto.randomUUID(),
    app: { version: '1', build: null, debug: false },
    sdkVersion: '1.2.2',
    platform: 'web',
    subject: { kind: 'anonymous' },
  });
  leases.push(lease);
  await new Promise((resolve) => setTimeout(resolve, 0));
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
  lease.fail('onerror');
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(sent).toEqual([
    { phase: 'start', keepalive: undefined },
    { phase: 'failure', keepalive: true },
  ]);
});
