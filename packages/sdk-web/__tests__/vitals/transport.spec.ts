// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVitalsTransport } from '../../src/vitals/transport.js';
import type { SessionSummary, VitalsChunk } from '@everframe/protocol';
import {
  IDENTITY_TOKEN_HEADER,
  IDENTITY_TOKEN_MAX_CHARS,
  createVitalsCollector,
} from '@everframe/sdk-core';

const ENDPOINT = 'https://ingest.example.com/api/ingest/vitals';
const API_KEY = 'pk_test_123';

const CHUNK: VitalsChunk = {
  kind: 'chunk',
  sessionId: '11111111-1111-1111-1111-111111111111',
  seq: 0,
  entries: [{ kind: 'sample', t: 1_000, mem: 2048, extras: { longTaskMs: 0, loopLagMs: 0 } }],
};

const SUMMARY: SessionSummary = {
  kind: 'summary',
  sessionId: '11111111-1111-1111-1111-111111111111',
  final: false,
  seq: 0,
  startedAt: 1_000,
  durationMs: 5_000,
  playtimeMs: 4_000,
  startupTimeMs: null,
  rebufferCount: 0,
  rebufferDurationMs: 0,
  bitrateMean: null,
  errorCount: 0,
  memPeak: 0,
  memAvg: 0,
  dims: { platform: 'web', appVersion: '1.0.0', sdkVersion: '1.0.0' },
};

function fetchResponse(status: number, headers?: Record<string, string>): Response {
  const lower = new Map(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
  } as unknown as Response;
}

describe('createVitalsTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops silently when killed — neither fetchFn nor beaconFn is called', () => {
    const fetchFn = vi.fn();
    const beaconFn = vi.fn();
    const send = createVitalsTransport({
      endpoint: ENDPOINT,
      apiKey: API_KEY,
      isKilled: () => true,
      fetchFn,
      beaconFn,
    });

    send(CHUNK, { beacon: false });
    send(CHUNK, { beacon: true });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(beaconFn).not.toHaveBeenCalled();
  });

  it('fetch path: POSTs { payload } with an Authorization header and no apiKey in the body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fetchResponse(200));
    const send = createVitalsTransport({
      endpoint: ENDPOINT,
      apiKey: API_KEY,
      isKilled: () => false,
      fetchFn,
    });

    send(CHUNK, { beacon: false });
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
    expect(init.headers).toEqual({
      authorization: 'Bearer ' + API_KEY,
      'content-type': 'application/json',
    });
    const parsed = JSON.parse(init.body as string);
    expect(parsed).toEqual({ payload: CHUNK });
    expect(parsed.apiKey).toBeUndefined();
  });

  it('retries exactly once, 5s later, on a 5xx response', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fetchResponse(500));
    const send = createVitalsTransport({
      endpoint: ENDPOINT,
      apiKey: API_KEY,
      isKilled: () => false,
      fetchFn,
    });

    send(CHUNK, { beacon: false });
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    // No further retry even if the retry also 5xx's.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  // Codex round-1 finding S3 — a 429 used to fall through to "swallowed
  // either way" with no retry scheduled at all, silently dropping every
  // vitals send caught by a rate limit's window.
  describe('429 (rate limited)', () => {
    it('retries once, honoring Retry-After (seconds) instead of the default 5s', async () => {
      const fetchFn = vi.fn().mockResolvedValue(fetchResponse(429, { 'Retry-After': '10' }));
      const send = createVitalsTransport({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        isKilled: () => false,
        fetchFn,
      });

      send(CHUNK, { beacon: false });
      await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

      // Not yet at 5s — the header says 10s, so no retry this early.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchFn).toHaveBeenCalledTimes(1);

      // Retry fires once the full 10s has elapsed.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchFn).toHaveBeenCalledTimes(2);

      // Still exactly one retry, even though the retry's own response is
      // never inspected for a further Retry-After.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('retries once after the normal 5s when Retry-After is absent', async () => {
      const fetchFn = vi.fn().mockResolvedValue(fetchResponse(429));
      const send = createVitalsTransport({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        isKilled: () => false,
        fetchFn,
      });

      send(CHUNK, { beacon: false });
      await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchFn).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('falls back to the normal 5s when Retry-After is unparseable', async () => {
      const fetchFn = vi.fn().mockResolvedValue(fetchResponse(429, { 'Retry-After': 'not-a-number' }));
      const send = createVitalsTransport({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        isKilled: () => false,
        fetchFn,
      });

      send(CHUNK, { beacon: false });
      await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('caps a huge Retry-After at 60s (Codex round-2 finding R3)', async () => {
      // 60s, not the old 30s: the route's rate-limit window is a fixed 60s
      // (the server vitals contract's RATE_LIMIT_WINDOW_MS) — a 30s
      // cap retried into the SAME still-exhausted window and dropped the
      // send permanently (the retry never reschedules). 60s lands the retry
      // at/after the window rolls over.
      const fetchFn = vi.fn().mockResolvedValue(fetchResponse(429, { 'Retry-After': '3600' }));
      const send = createVitalsTransport({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        isKilled: () => false,
        fetchFn,
      });

      send(CHUNK, { beacon: false });
      await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

      // Capped at exactly 60s, not left uncapped at 3600s: just under 60s,
      // the retry must not have fired yet.
      await vi.advanceTimersByTimeAsync(59_999);
      expect(fetchFn).toHaveBeenCalledTimes(1);

      // At 60s, the capped retry fires.
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('re-checks isKilled() before a 429 retry fires', async () => {
      const fetchFn = vi.fn().mockResolvedValue(fetchResponse(429, { 'Retry-After': '10' }));
      let killed = false;
      const send = createVitalsTransport({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        isKilled: () => killed,
        fetchFn,
      });

      send(CHUNK, { beacon: false });
      await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

      killed = true;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  });

  it('does not retry on a 4xx response', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fetchResponse(400));
    const send = createVitalsTransport({
      endpoint: ENDPOINT,
      apiKey: API_KEY,
      isKilled: () => false,
      fetchFn,
    });

    send(CHUNK, { beacon: false });
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('retries exactly once, 5s later, on a network error (rejected promise)', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('network down'));
    const send = createVitalsTransport({
      endpoint: ENDPOINT,
      apiKey: API_KEY,
      isKilled: () => false,
      fetchFn,
    });

    send(CHUNK, { beacon: false });
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('re-checks isKilled() before the retry fires and drops it if killed in the meantime', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fetchResponse(500));
    let killed = false;
    const send = createVitalsTransport({
      endpoint: ENDPOINT,
      apiKey: API_KEY,
      isKilled: () => killed,
      fetchFn,
    });

    send(CHUNK, { beacon: false });
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

    killed = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  // Codex round-5 item 1 — a burst of failed sends used to schedule one
  // retry timer PER send with no cap at all: 2,000 rejected sends produced
  // 2,000 live timers, each pinning its own serialised chunk body.
  //
  // Codex round-7 item 2 — the cap used to let EVERY first attempt through
  // (only the retry that followed a failure was bounded) by evicting an
  // older bookkeeping entry to make room. That eviction never actually
  // stopped a non-cooperative fetch wrapper's request (see the dedicated
  // describe block below), so the cap is now enforced at ADMISSION: once
  // `MAX_OUTSTANDING` (20) requests/retries are outstanding, a NEW one —
  // first attempt or retry alike — is dropped before `fetchFn` is ever
  // called, rather than being started and only later shedding something
  // else. The tests below are updated for that: a synchronous burst now
  // gets only the first 20 admitted, not all of them.
  describe('outstanding retry cap (Codex round-5 item 1 / round-7 item 2)', () => {
    it('a synchronous burst of failed sends only admits the first MAX_OUTSTANDING, then bounds the retries that follow', async () => {
      const fetchFn = vi.fn().mockRejectedValue(new Error('offline'));
      const send = createVitalsTransport({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        isKilled: () => false,
        fetchFn,
      });

      // 2,000 consecutive failed sends, each its own chunk (distinct seq so
      // they're not literally the same object), issued synchronously — the
      // same burst shape as the original report. None of the first 20's
      // fetch promises can have settled yet (nothing yields the microtask
      // queue mid-loop), so admission control refuses the remaining 1,980
      // outright: `fetchFn` is called exactly 20 times, not 2,000.
      for (let i = 0; i < 2000; i++) {
        send({ ...CHUNK, seq: i }, { beacon: false });
      }
      expect(fetchFn).toHaveBeenCalledTimes(20);

      // Each of those 20 rejects and schedules exactly one retry — the same
      // ceiling now bounds the retries that follow, just via admission
      // rather than eviction.
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(20));
    });

    it('every admitted retry still fires exactly once, and firing never reschedules another', async () => {
      const fetchFn = vi.fn().mockRejectedValue(new Error('offline'));
      const send = createVitalsTransport({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        isKilled: () => false,
        fetchFn,
      });

      for (let i = 0; i < 100; i++) {
        send({ ...CHUNK, seq: i }, { beacon: false });
      }
      // Only the first MAX_OUTSTANDING (20) sends were admitted — the rest
      // were dropped at admission, never reaching `fetchFn`.
      expect(fetchFn).toHaveBeenCalledTimes(20);
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(20));

      // Advancing past the retry delay fires every surviving retry exactly
      // once (isRetry === true never schedules a second retry), and none
      // accumulate past the ceiling.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchFn).toHaveBeenCalledTimes(40);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  // Codex round-6 item 1 — round 5's cap counted only scheduled retry
  // TIMERS. A `fetch` (or an instrumentation wrapper/polyfill on top of it)
  // that returns a promise which never settles never reaches the
  // retry-scheduling code at all, so the old cap never engaged: 2,000 sends
  // against a stalled fetch produced 2,000 permanently-live requests.
  //
  // Codex round-7 item 2 — round 6's fix bounded the BOOKKEEPING (evict the
  // oldest tracked entry, abort its signal) but not the actual number of
  // LIVE requests: a wrapper that ignores `AbortSignal` keeps its promise —
  // and the closure over the serialised body — alive whether or not this
  // module still tracks it, so evicting our own entry just made room for
  // ANOTHER real request to start on top of it. Reproduced concretely:
  // 2,000 sends against such a wrapper aborted 1,980 signals, yet the
  // wrapper still held all 2,000 pending promises. Fixed by moving the cap
  // to ADMISSION: once the ceiling is occupied, a new request is never
  // started at all — nothing is evicted or aborted, because there is
  // nothing to make room for.
  describe('in-flight ceiling stops starting new requests once occupied (Codex round-7 item 2)', () => {
    it('a fetch stub that never settles and ignores its abort signal still only ever gets MAX_OUTSTANDING requests started', async () => {
      // A fetch that never resolves or rejects and (unlike a well-behaved
      // implementation) never even accepts a `signal` to ignore — the exact
      // non-cooperative-wrapper shape codex reproduced.
      const fetchFn = vi.fn().mockReturnValue(new Promise<Response>(() => {}));
      const send = createVitalsTransport({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        isKilled: () => false,
        fetchFn,
      });

      for (let i = 0; i < 2000; i++) {
        send({ ...CHUNK, seq: i }, { beacon: false });
      }

      // Only the first MAX_OUTSTANDING (20) requests are ever started — the
      // remaining 1,980 sends are dropped before `fetchFn` is called at
      // all, so a non-cooperative wrapper can never accumulate more than 20
      // pending promises no matter how many chunks the page tries to send.
      expect(fetchFn).toHaveBeenCalledTimes(20);

      // Sending 2,000 MORE while the first 20 are still stalled changes
      // nothing — the ceiling stays occupied indefinitely by a wrapper that
      // never settles and never honors an abort, exactly as it must.
      for (let i = 2000; i < 4000; i++) {
        send({ ...CHUNK, seq: i }, { beacon: false });
      }
      expect(fetchFn).toHaveBeenCalledTimes(20);
    });
  });

  // Codex round-7 item 3 — this collector's cardinal invariant is that it
  // must NEVER surface an error in the host page. Neither the retry timer's
  // call into `sendViaFetch` nor the synchronous portion of the
  // `fetchFn(...).then(...)` call inside it was guarded, so a `fetchFn`
  // (the host page's own `fetch`, or an instrumentation wrapper on top of
  // it) that throws SYNCHRONOUSLY — rather than returning a rejected
  // promise — produced an uncaught exception in the host page. Codex
  // reproduced this concretely with a wrapper that rejects its first call,
  // then throws synchronously from a circuit breaker on the retry.
  describe('a synchronous throw from fetchFn never escapes (Codex round-7 item 3)', () => {
    it('fetchFn rejects the first call, then throws SYNCHRONOUSLY on the retry — the throw is swallowed', async () => {
      let calls = 0;
      const fetchFn = vi.fn().mockImplementation(() => {
        calls++;
        if (calls === 1) return Promise.reject(new Error('offline'));
        // A circuit breaker that opened after the first failure and now
        // throws synchronously instead of rejecting — outside any promise
        // chain a caller of `sendViaFetch` could ever catch.
        throw new Error('breaker open');
      });
      const send = createVitalsTransport({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        isKilled: () => false,
        fetchFn,
      });

      expect(() => send(CHUNK, { beacon: false })).not.toThrow();
      await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

      // The retry fires from a bare `setTimeout` callback (via the retry
      // TIMER entry point) and immediately re-enters `sendViaFetch`, whose
      // synchronous call into `fetchFn` throws. Without the fix, that throw
      // propagates out of the timer callback as an uncaught exception —
      // this `await` completing at all, rather than rejecting the test's
      // own promise chain, is what proves nothing escaped.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      // The retry itself never schedules a further retry, throw or not.
      expect(vi.getTimerCount()).toBe(0);
    });

    it('fetchFn throws SYNCHRONOUSLY on the very first attempt — the throw is swallowed and the one retry still gets scheduled', async () => {
      let calls = 0;
      const fetchFn = vi.fn().mockImplementation(() => {
        calls++;
        if (calls === 1) throw new Error('breaker open');
        return Promise.resolve(fetchResponse(200));
      });
      const send = createVitalsTransport({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        isKilled: () => false,
        fetchFn,
      });

      // `send()` calls into `sendViaFetch` synchronously — this is the
      // "synchronous portion of the fetch call" guard, exercised directly
      // rather than via the retry entry point.
      expect(() => send(CHUNK, { beacon: false })).not.toThrow();
      expect(fetchFn).toHaveBeenCalledTimes(1);

      // Treated exactly like an async rejection: one retry, which succeeds.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  // Verification-pass finding — this is the THIRD attempt at "this collector
  // must never surface an error in the host page". Round 7 guarded the retry
  // timer entry point, the synchronous `fetchFn` call, and the act of
  // attaching `.then` — but never the asynchronous fulfillment/rejection
  // CALLBACKS themselves. A throw inside either one rejects the promise
  // `.then()` returns, which nothing holds a reference to — an
  // `unhandledrejection` in the host page. Fixed structurally: each callback
  // body is individually try/catched, AND a terminal `.catch(() => {})` is
  // chained onto the whole thing so no path off the chain can ever be left
  // unhandled regardless. These tests assert the OBSERVABLE guarantee — a
  // real `process.on('unhandledRejection', …)` listener sees nothing — not
  // just that `send()` itself doesn't throw synchronously (which the round-7
  // tests above already cover for a different failure shape).
  describe('no path off the fetch promise ever surfaces as an unhandled rejection', () => {
    it('a fulfillment handler that throws — reproduced: a 429 response whose instrumented headers.get() throws — never escapes', async () => {
      vi.useRealTimers(); // a REAL macrotask boundary is what proves nothing escaped; see helper note below
      const escaped: unknown[] = [];
      const onRejection = (reason: unknown): void => {
        escaped.push(reason);
      };
      process.on('unhandledRejection', onRejection);
      try {
        const throwingHeaders429: Response = {
          status: 429,
          ok: false,
          headers: {
            get: () => {
              throw new Error('headers.get instrumented to throw');
            },
          },
        } as unknown as Response;
        const fetchFn = vi.fn().mockResolvedValue(throwingHeaders429);
        const send = createVitalsTransport({
          endpoint: ENDPOINT,
          apiKey: API_KEY,
          isKilled: () => false,
          fetchFn,
        });

        expect(() => send(CHUNK, { beacon: false })).not.toThrow();
        await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

        // A genuine macrotask boundary, on a REAL timer, for Node to have
        // surfaced any unhandled rejection by now — the throw happens
        // inside the FULFILLMENT callback, after fetchFn's own promise has
        // already resolved, which is exactly the shape a microtask-only
        // wait can miss.
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(escaped).toEqual([]);
      } finally {
        process.off('unhandledRejection', onRejection);
      }
    });

    it('a rejection handler that throws — a broken global setTimeout makes scheduleRetry() throw from inside it — never escapes', async () => {
      vi.useRealTimers();
      const escaped: unknown[] = [];
      const onRejection = (reason: unknown): void => {
        escaped.push(reason);
      };
      process.on('unhandledRejection', onRejection);
      const realSetTimeout = globalThis.setTimeout;
      try {
        const fetchFn = vi.fn().mockRejectedValue(new Error('network down'));
        const send = createVitalsTransport({
          endpoint: ENDPOINT,
          apiKey: API_KEY,
          isKilled: () => false,
          fetchFn,
        });

        // A host page (or a hardened runtime) whose global `setTimeout`
        // throws synchronously instead of scheduling — this is the only
        // foreign-code surface the REJECTION handler's body reaches
        // (`scheduleRetry`'s own `setTimeout` call).
        vi.stubGlobal('setTimeout', () => {
          throw new Error('setTimeout disabled');
        });

        expect(() => send(CHUNK, { beacon: false })).not.toThrow();

        // Flush microtasks — `fetchFn`'s already-rejected promise's
        // rejection callback runs on the microtask queue, so this reaches
        // the `scheduleRetry` → broken-`setTimeout` throw while `setTimeout`
        // is still stubbed, without needing a real timer (which is broken
        // right now anyway).
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        vi.unstubAllGlobals(); // restore the real setTimeout before waiting below
        await new Promise((resolve) => realSetTimeout(resolve, 50));

        // No retry was scheduled — the broken setTimeout means scheduleRetry
        // itself failed — but that's an acceptable lossy-by-design outcome;
        // the only thing this test asserts is that it failed SILENTLY.
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(escaped).toEqual([]);
      } finally {
        process.off('unhandledRejection', onRejection);
      }
    });

    it('an in-flight fetch aborted mid-request never escapes', async () => {
      vi.useRealTimers();
      const escaped: unknown[] = [];
      const onRejection = (reason: unknown): void => {
        escaped.push(reason);
      };
      process.on('unhandledRejection', onRejection);
      try {
        const controller = new AbortController();
        const fetchFn = vi.fn().mockImplementation(
          () =>
            new Promise<Response>((_resolve, reject) => {
              controller.signal.addEventListener('abort', () => {
                reject(new DOMException('The operation was aborted.', 'AbortError'));
              });
            }),
        );
        const send = createVitalsTransport({
          endpoint: ENDPOINT,
          apiKey: API_KEY,
          isKilled: () => false,
          fetchFn,
        });

        expect(() => send(CHUNK, { beacon: false })).not.toThrow();
        await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

        controller.abort();

        // A genuine macrotask boundary for the abort's rejection to reach
        // the rejection handler and for Node to have surfaced any unhandled
        // rejection by now.
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(escaped).toEqual([]);
      } finally {
        process.off('unhandledRejection', onRejection);
      }
    });
  });

  // Verification-pass finding — the outer catch in `sendViaFetch` (the one
  // that handles a SYNCHRONOUS throw from `fetchFn` itself) called
  // `scheduleRetry()` unguarded. `scheduleRetry` calls the host's own
  // `setTimeout`, foreign code exactly like `fetchFn` — if it throws, that
  // throw escaped this catch block, out of `sendViaFetch`, out of `send()`,
  // into the host page. Reproduced concretely with a disabled global
  // `setTimeout`. A related gap in the retry timer itself: `untrackPending()`
  // ran ahead of the try that already wrapped the timer's `sendViaFetch`
  // call, so a throw from `untrackPending`'s own bookkeeping escaped the
  // timer callback the same way.
  describe('verification-pass: scheduleRetry() (outer catch) and untrackPending() (retry timer) guarded', () => {
    it('fetchFn throws synchronously AND setTimeout itself throws — the outer catch\'s scheduleRetry() call never escapes send()', () => {
      const fetchFn = vi.fn().mockImplementation(() => {
        throw new Error('breaker open');
      });
      const send = createVitalsTransport({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        isKilled: () => false,
        fetchFn,
      });

      // Reached via the SYNCHRONOUS-throw route: fetchFn throws, landing in
      // sendViaFetch's outer catch, which (since this is the first attempt)
      // calls scheduleRetry() — which calls this broken setTimeout.
      vi.stubGlobal('setTimeout', () => {
        throw new Error('setTimeout disabled');
      });

      try {
        expect(() => send(CHUNK, { beacon: false })).not.toThrow();
      } finally {
        vi.unstubAllGlobals();
      }

      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('untrackPending() throwing inside the retry timer callback never escapes', async () => {
      const fetchFn = vi.fn().mockRejectedValue(new Error('network down'));
      const send = createVitalsTransport({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        isKilled: () => false,
        fetchFn,
      });

      send(CHUNK, { beacon: false });
      await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

      // Poison the bookkeeping call `untrackPending` makes (`pending.indexOf`)
      // so firing the retry timer throws from INSIDE the callback, before
      // `sendViaFetch` ever runs. Restored inside the poison itself (not just
      // in a `finally`) so exactly one call — whichever happens first once
      // the timer fires — throws, and every other call in the process
      // (including anything the test runner itself does) sees the real
      // `indexOf`. The whole poison-and-fire sequence runs through the
      // SYNCHRONOUS `advanceTimersByTime` (not the async variant) so nothing
      // else can interleave on the microtask/task queue while it's active.
      const realIndexOf = Array.prototype.indexOf;
      Array.prototype.indexOf = function (this: unknown[], ...args: Parameters<typeof realIndexOf>) {
        Array.prototype.indexOf = realIndexOf;
        throw new Error('indexOf broken');
      };
      let advanceError: unknown;
      try {
        vi.advanceTimersByTime(5_000);
      } catch (err) {
        advanceError = err;
      } finally {
        Array.prototype.indexOf = realIndexOf;
      }

      expect(advanceError).toBeUndefined();
      // untrackPending's throw happens before sendViaFetch runs in the retry
      // callback, so the retry's own fetch attempt never fires either way —
      // the only thing this test asserts is that firing the timer didn't
      // throw.
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  });

  it('beacon path: body contains apiKey and uses a text/plain blob', () => {
    const beaconFn = vi.fn().mockReturnValue(true);
    const fetchFn = vi.fn();
    const send = createVitalsTransport({
      endpoint: ENDPOINT,
      apiKey: API_KEY,
      isKilled: () => false,
      fetchFn,
      beaconFn,
    });

    send(CHUNK, { beacon: true });

    expect(beaconFn).toHaveBeenCalledTimes(1);
    const [url, data] = beaconFn.mock.calls[0] as [string, Blob];
    expect(url).toBe(ENDPOINT);
    expect(data).toBeInstanceOf(Blob);
    // jsdom's Blob.type getter normalizes to lowercase per spec — the
    // implementation still constructs it with the exact-cased string from
    // the brief; assert case-insensitively to reflect that jsdom quirk.
    expect(data.type.toLowerCase()).toBe('text/plain;charset=utf-8');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('falls back to the fetch path when beaconFn returns false', async () => {
    const beaconFn = vi.fn().mockReturnValue(false);
    const fetchFn = vi.fn().mockResolvedValue(fetchResponse(200));
    const send = createVitalsTransport({
      endpoint: ENDPOINT,
      apiKey: API_KEY,
      isKilled: () => false,
      fetchFn,
      beaconFn,
    });

    send(CHUNK, { beacon: true });

    expect(beaconFn).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
  });

  it('falls back to the fetch path when beaconFn is absent', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fetchResponse(200));
    const send = createVitalsTransport({
      endpoint: ENDPOINT,
      apiKey: API_KEY,
      isKilled: () => false,
      fetchFn,
    });

    send(CHUNK, { beacon: true });

    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
  });

  it('defaults fetchFn to global fetch and beaconFn to navigator.sendBeacon', () => {
    const realFetch = vi.fn().mockResolvedValue(fetchResponse(200));
    const realBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal('fetch', realFetch);
    vi.stubGlobal('navigator', { sendBeacon: realBeacon });

    const send = createVitalsTransport({
      endpoint: ENDPOINT,
      apiKey: API_KEY,
      isKilled: () => false,
    });

    send(CHUNK, { beacon: true });
    expect(realBeacon).toHaveBeenCalledTimes(1);

    send(CHUNK, { beacon: false });
    expect(realFetch).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it('drops silently rather than throwing when the payload is unserializable (BigInt) — fetch path', () => {
    const fetchFn = vi.fn();
    const beaconFn = vi.fn();
    const unserializable = {
      ...CHUNK,
      entries: [
        { kind: 'player' as const, t: 1_000, type: 'error' as const, data: { code: 1n } },
      ],
    } as unknown as VitalsChunk;
    const send = createVitalsTransport({
      endpoint: ENDPOINT,
      apiKey: API_KEY,
      isKilled: () => false,
      fetchFn,
      beaconFn,
    });

    expect(() => send(unserializable, { beacon: false })).not.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(beaconFn).not.toHaveBeenCalled();
  });

  it('drops silently rather than throwing when the payload is unserializable (circular ref) — beacon path', () => {
    const fetchFn = vi.fn();
    const beaconFn = vi.fn();
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const unserializable = {
      ...CHUNK,
      entries: [
        { kind: 'player' as const, t: 1_000, type: 'error' as const, data: circular },
      ],
    } as unknown as VitalsChunk;
    const send = createVitalsTransport({
      endpoint: ENDPOINT,
      apiKey: API_KEY,
      isKilled: () => false,
      fetchFn,
      beaconFn,
    });

    expect(() => send(unserializable, { beacon: true })).not.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(beaconFn).not.toHaveBeenCalled();
  });
  // Task 11 (spec 2026-09-10 — playback session identity). The token is a
  // VERIFIED credential, so it never rides in the payload the way the
  // self-declared `user` block does: it goes in the `x-tx-identity-token`
  // header on the fetch path, and — because `sendBeacon` cannot set headers,
  // which is exactly why `apiKey` already rides in the body there — in an
  // `identityToken` body field beside `apiKey` on the beacon path.
  // ROUND-4 FINDING 5 — the token now arrives WITH the payload, in
  // `opts.identityToken`, instead of being pulled from a provider dep of this
  // module's own. The collector reads identity once per summary and hands both
  // halves down together (sdk-core's `VitalsIdentitySnapshot`), so there is no
  // second read here to disagree with the body's `user` block. Every case
  // below is unchanged in substance; only where the token comes from moved.
  describe('identity token', () => {
    // COMPACT-JWS SHAPED, and that is now load-bearing rather than cosmetic
    // (round-3 finding 3): `presentableIdentityToken` refuses anything that
    // is not three base64url segments, because that alphabet is exactly what
    // an HTTP header value may carry. A bare `'tok-abc'` would be dropped by
    // the backstop below, which is the correct behaviour and not what these
    // wiring assertions are about.
    const jws = (payload: string): string => `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
    const TOK_ABC = jws('tok-abc');
    const TOK_ALICE = jws('tok-alice');
    const TOK_BOB = jws('tok-bob');
    /** Header + separators + signature — what `jws()` adds to its payload. */
    const JWS_OVERHEAD = jws('').length;
    it('fetch path: sends the x-tx-identity-token header when a token is available', async () => {
      const fetchFn = vi.fn().mockResolvedValue(fetchResponse(200));
      const send = createVitalsTransport({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        isKilled: () => false,
        fetchFn,
      });

      send(SUMMARY, { beacon: false, identityToken: TOK_ABC });
      await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(init.headers).toEqual({
        authorization: 'Bearer ' + API_KEY,
        'content-type': 'application/json',
        [IDENTITY_TOKEN_HEADER]: TOK_ABC,
      });
      // The header is the whole delivery — nothing leaks into the body.
      expect(JSON.parse(init.body as string)).toEqual({ payload: SUMMARY });
    });

    it('fetch path: omits the header when no token is available', async () => {
      const fetchFn = vi.fn().mockResolvedValue(fetchResponse(200));
      const send = createVitalsTransport({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        isKilled: () => false,
        fetchFn,
      });

      send(SUMMARY, { beacon: false });
      await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(init.headers).toEqual({
        authorization: 'Bearer ' + API_KEY,
        'content-type': 'application/json',
      });
    });

    it('beacon path: puts identityToken in the body beside apiKey', async () => {
      const beaconFn = vi.fn().mockReturnValue(true);
      const send = createVitalsTransport({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        isKilled: () => false,
        fetchFn: vi.fn(),
        beaconFn,
      });

      send(SUMMARY, { beacon: true, identityToken: TOK_ABC });

      const [, data] = beaconFn.mock.calls[0] as [string, Blob];
      expect(JSON.parse(await data.text())).toEqual({
        apiKey: API_KEY,
        identityToken: TOK_ABC,
        payload: SUMMARY,
      });
    });

    it('beacon path: omits identityToken when no token is available', async () => {
      const beaconFn = vi.fn().mockReturnValue(true);
      const send = createVitalsTransport({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        isKilled: () => false,
        fetchFn: vi.fn(),
        beaconFn,
      });

      send(SUMMARY, { beacon: true });

      const [, data] = beaconFn.mock.calls[0] as [string, Blob];
      const parsed = JSON.parse(await data.text());
      expect(parsed).toEqual({ apiKey: API_KEY, payload: SUMMARY });
      expect('identityToken' in parsed).toBe(false);
    });

    it('omits the token on a CHUNK — the route resolves identity on summaries only', async () => {
      const fetchFn = vi.fn().mockResolvedValue(fetchResponse(200));
      const beaconFn = vi.fn().mockReturnValue(true);
      const send = createVitalsTransport({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        isKilled: () => false,
        fetchFn,
        beaconFn,
      });

      send(CHUNK, { beacon: false });
      await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(init.headers).toEqual({
        authorization: 'Bearer ' + API_KEY,
        'content-type': 'application/json',
      });

      send(CHUNK, { beacon: true, identityToken: TOK_ABC });
      const [, data] = beaconFn.mock.calls[0] as [string, Blob];
      expect(JSON.parse(await data.text())).toEqual({ apiKey: API_KEY, payload: CHUNK });
    });

    // Adversarial review of PR #218, finding 2 — REVERSED from "drops the
    // token on the retry". Dropping it guaranteed an unverified twin on every
    // ordinary 429/503 retry (the route reads the self-declared `user` block
    // still sitting in the same body), and overwrote a verified attribution
    // with an unverified one whenever the first attempt had actually
    // committed and only its response was lost. Threading the ORIGINAL token
    // through costs at worst an expired token — which the route resolves
    // anonymous, creating no row at all. It is captured once per `send()` and
    // deliberately NOT re-read here: an account switch during the retry delay
    // must not re-attribute a summary built under a different identity.
    it('presents the SAME identity token on the retry that the first attempt carried', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(fetchResponse(500))
        .mockResolvedValueOnce(fetchResponse(200));
      const send = createVitalsTransport({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        isKilled: () => false,
        fetchFn,
      });

      send(SUMMARY, { beacon: false, identityToken: TOK_ABC });
      await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

      const [, firstInit] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(firstInit.headers).toEqual({
        authorization: 'Bearer ' + API_KEY,
        'content-type': 'application/json',
        [IDENTITY_TOKEN_HEADER]: TOK_ABC,
      });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchFn).toHaveBeenCalledTimes(2);

      const [, retryInit] = fetchFn.mock.calls[1] as [string, RequestInit];
      expect(retryInit.headers).toEqual({
        authorization: 'Bearer ' + API_KEY,
        'content-type': 'application/json',
        [IDENTITY_TOKEN_HEADER]: TOK_ABC,
      });
    });

    // The other half of the same rule: a retry presents the token its OWN
    // summary was built with. An account switch between the first attempt and
    // the retry — visible here as a second summary sent under Bob while
    // Alice's retry is still pending — must not re-attribute the first one.
    // Round-4 finding 5 makes this structural rather than careful: the token
    // is captured with the payload, so there is nothing left for the retry to
    // re-read.
    it('a retry carries its own summary token — a mid-delay account switch cannot re-attribute it', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(fetchResponse(503))
        .mockResolvedValue(fetchResponse(200));
      const send = createVitalsTransport({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        isKilled: () => false,
        fetchFn,
      });

      // The snapshot Alice's summary was BUILT with.
      send(SUMMARY, { beacon: false, identityToken: TOK_ALICE });
      await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

      // The host switches account mid-delay and a later summary goes out as
      // Bob, while Alice's retry is still scheduled.
      send(SUMMARY, { beacon: false, identityToken: TOK_BOB });
      await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
      expect(
        (fetchFn.mock.calls[1]![1] as RequestInit).headers as Record<string, string>,
      ).toMatchObject({ [IDENTITY_TOKEN_HEADER]: TOK_BOB });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchFn).toHaveBeenCalledTimes(3);

      const [, retryInit] = fetchFn.mock.calls[2] as [string, RequestInit];
      expect((retryInit.headers as Record<string, string>)[IDENTITY_TOKEN_HEADER]).toBe(
        TOK_ALICE,
      );
    });

    // The provider can no longer throw INTO this module — it is not called
    // here any more (round-4 finding 5). What a caller can still do is hand in
    // a value that is not a usable token at all; that must cost the
    // attribution and nothing else.
    it('never lets an unusable token break the send', async () => {
      const fetchFn = vi.fn().mockResolvedValue(fetchResponse(200));
      const send = createVitalsTransport({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        isKilled: () => false,
        fetchFn,
      });

      expect(() =>
        send(SUMMARY, { beacon: false, identityToken: 'not-a-jwt' }),
      ).not.toThrow();
      await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(init.headers).toEqual({
        authorization: 'Bearer ' + API_KEY,
        'content-type': 'application/json',
      });
    });

    // Adversarial review of PR #218 round 2, finding 6 — measured. Nothing
    // upstream caps a token's size: the holder only decodes `exp`, so a
    // validly signed JWT carrying a 70 KB extra claim arrives here intact. In
    // the beacon envelope it produced a 94,008-byte body (past sendBeacon's
    // 64 KiB ceiling); as a header on the fetch fallback a real local server
    // answered 431 before reading the request. Identity data may cost
    // ATTRIBUTION; it may never cost the summary carrying it.
    describe('an over-long token is dropped, never allowed to cost the summary', () => {
      // One character past the server's own `IDENTITY_TOKEN_MAX_CHARS`, which
      // `hasPlausibleIdentityTokenShape` refuses as `malformed` anyway — so
      // dropping it loses nothing that was going to authenticate anyone.
      const OVERSIZED = jws('a'.repeat(IDENTITY_TOKEN_MAX_CHARS + 1 - JWS_OVERHEAD));

      it('beacon path: sends the summary with no identityToken, well under 64 KiB', async () => {
        const beaconFn = vi.fn().mockReturnValue(true);
        const send = createVitalsTransport({
          endpoint: ENDPOINT,
          apiKey: API_KEY,
          isKilled: () => false,
          fetchFn: vi.fn(),
          beaconFn,
        });

        send(SUMMARY, { beacon: true, identityToken: OVERSIZED });

        expect(beaconFn).toHaveBeenCalledTimes(1);
        const [, data] = beaconFn.mock.calls[0] as [string, Blob];
        const text = await data.text();
        const parsed = JSON.parse(text);
        expect('identityToken' in parsed).toBe(false);
        expect(parsed.payload).toEqual(SUMMARY);
        expect(new TextEncoder().encode(text).length).toBeLessThan(64 * 1024);
      });

      it('fetch path: sends the summary with no identity header', async () => {
        const fetchFn = vi.fn().mockResolvedValue(fetchResponse(200));
        const send = createVitalsTransport({
          endpoint: ENDPOINT,
          apiKey: API_KEY,
          isKilled: () => false,
          fetchFn,
        });

        send(SUMMARY, { beacon: false, identityToken: OVERSIZED });

        await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
        const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
        expect(init.headers).toEqual({
          authorization: 'Bearer ' + API_KEY,
          'content-type': 'application/json',
        });
        expect(JSON.parse(init.body as string)).toEqual({ payload: SUMMARY });
      });

    });

    // ROUND-3 FINDING 3 — reproduced against native Request validation: a
    // three-segment token with a valid future `exp` and an embedded NEWLINE in
    // its signature passed round 2's length bound, and then `fetch` refused
    // the header before sending anything. Two TypeErrors, ZERO deliveries, and
    // the retry reused the same bad header. Identity garbage cost the whole
    // summary — invariant 2 — so the screen is header-safety, not just size.
    describe('a header-unsafe token is dropped, and the summary still ships', () => {
      const UNSAFE = 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.si\ng';

      /**
       * A `fetchFn` that builds a REAL `Request` from what the transport hands
       * it before answering — the same validation the browser's own `fetch`
       * performs, and the thing that actually threw in the reproduction. A
       * transport that let `UNSAFE` through fails here by throwing, not by an
       * assertion.
       */
      const validatingFetch = () =>
        vi.fn(async (url: string, init: RequestInit) => {
          new Request(url, init);
          return fetchResponse(200);
        });

      it('fetch path: delivers with no identity header', async () => {
        const fetchFn = validatingFetch();
        const send = createVitalsTransport({
          endpoint: ENDPOINT,
          apiKey: API_KEY,
          isKilled: () => false,
          fetchFn: fetchFn as unknown as typeof fetch,
        });

        send(SUMMARY, { beacon: false, identityToken: UNSAFE });
        await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
        const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
        expect(init.headers).toEqual({
          authorization: 'Bearer ' + API_KEY,
          'content-type': 'application/json',
        });
        expect(JSON.parse(init.body as string)).toEqual({ payload: SUMMARY });
      });

      it('beacon path: delivers with no identityToken in the body', async () => {
        const beaconFn = vi.fn().mockReturnValue(true);
        const send = createVitalsTransport({
          endpoint: ENDPOINT,
          apiKey: API_KEY,
          isKilled: () => false,
          fetchFn: vi.fn(),
          beaconFn,
        });

        send(SUMMARY, { beacon: true });

        expect(beaconFn).toHaveBeenCalledTimes(1);
        const [, data] = beaconFn.mock.calls[0] as [string, Blob];
        const parsed = JSON.parse(await data.text());
        expect('identityToken' in parsed).toBe(false);
        expect(parsed).toEqual({ apiKey: API_KEY, payload: SUMMARY });
      });
    });

    // The bound is a ceiling, not an off-by-one: the longest token the server
    // would still look at is presented.
    describe('the boundary', () => {
      it('a token exactly at the cap is still presented', async () => {
        const fetchFn = vi.fn().mockResolvedValue(fetchResponse(200));
        const atCap = jws('a'.repeat(IDENTITY_TOKEN_MAX_CHARS - JWS_OVERHEAD));
        const send = createVitalsTransport({
          endpoint: ENDPOINT,
          apiKey: API_KEY,
          isKilled: () => false,
          fetchFn,
        });

        send(SUMMARY, { beacon: false, identityToken: atCap });

        await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
        const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
        expect((init.headers as Record<string, string>)[IDENTITY_TOKEN_HEADER]).toBe(atCap);
      });
    });

    // ROUND-5 FINDING 3, reproduced by the reviewer through the REAL collector
    // and transport. `setupVitals`'s gate withholds both halves of a rejected
    // identity, but wiring `createVitalsCollector` straight to
    // `createVitalsTransport` skips that gate — and the transport used to drop
    // the credential while leaving the `user` block on the body, so the server
    // saw an ordinary unverified claim. Belt and braces: whichever layer
    // rejects the token, the claim goes with it.
    describe('a rejected token takes the self-declared claim with it (direct wiring)', () => {
      const SESSION = '11111111-1111-1111-1111-111111111111';

      /** The reviewer's wiring, verbatim in shape: no `setupVitals`, no gate. */
      function wire(
        identity: () => { token?: string; user?: { id?: string } },
        fetchFn: ReturnType<typeof vi.fn>,
      ): void {
        const send = createVitalsTransport({
          endpoint: ENDPOINT,
          apiKey: API_KEY,
          isKilled: () => false,
          fetchFn: fetchFn as unknown as typeof fetch,
        });
        createVitalsCollector({
          dims: { platform: 'web', appVersion: '1.0.0', sdkVersion: '1.0.0' },
          now: () => 1_000_000,
          newSessionId: () => SESSION,
          send,
          setIntervalFn: (() => 0) as unknown as typeof setInterval,
          clearIntervalFn: () => undefined,
          identity,
        });
      }

      it('drops both the header and the user block for an unpresentable token', async () => {
        const fetchFn = vi.fn().mockResolvedValue(fetchResponse(200));
        wire(() => ({ token: 'broken-token', user: { id: 'alice' } }), fetchFn);

        await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
        const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
        expect((init.headers as Record<string, string>)[IDENTITY_TOKEN_HEADER]).toBeUndefined();
        const payload = JSON.parse(init.body as string).payload as SessionSummary;
        expect(payload.kind).toBe('summary');
        expect('user' in payload).toBe(false);
      });

      it('beacon path drops both as well', async () => {
        const beaconFn = vi.fn().mockReturnValue(true);
        const send = createVitalsTransport({
          endpoint: ENDPOINT,
          apiKey: API_KEY,
          isKilled: () => false,
          fetchFn: vi.fn(),
          beaconFn,
        });
        send({ ...SUMMARY, user: { id: 'alice' } }, { beacon: true, identityToken: 'broken' });

        expect(beaconFn).toHaveBeenCalledTimes(1);
        const [, data] = beaconFn.mock.calls[0] as [string, Blob];
        const parsed = JSON.parse(await data.text());
        expect('identityToken' in parsed).toBe(false);
        expect('user' in parsed.payload).toBe(false);
      });

      // Narrow: a summary that never offered a token is the self-declared tier
      // working exactly as designed, and keeps its claim.
      it('leaves the claim alone when no token was supplied at all', async () => {
        const fetchFn = vi.fn().mockResolvedValue(fetchResponse(200));
        wire(() => ({ user: { id: 'alice' } }), fetchFn);

        await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
        const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
        const payload = JSON.parse(init.body as string).payload as SessionSummary;
        expect(payload.user).toEqual({ id: 'alice' });
      });

      // …and a token that IS presentable keeps both halves together too.
      it('keeps both when the token is presentable', async () => {
        const fetchFn = vi.fn().mockResolvedValue(fetchResponse(200));
        const good = jws('signature');
        wire(() => ({ token: good, user: { id: 'alice' } }), fetchFn);

        await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
        const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
        expect((init.headers as Record<string, string>)[IDENTITY_TOKEN_HEADER]).toBe(good);
        const payload = JSON.parse(init.body as string).payload as SessionSummary;
        expect(payload.user).toEqual({ id: 'alice' });
      });
    });
  });
});
