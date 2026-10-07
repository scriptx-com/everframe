// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { expect, it, vi } from 'vitest';
import { createPromiseRejectionObserver, type RejectionScheduler } from '../src/promise-rejections.js';
import type { AdapterOptions } from '../src/hermes-rejection-adapter.js';
import type { PreparedRejection } from '../src/rejection-capture.js';

function fixture(prepare?: (reason: unknown, occurredAt: string) => PreparedRejection | undefined,
  override: Partial<RejectionScheduler> = {}) {
  let now = 0, owned = true, id = 0;
  const timers = new Map<number, { fn: () => void; delay: number }>();
  const delivered: PreparedRejection[] = [];
  let hooks!: AdapterOptions;
  const snapshot = vi.fn(prepare ?? ((reason: unknown, occurredAt: string) => ({
    payload: JSON.stringify({ message: String(reason), occurredAt }), key: String(reason),
  })));
  const scheduler: RejectionScheduler = {
    now: () => now, occurredAt: () => '2026-10-05T12:00:00.000Z',
    setTimer: (fn, delay) => { timers.set(++id, {fn, delay}); return id; },
    clearTimer: (handle) => { timers.delete(handle as number); }, ...override,
  };
  const observer = createPromiseRejectionObserver({
    prepareRejection: snapshot,
    submitRejection: (value) => { delivered.push(value); return 'accepted'; },
    isActive: () => true, scheduler,
    installAdapter: (options) => { hooks = options; return { status: 'observing', adapterId: 'fixture',
      previousCallbacksPresent: false, ownsHooks: () => owned, dispose: () => { owned = false; } }; },
  });
  return { observer, hooks, snapshot, timers, delivered, displace: () => { owned = false; },
    at(time: number) { now = time; },
    tick(time: number) { now = time; const jobs = [...timers.values()]; timers.clear(); jobs.forEach(({fn}) => fn()); } };
}
it('waits 2000 ms and owns at most one timer', () => {
  const f = fixture();
  f.hooks.onReject({}, 'first'); f.hooks.onReject({}, 'second');
  expect(f.timers.size).toBe(1);
  f.tick(1999); expect(f.delivered).toEqual([]); expect(f.timers.size).toBe(1);
  f.tick(2000); expect(f.delivered).toHaveLength(2);
  expect(f.observer.getStatus().counters).toMatchObject({ pending: 0, accepted: 2 });
  expect(f.timers.size).toBe(0);
});
it('cancels a handler within the grace period without emitting a report', () => {
  const f = fixture(), promise = {};
  f.hooks.onReject(promise, 'handled'); f.tick(500); f.hooks.onHandle(promise); f.tick(2000);
  expect(f.delivered).toEqual([]);
  expect(f.observer.getStatus().counters).toMatchObject({ pending: 0, cancelled: 1 });
});
it('late handling does not withdraw or duplicate an accepted report', () => {
  const f = fixture(), promise = {};
  f.hooks.onReject(promise, 'late'); f.tick(2000); f.hooks.onHandle(promise); f.tick(4000);
  expect(f.delivered).toHaveLength(1);
  expect(f.observer.getStatus().counters.cancelled).toBe(0);
});
it('drops overflow before touching reason data', () => {
  const f = fixture();
  for (let i = 0; i < 100; i++) f.hooks.onReject({}, `reason ${i}`);
  expect(f.observer.getStatus().counters).toMatchObject({ pending: 16, capacityDropped: 84 });
  expect(f.snapshot).toHaveBeenCalledTimes(16);
  f.tick(2000); expect(f.delivered).toHaveLength(16);
  expect(f.observer.getStatus().counters.pending).toBe(0);
});
it.each(['ascii', 'emoji', 'escaped', 'surrogate'] as const)('counts serialized UTF-8 bytes for %s at the inclusive limit', (kind) => {
  const fragment = { ascii: 'a', emoji: '😀', escaped: '\\u0001', surrogate: '\\ud800' }[kind];
  const count = Math.floor((65536 - 2) / Buffer.byteLength(fragment));
  const head = fragment.repeat(count);
  const payload = '"' + head + 'x'.repeat(65536 - 2 - Buffer.byteLength(head)) + '"';
  expect(Buffer.byteLength(payload)).toBe(65536);
  const f = fixture((reason) => ({ payload: String(reason), key: 'boundary' }));
  f.hooks.onReject({}, payload);
  f.hooks.onReject({}, payload.slice(0, -1) + 'x"');
  expect(f.observer.getStatus().counters).toMatchObject({ pending: 1, sizeDropped: 1 });
  f.tick(2000); expect(f.delivered).toHaveLength(1);
});
it('cancellation during extraction cannot resurrect the reserved record', () => {
  const promise = {};
  const f = fixture(() => { f.hooks.onHandle(promise); return {payload: '{}', key: 'cancelled'}; });
  f.hooks.onReject(promise, 'reason'); f.tick(2000);
  expect(f.delivered).toEqual([]);
  expect(f.observer.getStatus().counters).toMatchObject({ pending: 0, cancelled: 1 });
});
it('bounds reentrant preparation before accessing more than 16 values', () => {
  const f = fixture(() => { f.hooks.onReject({}, 'nested'); return {payload: '{}', key: 'nested'}; });
  f.hooks.onReject({}, 'outer');
  expect(f.snapshot).toHaveBeenCalledTimes(16);
  expect(f.observer.getStatus().counters).toMatchObject({ pending: 16, capacityDropped: 1 });
  f.observer.dispose(); expect(f.timers.size).toBe(0);
});
it('drops stale work instead of reporting it after a long suspension', () => {
  const f = fixture(); f.hooks.onReject({}, 'old'); f.tick(30001);
  expect(f.delivered).toEqual([]);
  expect(f.observer.getStatus().counters).toMatchObject({ pending: 0, expired: 1 });
});
it('notifies overdue work from later Promise activity while timers are paused', () => {
  const microtasks: (() => void)[] = [];
  const f = fixture(undefined, { queueMicrotask: (fn) => { microtasks.push(fn); } });
  f.hooks.onReject({}, 'background');
  f.at(1500); f.hooks.onHandle({});
  expect(microtasks).toEqual([]);
  f.at(2500); f.hooks.onHandle({}); f.hooks.onReject({}, 'second');
  expect(f.delivered).toEqual([]);
  expect(microtasks).toHaveLength(1);
  microtasks.splice(0).forEach((fn) => fn());
  expect(f.delivered.map((value) => JSON.parse(value.payload).message)).toEqual(['background']);
  expect(f.observer.getStatus().counters).toMatchObject({ pending: 1, accepted: 1, expired: 0 });
});
it('never flushes synchronously inside a Promise hook', () => {
  const f = fixture(undefined, { queueMicrotask: (fn) => fn() });
  f.hooks.onReject({}, 'held'); f.at(2500); f.hooks.onHandle({});
  expect(f.delivered).toEqual([]);
  f.tick(2500); expect(f.delivered).toHaveLength(1);
});
it('expires work held across device sleep by wall-clock age', () => {
  let wall = 0;
  const f = fixture(undefined, { wallNow: () => wall });
  f.hooks.onReject({}, 'slept'); wall = 600_000;
  f.tick(1999); expect(f.observer.getStatus().counters).toMatchObject({ pending: 1, expired: 0 });
  f.tick(15_000);
  expect(f.delivered).toEqual([]);
  expect(f.observer.getStatus().counters).toMatchObject({ pending: 0, expired: 1, accepted: 0 });
});
it('ignores a wall clock that moves backwards', () => {
  let wall = 0;
  const f = fixture(undefined, { wallNow: () => wall });
  f.hooks.onReject({}, 'adjusted'); wall = -1_000_000; f.tick(2000);
  expect(f.delivered).toHaveLength(1);
  expect(f.observer.getStatus()).toMatchObject({ status: 'observing', counters: { accepted: 1, expired: 0 } });
});
it('fails closed on an elapsed-clock rollback', () => {
  const f = fixture(); f.hooks.onReject({}, 'old'); f.tick(-1);
  expect(f.delivered).toEqual([]);
  expect(f.observer.getStatus()).toMatchObject({ status: 'install-failed', reason: 'runtime', counters: {pending: 0} });
});
it('clears state when scheduling fails', () => {
  const f = fixture(undefined, { setTimer() { throw new Error('scheduler unavailable'); } });
  f.hooks.onReject({}, 'unscheduled');
  expect(f.observer.getStatus()).toMatchObject({ status: 'install-failed', counters: {pending: 0, captureFailed: 1} });
  expect(f.delivered).toEqual([]);
});
it('contains a synchronous reentrant timer without early delivery', () => {
  const f = fixture(undefined, { setTimer(fn) { fn(); return 1; } });
  f.hooks.onReject({}, 'early');
  expect(f.delivered).toEqual([]);
  expect(f.observer.getStatus()).toMatchObject({ status: 'install-failed', counters: {pending: 0} });
});
it('detects displacement on status read and releases pending snapshots', () => {
  const f = fixture(); f.hooks.onReject({}, 'owned'); f.displace();
  expect(f.observer.getStatus()).toMatchObject({ status: 'displaced', reason: 'hook-displaced', counters: {pending: 0} });
  f.tick(2000); expect(f.delivered).toEqual([]); expect(f.timers.size).toBe(0);
});
it('disposal makes retained callbacks inert and status contains no captured content', () => {
  const f = fixture(); f.hooks.onReject({}, 'secret');
  const status = f.observer.getStatus(); status.counters.pending = 99;
  expect(f.observer.getStatus().counters.pending).toBe(1);
  expect(JSON.stringify(status)).not.toContain('secret');
  f.observer.dispose(); f.hooks.onReject({}, 'later'); f.tick(2000);
  expect(f.delivered).toEqual([]);
  expect(f.observer.getStatus()).toMatchObject({ status: 'not-mounted', counters: {pending: 0, accepted: 0} });
});
