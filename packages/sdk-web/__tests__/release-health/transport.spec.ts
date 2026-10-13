// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, expect, it, vi } from 'vitest';
import type { WebReleaseHealthRecord } from '@everframe/protocol';
import { createWebHealthJournal } from '../../src/release-health/journal.js';
import { createWebHealthTransport } from '../../src/release-health/transport.js';
import { createWebHealthSession } from '../../src/release-health/session.js';
import { exposure, at } from './fixture.js';
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('retries network failure, keeps immutable IDs, and acknowledges delivered rows', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(at);
  const journal = createWebHealthJournal(null),
    record = createWebHealthSession(exposure()).start();
  journal.put({ endpoint: 'https://example.test', sdkKey: 'key', record });
  const received: unknown[] = [];
  let attempt = 0;
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    received.push(JSON.parse(String(init.body)));
    if (attempt++ === 0) throw Error('offline');
    return new Response('{}', { status: 201 });
  });
  const transport = createWebHealthTransport(journal);
  await transport.flush();
  expect(journal.list(at)).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(received).toEqual([record, record]);
  expect(journal.list(at)).toEqual([]);
});
it('revocation aborts in-flight work and late failures cannot resurrect it', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(at);
  const journal = createWebHealthJournal(null);
  journal.put({
    endpoint: 'https://example.test',
    sdkKey: 'key',
    record: createWebHealthSession(exposure()).start(),
  });
  let reject!: (e: Error) => void;
  let signal: AbortSignal | null | undefined;
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    signal = init.signal;
    return new Promise((_r, j) => {
      reject = j;
    });
  });
  const t = createWebHealthTransport(journal);
  const pending = t.flush();
  t.revoke('https://example.test', 'key');
  expect(signal?.aborted).toBe(true);
  reject(Error('aborted'));
  await pending;
  expect(journal.list(at)).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
it('drops permanent rejection and retains rate-limited records until Retry-After', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(at);
  const j = createWebHealthJournal(null);
  j.put({
    endpoint: 'https://example.test',
    sdkKey: 'key',
    record: createWebHealthSession(exposure()).start(),
  });
  let calls = 0;
  vi.stubGlobal('fetch', async () =>
    ++calls === 1
      ? new Response('{}', { status: 429, headers: { 'Retry-After': '10' } })
      : new Response('{}', { status: 400 }),
  );
  const t = createWebHealthTransport(j);
  await t.flush();
  await vi.advanceTimersByTimeAsync(9999);
  expect(j.list(at)).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(j.list(at)).toEqual([]);
});
it('honors Retry-After when another lifecycle flush arrives', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(at);
  const j = createWebHealthJournal(null);
  j.put({
    endpoint: 'https://example.test',
    sdkKey: 'key',
    record: createWebHealthSession(exposure()).start(),
  });
  const fetcher = vi.fn(
    async () => new Response('{}', { status: 429, headers: { 'Retry-After': '10' } }),
  );
  vi.stubGlobal('fetch', fetcher);
  const t = createWebHealthTransport(j);
  await t.flush();
  await t.flush();
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetcher).toHaveBeenCalledTimes(2);
  t.revoke('https://example.test', 'key');
});
it('uses keepalive for exit records queued while the start is in flight', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(at);
  const j = createWebHealthJournal(null),
    session = createWebHealthSession(exposure());
  j.put({ endpoint: 'https://example.test', sdkKey: 'key', record: session.start() });
  let resolve!: (response: Response) => void;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    )
    .mockResolvedValue(new Response('{}', { status: 201 }));
  vi.stubGlobal('fetch', fetcher);
  const t = createWebHealthTransport(j),
    pending = t.flush();
  j.put({ endpoint: 'https://example.test', sdkKey: 'key', record: session.complete(at)! });
  void t.flush({ keepalive: true });
  resolve(new Response('{}', { status: 201 }));
  await pending;
  expect(fetcher.mock.calls[1]?.[1].keepalive).toBe(true);
});

it('does not send a superseded completion from an earlier drain snapshot', async () => {
  const now = new Date(),
    session = createWebHealthSession({ ...exposure(), startedAt: now.toISOString() });
  const journal = createWebHealthJournal(null);
  const wrap = (record: WebReleaseHealthRecord) => ({
    endpoint: 'https://example.test',
    sdkKey: 'key',
    record,
  });
  journal.put(wrap(session.start()));
  journal.put(wrap(session.complete(now)!));
  let acknowledgeStart!: (response: Response) => void;
  const phases: string[] = [];
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    const phase = JSON.parse(String(init.body)).phase;
    phases.push(phase);
    return phase === 'start'
      ? new Promise<Response>((resolve) => {
          acknowledgeStart = resolve;
        })
      : Promise.resolve(new Response('{}', { status: 201 }));
  });
  const transport = createWebHealthTransport(journal),
    pending = transport.flush();
  journal.put(wrap(session.fail('onerror', now)!));
  void transport.flush({ keepalive: true });
  acknowledgeStart(new Response('{}', { status: 201 }));
  await pending;
  expect(phases).toEqual(['start', 'failure']);
});
it('sends an urgent exit failure without waiting for the completion response', async () => {
  const now = new Date(),
    session = createWebHealthSession({ ...exposure(), startedAt: now.toISOString() });
  const journal = createWebHealthJournal(null);
  const wrap = (record: WebReleaseHealthRecord) => ({
    endpoint: 'https://example.test',
    sdkKey: 'key',
    record,
  });
  journal.put(wrap(session.complete(now)!));
  let acknowledgeEnd!: (response: Response) => void;
  const sent: { phase: string; keepalive?: boolean }[] = [];
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    const phase = JSON.parse(String(init.body)).phase;
    sent.push({ phase, keepalive: init.keepalive });
    return phase === 'end'
      ? new Promise<Response>((resolve) => {
          acknowledgeEnd = resolve;
        })
      : Promise.resolve(new Response('{}', { status: 201 }));
  });
  const transport = createWebHealthTransport(journal),
    pending = transport.flush({ keepalive: true });
  journal.put(wrap(session.fail('onerror', now)!));
  void transport.flush({ keepalive: true, urgent: true });
  expect(sent).toEqual([
    { phase: 'end', keepalive: true },
    { phase: 'failure', keepalive: true },
  ]);
  acknowledgeEnd(new Response('{}', { status: 201 }));
  await pending;
});
it('deduplicates urgent failure sends and aborts both in-flight requests on withdrawal', async () => {
  const now = new Date(),
    session = createWebHealthSession({ ...exposure(), startedAt: now.toISOString() });
  const journal = createWebHealthJournal(null);
  const wrap = (record: WebReleaseHealthRecord) => ({
    endpoint: 'https://example.test',
    sdkKey: 'key',
    record,
  });
  journal.put(wrap(session.complete(now)!));
  const signals: AbortSignal[] = [];
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    signals.push(init.signal!);
    return new Promise<Response>((_resolve, reject) =>
      init.signal!.addEventListener('abort', () => reject(Error('aborted'))),
    );
  });
  const transport = createWebHealthTransport(journal),
    pending = transport.flush({ keepalive: true });
  journal.put(wrap(session.fail('onerror', now)!));
  const urgent = transport.flush({ keepalive: true, urgent: true });
  const duplicate = transport.flush({ keepalive: true, urgent: true });
  expect(signals).toHaveLength(2);
  transport.revoke('https://example.test', 'key');
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  await Promise.all([pending, urgent, duplicate]);
  expect(journal.list(now)).toEqual([]);
});
it('re-arms the retry when an urgent response extends Retry-After after the drain ended', async () => {
  vi.useFakeTimers();
  const now = new Date(),
    session = createWebHealthSession({ ...exposure(), startedAt: now.toISOString() });
  const journal = createWebHealthJournal(null);
  const wrap = (record: WebReleaseHealthRecord) => ({
    endpoint: 'https://example.test',
    sdkKey: 'key',
    record,
  });
  journal.put(wrap(session.complete(now)!));
  let acknowledgeEnd!: (response: Response) => void, rateLimit!: (response: Response) => void;
  let failures = 0;
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    if (JSON.parse(String(init.body)).phase === 'end')
      return new Promise<Response>((resolve) => {
        acknowledgeEnd = resolve;
      });
    if (++failures === 1)
      return new Promise<Response>((resolve) => {
        rateLimit = resolve;
      });
    return Promise.resolve(new Response('{}', { status: 201 }));
  });
  const transport = createWebHealthTransport(journal),
    pending = transport.flush({ keepalive: true });
  journal.put(wrap(session.fail('onerror', now)!));
  const urgent = transport.flush({ keepalive: true, urgent: true });
  acknowledgeEnd(new Response('{}', { status: 201 }));
  await pending;
  rateLimit(new Response('{}', { status: 429, headers: { 'Retry-After': '10' } }));
  await urgent;
  await vi.advanceTimersByTimeAsync(9999);
  expect(failures).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(failures).toBe(2);
  expect(journal.list(new Date())).toEqual([]);
});
