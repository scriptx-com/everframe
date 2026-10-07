// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { utf8ByteLength } from '@everframe/protocol';
import { installHermesRejectionAdapter, type AdapterOptions, type AdapterResult } from './hermes-rejection-adapter.js';
import { emptyPromiseRejectionStatus, type PromiseRejectionCounters, type PromiseRejectionStatus,
  type RejectionReason } from './promise-rejection-types.js';
import type { PreparedRejection, RejectionOutcome } from './rejection-capture.js';

export interface RejectionScheduler {
  now(): number;
  /** Wall-clock time. The elapsed clock can exclude time an Android device sleeps. */
  wallNow?(): number;
  occurredAt(): string;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
  /** Called inside Promise hooks, so it must never schedule through Promise. */
  queueMicrotask?(callback: () => void): void;
}
interface ObserverOptions {
  prepareRejection(reason: unknown, occurredAt: string): PreparedRejection | undefined;
  submitRejection(snapshot: PreparedRejection): RejectionOutcome;
  isActive(): boolean;
  scheduler?: RejectionScheduler;
  installAdapter?: (options: AdapterOptions) => AdapterResult;
}
export interface RejectionObserver {
  getStatus(): PromiseRejectionStatus;
  dispose(): void;
}
interface Pending {
  start: number;
  wall: number;
  done: boolean;
  snapshot: PreparedRejection | undefined;
}
type Counter = Exclude<keyof PromiseRejectionCounters, 'pending'>;
/** A drop counted on arrival; a handler within the grace period withdraws it. */
interface Dropped { start: number; done: boolean; counter: Counter }
interface Timer { handle: unknown; assigned: boolean }

function nativeMicrotask(): ((callback: () => void) => void) | undefined {
  try {
    // Bridgeless React Native installs the native microtask queue. The legacy
    // polyfill schedules through Promise and would re-enter the observed hooks.
    if ((globalThis as { RN$Bridgeless?: unknown }).RN$Bridgeless !== true) return undefined;
    const queue = globalThis.queueMicrotask;
    return typeof queue === 'function' ? (callback) => queue(callback) : undefined;
  } catch { return undefined; }
}

function defaultScheduler(): RejectionScheduler {
  const performance = globalThis.performance;
  if (typeof performance?.now !== 'function') throw new Error('No elapsed clock');
  const now = performance.now.bind(performance);
  const queueMicrotask = nativeMicrotask();
  return {
    now, wallNow: () => Date.now(), occurredAt: () => new Date().toISOString(),
    setTimer: (fn, delay) => setTimeout(fn, delay),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    ...(queueMicrotask ? { queueMicrotask } : {}),
  };
}

/** Pending records own strings and detached identity only, never host objects. */
export function createPromiseRejectionObserver(options: ObserverOptions): RejectionObserver {
  let state = emptyPromiseRejectionStatus('install-failed', 'runtime');
  let active = true;
  let scheduler: RejectionScheduler;
  let adapter: Extract<AdapterResult, { status: 'observing' }> | undefined;
  const pending = new Set<Pending>();
  let identities = new WeakMap<object, Pending | Dropped>();
  let timer: Timer | undefined;
  let scheduling = false;
  let deferred: object | undefined;
  let deferring = false;
  let lastTime = -Infinity;
  const count = (key: Counter, amount = 1) => {
    state.counters[key] = Math.min(2_147_483_647, state.counters[key] + amount);
  };
  function clearTimer(): void {
    const previous = timer;
    timer = undefined;
    if (previous?.assigned) {
      try { scheduler.clearTimer(previous.handle); } catch { /* already inert */ }
    }
  }
  function remove(record: Pending): void {
    pending.delete(record);
    record.done = true;
    record.snapshot = undefined;
    if (pending.size === 0) clearTimer();
  }
  function stop(status: PromiseRejectionStatus['status'], reason: RejectionReason): void {
    state.status = status; state.reason = reason;
    for (const record of pending) { record.done = true; record.snapshot = undefined; }
    pending.clear(); identities = new WeakMap(); clearTimer();
    try { adapter?.dispose(); } catch { /* observer ownership is already revoked */ }
  }
  function owns(): boolean {
    if (!active || state.status !== 'observing') return false;
    try {
      if (options.isActive() && adapter?.ownsHooks()) return true;
    } catch { /* Treat failed ownership lookup as displacement. */ }
    stop('displaced', 'hook-displaced');
    return false;
  }
  function now(): number {
    const value = scheduler.now();
    if (!Number.isFinite(value) || value < lastTime) throw new Error('Invalid elapsed clock');
    lastTime = value;
    return value;
  }
  function wallNow(): number {
    try { return scheduler.wallNow?.() ?? NaN; } catch { return NaN; }
  }
  function fail(reason: RejectionReason): void {
    count('captureFailed', pending.size);
    stop('install-failed', reason);
  }
  function schedule(): void {
    if (timer || !owns()) return;
    const eligible = [...pending].filter((record) => record.snapshot !== undefined);
    if (eligible.length === 0) return;
    let time: number;
    try { time = now(); } catch { fail('runtime'); return; }
    const due = Math.min(...eligible.map((record) => record.start + 2000));
    const ticket: Timer = { handle: undefined, assigned: false };
    timer = ticket;
    scheduling = true;
    try {
      ticket.handle = scheduler.setTimer(() => {
        if (timer !== ticket) return;
        if (scheduling) { fail('hook-install'); return; }
        timer = undefined;
        flush();
      }, Math.max(0, due - time));
      ticket.assigned = true;
      if (timer !== ticket) scheduler.clearTimer(ticket.handle);
    } catch { fail('hook-install'); }
    finally { scheduling = false; }
  }
  /**
   * Android pauses JS timers while its activity is paused, but JS can keep
   * running. Promise traffic then notifies overdue records from a microtask,
   * never synchronously inside the hook.
   */
  function flushOverdue(): void {
    if (deferred || pending.size === 0 || !scheduler.queueMicrotask) return;
    let time: number;
    try { time = now(); } catch { fail('runtime'); return; }
    if (![...pending].some((record) => record.snapshot && time - record.start >= 2000)) return;
    const ticket = {};
    deferred = ticket; deferring = true;
    try {
      scheduler.queueMicrotask(() => {
        if (deferred !== ticket) return;
        deferred = undefined;
        if (!deferring) flush();
      });
    } catch { deferred = undefined; }
    finally { deferring = false; }
  }
  function flush(): void {
    if (!owns()) return;
    let time: number;
    try { time = now(); } catch { fail('runtime'); return; }
    const wall = wallNow();
    for (const record of [...pending]) {
      if (!owns()) break;
      if (record.done || !record.snapshot || time - record.start < 2000) continue;
      const snapshot = record.snapshot;
      remove(record);
      // Wall time also bounds age: the elapsed clock can exclude device sleep.
      const wallAge = wall - record.wall;
      if (time - record.start > 30000 || (Number.isFinite(wallAge) && wallAge > 30000)) { count('expired'); continue; }
      try {
        switch (options.submitRejection(snapshot)) {
          case 'accepted': count('accepted'); break;
          case 'duplicate': count('duplicateSuppressed'); break;
          case 'allowance': count('allowanceSuppressed'); break;
          case 'native-refused': count('nativeRefused'); break;
          case 'capture-failed': count('captureFailed'); break;
          case 'inactive': break;
        }
      } catch { count('captureFailed'); }
    }
    schedule();
  }
  function onReject(promise: object, reason: unknown): void {
    track(promise, reason);
    flushOverdue();
  }
  function track(promise: object, reason: unknown): void {
    if (!owns() || identities.has(promise)) return;
    if (pending.size >= 16) {
      count('capacityDropped');
      try { identities.set(promise, { start: now(), done: false, counter: 'capacityDropped' }); }
      catch { fail('runtime'); }
      return;
    }
    const record: Pending = { start: 0, wall: NaN, done: false, snapshot: undefined };
    identities.set(promise, record); pending.add(record);
    try {
      record.start = now();
    } catch { fail('runtime'); return; }
    record.wall = wallNow();
    let counter: Counter = 'captureFailed';
    try {
      const snapshot = options.prepareRejection(reason, scheduler.occurredAt());
      if (record.done || !owns()) return;
      if (snapshot && utf8ByteLength(snapshot.payload) <= 65536) {
        record.snapshot = snapshot;
        schedule();
        return;
      }
      if (snapshot) counter = 'sizeDropped';
    } catch { /* Counted as a failed capture below. */ }
    if (record.done) return;
    remove(record); count(counter);
    identities.set(promise, { start: record.start, done: false, counter });
  }
  function onHandle(promise: object): void {
    if (!owns()) return;
    const entry = identities.get(promise);
    if (entry && !entry.done) {
      if ('counter' in entry) withdraw(entry);
      else { remove(entry); count('cancelled'); }
    }
    flushOverdue();
  }
  /** Handled within the grace period, a dropped rejection would never have been reported. */
  function withdraw(entry: Dropped): void {
    entry.done = true;
    let time: number;
    try { time = now(); } catch { fail('runtime'); return; }
    if (time - entry.start >= 2000) return;
    if (state.counters[entry.counter] < 2_147_483_647) state.counters[entry.counter]--;
    count('cancelled');
  }
  try {
    scheduler = options.scheduler ?? defaultScheduler();
    now();
    const result = (options.installAdapter ?? installHermesRejectionAdapter)({
      onReject, onHandle, onDisplaced: () => stop('displaced', 'hook-displaced'),
      isActive: () => active && options.isActive(),
    });
    if (result.status === 'observing') {
      adapter = result;
      state = { ...state, status: 'observing', reason: 'none', adapterId: result.adapterId,
        previousCallbacksPresent: result.previousCallbacksPresent };
      owns();
    } else { state.status = result.status; state.reason = result.reason; }
  } catch { stop('install-failed', 'runtime'); }
  return {
    getStatus() {
      if (!active) return emptyPromiseRejectionStatus('not-mounted', 'no-mount');
      owns();
      return { ...state, counters: { ...state.counters, pending: pending.size } };
    },
    dispose() {
      if (!active) return;
      active = false;
      stop('not-mounted', 'no-mount');
    },
  };
}
