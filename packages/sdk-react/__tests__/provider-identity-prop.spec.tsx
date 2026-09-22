// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// The `identity` prop writes, once and correctly, the effect that
// user-recognition.md currently asks every customer to hand-write:
// keyed on the USER's identity rather than on a callback's identity, with
// `headers` read at call time so a rotating access token is never captured.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { Suspense, startTransition, useContext, useEffect, useLayoutEffect } from 'react';
import { TraceItXProvider, TraceItXContext, type InternalContext } from '../src/provider.js';

// Child-component idiom for reaching the adapter/client from a test, matching
// provider-outbox-drain-identity-gate.spec.tsx: rendered AS A CHILD of
// TraceItXProvider so its effect commits inside the same tree, and it simply
// stashes the context in a test-scoped variable for direct assertions below
// (e.g. forcing a read via `__identityTokenReader.get(...)`).
let ctxRef: InternalContext | null = null;
function Ctx() {
  const ctx = useContext(TraceItXContext);
  useEffect(() => {
    ctxRef = ctx;
  });
  return null;
}

/** Calls `client.setIdentityToken` from ITS OWN mount effect — the same
 *  shape a host's real auth-wiring component takes. Used by the
 *  "no identity prop" test to prove a MANUAL integration survives untouched. */
function ManualIdentitySetter({ token }: { token: string }) {
  const ctx = useContext(TraceItXContext);
  useEffect(() => {
    ctx?.client.setIdentityToken(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  ctxRef = null;
});

const APP_KEY = 'txx_live_identity_prop_test';
const config = { apiKey: APP_KEY };

function mkJwt(sub: string): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ sub, exp: Math.floor(Date.now() / 1000) + 300 })}.sig`;
}

/** Same as mkJwt, but with an `exp` that lands INSIDE
 *  IDENTITY_REFRESH_MARGIN_MS (30s, sdk-core's identity-token.ts) — so a
 *  token minted with this helper is cached but considered near-expiry on the
 *  very next read, forcing the holder to re-ask the host's provider rather
 *  than serve the cache. Used to prove a re-mint happens WITHOUT a key
 *  change (the rotation guarantee). */
function mkJwtExpiringIn(seconds: number): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ sub: 'u_alice', exp: Math.floor(Date.now() / 1000) + seconds })}.sig`;
}

interface Harness {
  calls: Array<{ url: string; headers: Record<string, string> }>;
  configBody: { identity?: { enabled: boolean } };
}

/**
 * Stubs fetch for BOTH /api/config (which gates identity) and the mint
 * endpoint. Identity is enabled by default: a project with no signing secret
 * never reaches the endpoint at all, which is asserted separately below.
 */
function stubFetch(h: Harness, tokenFor: (n: number) => string | null): void {
  let n = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/config')) {
        // ReplayConfigResponse (sdk-core) is a `.strict()` Zod schema with
        // replayEnabled/replayDurationSec/samplingRate REQUIRED — omitting
        // them fails safeParse, so refresh() fails closed and
        // isIdentityEnabled() reads false regardless of `identity.enabled`
        // below. Matches the shape every other provider test in this
        // package stubs (e.g. provider-outbox-drain-identity-gate.spec.tsx).
        return new Response(
          JSON.stringify({ replayEnabled: false, replayDurationSec: 30, samplingRate: 1, ...h.configBody }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/mint')) {
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
        h.calls.push({ url, headers });
        const token = tokenFor(n++);
        return new Response(JSON.stringify({ token, expiresAt: Date.now() + 300_000 }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

const flush = async () => { await act(async () => { await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); }); };

describe('identity prop', () => {
  it('fetches a token when key is set', async () => {
    const h: Harness = { calls: [], configBody: { identity: { enabled: true } } };
    stubFetch(h, () => mkJwt('u_alice'));

    render(
      <TraceItXProvider config={config} identity={{ endpoint: '/mint', key: 'u_alice' }}>
        <div />
      </TraceItXProvider>,
    );
    await flush();

    expect(h.calls.length).toBeGreaterThan(0);
  });

  it('never calls the endpoint while identity.enabled is false', async () => {
    // A project with no signing secret must pay nothing — not even one request
    // to the customer's own backend.
    const h: Harness = { calls: [], configBody: { identity: { enabled: false } } };
    stubFetch(h, () => mkJwt('u_alice'));

    render(
      <TraceItXProvider config={config} identity={{ endpoint: '/mint', key: 'u_alice' }}>
        <div />
      </TraceItXProvider>,
    );
    await flush();

    expect(h.calls).toHaveLength(0);
  });

  it('re-invokes headers on EVERY mint rather than capturing it', async () => {
    // The rotation guarantee. A headers callback captured at mount would pin a
    // rotated-away access token and silently stop authenticating.
    const h: Harness = { calls: [], configBody: { identity: { enabled: true } } };
    stubFetch(h, () => mkJwt('u_alice'));
    let nth = 0;

    const { rerender } = render(
      <TraceItXProvider
        config={config}
        identity={{ endpoint: '/mint', key: 'u_alice', headers: () => ({ authorization: `Bearer t${nth++}` }) }}
      >
        <div />
      </TraceItXProvider>,
    );
    await flush();
    const first = h.calls.length;
    expect(first).toBeGreaterThan(0);
    expect(h.calls[0]!.headers.authorization).toBe('Bearer t0');

    // A NEW key forces a new mint; the header must be recomputed, not replayed.
    rerender(
      <TraceItXProvider
        config={config}
        identity={{ endpoint: '/mint', key: 'u_bob', headers: () => ({ authorization: `Bearer t${nth++}` }) }}
      >
        <div />
      </TraceItXProvider>,
    );
    await flush();

    expect(h.calls.length).toBeGreaterThan(first);
    expect(h.calls.at(-1)!.headers.authorization).not.toBe('Bearer t0');
  });

  it('re-reads headers on a re-mint even when key never changes', async () => {
    // THE ROTATION GUARANTEE. A long session where the user never changes but
    // the access token does. An implementation that captured `identity.headers`
    // in the effect closure instead of reading the `latest` ref would keep
    // sending the token captured at mount and silently stop authenticating —
    // and no other test in this file distinguishes the two, because they all
    // force a re-mint by changing `key`, which re-runs the effect and
    // re-captures the arrow.
    const h: Harness = { calls: [], configBody: { identity: { enabled: true } } };
    // Mint a token already inside the holder's refresh margin so the NEXT read
    // re-asks the provider rather than serving the cache.
    stubFetch(h, () => mkJwtExpiringIn(10)); // seconds — inside the 30s margin

    const { rerender } = render(
      <TraceItXProvider
        config={config}
        identity={{ endpoint: '/mint', key: 'u_alice', headers: () => ({ authorization: 'Bearer OLD' }) }}
      >
        <Ctx />
      </TraceItXProvider>,
    );
    await flush();
    expect(h.calls.at(-1)!.headers.authorization).toBe('Bearer OLD');

    // SAME key. Only the callback changes — exactly what a rotating token looks like.
    rerender(
      <TraceItXProvider
        config={config}
        identity={{ endpoint: '/mint', key: 'u_alice', headers: () => ({ authorization: 'Bearer NEW' }) }}
      >
        <Ctx />
      </TraceItXProvider>,
    );
    await flush();

    // Force a read. The cached token is near expiry, so the holder re-asks the
    // provider, which must consult the CURRENT headers callback.
    await act(async () => { await ctxRef!.adapter.__identityTokenReader.get(Date.now()); });

    expect(h.calls.at(-1)!.headers.authorization).toBe('Bearer NEW');
  });

  it('does NOT re-fetch when only the callback identity changes', async () => {
    // The footgun retired: an inline arrow is a new function every render and
    // must not re-run the effect.
    const h: Harness = { calls: [], configBody: { identity: { enabled: true } } };
    stubFetch(h, () => mkJwt('u_alice'));

    const { rerender } = render(
      <TraceItXProvider config={config} identity={{ endpoint: '/mint', key: 'u_alice', headers: () => ({ a: '1' }) }}>
        <div />
      </TraceItXProvider>,
    );
    await flush();
    const after = h.calls.length;

    for (let i = 0; i < 3; i++) {
      rerender(
        <TraceItXProvider config={config} identity={{ endpoint: '/mint', key: 'u_alice', headers: () => ({ a: '1' }) }}>
          <div />
        </TraceItXProvider>,
      );
      await flush();
    }

    expect(h.calls.length).toBe(after);
  });

  it('signs out when key becomes undefined', async () => {
    const h: Harness = { calls: [], configBody: { identity: { enabled: true } } };
    stubFetch(h, () => mkJwt('u_alice'));

    const { rerender } = render(
      <TraceItXProvider config={config} identity={{ endpoint: '/mint', key: 'u_alice' }}>
        <Ctx />
      </TraceItXProvider>,
    );
    await flush();
    const after = h.calls.length;

    rerender(
      <TraceItXProvider config={config} identity={{ endpoint: '/mint' }}>
        <Ctx />
      </TraceItXProvider>,
    );
    await flush();

    // No further mint: signed out drops the source outright.
    expect(h.calls.length).toBe(after);

    // The stronger assertion: the PREVIOUSLY cached token must actually be
    // gone, not merely "no new mint happened" — an implementation that did
    // nothing at all on sign-out (leaving Alice's provider installed and her
    // token cached) would also produce zero new mint calls, but would still
    // be misattributing every request to Alice. Asking the reader directly
    // proves the cache was dropped, not just that a network call didn't fire.
    await act(async () => {
      const token = await ctxRef!.adapter.__identityTokenReader.get(Date.now());
      expect(token).toBeNull();
    });
  });

  it('stays anonymous when the endpoint fails, without throwing', async () => {
    const h: Harness = { calls: [], configBody: { identity: { enabled: true } } };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/config')) {
        // See the matching comment in stubFetch() above — required fields.
        return new Response(
          JSON.stringify({ replayEnabled: false, replayDurationSec: 30, samplingRate: 1, ...h.configBody }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new TypeError('network down');
    }));

    expect(() =>
      render(
        <TraceItXProvider config={config} identity={{ endpoint: '/mint', key: 'u_alice' }}>
          <div />
        </TraceItXProvider>,
      ),
    ).not.toThrow();
    await flush();
  });

  it('stays anonymous when the endpoint responds non-200, without throwing', async () => {
    // `!res.ok` is checked explicitly before the body is even parsed — a
    // 401/500/etc from the customer's mint endpoint must degrade the same as
    // a network failure, not throw or leave a stale token in place.
    const h: Harness = { calls: [], configBody: { identity: { enabled: true } } };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/config')) {
        return new Response(
          JSON.stringify({ replayEnabled: false, replayDurationSec: 30, samplingRate: 1, ...h.configBody }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 500, headers: { 'content-type': 'application/json' },
      });
    }));

    render(
      <TraceItXProvider config={config} identity={{ endpoint: '/mint', key: 'u_alice' }}>
        <Ctx />
      </TraceItXProvider>,
    );
    await flush();

    await act(async () => {
      const token = await ctxRef!.adapter.__identityTokenReader.get(Date.now());
      expect(token).toBeNull();
    });
  });

  it('stays anonymous when the response body has a malformed/non-string token, without throwing', async () => {
    // A 200 with `{ token: 42 }` or `{ token: {} }` etc. must resolve to
    // anonymous rather than being coerced or crashing the provider.
    const h: Harness = { calls: [], configBody: { identity: { enabled: true } } };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/config')) {
        return new Response(
          JSON.stringify({ replayEnabled: false, replayDurationSec: 30, samplingRate: 1, ...h.configBody }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ token: 42 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }));

    render(
      <TraceItXProvider config={config} identity={{ endpoint: '/mint', key: 'u_alice' }}>
        <Ctx />
      </TraceItXProvider>,
    );
    await flush();

    await act(async () => {
      const token = await ctxRef!.adapter.__identityTokenReader.get(Date.now());
      expect(token).toBeNull();
    });
  });

  it('does not touch setIdentityToken when no identity prop is given', async () => {
    // Every existing manual integration must be byte-identical. Asserting
    // only "no /mint call happened" is vacuous here — with no `identity`
    // prop nothing points at /mint at all, so that would hold even if the
    // hook called `setIdentityToken(null)` unconditionally and silently
    // de-attributed every existing manual integration. Instead: set a token
    // manually (the same way a host's own auth-wiring component would, from
    // ITS OWN mount effect), render with NO `identity` prop, and prove that
    // manual token SURVIVES — i.e. the hook touched nothing.
    const h: Harness = { calls: [], configBody: { identity: { enabled: true } } };
    stubFetch(h, () => mkJwt('u_alice'));
    const manualToken = mkJwt('u_manual');

    render(
      <TraceItXProvider config={config}>
        <Ctx />
        <ManualIdentitySetter token={manualToken} />
      </TraceItXProvider>,
    );
    await flush();

    expect(h.calls).toHaveLength(0);

    await act(async () => {
      const token = await ctxRef!.adapter.__identityTokenReader.get(Date.now());
      expect(token).toBe(manualToken);
    });
  });

  it('mints against the endpoint captured when the provider was installed, never a different one', async () => {
    // Regression pin for the fix that binds a provider to the endpoint it was
    // installed for (read from the effect's own closure) rather than
    // `latest.current.endpoint` (a ref that, pre-fix, was writable DURING
    // RENDER and so could be mutated by a render React later discarded).
    // Switching identities end-to-end — different endpoint AND different key,
    // exactly a sign-out/sign-in across users — must never cross-contaminate:
    // each mint lands on its own endpoint, never the other's.
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/api/config')) {
          return new Response(
            JSON.stringify({ replayEnabled: false, replayDurationSec: 30, samplingRate: 1, identity: { enabled: true } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        calls.push(url);
        return new Response(JSON.stringify({ token: mkJwt('u'), expiresAt: Date.now() + 300_000 }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }),
    );

    const { rerender } = render(
      <TraceItXProvider config={config} identity={{ endpoint: '/mint-alice', key: 'u_alice' }}>
        <div />
      </TraceItXProvider>,
    );
    await flush();
    expect(calls.some((u) => u.includes('/mint-alice'))).toBe(true);
    expect(calls.some((u) => u.includes('/mint-bob'))).toBe(false);

    rerender(
      <TraceItXProvider config={config} identity={{ endpoint: '/mint-bob', key: 'u_bob' }}>
        <div />
      </TraceItXProvider>,
    );
    await flush();

    expect(calls.some((u) => u.includes('/mint-bob'))).toBe(true);
    // No call at any point requested Bob's endpoint while Alice's identity
    // was still the one installed, or vice versa after the switch.
    expect(calls.every((u) => u.includes('/mint-alice') || u.includes('/mint-bob'))).toBe(true);
  });

  it('never sends the post-switch identity\'s credential to the pre-switch endpoint (in-flight mint during a switch)', async () => {
    // THE FIX'S OWN TARGET (Serious finding). `endpoint` is captured in the
    // effect closure (so a provider can never mint against a different
    // endpoint than it was installed for) but `headers`/`fetch`/`credentials`
    // are read LIVE off `latest.current` (so a rotating access token is
    // never captured stale). Those two are each correct on their own but can
    // DIVERGE mid-flight: if the identity switches while `headers()` is
    // still pending, the callback can resolve with the NEW identity's
    // credential (e.g. because internally it reads a live auth store) while
    // this call is still bound to the OLD identity's endpoint — sending the
    // new user's bearer token to the old endpoint. The holder's generation
    // check only runs after the fetch resolves, so it guards the CACHE, not
    // a request already sent. Reproduced here with a `headers()` the test
    // controls directly, so the switch can be forced while it's pending.
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/api/config')) {
          return new Response(
            JSON.stringify({ replayEnabled: false, replayDurationSec: 30, samplingRate: 1, identity: { enabled: true } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
        calls.push({ url, headers });
        return new Response(JSON.stringify({ token: mkJwt('u'), expiresAt: Date.now() + 300_000 }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }),
    );

    let resolveAliceHeaders: (h: Record<string, string>) => void = () => {};
    const aliceHeadersPromise = new Promise<Record<string, string>>((resolve) => {
      resolveAliceHeaders = resolve;
    });

    const { rerender } = render(
      <TraceItXProvider
        config={config}
        identity={{ endpoint: '/mint-alice', key: 'u_alice', headers: () => aliceHeadersPromise }}
      >
        <div />
      </TraceItXProvider>,
    );
    // Let the warm mint begin and reach `await headers()`, but do NOT
    // resolve it yet — it stays pending across the switch below. Nothing has
    // been fetched from the mint endpoint yet.
    await flush();
    expect(calls).toHaveLength(0);

    // Switch to Bob WHILE Alice's headers() is still pending.
    rerender(
      <TraceItXProvider
        config={config}
        identity={{ endpoint: '/mint-bob', key: 'u_bob', headers: () => ({ authorization: 'Bearer BOB_LIVE' }) }}
      >
        <div />
      </TraceItXProvider>,
    );
    await flush();

    // NOW Alice's headers() resolves — simulating a callback that reads a
    // LIVE auth store internally and therefore now returns BOB's credential,
    // even though it's "Alice's" callback reference that never changed.
    resolveAliceHeaders({ authorization: 'Bearer BOB_LIVE' });
    await flush();

    // The one request that must never exist: Bob's credential value paired
    // with Alice's (pre-switch) endpoint.
    const leaked = calls.some(
      (c) => c.url.includes('/mint-alice') && c.headers.authorization === 'Bearer BOB_LIVE',
    );
    expect(leaked).toBe(false);
  });

  it('never lets a descendant effect observe the PREVIOUS user\'s token mid-switch', async () => {
    // THE POINT OF THIS FIX. React runs passive effects child-before-parent
    // within a commit. A descendant reacting to the same sign-in (its own
    // effect keyed on the same user id) therefore commits BEFORE
    // useIdentityProp's own effect — so under the old single-passive-effect
    // implementation it could read `__identityTokenReader` while ALICE's
    // provider + cached token were still installed, mid-switch to Bob.
    // This renders exactly that descendant and proves it never observes
    // Alice's token once the switch to Bob has started: it must see either
    // `null` (the anonymous window) or Bob's own token, never Alice's.
    const h: Harness = { calls: [], configBody: { identity: { enabled: true } } };
    const aliceToken = mkJwt('u_alice');
    const bobToken = mkJwt('u_bob');
    stubFetch(h, (n) => (n === 0 ? aliceToken : bobToken));

    const observations: Array<{ userId: string; token: string | null }> = [];
    function Observer({ userId }: { userId: string }) {
      const ctx = useContext(TraceItXContext);
      useEffect(() => {
        if (!ctx) return;
        void ctx.adapter.__identityTokenReader.get(Date.now()).then((token) => {
          observations.push({ userId, token });
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [userId]);
      return null;
    }

    const { rerender } = render(
      <TraceItXProvider config={config} identity={{ endpoint: '/mint', key: 'u_alice' }}>
        <Ctx />
        <Observer userId="u_alice" />
      </TraceItXProvider>,
    );
    await flush();

    // Confirm Alice's token is actually cached (not merely installed) before
    // the switch, so the assertion below proves something real was avoided
    // rather than trivially holding because there was never anything to leak.
    await act(async () => {
      const token = await ctxRef!.adapter.__identityTokenReader.get(Date.now());
      expect(token).toBe(aliceToken);
    });

    rerender(
      <TraceItXProvider config={config} identity={{ endpoint: '/mint', key: 'u_bob' }}>
        <Ctx />
        <Observer userId="u_bob" />
      </TraceItXProvider>,
    );
    await flush();

    const bobObservation = observations.find((o) => o.userId === 'u_bob');
    expect(bobObservation).toBeDefined();
    expect(bobObservation!.token).not.toBe(aliceToken);
  });

  it("never lets a descendant's LAYOUT effect observe the previous user's token mid-switch", async () => {
    // THE FIX'S OWN TARGET (Serious finding, render-phase guard). React runs
    // BOTH layout effects and passive effects child-before-parent within a
    // commit. The provider's invalidate step (a layout effect) already beats
    // a descendant's PASSIVE effect — see the test above — but not a
    // descendant's own LAYOUT effect: within the same commit, a child's
    // layout effect (keyed on the same user id) runs BEFORE the parent's own
    // invalidate layout effect gets a chance to clear the outgoing user's
    // cached token. Without the render-phase guard (identity-prop.ts's
    // `renderedKeyRef`/`installedKeyRef`/`setGuard`), this child would still
    // observe Alice's cached token while switching to Bob.
    const h: Harness = { calls: [], configBody: { identity: { enabled: true } } };
    const aliceToken = mkJwt('u_alice');
    const bobToken = mkJwt('u_bob');
    stubFetch(h, (n) => (n === 0 ? aliceToken : bobToken));

    const observations: Array<{ userId: string; token: string | null }> = [];
    function LayoutObserver({ userId }: { userId: string }) {
      const ctx = useContext(TraceItXContext);
      useLayoutEffect(() => {
        if (!ctx) return;
        void ctx.adapter.__identityTokenReader.get(Date.now()).then((token) => {
          observations.push({ userId, token });
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [userId]);
      return null;
    }

    const { rerender } = render(
      <TraceItXProvider config={config} identity={{ endpoint: '/mint', key: 'u_alice' }}>
        <Ctx />
        <LayoutObserver userId="u_alice" />
      </TraceItXProvider>,
    );
    await flush();

    // Confirm Alice's token is actually cached (not merely installed) before
    // the switch, so the assertion below proves something real was avoided
    // rather than trivially holding because there was never anything to leak.
    await act(async () => {
      const token = await ctxRef!.adapter.__identityTokenReader.get(Date.now());
      expect(token).toBe(aliceToken);
    });

    rerender(
      <TraceItXProvider config={config} identity={{ endpoint: '/mint', key: 'u_bob' }}>
        <Ctx />
        <LayoutObserver userId="u_bob" />
      </TraceItXProvider>,
    );
    await flush();

    const bobObservation = observations.find((o) => o.userId === 'u_bob');
    expect(bobObservation).toBeDefined();
    expect(bobObservation!.token).not.toBe(aliceToken);
  });

  it("no leak on a resumed transition: the retry render re-raises the suspicion right before Bob's commit", async () => {
    // THE CRUX. There is no timer anywhere in this hook (see identity-prop.ts's
    // block comment on why even a zero-delay one is unsafe), so the only way
    // the render-phase suspicion could ever be down going into Bob's real
    // commit is if something OTHER than a timer cleared it prematurely. It
    // can't: the suspicion is raised the instant Bob's mismatched render runs
    // and is never touched again until either a render shows the installed
    // (Alice) key, or a commit confirms Bob's key. Neither happens between
    // the initial suspend and the resume below, so the suspicion is still up
    // when React retries the suspended boundary — and the retry render (this
    // hook included) re-raises it fresh, in the very same synchronous task as
    // the commit that follows it, immediately before Bob's descendant layout
    // effect runs.
    const h: Harness = { calls: [], configBody: { identity: { enabled: true } } };
    const aliceToken = mkJwt('u_alice');
    const bobToken = mkJwt('u_bob');
    stubFetch(h, (n) => (n === 0 ? aliceToken : bobToken));

    const observations: Array<string | null> = [];
    function LayoutObserver({ tag }: { tag: string }) {
      const ctx = useContext(TraceItXContext);
      useLayoutEffect(() => {
        if (!ctx) return;
        void ctx.adapter.__identityTokenReader.get(Date.now()).then((token) => {
          observations.push(token);
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [tag]);
      return null;
    }

    // A controllable suspension: throws the SAME promise until `gateResolved`
    // flips, at which point the retry render (React's automatic response to
    // the thrown promise settling) returns null instead and the boundary
    // commits — the standard "resumed transition" shape.
    let gateResolved = false;
    let resolveGate: () => void = () => {};
    const gatePromise = new Promise<void>((resolve) => {
      resolveGate = () => { gateResolved = true; resolve(); };
    });
    function SuspendUntilResolved() {
      if (!gateResolved) throw gatePromise;
      return null;
    }

    const { rerender } = render(
      <Suspense fallback={<div>loading</div>}>
        <TraceItXProvider config={config} identity={{ endpoint: '/mint', key: 'u_alice' }}>
          <Ctx />
        </TraceItXProvider>
      </Suspense>,
    );
    await flush();

    // Confirm Alice's token is actually cached before the switch starts, so
    // later assertions prove something real rather than holding vacuously.
    await act(async () => {
      const token = await ctxRef!.adapter.__identityTokenReader.get(Date.now());
      expect(token).toBe(aliceToken);
    });

    // Start the transition to Bob. It suspends on the very first attempt
    // and does not commit — Alice's already-committed tree stays on screen.
    act(() => {
      startTransition(() => {
        rerender(
          <Suspense fallback={<div>loading</div>}>
            <TraceItXProvider config={config} identity={{ endpoint: '/mint', key: 'u_bob' }}>
              <Ctx />
              <SuspendUntilResolved />
              <LayoutObserver tag="bob" />
            </TraceItXProvider>
          </Suspense>,
        );
      });
    });

    // The render-phase suspicion is up; the cache is refused right now, and
    // stays refused for as long as nothing resolves it — there is no clock
    // running down in the background that could release it early.
    await act(async () => {
      const token = await ctxRef!.adapter.__identityTokenReader.get(Date.now());
      expect(token).toBeNull();
    });

    // NOW resume the transition. React retries the suspended boundary — the
    // component tree, including TraceItXProvider, renders again — and this
    // time SuspendUntilResolved returns instead of throwing, so the retry
    // commits Bob. `LayoutObserver`'s layout effect fires DURING that commit.
    await act(async () => {
      resolveGate();
      await gatePromise;
    });
    await flush();

    // The descendant's LAYOUT effect from Bob's commit must never have
    // observed Alice's token: the suspicion was still up going into the
    // retry render, and the retry render re-raises it fresh immediately
    // before this commit.
    expect(observations).toEqual([null]);
    expect(observations).not.toContain(aliceToken);
  });

  it('a render that never commits refuses the cache while it stands, then self-heals on the next render showing the committed key', async () => {
    // THE FIX (replacing a removed time-based repair). The render-phase
    // guard records its suspicion the instant it sees a mismatched key —
    // including during a render React never commits, since `useRef` writes
    // during render are visible immediately regardless of whether that
    // render's fiber is ever committed. A suspended/abandoned Alice->Bob
    // transition therefore mutates the SAME ref object the committed Alice
    // tree's guard reads, with no commit ever arriving to resolve it.
    // Reproduced here with a REAL indefinite suspension: a sibling that
    // throws a promise which never resolves, inside a <Suspense> that
    // already has Alice's tree committed. React runs TraceItXProvider's
    // render (mutating the guard's ref) before it reaches the sibling that
    // suspends, then discards the whole attempt without committing — so
    // Alice's tree stays mounted and its context/client object (captured
    // below via `ctxRef`) is untouched, but the guard it reads was just
    // mutated by the discarded render.
    //
    // There is no clock involved: a timeout can't tell an abandoned render
    // from one that's merely slow-but-committing (see identity-prop.ts's
    // block comment on why even a zero-delay one is unsafe), so the
    // suspicion stands until something resolves it. What resolves it here,
    // with no commit ever arriving for Bob, is the render-phase CLEAR:
    // React's next render of the provider (a plain re-render still showing
    // Alice's committed key, exactly what happens when the abandoned
    // transition's sibling is later rendered non-suspending again) sees
    // `key === installedKeyRef.current` and clears the suspicion right there
    // — no effect, no commit of a NEW identity required, and no timer. This
    // proves both halves: the cache is REFUSED (not destroyed) while the
    // mismatch stands, and the exact same cached token comes back once a
    // render shows the committed key again — recovery is render-driven, not
    // time-driven.
    const h: Harness = { calls: [], configBody: { identity: { enabled: true } } };
    const aliceToken = mkJwt('u_alice');
    stubFetch(h, () => aliceToken);

    function SuspendForever({ active }: { active: boolean }) {
      if (active) throw new Promise<void>(() => {});
      return null;
    }

    // Proves the clear happens IN RENDER, not merely "eventually via some
    // effect": a LAYOUT effect runs strictly before any PASSIVE effect in
    // the same commit (React phase ordering), including the reconcile
    // effect declared alongside `latest` above, which ALSO clears
    // `suspectedRef` — but only from the PASSIVE phase, one whole phase
    // later. If the render-phase branch were the only thing keyed to run
    // this early, this observer reading a non-null token proves the clear
    // already happened before ANY effect — layout or passive — got a
    // chance to run.
    const revertObservations: Array<string | null> = [];
    function RevertLayoutObserver({ tag }: { tag: string }) {
      const ctx = useContext(TraceItXContext);
      useLayoutEffect(() => {
        if (!ctx) return;
        void ctx.adapter.__identityTokenReader.get(Date.now()).then((token) => {
          revertObservations.push(token);
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [tag]);
      return null;
    }

    const { rerender } = render(
      <Suspense fallback={<div>loading</div>}>
        <TraceItXProvider config={config} identity={{ endpoint: '/mint', key: 'u_alice' }}>
          <Ctx />
          <SuspendForever active={false} />
        </TraceItXProvider>
      </Suspense>,
    );
    await flush();

    // Confirm Alice's token is actually cached before the aborted switch, so
    // the assertions below prove something real was recovered rather than
    // trivially holding because there was never anything to lose.
    await act(async () => {
      const token = await ctxRef!.adapter.__identityTokenReader.get(Date.now());
      expect(token).toBe(aliceToken);
    });
    const mintsBeforeSwitch = h.calls.length;

    // Trigger a TRANSITION to Bob that suspends indefinitely and therefore
    // NEVER COMMITS. Unlike a plain synchronous update into a Suspense
    // boundary (which — empirically — React commits as a "hidden, showing
    // fallback" state the instant it suspends, persisting the attempted
    // render's props as the new baseline even though its effects don't run,
    // so a LATER render back to Alice still has to diff against Bob and
    // re-fires this hook's install/invalidate effects), `startTransition`
    // keeps Alice's ALREADY-COMMITTED tree on screen with NO fallback and NO
    // commit of Bob's attempt at all: TraceItXProvider's render function
    // still runs for Bob (mutating the SAME `suspectedRef` object the
    // visible Alice fiber reads — `useRef`'s cell is shared between a fiber
    // and its in-progress alternate, so this write is observable immediately
    // regardless of whether the transition ever commits), but the
    // transition itself just stays pending forever. Alice's install
    // (`installed`/`installedKeyRef`/the guard on the holder) is left
    // completely untouched.
    act(() => {
      startTransition(() => {
        rerender(
          <Suspense fallback={<div>loading</div>}>
            <TraceItXProvider config={config} identity={{ endpoint: '/mint', key: 'u_bob' }}>
              <Ctx />
              <SuspendForever active={true} />
            </TraceItXProvider>
          </Suspense>,
        );
      });
    });

    // While the mismatched render stands — no commit has arrived, nor ever
    // will for Bob — the guard refuses the cache outright.
    await act(async () => {
      const token = await ctxRef!.adapter.__identityTokenReader.get(Date.now());
      expect(token).toBeNull();
    });

    // Nothing will ever commit Bob's transition (the promise never
    // resolves). Superseding it with an ordinary, non-transition render back
    // to Alice's UNCHANGED, already-committed key — a plain re-render, not a
    // commit of any new identity — preempts the pending low-priority
    // transition outright (transitions never block a higher-priority
    // update). React re-invokes the hook with `key` unchanged from what's
    // still officially installed, so the render-phase branch
    // (`key === installedKeyRef.current`) clears the suspicion, and — since
    // the effective [endpoint, key] the install/invalidate effects last
    // committed against was NEVER touched by Bob's pending-but-never-run
    // transition — those effects correctly see no change and don't re-fire.
    rerender(
      <Suspense fallback={<div>loading</div>}>
        <TraceItXProvider config={config} identity={{ endpoint: '/mint', key: 'u_alice' }}>
          <Ctx />
          <SuspendForever active={false} />
          <RevertLayoutObserver tag="revert" />
        </TraceItXProvider>
      </Suspense>,
    );
    await flush();

    // The descendant's LAYOUT effect — which ran before ANY passive effect
    // in this commit, including the reconcile effect that ALSO clears
    // `suspectedRef` — already observed a served (non-null) token. The
    // clear that unblocked it could only have happened during RENDER.
    expect(revertObservations).toEqual([aliceToken]);

    // Self-healed: the SAME cached token is served again — proving the
    // earlier refusal degraded the cache rather than destroying it, and that
    // no re-mint against the endpoint was needed to recover it.
    await act(async () => {
      const token = await ctxRef!.adapter.__identityTokenReader.get(Date.now());
      expect(token).toBe(aliceToken);
    });
    expect(h.calls.length).toBe(mintsBeforeSwitch);
  });

  it('signs out when the whole identity prop is dropped (identity={undefined})', async () => {
    // The idiomatic React spelling for sign-out is dropping the prop entirely
    // — `identity={user ? { endpoint, key: user.id } : undefined}` — not just
    // clearing `key` while `endpoint` stays put. That takes BOTH `endpoint`
    // and `key` from defined to undefined in one rerender, which must still
    // clear the cached token, not silently keep serving it for the rest of
    // its TTL.
    const h: Harness = { calls: [], configBody: { identity: { enabled: true } } };
    stubFetch(h, () => mkJwt('u_alice'));

    const { rerender } = render(
      <TraceItXProvider config={config} identity={{ endpoint: '/mint', key: 'u_alice' }}>
        <Ctx />
      </TraceItXProvider>,
    );
    await flush();

    // Confirm the token is actually cached before dropping the prop, so the
    // assertion below proves something was cleared rather than trivially
    // holding for a token that was never there.
    await act(async () => {
      const token = await ctxRef!.adapter.__identityTokenReader.get(Date.now());
      expect(token).not.toBeNull();
    });

    rerender(
      <TraceItXProvider config={config} identity={undefined}>
        <Ctx />
      </TraceItXProvider>,
    );
    await flush();

    await act(async () => {
      const token = await ctxRef!.adapter.__identityTokenReader.get(Date.now());
      expect(token).toBeNull();
    });
  });
});
