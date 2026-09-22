// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// CONFIG-02 — remote per-app config provider, FAIL CLOSED (HIGHEST-LIABILITY GATE).
// Turned RED→GREEN in plan 20-02.
//
// Contract (RESEARCH §"GET /api/config contract"):
//   - fetch once at init; cache in-memory; TTL 5 min; exponential backoff on failure.
//   - FAIL CLOSED: network error / non-200 / malformed body / timeout / missing
//     field ⇒ replayEnabled = false.
//   - default object is OFF; overwritten only by a fully Zod-validated 200.
//   - never records before the first successful resolution.
import { describe, it, expect, vi } from 'vitest';
import {
  createConfigProvider,
  REPLAY_CONFIG_OFF,
  ReplayConfigResponse,
  BREADCRUMBS_CONFIG_DEFAULT,
  getBreadcrumbsConfig,
  isRepliesEnabled,
  isIdentityEnabled,
  type ReplayConfig,
} from '../../src/types/replay/config-provider.js';

const OFF: ReplayConfig = { replayEnabled: false, replayDurationSec: 30, samplingRate: 1.0 };

/** A `fetch`-shaped impl that always returns the given Response (or throws/rejects). */
function fetchReturning(make: () => Response | Promise<Response>): typeof fetch {
  return (async () => make()) as unknown as typeof fetch;
}

describe('CONFIG-02 config provider fail-closed', () => {
  it('REPLAY_CONFIG_OFF is the canonical OFF default', () => {
    expect(REPLAY_CONFIG_OFF).toEqual(OFF);
    expect(REPLAY_CONFIG_OFF.replayEnabled).toBe(false);
  });

  it('default object is OFF before any fetch resolves', () => {
    const cp = createConfigProvider({
      // never-resolving fetch: get() must still return OFF synchronously
      fetchImpl: (() => new Promise<Response>(() => {})) as unknown as typeof fetch,
      configUrl: 'https://x/api/config',
      apiKey: 'k',
    });
    expect(cp.get()).toEqual(OFF);
    expect(cp.get().replayEnabled).toBe(false);
  });

  it('network error (rejection) keeps replayEnabled:false', async () => {
    const cp = createConfigProvider({
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
      configUrl: 'https://x/api/config',
      apiKey: 'k',
    });
    await cp.refresh();
    expect(cp.get().replayEnabled).toBe(false);
  });

  it('non-200 (5xx) keeps replayEnabled:false', async () => {
    const cp = createConfigProvider({
      fetchImpl: fetchReturning(() => new Response('', { status: 503 })),
      configUrl: 'https://x/api/config',
      apiKey: 'k',
    });
    await cp.refresh();
    expect(cp.get().replayEnabled).toBe(false);
  });

  it('non-200 (4xx) keeps replayEnabled:false', async () => {
    const cp = createConfigProvider({
      fetchImpl: fetchReturning(() => new Response('', { status: 401 })),
      configUrl: 'https://x/api/config',
      apiKey: 'k',
    });
    await cp.refresh();
    expect(cp.get().replayEnabled).toBe(false);
  });

  it('malformed JSON body keeps replayEnabled:false', async () => {
    const cp = createConfigProvider({
      fetchImpl: fetchReturning(() => new Response('not json', { status: 200 })),
      configUrl: 'https://x/api/config',
      apiKey: 'k',
    });
    await cp.refresh();
    expect(cp.get().replayEnabled).toBe(false);
  });

  it('missing field (partial body) fails Zod ⇒ replayEnabled:false', async () => {
    const cp = createConfigProvider({
      // no durationSec / samplingRate
      fetchImpl: fetchReturning(() => Response.json({ replayEnabled: true })),
      configUrl: 'https://x/api/config',
      apiKey: 'k',
    });
    await cp.refresh();
    expect(cp.get().replayEnabled).toBe(false);
  });

  it('wrong-typed field fails Zod ⇒ replayEnabled:false', async () => {
    const cp = createConfigProvider({
      fetchImpl: fetchReturning(() =>
        Response.json({ replayEnabled: 'yes', replayDurationSec: 15, samplingRate: 0.5 }),
      ),
      configUrl: 'https://x/api/config',
      apiKey: 'k',
    });
    await cp.refresh();
    expect(cp.get().replayEnabled).toBe(false);
  });

  it('an out-of-[0,1] samplingRate fails Zod ⇒ replayEnabled:false (CR-04-C bounds match server)', async () => {
    const cp = createConfigProvider({
      // samplingRate 2.0 is out of the server-enforced [0,1] range — must fail closed,
      // never feed an out-of-range value to the `random() < samplingRate` gate.
      fetchImpl: fetchReturning(() =>
        Response.json({ replayEnabled: true, replayDurationSec: 30, samplingRate: 2.0 }),
      ),
      configUrl: 'https://x/api/config',
      apiKey: 'k',
    });
    await cp.refresh();
    expect(cp.get().replayEnabled).toBe(false);
    expect(cp.get()).toEqual(OFF);
  });

  it('a negative samplingRate fails Zod ⇒ replayEnabled:false (CR-04-C lower bound)', async () => {
    const cp = createConfigProvider({
      fetchImpl: fetchReturning(() =>
        Response.json({ replayEnabled: true, replayDurationSec: 30, samplingRate: -0.5 }),
      ),
      configUrl: 'https://x/api/config',
      apiKey: 'k',
    });
    await cp.refresh();
    expect(cp.get().replayEnabled).toBe(false);
  });

  it('timeout (AbortError) keeps replayEnabled:false', async () => {
    const cp = createConfigProvider({
      fetchImpl: (async () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }) as unknown as typeof fetch,
      configUrl: 'https://x/api/config',
      apiKey: 'k',
    });
    await cp.refresh();
    expect(cp.get().replayEnabled).toBe(false);
  });

  it('a fully Zod-validated 200 is the ONLY thing that flips replayEnabled true', async () => {
    const cp = createConfigProvider({
      fetchImpl: fetchReturning(() =>
        Response.json({ replayEnabled: true, replayDurationSec: 15, samplingRate: 0.5 }),
      ),
      configUrl: 'https://x/api/config',
      apiKey: 'k',
    });
    await cp.refresh();
    expect(cp.get()).toEqual({ replayEnabled: true, replayDurationSec: 15, samplingRate: 0.5 });
  });

  it('still fetches and commits on engines without AbortSignal.timeout (webOS 6.x / Tizen ≤ 7)', async () => {
    // Field bug 2026-08-27: `signal: AbortSignal.timeout(ttl)` threw a
    // synchronous TypeError on Chrome ≤ 102 webviews BEFORE the fetch was
    // issued, so every refresh on those TVs fail-closed without a single
    // request on the wire — replay/replies/identity permanently OFF.
    const nativeTimeout = AbortSignal.timeout;
    (AbortSignal as { timeout?: unknown }).timeout = undefined;
    try {
      const cp = createConfigProvider({
        fetchImpl: fetchReturning(() =>
          Response.json({ replayEnabled: true, replayDurationSec: 15, samplingRate: 0.5 }),
        ),
        configUrl: 'https://x/api/config',
        apiKey: 'k',
      });
      await expect(cp.refresh()).resolves.toBe(true);
      expect(cp.get().replayEnabled).toBe(true);
    } finally {
      (AbortSignal as { timeout?: typeof AbortSignal.timeout }).timeout = nativeTimeout;
    }
  });

  it('still bounds the fetch wait on engines with NEITHER AbortSignal.timeout NOR AbortController', async () => {
    // Codex round-2 finding 7: with no abort primitive at all (Chrome < 66 —
    // webOS 4.x, Tizen 3/4), timeoutSignal returns null and the fetch was
    // UNBOUNDED — a hung request wedged the provider (and everything awaiting
    // __initReplay) forever. Previously the bare AbortSignal.timeout access
    // threw synchronously, which at least failed closed. The wait itself must
    // be bounded even when the network request cannot be aborted.
    vi.useFakeTimers();
    const nativeTimeout = AbortSignal.timeout;
    const NativeController = globalThis.AbortController;
    (AbortSignal as { timeout?: unknown }).timeout = undefined;
    globalThis.AbortController = undefined as unknown as typeof AbortController;
    try {
      const cp = createConfigProvider({
        fetchImpl: (() => new Promise<Response>(() => {})) as unknown as typeof fetch, // hangs
        configUrl: 'https://x/api/config',
        apiKey: 'k',
      });
      const pending = cp.refresh();
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      await expect(pending).resolves.toBe(false);
      expect(cp.get().replayEnabled).toBe(false);
    } finally {
      (AbortSignal as { timeout?: typeof AbortSignal.timeout }).timeout = nativeTimeout;
      globalThis.AbortController = NativeController;
      vi.useRealTimers();
    }
  });

  it('still bounds the BODY read when the server sends headers but stalls the body', async () => {
    // Codex round-3 finding 3: fetch() settles at response HEADERS; on
    // engines with no abort primitive a stalled body left res.json() pending
    // forever, wedging the provider past the round-2 boundWait fix.
    vi.useFakeTimers();
    const nativeTimeout = AbortSignal.timeout;
    const NativeController = globalThis.AbortController;
    (AbortSignal as { timeout?: unknown }).timeout = undefined;
    globalThis.AbortController = undefined as unknown as typeof AbortController;
    try {
      const hungBody = {
        ok: true,
        status: 200,
        json: () => new Promise(() => {}), // headers arrived; body never does
      } as unknown as Response;
      const cp = createConfigProvider({
        fetchImpl: (async () => hungBody) as unknown as typeof fetch,
        configUrl: 'https://x/api/config',
        apiKey: 'k',
      });
      const pending = cp.refresh();
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      await expect(pending).resolves.toBe(false);
      expect(cp.get().replayEnabled).toBe(false);
    } finally {
      (AbortSignal as { timeout?: typeof AbortSignal.timeout }).timeout = nativeTimeout;
      globalThis.AbortController = NativeController;
      vi.useRealTimers();
    }
  });

  it('surfaces samplingRate verbatim from the validated response', async () => {
    const cp = createConfigProvider({
      fetchImpl: fetchReturning(() =>
        Response.json({ replayEnabled: true, replayDurationSec: 60, samplingRate: 0.25 }),
      ),
      configUrl: 'https://x/api/config',
      apiKey: 'k',
    });
    await cp.refresh();
    expect(cp.get().samplingRate).toBe(0.25);
  });

  it('does NOT throw to the caller on any error path (fails closed silently)', async () => {
    const cp = createConfigProvider({
      fetchImpl: (async () => {
        throw new Error('boom');
      }) as unknown as typeof fetch,
      configUrl: 'https://x/api/config',
      apiKey: 'k',
    });
    // F18: refresh() now resolves a success boolean (false on any failure
    // path) instead of void — still never throws/rejects to the caller.
    await expect(cp.refresh()).resolves.toBe(false);
  });

  it('sends the Bearer SDK key header exactly like the ingest path', async () => {
    const seen: { url?: string; auth?: string | null } = {};
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.url = url;
      const headers = new Headers(init?.headers);
      seen.auth = headers.get('Authorization');
      return Response.json({ replayEnabled: false, replayDurationSec: 30, samplingRate: 1.0 });
    }) as unknown as typeof fetch;
    const cp = createConfigProvider({ fetchImpl, configUrl: 'https://x/api/config', apiKey: 'sdk_abc' });
    await cp.refresh();
    expect(seen.url).toBe('https://x/api/config');
    expect(seen.auth).toBe('Bearer sdk_abc');
  });

  // Capability declaration moved from a config-provider-internal hardcoded
  // header (round-4/round-7 network-body-capture work) to the generic
  // `sdkFeatures` deps mechanism shared with two-way replies (spec
  // 2026-08-01 §4.3) — see the `sdkFeatures negotiation` describe block
  // below for the general contract. This test pins the specific case the
  // web adapter relies on: passing 'networkbodies' actually reaches the
  // wire header.
  it('declares the networkbodies capability when the caller opts in via sdkFeatures', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ replayEnabled: false, replayDurationSec: 30, samplingRate: 1 }),
      { status: 200 },
    ));
    const cp = createConfigProvider({
      fetchImpl,
      configUrl: 'https://x/api/config',
      apiKey: 'k',
      sdkFeatures: ['networkbodies'],
    });
    await cp.refresh();
    const headers = fetchImpl.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['X-TX-SDK-Features']).toBe('networkbodies');
  });

  // The web adapter declares BOTH features on the one shared config fetch
  // (spec 2026-08-01 §4.3) — the server's `parseSdkFeatures` lowercases and
  // splits on commas, so both tokens must ride in a single comma-joined
  // header value.
  it('declares multiple capabilities as a single comma-separated header value', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ replayEnabled: false, replayDurationSec: 30, samplingRate: 1 }),
      { status: 200 },
    ));
    const cp = createConfigProvider({
      fetchImpl,
      configUrl: 'https://x/api/config',
      apiKey: 'k',
      sdkFeatures: ['replies', 'networkbodies'],
    });
    await cp.refresh();
    const headers = fetchImpl.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['X-TX-SDK-Features']).toBe('replies, networkbodies');
  });

  it('a transient error after a good resolution does NOT flip ON→OFF (stays last-good)', async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) {
        return Response.json({ replayEnabled: true, replayDurationSec: 30, samplingRate: 1.0 });
      }
      throw new Error('transient');
    }) as unknown as typeof fetch;
    const cp = createConfigProvider({ fetchImpl, configUrl: 'https://x/api/config', apiKey: 'k' });
    await cp.refresh();
    expect(cp.get().replayEnabled).toBe(true);
    await cp.refresh(); // transient failure
    expect(cp.get().replayEnabled).toBe(true); // last-good retained, never flipped to OFF by an error
  });

  it('refresh is a no-op within the TTL window, refetches after expiry', async () => {
    let calls = 0;
    let nowMs = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return Response.json({ replayEnabled: true, replayDurationSec: 30, samplingRate: 1.0 });
    }) as unknown as typeof fetch;
    const cp = createConfigProvider({
      fetchImpl,
      configUrl: 'https://x/api/config',
      apiKey: 'k',
      ttlMs: 300_000,
      now: () => nowMs,
    });
    await cp.refresh();
    expect(calls).toBe(1);
    nowMs = 100_000; // still within TTL
    await cp.refresh();
    expect(calls).toBe(1); // cached, no refetch
    nowMs = 400_000; // past TTL
    await cp.refresh();
    expect(calls).toBe(2); // refetched
  });

  // F18 (round-4 review): refresh() exposes a success/freshness signal, and
  // `force` bypasses the TTL gate — both needed so a periodic re-read loop
  // (the web adapter, 300s cadence) gets a real fetch every tick and can
  // tell a failed read apart from "nothing needed reading".
  describe('F18: refresh({force}) + success-boolean return', () => {
    it('resolves true on a fully validated 200', async () => {
      const cp = createConfigProvider({
        fetchImpl: fetchReturning(() =>
          Response.json({ replayEnabled: true, replayDurationSec: 30, samplingRate: 1.0 }),
        ),
        configUrl: 'https://x/api/config',
        apiKey: 'k',
      });
      await expect(cp.refresh()).resolves.toBe(true);
    });

    it('resolves false on a non-200', async () => {
      const cp = createConfigProvider({
        fetchImpl: fetchReturning(() => new Response('', { status: 503 })),
        configUrl: 'https://x/api/config',
        apiKey: 'k',
      });
      await expect(cp.refresh()).resolves.toBe(false);
    });

    it('resolves false on malformed JSON', async () => {
      const cp = createConfigProvider({
        fetchImpl: fetchReturning(() => new Response('not json', { status: 200 })),
        configUrl: 'https://x/api/config',
        apiKey: 'k',
      });
      await expect(cp.refresh()).resolves.toBe(false);
    });

    it('resolves false on a Zod-validation failure', async () => {
      const cp = createConfigProvider({
        fetchImpl: fetchReturning(() => Response.json({ replayEnabled: true })),
        configUrl: 'https://x/api/config',
        apiKey: 'k',
      });
      await expect(cp.refresh()).resolves.toBe(false);
    });

    it('a non-forced call within the TTL window resolves true without fetching (fresh, no read needed)', async () => {
      let calls = 0;
      let nowMs = 0;
      const fetchImpl = (async () => {
        calls += 1;
        return Response.json({ replayEnabled: true, replayDurationSec: 30, samplingRate: 1.0 });
      }) as unknown as typeof fetch;
      const cp = createConfigProvider({
        fetchImpl,
        configUrl: 'https://x/api/config',
        apiKey: 'k',
        ttlMs: 300_000,
        now: () => nowMs,
      });
      await cp.refresh();
      expect(calls).toBe(1);
      nowMs = 100_000; // still within TTL
      await expect(cp.refresh()).resolves.toBe(true);
      expect(calls).toBe(1); // no refetch — the TTL no-op path
    });

    it('force:true bypasses the TTL window and always issues a real fetch', async () => {
      let calls = 0;
      let nowMs = 0;
      const fetchImpl = (async () => {
        calls += 1;
        return Response.json({ replayEnabled: true, replayDurationSec: 30, samplingRate: 1.0 });
      }) as unknown as typeof fetch;
      const cp = createConfigProvider({
        fetchImpl,
        configUrl: 'https://x/api/config',
        apiKey: 'k',
        ttlMs: 300_000,
        now: () => nowMs,
      });
      await cp.refresh();
      expect(calls).toBe(1);
      nowMs = 1_000; // WELL within TTL — a non-forced call here would no-op
      await cp.refresh({ force: true });
      expect(calls).toBe(2); // forced anyway
    });

    it('force:true still resolves false on a failed forced fetch', async () => {
      let calls = 0;
      const fetchImpl = (async () => {
        calls += 1;
        if (calls === 1) {
          return Response.json({ replayEnabled: true, replayDurationSec: 30, samplingRate: 1.0 });
        }
        throw new Error('transient');
      }) as unknown as typeof fetch;
      const cp = createConfigProvider({ fetchImpl, configUrl: 'https://x/api/config', apiKey: 'k' });
      await cp.refresh();
      await expect(cp.refresh({ force: true })).resolves.toBe(false);
      // Last-good cache semantics unaffected by the boolean return.
      expect(cp.get().replayEnabled).toBe(true);
    });
  });

  // F32 (round-7 review, P1) — the web periodic re-read loop (adapter.ts)
  // fires `setInterval` ticks without awaiting the previous tick's
  // `refresh()`, and each tick's fetch timeout equals the interval, so two
  // `refresh()` calls can legitimately be in flight at once. Before this
  // fix, the cache committed in COMPLETION order: an older-started request
  // resolving AFTER a newer one silently overwrote the newer result —
  // undoing a remote privacy kill switch. Fixed with a request-sequence
  // number: only the LATEST-STARTED request may ever commit.
  describe('F32: overlapping refreshes commit in START order, not completion order', () => {
    /** A deferred promise the test resolves explicitly, to control completion order. */
    function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
      let resolve!: (v: T) => void;
      const promise = new Promise<T>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    }

    it("an older-started request never overwrites a newer one, even resolving last (F32's probe)", async () => {
      const gateA = deferred<Response>(); // request A (ON) — started first
      const gateB = deferred<Response>(); // request B (OFF) — started second
      let calls = 0;
      const fetchImpl = ((): typeof fetch => {
        return (async () => {
          calls += 1;
          return calls === 1 ? gateA.promise : gateB.promise;
        }) as unknown as typeof fetch;
      })();

      const cp = createConfigProvider({ fetchImpl, configUrl: 'https://x/api/config', apiKey: 'k' });

      // Start request A (ON) first.
      const refreshA = cp.refresh({ force: true });
      // Start request B (OFF) after A has already started (A's fetchImpl
      // call has already run synchronously up to its awaited promise).
      const refreshB = cp.refresh({ force: true });
      expect(calls).toBe(2); // both fetches are genuinely in flight

      // Resolve B (the NEWER request) first.
      gateB.resolve(
        Response.json({ replayEnabled: false, replayDurationSec: 30, samplingRate: 1.0, networkBodies: { captureBodies: false } }),
      );
      await expect(refreshB).resolves.toBe(true);
      expect(cp.get().replayEnabled).toBe(false);

      // THEN resolve A (the OLDER request) — it must NOT win despite
      // resolving last.
      gateA.resolve(
        Response.json({ replayEnabled: true, replayDurationSec: 30, samplingRate: 1.0, networkBodies: { captureBodies: true } }),
      );
      // A's own call reports it was superseded — not a fresh success — so a
      // caller like the web adapter's `bodyGateFailedClosed` never mistakes
      // a stale response for live confirmation.
      await expect(refreshA).resolves.toBe(false);

      // B's OFF result stands — A's stale ON never commits.
      expect(cp.get().replayEnabled).toBe(false);
      expect(cp.get().networkBodies?.captureBodies).toBe(false);
    });

    it('when the OLDER request resolves first, it still loses to the newer one that resolves later', async () => {
      const gateA = deferred<Response>();
      const gateB = deferred<Response>();
      let calls = 0;
      const fetchImpl = (async () => {
        calls += 1;
        return calls === 1 ? gateA.promise : gateB.promise;
      }) as unknown as typeof fetch;

      const cp = createConfigProvider({ fetchImpl, configUrl: 'https://x/api/config', apiKey: 'k' });

      const refreshA = cp.refresh({ force: true }); // ON, started first
      const refreshB = cp.refresh({ force: true }); // OFF, started second
      expect(calls).toBe(2);

      // Resolve A first this time (completion order == start order) — the
      // ordinary case, must still behave correctly.
      gateA.resolve(
        Response.json({ replayEnabled: true, replayDurationSec: 30, samplingRate: 1.0, networkBodies: { captureBodies: true } }),
      );
      await refreshA;

      gateB.resolve(
        Response.json({ replayEnabled: false, replayDurationSec: 30, samplingRate: 1.0, networkBodies: { captureBodies: false } }),
      );
      await expect(refreshB).resolves.toBe(true);

      expect(cp.get().replayEnabled).toBe(false);
      expect(cp.get().networkBodies?.captureBodies).toBe(false);
    });

    it('a superseded response that fails validation still reports false (no behavior change on that path)', async () => {
      const gateA = deferred<Response>();
      const gateB = deferred<Response>();
      let calls = 0;
      const fetchImpl = (async () => {
        calls += 1;
        return calls === 1 ? gateA.promise : gateB.promise;
      }) as unknown as typeof fetch;

      const cp = createConfigProvider({ fetchImpl, configUrl: 'https://x/api/config', apiKey: 'k' });

      const refreshA = cp.refresh({ force: true });
      const refreshB = cp.refresh({ force: true });
      expect(calls).toBe(2);

      gateB.resolve(
        Response.json({ replayEnabled: false, replayDurationSec: 30, samplingRate: 1.0 }),
      );
      await expect(refreshB).resolves.toBe(true);

      // A resolves last with a fully valid, but now-superseded, response.
      gateA.resolve(
        Response.json({ replayEnabled: true, replayDurationSec: 30, samplingRate: 1.0 }),
      );
      await expect(refreshA).resolves.toBe(false);
      expect(cp.get().replayEnabled).toBe(false);
    });
  });

  // Finding 1 (round 5, PR review): a deliberate wake/new-thread signal must
  // be able to bypass the TTL gate to re-resolve the config — otherwise a
  // config flip mid-session (replies turned on server-side, or a mount-time
  // fetch that transiently failed) stays invisible for up to the full 5-min
  // TTL window. refresh({ force: true }) must refetch even within the
  // window; default (no options / force omitted / force:false) must remain
  // byte-identical to the existing TTL-gated behavior above.
  it('refresh({ force: true }) bypasses the TTL window and refetches', async () => {
    let calls = 0;
    let nowMs = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return Response.json({ replayEnabled: true, replayDurationSec: 30, samplingRate: 1.0 });
    }) as unknown as typeof fetch;
    const cp = createConfigProvider({
      fetchImpl,
      configUrl: 'https://x/api/config',
      apiKey: 'k',
      ttlMs: 300_000,
      now: () => nowMs,
    });
    await cp.refresh();
    expect(calls).toBe(1);
    nowMs = 100_000; // still within TTL
    await cp.refresh({ force: true });
    expect(calls).toBe(2); // forced past the TTL gate
    await cp.refresh(); // ordinary call right after a forced one — TTL window restarted
    expect(calls).toBe(2);
    await cp.refresh({ force: false });
    expect(calls).toBe(2); // force:false is the same as omitted
  });

  // Finding 3 (round 6, PR review): sdk-react's wake() now issues
  // `provider.refresh({ force: true })` on every visibility return, which can
  // overlap in-flight with an earlier forced refresh still resolving. Without
  // a generation guard, whichever response *completes* last wins the cache
  // write — even if it was the *older* request — so a late-arriving stale
  // response can silently undo a newer gate flip. The fix must make the
  // LATER-STARTED refresh win regardless of completion order.
  it('two overlapping forced refreshes resolved out of order: the later-started response wins', async () => {
    type Resolver = (res: Response) => void;
    const resolvers: Resolver[] = [];
    let calls = 0;
    const fetchImpl = (() => {
      calls += 1;
      return new Promise<Response>((resolve) => {
        resolvers.push(resolve);
      });
    }) as unknown as typeof fetch;
    const cp = createConfigProvider({
      fetchImpl,
      configUrl: 'https://x/api/config',
      apiKey: 'k',
    });

    // Request 1 starts first (older gate: replies OFF).
    const p1 = cp.refresh({ force: true });
    // Request 2 starts second (newer gate: replies ON).
    const p2 = cp.refresh({ force: true });
    expect(calls).toBe(2);

    // Resolve the LATER-started request (2) FIRST, with the newer ON payload.
    resolvers[1]!(
      Response.json({
        replayEnabled: false,
        replayDurationSec: 30,
        samplingRate: 1.0,
        replies: { enabled: true },
      }),
    );
    await p2;
    expect(isRepliesEnabled(cp.get())).toBe(true);

    // Now resolve the EARLIER-started request (1), with the older OFF payload.
    // Completion order is reversed, but request 1 started BEFORE request 2 —
    // its stale response must be discarded, never written to the cache.
    resolvers[0]!(
      Response.json({ replayEnabled: false, replayDurationSec: 30, samplingRate: 1.0 }),
    );
    await p1;
    // The newer (request 2) result must still be in effect.
    expect(isRepliesEnabled(cp.get())).toBe(true);
  });

  it('a single refresh still updates the cache normally (generation guard does not regress the common case)', async () => {
    const cp = createConfigProvider({
      fetchImpl: fetchReturning(() =>
        Response.json({ replayEnabled: true, replayDurationSec: 45, samplingRate: 0.75 }),
      ),
      configUrl: 'https://x/api/config',
      apiKey: 'k',
    });
    await cp.refresh({ force: true });
    expect(cp.get()).toEqual({ replayEnabled: true, replayDurationSec: 45, samplingRate: 0.75 });
  });

  it('a stale response after a newer refresh FAILS does not resurrect old config', async () => {
    type Resolver = (res: Response) => void;
    type Rejecter = (err: unknown) => void;
    const resolvers: Resolver[] = [];
    const rejecters: Rejecter[] = [];
    const fetchImpl = (() => {
      return new Promise<Response>((resolve, reject) => {
        resolvers.push(resolve);
        rejecters.push(reject);
      });
    }) as unknown as typeof fetch;
    const cp = createConfigProvider({
      fetchImpl,
      configUrl: 'https://x/api/config',
      apiKey: 'k',
    });

    // Seed a last-good ON value first.
    resolvers.length = 0;
    const seed = cp.refresh({ force: true });
    resolvers[0]!(
      Response.json({ replayEnabled: true, replayDurationSec: 30, samplingRate: 1.0 }),
    );
    await seed;
    expect(cp.get().replayEnabled).toBe(true);

    // Request A (older) starts, then request B (newer) starts.
    const pA = cp.refresh({ force: true });
    const pB = cp.refresh({ force: true });
    const idxA = 1;
    const idxB = 2;

    // The newer request B fails first (network error) — fail-closed keeps
    // last-good (still true) per existing CONFIG-02 semantics.
    rejecters[idxB]!(new Error('transient'));
    await pB;
    expect(cp.get().replayEnabled).toBe(true);

    // The older, stale request A now resolves successfully with an OFF
    // payload. Even though it succeeded, it started BEFORE request B, so it
    // must be discarded — it must not resurrect/overwrite state after a
    // newer refresh has already started (and finished, even by failure).
    resolvers[idxA]!(
      Response.json({ replayEnabled: false, replayDurationSec: 30, samplingRate: 1.0 }),
    );
    await pA;
    expect(cp.get().replayEnabled).toBe(true);
  });

  it('uses an AbortSignal timeout so a hung fetch cannot wedge the provider', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    const cp = createConfigProvider({
      fetchImpl: fetchReturning(() =>
        Response.json({ replayEnabled: false, replayDurationSec: 30, samplingRate: 1.0 }),
      ),
      configUrl: 'https://x/api/config',
      apiKey: 'k',
    });
    await cp.refresh();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('breadcrumbs config (spec §6)', () => {
  it('defaults: enabled, all seven kinds, 100/16384/1024', () => {
    expect(BREADCRUMBS_CONFIG_DEFAULT).toEqual({
      enabled: true,
      kinds: ['navigation', 'tap', 'console', 'network', 'lifecycle', 'error', 'custom'],
      maxCount: 100,
      byteBudget: 16384,
      consoleEntryCap: 1024,
    });
  });

  it('ReplayConfigResponse still parses a legacy 3-field body (no breadcrumbs)', () => {
    const legacy = { replayEnabled: true, replayDurationSec: 30, samplingRate: 1 };
    expect(ReplayConfigResponse.safeParse(legacy).success).toBe(true);
  });

  it('ReplayConfigResponse parses a body WITH a breadcrumbs block', () => {
    const body = {
      replayEnabled: false, replayDurationSec: 30, samplingRate: 0,
      breadcrumbs: {
        enabled: true, kinds: ['navigation', 'error'],
        maxCount: 50, byteBudget: 8192, consoleEntryCap: 512,
      },
    };
    const parsed = ReplayConfigResponse.safeParse(body);
    expect(parsed.success).toBe(true);
  });

  it('rejects a breadcrumbs block with an unknown kind or extra key (strict)', () => {
    const base = { replayEnabled: false, replayDurationSec: 30, samplingRate: 0 };
    const badKind = { ...base, breadcrumbs: { ...BREADCRUMBS_CONFIG_DEFAULT, kinds: ['scroll'] } };
    expect(ReplayConfigResponse.safeParse(badKind).success).toBe(false);
    const extraKey = { ...base, breadcrumbs: { ...BREADCRUMBS_CONFIG_DEFAULT, surprise: 1 } };
    expect(ReplayConfigResponse.safeParse(extraKey).success).toBe(false);
  });

  it('getBreadcrumbsConfig falls back to the default when the block is absent', () => {
    expect(getBreadcrumbsConfig(REPLAY_CONFIG_OFF)).toEqual(BREADCRUMBS_CONFIG_DEFAULT);
    const withBlock = {
      ...REPLAY_CONFIG_OFF,
      breadcrumbs: { ...BREADCRUMBS_CONFIG_DEFAULT, maxCount: 25 },
    };
    expect(getBreadcrumbsConfig(withBlock).maxCount).toBe(25);
  });
});

describe('replies config (two-way replies server core)', () => {
  it('ReplayConfigResponse parses a body WITH a replies block and carries it through', () => {
    const body = {
      replayEnabled: false, replayDurationSec: 30, samplingRate: 0,
      replies: { enabled: true },
    };
    const parsed = ReplayConfigResponse.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.replies).toEqual({ enabled: true });
    }
  });

  it('ReplayConfigResponse still parses a body with no replies key (ships dark)', () => {
    const legacy = { replayEnabled: true, replayDurationSec: 30, samplingRate: 1 };
    const parsed = ReplayConfigResponse.safeParse(legacy);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.replies).toBeUndefined();
    }
  });

  it('still rejects an unrelated unknown top-level key (schema stays strict)', () => {
    const body = {
      replayEnabled: false, replayDurationSec: 30, samplingRate: 0,
      somethingUnexpected: true,
    };
    expect(ReplayConfigResponse.safeParse(body).success).toBe(false);
  });
});

describe('sdkFeatures negotiation', () => {
  it('carries the negotiated dashboard report hotkey through the config cache', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      replayEnabled: false,
      replayDurationSec: 30,
      samplingRate: 1,
      reportHotkey: { binding: 'Alt+R' },
    }), { status: 200 }));
    const provider = createConfigProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      configUrl: 'https://x.test/api/config',
      apiKey: 'txx_live_k',
      sdkFeatures: ['reporthotkey'],
    });

    await provider.refresh();

    expect(provider.get().reportHotkey).toEqual({ binding: 'Alt+R' });
  });

  it('sends X-TX-SDK-Features when features are supplied', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      replayEnabled: false, replayDurationSec: 30, samplingRate: 1.0,
      replies: { enabled: true },
    }), { status: 200 }));
    const provider = createConfigProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      configUrl: 'https://x.test/api/config', apiKey: 'txx_live_k',
      sdkFeatures: ['replies'],
    });
    await provider.refresh();
    const callArgs = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit]);
    const headers = callArgs[1].headers as Record<string, string>;
    expect(headers['X-TX-SDK-Features']).toBe('replies');
    expect(isRepliesEnabled(provider.get())).toBe(true);
  });

  it('omits the header when no features are supplied, and absence of the block means off', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      replayEnabled: false, replayDurationSec: 30, samplingRate: 1.0,
    }), { status: 200 }));
    const provider = createConfigProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      configUrl: 'https://x.test/api/config', apiKey: 'txx_live_k',
    });
    await provider.refresh();
    const callArgs = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit]);
    const headers = callArgs[1].headers as Record<string, string>;
    expect('X-TX-SDK-Features' in headers).toBe(false);
    expect(isRepliesEnabled(provider.get())).toBe(false);
  });

  // Reporter identity recognition (spec 2026-08-06) — same capability-
  // negotiation doctrine as `replies`/`networkbodies` above. Missing this
  // token means the server never sends the `identity` block at all, and
  // `identity.enabled` stays undefined forever with nothing in the SDK's
  // logs to explain why — see the task-14 brief's "Capability negotiation"
  // section.
  it('declares the identity capability and carries the enabled block through', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      replayEnabled: false, replayDurationSec: 30, samplingRate: 1.0,
      identity: { enabled: true },
    }), { status: 200 }));
    const provider = createConfigProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      configUrl: 'https://x.test/api/config', apiKey: 'txx_live_k',
      sdkFeatures: ['identity'],
    });
    await provider.refresh();
    const callArgs = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit]);
    const headers = callArgs[1].headers as Record<string, string>;
    expect(headers['X-TX-SDK-Features']).toBe('identity');
    expect(isIdentityEnabled(provider.get())).toBe(true);
  });

  it('identity.enabled is false when the block is absent (old server or no secret configured)', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      replayEnabled: false, replayDurationSec: 30, samplingRate: 1.0,
    }), { status: 200 }));
    const provider = createConfigProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      configUrl: 'https://x.test/api/config', apiKey: 'txx_live_k',
      sdkFeatures: ['identity'],
    });
    await provider.refresh();
    expect(isIdentityEnabled(provider.get())).toBe(false);
  });
});
