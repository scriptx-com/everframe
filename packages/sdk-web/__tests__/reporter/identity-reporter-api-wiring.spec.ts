// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Task 14 review, CRITICAL 1 — the third broken call site: adapter.ts's only
// `createReporterApi(...)` construction (the thread-client's reporter API,
// used for /api/reporter/* polling) was built with no `identityToken` at
// all, so `api.ts`'s `if (deps.identityToken)` was always false regardless
// of what a host set via `setIdentityToken`. This drives a REAL poll through
// the adapter + client (no submitReportFromDraft/provider.tsx involved — that
// surface is covered by the ingest submit tests in
// __tests__/integration/end-to-end.spec.tsx) and asserts the header on the
// real /api/reporter/threads fetch call.
//
// Re-review Finding A — the FIRST version of these tests put the header
// `expect(...)` INSIDE the fetch mock. A failing assertion there throws
// inside the mocked `fetch`, which rejects the promise thread-client.ts's
// pollOnce() awaits — and production swallows exactly that (its own catch
// keeps polling cadence, per thread-client.ts's fail-closed-on-network-error
// posture). The test body only ever checked "was some /api/reporter/threads
// call recorded", which stays true even with the header missing entirely —
// the test could not fail on the thing it claimed to prove. Fixed by
// capturing the observed header into a plain variable INSIDE the mock (no
// assertion there) and asserting on that variable in the test body, AFTER
// the `waitFor` confirms the call happened.
//
// Also covers Finding B — the crash-sink drain (adapter.ts's uncaught-error
// handler) was the fifth live call site that still built `drainOutbox(...)`
// with no `identityToken`, even though `identityTokenReader` was already in
// scope in that closure. A recognized user's crash would ship anonymously.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, __internalClientState, ensureDeviceToken } from '@traceitx/sdk-core';
import { createWebPlatformAdapter, type WebPlatformAdapter } from '../../src/adapter.js';

const adapters: WebPlatformAdapter[] = [];
afterEach(() => {
  while (adapters.length) adapters.pop()!.__testCleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
}

function tokenHeaderOf(init: RequestInit | undefined): string | null | undefined {
  const headers = init?.headers as Record<string, string> | Headers | undefined;
  return headers instanceof Headers
    ? headers.get('X-TX-Identity-Token')
    : headers?.['X-TX-Identity-Token'];
}

const mkJwt = (expSec: number): string => {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', exp: expSec })}.sig`;
};

describe('adapter.ts thread-client reporterApi — identity token wiring', () => {
  it('a real /api/reporter/threads poll carries X-TX-Identity-Token when a token is set and recognition is enabled', async () => {
    const jwt = mkJwt(Date.now() / 1000 + 300);
    let observedHeader: string | null | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.includes('/api/config')) {
        return new Response(
          JSON.stringify({
            replayEnabled: false, replayDurationSec: 30, samplingRate: 1,
            replies: { enabled: true },
            identity: { enabled: true },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/reporter/threads')) {
        observedHeader = tokenHeaderOf(init);
        return new Response(JSON.stringify({ threads: [] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createWebPlatformAdapter({ apiKey: 'k_identity_reporter_api' });
    adapters.push(adapter);
    const client = createClient(adapter);
    client.init({ apiKey: 'k_identity_reporter_api' });
    // Same seam provider.tsx binds right after createClient.
    adapter.__setIdentityTokenHolder(() => __internalClientState.get(client)?.identityToken);
    client.setIdentityToken(jwt);

    // The thread client's poll only PRESENTS an existing device token — it
    // never mints one itself (that happens on submit). Seed one directly so
    // pollOnce() doesn't bail out at its own loadToken() check before ever
    // reaching listThreads().
    if (adapter.reporterCredentials) await ensureDeviceToken(adapter.reporterCredentials);
    await adapter.__initReplay(); // resolves the config fetch (replies + identity blocks)
    await adapter.threads?.refresh(); // drives a real listThreads() call

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).includes('/api/reporter/threads'))).toBe(true);
    });

    // Asserted here, OUTSIDE the mock — see the Finding A comment at the top.
    expect(observedHeader).toBe(jwt);
  });

  it('omits the header when recognition is disabled, even though a token was set', async () => {
    const jwt = mkJwt(Date.now() / 1000 + 300);
    let observedHeader: string | null | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.includes('/api/config')) {
        return new Response(
          JSON.stringify({
            replayEnabled: false, replayDurationSec: 30, samplingRate: 1,
            replies: { enabled: true },
            // No `identity` block — same wire shape as no signing secret configured.
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/reporter/threads')) {
        observedHeader = tokenHeaderOf(init);
        return new Response(JSON.stringify({ threads: [] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createWebPlatformAdapter({ apiKey: 'k_identity_reporter_api_off' });
    adapters.push(adapter);
    const client = createClient(adapter);
    client.init({ apiKey: 'k_identity_reporter_api_off' });
    adapter.__setIdentityTokenHolder(() => __internalClientState.get(client)?.identityToken);
    client.setIdentityToken(jwt);

    if (adapter.reporterCredentials) await ensureDeviceToken(adapter.reporterCredentials);
    await adapter.__initReplay();
    await adapter.threads?.refresh();

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).includes('/api/reporter/threads'))).toBe(true);
    });

    expect(observedHeader).toBeFalsy();
  });
});

describe('adapter.ts crash-sink drain — identity token wiring (Finding B)', () => {
  it('a real crash-report drain carries X-TX-Identity-Token when a token is set and recognition is enabled', async () => {
    const jwt = mkJwt(Date.now() / 1000 + 300);
    let observedHeader: string | null | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.includes('/api/config')) {
        return new Response(
          JSON.stringify({
            replayEnabled: false, replayDurationSec: 30, samplingRate: 1,
            identity: { enabled: true },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/ingest')) {
        observedHeader = tokenHeaderOf(init);
        return new Response(JSON.stringify({ status: 'received' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createWebPlatformAdapter({ apiKey: 'k_identity_crash_sink' });
    adapters.push(adapter);
    const client = createClient(adapter);
    client.init({ apiKey: 'k_identity_crash_sink' });
    adapter.__setIdentityTokenHolder(() => __internalClientState.get(client)?.identityToken);
    client.setIdentityToken(jwt);

    // Same ordering dependency as the poll tests above: identity.enabled
    // must be resolved before the crash fires, so the reader's gate reads
    // the live value rather than the fail-closed default.
    await adapter.__initReplay();

    // PR review, round 3 (Serious) — the crash sink now captures its subject
    // from the holder's CACHE ONLY (`peek()`, never the provider — see the
    // dedicated describe block below), so a real crash needs the cache
    // already warm, exactly as it would be in practice by the time a crash
    // sink actually fires (the host set identity, and something — a submit,
    // a poll — already resolved it at least once). Mirrors the round-3
    // describe block's warm-up call.
    await adapter.__identityTokenReader.get(Date.now());

    // Trigger the SAME uncaught-error path adapter.ts's crashSink installs
    // on window.onerror (mirrors replies-disabled-credential-veto.spec.ts's
    // crash-outbox-drain test).
    const err = new Error('identity-crash-path');
    err.stack = 'Error: identity-crash-path\n    at f (a.ts:1:1)';
    window.onerror?.('identity-crash-path', 'a.ts', 1, 1, err);

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).includes('/api/ingest'))).toBe(true);
    });

    expect(observedHeader).toBe(jwt);
  });

  // PR review, round 3 (Serious) — the flip side of the warm-cache test
  // above, and the EXPLICIT accepted tradeoff of switching crash-time
  // capture to `peek()`: if a crash fires before ANYTHING has ever resolved
  // the identity (cache genuinely empty — `set()` was called but `get()`
  // never was), `peek()` returns `null` by construction, since it never
  // invokes the provider to find out what it WOULD resolve to. The crash
  // report goes out anonymous rather than paying a provider round-trip (up
  // to `IDENTITY_PROVIDER_TIMEOUT_MS`) on a path that must never wait.
  it('goes out anonymous when a crash fires before the cache was ever warmed, even though a token was set', async () => {
    const jwt = mkJwt(Date.now() / 1000 + 300);
    let observedHeader: string | null | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.includes('/api/config')) {
        return new Response(
          JSON.stringify({
            replayEnabled: false, replayDurationSec: 30, samplingRate: 1,
            identity: { enabled: true },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/ingest')) {
        observedHeader = tokenHeaderOf(init);
        return new Response(JSON.stringify({ status: 'received' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createWebPlatformAdapter({ apiKey: 'k_identity_crash_cold' });
    adapters.push(adapter);
    const client = createClient(adapter);
    client.init({ apiKey: 'k_identity_crash_cold' });
    adapter.__setIdentityTokenHolder(() => __internalClientState.get(client)?.identityToken);
    client.setIdentityToken(jwt);

    await adapter.__initReplay();
    // Deliberately NO warm-up `get()` call here — the cache is cold.

    const err = new Error('identity-crash-cold-path');
    err.stack = 'Error: identity-crash-cold-path\n    at f (a.ts:1:1)';
    window.onerror?.('identity-crash-cold-path', 'a.ts', 1, 1, err);

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).includes('/api/ingest'))).toBe(true);
    });

    expect(observedHeader).toBeFalsy();
  });

  it('omits the header when recognition is disabled, even though a token was set', async () => {
    const jwt = mkJwt(Date.now() / 1000 + 300);
    let observedHeader: string | null | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.includes('/api/config')) {
        return new Response(
          JSON.stringify({ replayEnabled: false, replayDurationSec: 30, samplingRate: 1 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/ingest')) {
        observedHeader = tokenHeaderOf(init);
        return new Response(JSON.stringify({ status: 'received' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createWebPlatformAdapter({ apiKey: 'k_identity_crash_sink_off' });
    adapters.push(adapter);
    const client = createClient(adapter);
    client.init({ apiKey: 'k_identity_crash_sink_off' });
    adapter.__setIdentityTokenHolder(() => __internalClientState.get(client)?.identityToken);
    client.setIdentityToken(jwt);

    await adapter.__initReplay();

    const err = new Error('identity-crash-path-off');
    err.stack = 'Error: identity-crash-path-off\n    at f (a.ts:1:1)';
    window.onerror?.('identity-crash-path-off', 'a.ts', 1, 1, err);

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).includes('/api/ingest'))).toBe(true);
    });

    expect(observedHeader).toBeFalsy();
  });
});

// PR review, round 3 (Serious) — the crash sink used to capture its subject
// AFTER `outbox.enqueue()`, via `identityTokenReader.get()` (the real, async,
// provider-invoking reader). The fix moves the capture BEFORE the enqueue and
// switches it to `IdentityTokenHolder.peek()` — cache-only, synchronous,
// never touches the host's provider — reasoning that a crash sink must never
// wait on a provider (identity is an enhancement, never a blocker) while
// still recording "the identity that was live when the crash happened"
// instead of whatever happens to still be around a beat later.
describe('adapter.ts crash-sink — peek captures crash-time identity without invoking the provider (round 3, Serious)', () => {
  it('records the crash-time cached subject and never invokes the provider during the crash path', async () => {
    let providerCalls = 0;
    const jwt = mkJwt(Date.now() / 1000 + 300);
    // A PROVIDER function (not a one-shot string) so calls to it are
    // observable — the load-bearing signal for "never invokes the provider".
    const provider = (): string => {
      providerCalls += 1;
      return jwt;
    };

    let observedHeader: string | null | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.includes('/api/config')) {
        return new Response(
          JSON.stringify({
            replayEnabled: false, replayDurationSec: 30, samplingRate: 1,
            identity: { enabled: true },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/ingest')) {
        observedHeader = tokenHeaderOf(init);
        return new Response(JSON.stringify({ status: 'received' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createWebPlatformAdapter({ apiKey: 'k_identity_crash_peek' });
    adapters.push(adapter);
    const client = createClient(adapter);
    client.init({ apiKey: 'k_identity_crash_peek' });
    adapter.__setIdentityTokenHolder(() => __internalClientState.get(client)?.identityToken);
    client.setIdentityToken(provider);

    await adapter.__initReplay(); // resolves identity.enabled

    // Warm the holder's cache — exactly ONE provider call, standing in for
    // "the identity was already live" before the crash happens (e.g. an
    // earlier submit or poll already resolved and cached it).
    await adapter.__identityTokenReader.get(Date.now());
    expect(providerCalls).toBe(1);

    // Trigger the SAME uncaught-error path as the Finding B tests above.
    const err = new Error('identity-crash-peek-path');
    err.stack = 'Error: identity-crash-peek-path\n    at f (a.ts:1:1)';
    window.onerror?.('identity-crash-peek-path', 'a.ts', 1, 1, err);

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => urlOf(c[0] as RequestInfo | URL).includes('/api/ingest'))).toBe(true);
    });

    // Asserted here, OUTSIDE the mock and OUTSIDE the crash handler — the
    // crash report is attributed to the cached identity...
    expect(observedHeader).toBe(jwt);
    // ...and getting there — capture, enqueue, and drain — never asked the
    // host's provider again. Pre-fix this would be 2: one for the (async,
    // post-enqueue) subject capture, one for the drain-time gate.
    expect(providerCalls).toBe(1);
  });
});

// Adversarial review of PR #218 round 2, finding 3 — the COLD-START TWIN.
// `__identityTokenPending()` is what tells the vitals collector "no token yet,
// but one IS coming" apart from "no token, and none ever will be". It is
// gated identically to `__peekIdentityToken()`, because the same gate decides
// whether a token can ever arrive: with recognition off for the project
// nothing is pending no matter what the host set, and withholding the
// self-declared block on that basis would make it wait forever.
describe('adapter.__identityTokenPending — the cold-start twin gate', () => {
  const configFetch = (identityEnabled: boolean) =>
    vi.fn(async (input: RequestInfo | URL) => {
      if (urlOf(input).includes('/api/config')) {
        return new Response(
          JSON.stringify({
            replayEnabled: false,
            replayDurationSec: 30,
            samplingRate: 1,
            ...(identityEnabled ? { identity: { enabled: true } } : {}),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200 });
    });

  const boot = async (identityEnabled: boolean, key: string) => {
    vi.stubGlobal('fetch', configFetch(identityEnabled));
    const adapter = createWebPlatformAdapter({ apiKey: key });
    adapters.push(adapter);
    const client = createClient(adapter);
    client.init({ apiKey: key });
    adapter.__setIdentityTokenHolder(() => __internalClientState.get(client)?.identityToken);
    await adapter.__initReplay(); // resolves the config fetch
    return { adapter, client };
  };

  it('is false before a host sets any token source', async () => {
    const { adapter } = await boot(true, 'k_pending_none');
    expect(adapter.__identityTokenPending()).toBe(false);
  });

  it('is true while an async provider has not resolved, and false once it has', async () => {
    const { adapter, client } = await boot(true, 'k_pending_async');
    const jwt = mkJwt(Date.now() / 1000 + 300);
    let release!: (t: string) => void;
    const pendingToken = new Promise<string>((r) => {
      release = r;
    });
    client.setIdentityToken(() => pendingToken);

    // The moment that used to mint the unverified twin: a source is set, the
    // cache is cold, and the collector's first summary is about to go out.
    expect(adapter.__peekIdentityToken()).toBeNull();
    expect(adapter.__identityTokenPending()).toBe(true);

    const warming = adapter.__identityTokenReader.get(Date.now());
    release(jwt);
    await warming;

    expect(adapter.__peekIdentityToken()).toBe(jwt);
    expect(adapter.__identityTokenPending()).toBe(false);
  });

  // ROUND 5 — a provider that answers "nobody is signed in" leaves the holder
  // with no usable token, so the self-declared block stays withheld and the
  // session is ANONYMOUS. That is the stateless rule's known cost and the
  // trade invariant 1 wants; see `IdentityTokenHolder.hasUnresolvedSource`.
  it('stays true for a configured provider that resolves to null', async () => {
    const { adapter, client } = await boot(true, 'k_pending_null');
    client.setIdentityToken(async () => null);
    expect(adapter.__identityTokenPending()).toBe(true);
    await adapter.__identityTokenReader.get(Date.now());
    expect(adapter.__identityTokenPending()).toBe(true);
  });

  // …and the host's opt-out: say there is nobody signed in, rather than
  // wiring a provider that says so. No source, so nothing is withheld.
  it('is false once the host clears the token source with setIdentityToken(null)', async () => {
    const { adapter, client } = await boot(true, 'k_pending_cleared');
    client.setIdentityToken(async () => null);
    expect(adapter.__identityTokenPending()).toBe(true);
    client.setIdentityToken(null);
    expect(adapter.__identityTokenPending()).toBe(false);
  });

  it('is false when recognition is DISABLED for the project, token source or not', async () => {
    const { adapter, client } = await boot(false, 'k_pending_off');
    client.setIdentityToken(async () => mkJwt(Date.now() / 1000 + 300));
    // No token is coming — the gate would refuse to invoke the provider at
    // all — so the self-declared block must go out immediately.
    expect(adapter.__identityTokenPending()).toBe(false);
  });
});
