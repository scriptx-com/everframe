// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import { describe, it, expect, vi } from 'vitest';
import { createThreadClient, POLL_FLOOR_MS } from '../src/reporter/thread-client.js';
import { ReporterApiError } from '../src/reporter/api.js';
import type { ReporterApi, ThreadSummary } from '../src/reporter/api.js';
import type { ThreadClientState } from '../src/reporter/thread-client.js';

const TOKEN = 'evr_' + 'a'.repeat(43);
const OPEN: ThreadSummary = { id: 't1', status: 'open', reportTitle: 'Crash', createdAt: '2026-08-01T00:00:00.000Z', lastMessageAt: null, unreadCount: 3 };

function memoryStore(initial: string | null = TOKEN) {
  let value = initial;
  return {
    randomBytes: (n: number) => new Uint8Array(n).fill(1),
    load: async () => value,
    save: async (t: string) => { value = t; },
    clear: async () => { value = null; },
    _get: () => value,
  };
}

/** Manual scheduler: collects callbacks; test fires them explicitly. */
function manualScheduler() {
  const queue: Array<{ fn: () => void; ms: number }> = [];
  return {
    schedule: (fn: () => void, ms: number) => { queue.push({ fn, ms }); return queue.length; },
    cancel: () => {},
    fireNext: () => { const j = queue.shift(); j?.fn(); return j?.ms; },
    queued: () => queue.length,
    lastDelay: () => queue[queue.length - 1]?.ms,
  };
}

function apiReturning(threads: ThreadSummary[]): ReporterApi {
  return {
    listThreads: vi.fn(async () => ({ kind: 'ok' as const, threads, etag: '"e1"' })),
    listMessages: vi.fn(), postMessage: vi.fn(), markRead: vi.fn(), deleteThread: vi.fn(),
  } as unknown as ReporterApi;
}

function clientWith(api: ReporterApi, over: Record<string, unknown> = {}) {
  const sched = manualScheduler();
  let nowMs = 0;
  const client = createThreadClient({
    api, credentials: memoryStore(), isEnabled: () => true,
    now: () => nowMs, schedule: sched.schedule, cancel: sched.cancel, ...over,
  });
  return { client, sched, setNow: (v: number) => { nowMs = v; } };
}

describe('createThreadClient polling', () => {
  it('startPolling polls immediately, stores threads, computes unreadCount, notifies', async () => {
    const api = apiReturning([OPEN, { ...OPEN, id: 't2', unreadCount: 1 }]);
    const { client, sched } = clientWith(api);
    const seen: number[] = [];
    client.subscribe((s) => seen.push(s.unreadCount));
    client.startPolling();
    sched.fireNext();                       // the immediate (0ms) tick
    await vi.waitFor(() => expect(client.list()).toHaveLength(2));
    expect(client.unreadCount()).toBe(4);
    expect(seen.at(-1)).toBe(4);
    expect(sched.lastDelay()).toBe(POLL_FLOOR_MS);   // next tick armed at the floor
  });

  it('enforces the 60s floor on pollIntervalMs', () => {
    const { client, sched } = clientWith(apiReturning([OPEN]), { pollIntervalMs: 5_000 });
    client.startPolling();
    sched.fireNext();
    return vi.waitFor(() => expect(sched.lastDelay()).toBe(POLL_FLOOR_MS));
  });

  it('sends the cached etag and keeps state on 304', async () => {
    const listThreads = vi.fn()
      .mockResolvedValueOnce({ kind: 'ok', threads: [OPEN], etag: '"e1"' })
      .mockResolvedValueOnce({ kind: 'not-modified' });
    const api = { ...apiReturning([]), listThreads } as unknown as ReporterApi;
    const { client, sched } = clientWith(api);
    client.startPolling();
    sched.fireNext();
    await vi.waitFor(() => expect(client.list()).toHaveLength(1));
    sched.fireNext();                       // second tick → 304
    await vi.waitFor(() => expect(listThreads).toHaveBeenCalledTimes(2));
    expect(listThreads.mock.calls[1]).toEqual([TOKEN, '"e1"']);
    expect(client.list()).toHaveLength(1);  // unchanged
  });

  it('idles to zero: stops scheduling when a poll returns no open threads; wake() re-arms', async () => {
    const closed = { ...OPEN, status: 'closed' as const, unreadCount: 0 };
    const { client, sched } = clientWith(apiReturning([closed]));
    client.startPolling();
    sched.fireNext();
    await vi.waitFor(() => expect(client.list()).toHaveLength(1));
    expect(sched.queued()).toBe(0);         // nothing re-armed
    client.wake();
    expect(sched.queued()).toBe(1);
  });

  it('never polls when replies are not enabled or no token exists', async () => {
    const api = apiReturning([OPEN]);
    const off = clientWith(api, { isEnabled: () => false });
    off.client.startPolling();
    off.sched.fireNext();
    await Promise.resolve();
    expect(api.listThreads).not.toHaveBeenCalled();

    const api2 = apiReturning([OPEN]);
    const tokenless = clientWith(api2, { credentials: memoryStore(null) });
    tokenless.client.startPolling();
    tokenless.sched.fireNext();
    await vi.waitFor(() => expect(tokenless.sched.queued()).toBe(0));
    expect(api2.listThreads).not.toHaveBeenCalled();
  });

  it('401 invalid_device_token clears the stored token and resets state silently', async () => {
    const store = memoryStore();
    const listThreads = vi.fn(async () => { throw new ReporterApiError('invalid_device_token', 401); });
    const api = { ...apiReturning([]), listThreads } as unknown as ReporterApi;
    const { client, sched } = clientWith(api, { credentials: store });
    client.startPolling();
    sched.fireNext();
    await vi.waitFor(() => expect(store._get()).toBeNull());
    expect(client.getState().threads).toEqual([]);
    expect(sched.queued()).toBe(0);         // polling stopped
  });

  it('401 replies_disabled stops polling and marks state read-only with threads closed', async () => {
    const listThreads = vi.fn()
      .mockResolvedValueOnce({ kind: 'ok', threads: [OPEN], etag: null })
      .mockRejectedValueOnce(new ReporterApiError('replies_disabled', 401));
    const api = { ...apiReturning([]), listThreads } as unknown as ReporterApi;
    const { client, sched } = clientWith(api);
    client.startPolling();
    sched.fireNext();
    await vi.waitFor(() => expect(client.list()).toHaveLength(1));
    sched.fireNext();
    await vi.waitFor(() => expect(client.getState().readOnly).toBe(true));
    expect(client.list()[0]?.status).toBe('closed');
    expect(sched.queued()).toBe(0);
  });

  // Finding 7: the replies_disabled latch (readOnly=true) must not be
  // permanent for the client's lifetime — otherwise an admin re-enabling
  // replies can never be noticed again, because pollOnce() short-circuits
  // on readOnly forever. wake() must clear the latch and re-arm polling.
  it('wake() clears the replies_disabled latch and re-arms polling; a healthy server refreshes with readOnly false', async () => {
    const listThreads = vi.fn()
      .mockResolvedValueOnce({ kind: 'ok', threads: [OPEN], etag: null })
      .mockRejectedValueOnce(new ReporterApiError('replies_disabled', 401))
      .mockResolvedValueOnce({ kind: 'ok', threads: [OPEN], etag: null });
    const api = { ...apiReturning([]), listThreads } as unknown as ReporterApi;
    const { client, sched } = clientWith(api);
    client.startPolling();
    sched.fireNext();
    await vi.waitFor(() => expect(client.list()).toHaveLength(1));
    sched.fireNext();
    await vi.waitFor(() => expect(client.getState().readOnly).toBe(true));
    expect(client.list()[0]?.status).toBe('closed');
    expect(sched.queued()).toBe(0);          // polling stopped, latched

    client.wake();
    expect(client.getState().readOnly).toBe(false);   // latch cleared optimistically
    expect(sched.queued()).toBe(1);                    // re-armed

    sched.fireNext();
    await vi.waitFor(() => expect(listThreads).toHaveBeenCalledTimes(3));
    expect(client.getState().readOnly).toBe(false);
    expect(client.list()[0]?.status).toBe('open');     // the next successful list is authoritative
  });

  it('wake() re-arms after the latch, but a still-disabled server re-latches on the next 401', async () => {
    const listThreads = vi.fn()
      .mockResolvedValueOnce({ kind: 'ok', threads: [OPEN], etag: null })
      .mockRejectedValueOnce(new ReporterApiError('replies_disabled', 401))
      .mockRejectedValueOnce(new ReporterApiError('replies_disabled', 401));
    const api = { ...apiReturning([]), listThreads } as unknown as ReporterApi;
    const { client, sched } = clientWith(api);
    client.startPolling();
    sched.fireNext();
    await vi.waitFor(() => expect(client.list()).toHaveLength(1));
    sched.fireNext();
    await vi.waitFor(() => expect(client.getState().readOnly).toBe(true));

    client.wake();
    expect(client.getState().readOnly).toBe(false);
    expect(sched.queued()).toBe(1);

    sched.fireNext();
    await vi.waitFor(() => expect(client.getState().readOnly).toBe(true));   // re-latched
    expect(sched.queued()).toBe(0);          // stopped again
  });

  // Regression: the latch's cached ETag hashes the server's list JSON, which
  // disabling/re-enabling replies does not change server-side. If it were
  // kept across the latch, the first post-recovery poll would send it back
  // as a stale If-None-Match, get a 304, and the 'ok' branch (which is the
  // only place locally-forced-closed statuses get corrected) would never
  // run — anyOpen stays false and the poller idles again, leaving the inbox
  // showing everything Closed indefinitely. handleAuthFailure must drop the
  // cached etag the moment the latch engages, since that's the moment the
  // local view (all threads forced closed) diverges from the server's.
  it('drops the cached ETag when the replies_disabled latch engages, so the post-wake() poll is a full 200 not a stale 304', async () => {
    const listThreads = vi.fn()
      .mockResolvedValueOnce({ kind: 'ok', threads: [OPEN], etag: '"real-etag"' })
      .mockRejectedValueOnce(new ReporterApiError('replies_disabled', 401))
      .mockResolvedValueOnce({ kind: 'ok', threads: [OPEN], etag: '"real-etag"' });
    const api = { ...apiReturning([]), listThreads } as unknown as ReporterApi;
    const { client, sched } = clientWith(api);
    client.startPolling();
    sched.fireNext();
    await vi.waitFor(() => expect(client.list()).toHaveLength(1));
    sched.fireNext();
    await vi.waitFor(() => expect(client.getState().readOnly).toBe(true));
    expect(client.list()[0]?.status).toBe('closed');

    client.wake();
    sched.fireNext();
    await vi.waitFor(() => expect(listThreads).toHaveBeenCalledTimes(3));
    // The post-recovery poll must NOT echo the stale (pre-latch) etag back
    // as If-None-Match — it must ask for a full list.
    expect(listThreads.mock.calls[2]).toEqual([TOKEN, null]);
    expect(client.getState().readOnly).toBe(false);
    expect(client.list()[0]?.status).toBe('open');   // the 200 corrected the forced-closed status
    expect(sched.queued()).toBe(1);                  // still armed, not idled
  });

  it('429 delays the next tick by retryAfter instead of the base interval', async () => {
    const listThreads = vi.fn(async () => { throw new ReporterApiError('rate_limit_exceeded', 429, 90); });
    const api = { ...apiReturning([]), listThreads } as unknown as ReporterApi;
    const { client, sched } = clientWith(api);
    client.startPolling();
    sched.fireNext();
    await vi.waitFor(() => expect(sched.lastDelay()).toBe(90_000));
  });

  it('network errors keep cadence and keep cached state (fail-closed)', async () => {
    const listThreads = vi.fn()
      .mockResolvedValueOnce({ kind: 'ok', threads: [OPEN], etag: null })
      .mockRejectedValueOnce(new ReporterApiError('network_error', null));
    const api = { ...apiReturning([]), listThreads } as unknown as ReporterApi;
    const { client, sched } = clientWith(api);
    client.startPolling();
    sched.fireNext();
    await vi.waitFor(() => expect(client.list()).toHaveLength(1));
    sched.fireNext();
    await vi.waitFor(() => expect(listThreads).toHaveBeenCalledTimes(2));
    expect(client.list()).toHaveLength(1);
    expect(sched.queued()).toBe(1);         // still armed
  });

  it('refresh() polls immediately even between ticks', async () => {
    const api = apiReturning([OPEN]);
    const { client } = clientWith(api);
    await client.refresh();
    expect(api.listThreads).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops notifications', async () => {
    const api = apiReturning([OPEN]);
    const { client } = clientWith(api);
    const cb = vi.fn();
    const un = client.subscribe(cb);
    un();
    await client.refresh();
    expect(cb).not.toHaveBeenCalled();
  });

  it('regression: a scheduled tick firing while refresh() is in flight does not orphan the poll loop', async () => {
    let resolveSecond: ((v: { kind: 'ok'; threads: ThreadSummary[]; etag: string | null }) => void) | undefined;
    const listThreads = vi.fn()
      .mockResolvedValueOnce({ kind: 'ok', threads: [OPEN], etag: null })       // startPolling's immediate tick
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; })) // refresh(), held open
      .mockResolvedValue({ kind: 'ok', threads: [OPEN], etag: null });          // any tick after recovery
    const api = { ...apiReturning([]), listThreads } as unknown as ReporterApi;
    const { client, sched } = clientWith(api);

    client.startPolling();
    sched.fireNext();                                     // establishes state, arms the next tick
    await vi.waitFor(() => expect(client.list()).toHaveLength(1));
    expect(sched.queued()).toBe(1);                        // next scheduled tick is armed

    const refreshPromise = client.refresh();               // second listThreads call hangs, in flight
    await vi.waitFor(() => expect(listThreads).toHaveBeenCalledTimes(2));

    sched.fireNext();                                       // the already-armed tick fires WHILE refresh() is in flight
    expect(sched.queued()).toBe(0);                         // its slot is consumed, not (yet) re-armed
    expect(listThreads).toHaveBeenCalledTimes(2);            // the racing tick must not run a concurrent poll

    resolveSecond?.({ kind: 'ok', threads: [OPEN], etag: null });
    await refreshPromise;

    await vi.waitFor(() => expect(sched.queued()).toBe(1)); // loop re-armed once the in-flight poll settles

    sched.fireNext();                                        // a subsequent tick still polls normally
    await vi.waitFor(() => expect(listThreads).toHaveBeenCalledTimes(3));
  });
});

// Finding 1 (round 5, PR review): the config-gate cache (isEnabled()) is
// warmed once at mount and then TTL-cached for up to 5 minutes. A deliberate
// wake() signal (a submit that provisions a thread, tab foreground) is the
// only place that gate can ever get a chance to re-resolve mid-session —
// without this, replies that turn on server-side after mount (or a
// mount-time config fetch that transiently failed) can never be noticed
// until a full reload. wake() must await an injected refreshGate() BEFORE
// deciding whether to arm, and must stay safe even when that gate rejects.
describe('createThreadClient wake() refreshGate (finding 1, round 5)', () => {
  it('wake() invokes refreshGate and awaits it before arming polling', async () => {
    let resolveGate: (() => void) | undefined;
    const gate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveGate = resolve;
        }),
    );
    const { client, sched } = clientWith(apiReturning([OPEN]), { refreshGate: gate });

    client.wake();
    expect(gate).toHaveBeenCalledTimes(1);
    // Arming is deferred until the gate settles — not synchronous like the
    // no-refreshGate path.
    expect(sched.queued()).toBe(0);

    resolveGate?.();
    await vi.waitFor(() => expect(sched.queued()).toBe(1));
  });

  it('a rejecting refreshGate still leaves wake() safe: polling still arms (fail-closed)', async () => {
    const gate = vi.fn(async () => {
      throw new Error('boom');
    });
    const { client, sched } = clientWith(apiReturning([OPEN]), { refreshGate: gate });

    expect(() => client.wake()).not.toThrow();
    await vi.waitFor(() => expect(gate).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(sched.queued()).toBe(1));
  });

  it('does NOT invoke refreshGate on the ordinary poll tick — only wake() does', async () => {
    const gate = vi.fn(async () => {});
    const { client, sched } = clientWith(apiReturning([OPEN]), { refreshGate: gate });
    client.startPolling();
    sched.fireNext();
    await vi.waitFor(() => expect(client.list()).toHaveLength(1));
    expect(gate).not.toHaveBeenCalled();
  });

  it('does not call refreshGate at all after shutdown()', async () => {
    const gate = vi.fn(async () => {});
    const { client } = clientWith(apiReturning([OPEN]), { refreshGate: gate });
    client.shutdown();
    client.wake();
    await Promise.resolve();
    expect(gate).not.toHaveBeenCalled();
  });

  it('shutdown() firing while a wake()-triggered gate refresh is in flight leaves polling un-armed', async () => {
    let resolveGate: (() => void) | undefined;
    const gate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveGate = resolve;
        }),
    );
    const { client, sched } = clientWith(apiReturning([OPEN]), { refreshGate: gate });

    client.wake();
    expect(gate).toHaveBeenCalledTimes(1);
    client.shutdown();
    resolveGate?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(sched.queued()).toBe(0);
  });
});

// Round-5 re-review, finding 1 follow-up (Important defect): wake()'s async
// refreshGate continuation used to re-check ONLY shutdownFlag, not whether
// polling had been paused meanwhile. Sequence: tab visible → wake() starts
// the gate fetch (in flight) → tab goes hidden → the Provider's
// visibilitychange handler calls stopPolling() (active=false) → the gate
// settles → the continuation saw !active and called startPolling(),
// arming polling IN A HIDDEN TAB, which then polled at the normal cadence
// until the next visibility transition — violating the foreground-only
// contract the mount-path visibility gate otherwise enforces. Pre-fix,
// wake() was synchronous so this interleave was impossible.
describe('createThreadClient wake() vs. a pause mid-flight (round-5 re-review, finding 1 follow-up)', () => {
  it('a stopPolling() that fires WHILE the gate is in flight leaves nothing armed once the gate settles — no listThreads call follows', async () => {
    let resolveGate: (() => void) | undefined;
    const gate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveGate = resolve;
        }),
    );
    const api = apiReturning([OPEN]);
    const { client, sched } = clientWith(api, { refreshGate: gate });

    client.wake();
    expect(gate).toHaveBeenCalledTimes(1);
    expect(sched.queued()).toBe(0); // gate still in flight, nothing armed yet

    client.stopPolling(); // tab goes hidden mid-flight
    resolveGate?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(sched.queued()).toBe(0); // the settling gate must NOT arm polling in a hidden tab
    expect(api.listThreads).not.toHaveBeenCalled();
  });

  it('a normal wake with no pause in between still arms and polls once the gate settles', async () => {
    let resolveGate: (() => void) | undefined;
    const gate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveGate = resolve;
        }),
    );
    const api = apiReturning([OPEN]);
    const { client, sched } = clientWith(api, { refreshGate: gate });

    client.wake();
    resolveGate?.();
    await vi.waitFor(() => expect(sched.queued()).toBe(1));
    sched.fireNext();
    await vi.waitFor(() => expect(api.listThreads).toHaveBeenCalledTimes(1));
  });

  it('a LATER genuine wake() after a stopPolling() still arms normally — the epoch does not permanently poison future wakes', async () => {
    let resolveFirstGate: (() => void) | undefined;
    const gate = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirstGate = resolve;
          }),
      )
      .mockImplementation(async () => {});
    const api = apiReturning([OPEN]);
    const { client, sched } = clientWith(api, { refreshGate: gate });

    client.wake(); // first wake — gate in flight
    client.stopPolling(); // paused mid-flight (tab hidden)
    resolveFirstGate?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(sched.queued()).toBe(0); // aborted, per the regression above

    client.wake(); // a LATER, genuine wake (e.g. tab foregrounded again)
    await vi.waitFor(() => expect(sched.queued()).toBe(1)); // arms normally this time
  });
});

// Finding 1 (round 8, PR review): pollOnce() used to return immediately
// once isEnabled() became false, before any reporter request could ever
// produce a replies_disabled 401 — so an admin disabling replies mid-session
// (the config gate flipping ON->OFF, e.g. via wake()'s refreshGate) idled
// the poller silently: cached rows stayed 'open', readOnly stayed false, and
// subscribers were never notified. The fix reconciles a genuine ON->OFF
// transition into the SAME latch handleAuthFailure(replies_disabled)
// produces, but only when the client previously observed the gate enabled
// (wasEnabled) — a client that starts disabled (or whose config is still
// unresolved) must not spuriously latch.
describe('createThreadClient gate ON->OFF transition (finding 1, round 8)', () => {
  it('reconciles an ON->OFF config gate flip into the replies_disabled latch: closes cached threads, notifies exactly once, stops polling, without a network request', async () => {
    const gate = { on: true };
    const api = apiReturning([OPEN]);
    const { client, sched } = clientWith(api, { isEnabled: () => gate.on });
    client.startPolling();
    sched.fireNext();
    await vi.waitFor(() => expect(client.list()).toHaveLength(1));
    expect(client.getState().readOnly).toBe(false);
    expect(sched.queued()).toBe(1); // anyOpen -> still armed

    gate.on = false; // admin disables replies mid-session; the shared gate flips
    let notifyCount = 0;
    client.subscribe(() => { notifyCount++; });
    sched.fireNext(); // the next poll tick observes the OFF gate
    await vi.waitFor(() => expect(client.getState().readOnly).toBe(true));
    expect(client.list()[0]?.status).toBe('closed');
    expect(notifyCount).toBe(1);
    expect(sched.queued()).toBe(0); // polling stopped
    // The latch engages BEFORE any reporter request — no doomed network call.
    expect(api.listThreads).toHaveBeenCalledTimes(1);
  });

  it('a client that was never enabled polls and idles without latching or notifying', async () => {
    const api = apiReturning([OPEN]);
    const { client, sched } = clientWith(api, { isEnabled: () => false });
    const cb = vi.fn();
    client.subscribe(cb);
    client.startPolling();
    sched.fireNext();
    await Promise.resolve();
    expect(client.getState().readOnly).toBe(false);
    expect(cb).not.toHaveBeenCalled();
    expect(sched.queued()).toBe(0);
    expect(api.listThreads).not.toHaveBeenCalled();
  });

  it('OFF->ON recovery via wake() still lists threads after a gate-transition latch', async () => {
    const gate = { on: true };
    const api = apiReturning([OPEN]);
    const { client, sched } = clientWith(api, { isEnabled: () => gate.on });
    client.startPolling();
    sched.fireNext();
    await vi.waitFor(() => expect(client.list()).toHaveLength(1));

    gate.on = false;
    sched.fireNext();
    await vi.waitFor(() => expect(client.getState().readOnly).toBe(true));
    expect(sched.queued()).toBe(0);

    gate.on = true; // admin re-enables replies
    client.wake(); // clears readOnly, re-arms (no refreshGate dep -> synchronous)
    expect(client.getState().readOnly).toBe(false);
    expect(sched.queued()).toBe(1);

    sched.fireNext();
    await vi.waitFor(() => expect(client.list()[0]?.status).toBe('open'));
    expect(client.getState().readOnly).toBe(false);
  });

  it('re-latches cleanly after a failed OFF->ON recovery attempt, notifying exactly once (not in a loop)', async () => {
    const gate = { on: true };
    const api = apiReturning([OPEN]);
    const { client, sched } = clientWith(api, { isEnabled: () => gate.on });
    client.startPolling();
    sched.fireNext();
    await vi.waitFor(() => expect(client.list()).toHaveLength(1));

    gate.on = false;
    sched.fireNext();
    await vi.waitFor(() => expect(client.getState().readOnly).toBe(true));

    // Recovery attempt: wake() clears readOnly and re-arms, but the gate is
    // still off server-side.
    client.wake();
    expect(client.getState().readOnly).toBe(false);
    expect(sched.queued()).toBe(1);

    let notifyCount = 0;
    client.subscribe(() => { notifyCount++; });
    sched.fireNext(); // still off -> re-latches
    await vi.waitFor(() => expect(client.getState().readOnly).toBe(true));
    expect(notifyCount).toBe(1); // exactly one notify for the re-latch, not repeated
    expect(sched.queued()).toBe(0);
  });
});

// Finding 6: kill() must be irreversible. stopPolling() alone only flips
// `active` off — deliberately reversible, since wake()/startPolling() are
// meant to re-arm it after a normal pause (tab hidden, etc). shutdown() is
// the terminal counterpart: nothing (no caller, no internal path) can
// resurrect this client afterward, regardless of whether it's reached
// through the tx.threads.* facade or directly on the adapter.
describe('createThreadClient shutdown (finding 6)', () => {
  it('is terminal: wake()/startPolling()/refresh() are all no-ops afterward — no listThreads calls, nothing armed', async () => {
    const api = apiReturning([OPEN]);
    const { client, sched } = clientWith(api);

    client.shutdown();
    client.wake();
    client.startPolling();
    await client.refresh();

    expect(api.listThreads).not.toHaveBeenCalled();
    expect(sched.queued()).toBe(0);
    expect(client.getState()).toEqual({
      enabled: false, readOnly: false, threads: [], unreadCount: 0, pending: [], cooldownUntilMs: null,
    });
  });

  it('idempotent: a second shutdown() call is a harmless no-op', async () => {
    const api = apiReturning([OPEN]);
    const { client } = clientWith(api);
    client.shutdown();
    expect(() => client.shutdown()).not.toThrow();
    expect(client.getState().enabled).toBe(false);
  });

  it('notifies subscribers once with a final empty snapshot, then clears them — no later notify reaches them', async () => {
    const api = apiReturning([OPEN]);
    const { client, sched } = clientWith(api);
    client.startPolling();
    sched.fireNext();
    await vi.waitFor(() => expect(client.list()).toHaveLength(1));

    const seen: ThreadClientState[] = [];
    client.subscribe((s) => seen.push(s));
    client.shutdown();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      enabled: false, readOnly: false, threads: [], unreadCount: 0, pending: [], cooldownUntilMs: null,
    });

    // Every path that used to trigger notify() is now a guarded no-op post
    // shutdown — the already-cleared subscriber set must never see another
    // callback fire.
    client.wake();
    client.startPolling();
    await client.refresh();
    await client.reply('t1', 'hi');
    await client.markRead('t1');
    expect(seen).toHaveLength(1);
  });
});
