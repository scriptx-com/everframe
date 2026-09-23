// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The `identity` prop's effect — written ONCE, here, instead of by every
// customer. the user-recognition contract used to state the rule as:
// "call it on every account switch, but not on every render, with a stable
// function reference, in an effect keyed on your user id rather than the
// callback's identity". That is this file.
//
// Two rules, and the dependency array is where both live:
//
//   - Keyed on [endpoint, key] — the USER's identity. A new sign-in re-mints;
//     a re-render does not.
//   - `headers` / `fetch` / `credentials` are read off a REF at call time, so
//     an inline arrow never re-runs the effect and a rotating access token is
//     never captured stale. Putting `headers` in the deps would reintroduce
//     the exact footgun this file exists to remove.
import { useEffect, useLayoutEffect, useRef } from 'react';
import { __internalClientState } from '@everframe/sdk-core';
import type { InternalContext } from './provider.js';

// SSR-safe: useLayoutEffect warns during server rendering, and this package is
// consumed by Next.js apps that server-render client components.
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export interface IdentityProp {
  /** URL of your @everframe/identity endpoint. */
  endpoint: string;
  /**
   * Your signed-in user's id. When it CHANGES the SDK re-mints; when it
   * becomes undefined or null the SDK signs out.
   */
  key?: string | number | null;
  /** Re-invoked on EVERY mint. Return bearer/auth headers here. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Defaults to 'same-origin'. Set 'include' only for a cookie-based cross-origin endpoint. */
  credentials?: RequestCredentials;
  /** Replace the request entirely. */
  fetch?: typeof fetch;
}

interface MintBody {
  token?: unknown;
}

export function useIdentityProp(
  ctxValue: InternalContext,
  identity: IdentityProp | undefined,
  settled: () => Promise<void>,
): void {
  // Updated on EVERY COMMIT, read only at call time. This is what lets the
  // deps array below stay narrow.
  const latest = useRef<IdentityProp | undefined>(identity);
  // Written on COMMIT, never during render. A ref mutated in render is visible
  // to an already-committed provider, so a render that React later discards
  // (Suspense, an aborted transition) could otherwise hand Alice's committed
  // provider Bob's headers — minting Bob's token and caching it as Alice's.
  // Declared before the effect below so it is already current when that effect
  // installs a provider in the same commit.
  useEffect(() => {
    latest.current = identity;
  });

  const endpoint = identity?.endpoint;
  const key = identity?.key;

  // PR review, Serious finding — layout effects and passive effects BOTH run
  // child-before-parent within a commit. The layout effect below (which
  // clears the PREVIOUS user's token) beats a descendant's PASSIVE effect,
  // but not a descendant's own LAYOUT effect: a child reading the token from
  // ITS `useLayoutEffect`, keyed on the same user change, still runs before
  // this hook's clear — carrying the outgoing user's token into the
  // incoming user's first render. Render is the only phase that runs
  // parent-before-child, so the fix has to engage from render — but a
  // render-phase CLEAR is unsafe: a concurrent render React later discards
  // would destroy a live token with no path back (the install effect only
  // re-runs on [endpoint, key] change). Instead, render writes a SIGNAL — a
  // SUSPICION — that a non-destructive predicate on the holder consults
  // before ever serving the cache. A refusal is never destructive: it
  // degrades to anonymous for one read.
  //
  // A round of the same fix once bounded that suspicion with a 1000ms
  // timestamp — "expire after N ms" — on the theory that a render which
  // never commits (a suspended/abandoned transition) shouldn't refuse
  // forever. That was rejected: a Suspense/transition render can stay
  // pending LONGER than any fixed window and then commit anyway, so a
  // 1000ms clock had already expired — releasing the guard — by the time
  // that late commit's descendant layout effects ran, serving them the
  // outgoing user's cached token.
  //
  // A LATER round replaced the fixed window with a `setTimeout(..., 0)`
  // repair, reasoning that React never yields between a completed render and
  // its commit, so a same-task macrotask would always be beaten to the punch
  // by any real resolution. That reasoning addressed the wrong interval, and
  // was wrong for a subtler reason too: React CAN yield *during* the render
  // phase itself — concurrent rendering walks the fiber tree in slices and
  // can hand control back to the event loop after THIS component has
  // rendered but before its descendants have. A zero-delay timer scheduled
  // during this component's render can fire in exactly that gap, clearing
  // `suspectedRef` while the parent has already rendered but the subtree
  // hasn't finished. React then resumes, completes the descendants, and
  // commits WITHOUT re-rendering the parent — so nothing re-raises the
  // suspicion before a descendant's layout effect reads the guard. That
  // descendant then observes the outgoing user's cached token: exactly the
  // cross-user leak this guard exists to prevent.
  //
  // NO TIMER, of any duration, can be made safe here — every one races
  // React's own scheduling, which promises no lower bound on how long a
  // render can be interrupted for. So there is no repair. `suspectedRef` is
  // cleared ONLY by React lifecycle signals: the render-phase branch below
  // (a later render shows the installed key again) and the commit-time
  // effects further down (a real commit confirms the key). If neither ever
  // arrives — an abandoned or permanently suspended transition that never
  // renders this provider again — the suspicion simply stands, and the
  // cached token stays refused until it does.
  //
  // That is a DELIBERATE, accepted cost, not an oversight: recognition is
  // off for that report, i.e. attribution is lost until the provider renders
  // again. It is NOT a cross-user credential leak, and the asymmetry is the
  // entire point of this design — losing attribution (an anonymous report
  // where a named one was expected) is the failure this design nominates as
  // acceptable; serving Bob a page carrying Alice's identity token is not,
  // under any circumstances.

  // The key the currently-installed provider was installed FOR.
  const installedKeyRef = useRef<string | number | null | undefined>(undefined);

  // Whether a render-phase mismatch (below) is currently outstanding.
  // Cleared by whichever resolves it first: the render-phase match branch
  // just below, or one of the two commit-time effects further down. There is
  // no third path — see the block comment above for why a timer cannot be
  // one — so a render that raises this and then never renders this provider
  // again leaves it standing indefinitely, by design.
  const suspectedRef = useRef(false);

  // Render is the only phase that runs parent-before-child, so this is the
  // only signal that can be in place before a DESCENDANT's layout effect
  // runs. A render that never commits (a suspended or abandoned transition)
  // still mutates this ref, but that is harmless: the moment React next
  // renders this provider with the INSTALLED key (which is exactly what
  // happens when an abandoned transition's tree stays put), this branch
  // fires and clears the suspicion — no commit required. For the case where
  // no such render ever arrives, the suspicion stands until a real commit
  // resolves it (see the block comment above) — recognition is off for that
  // stretch, never a cross-user leak.
  if (key !== installedKeyRef.current) {
    suspectedRef.current = true;
  } else {
    suspectedRef.current = false;
  }

  // The cached token is refused only while a render-phase suspicion is
  // currently recorded — no clock, just the flag. A stable ref so
  // install/invalidate can hand the SAME function to setGuard/clear it
  // without recreating it every render.
  const guardRef = useRef(() => !suspectedRef.current);

  // Resolves a suspicion once a REAL commit confirms it: once
  // `installedKeyRef` has caught up to the committed `key`, any earlier
  // render-phase mismatch was accurate but is now stale, so clear it. This
  // handles "no identity change this commit" and sign-out (installedKeyRef
  // is already caught up by the time this runs). An identity SWITCH is
  // instead resolved by the install effect below, which runs later in the
  // same commit's passive phase (hooks fire in declaration order) and sets
  // `installedKeyRef` itself — by the time this effect runs, `installedKeyRef`
  // hasn't caught up yet for that case. Declared alongside the `latest`
  // reconcile effect above — same shape, same reason: resynced on every
  // commit with no dependency array.
  useEffect(() => {
    if (installedKeyRef.current === key) {
      suspectedRef.current = false;
    }
  });

  // Whether THIS hook is the one currently holding the token source. Guards
  // the sign-out/no-op branch below: without it, a host that never uses the
  // `identity` prop at all (endpoint always undefined) would still call
  // `setIdentityToken(null)` on mount and clobber a token that host's own
  // manual `setIdentityToken` call installed — silently breaking every
  // existing manual integration.  Only cleared when THIS hook previously
  // installed a provider, so an uninvolved host is never touched.
  const installed = useRef(false);

  // INVALIDATE FIRST, in a LAYOUT effect. React runs passive effects
  // child-before-parent within a commit, so a descendant's passive effect
  // reacting to the same sign-in/sign-out would otherwise run BEFORE this
  // hook's own passive effect got a chance to clear the PREVIOUS user's
  // token — making an authenticated call while Alice's token was still
  // installed, fetching Alice's conversations into Bob's UI. Every layout
  // effect in a commit runs before any passive effect, so clearing here
  // means the worst a descendant can observe is "anonymous", never "the
  // last user". Fires on every commit where [endpoint, key] changed —
  // including "no identity prop"/"signed out" (this IS the clear branch)
  // and "signing in"/"switching" (clears the old source; the passive effect
  // below then installs the new one, so there's a brief anonymous window by
  // design, never a stale-identity one).
  useIsomorphicLayoutEffect(() => {
    if (installed.current) {
      ctxValue.client.setIdentityToken(null);
      installed.current = false;
      // A host that never uses the `identity` prop, or has fully signed out,
      // is left in PRISTINE condition: no installed key, no guard — a manual
      // `setIdentityToken` integration on the same client is untouched.
      installedKeyRef.current = undefined;
      __internalClientState.get(ctxValue.client)?.identityToken.setGuard(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, key]);

  useEffect(() => {
    if (endpoint === undefined || key === undefined || key === null) {
      // "No identity prop at all" / "signed out": the layout effect above
      // already cleared any token this hook had installed. Nothing to mint.
      return;
    }

    let disposed = false;

    const provider = async (): Promise<string | null> => {
      // `endpoint` is the value CLOSED OVER from this effect run — the target
      // this provider was installed for — so it can never mint against a
      // different endpoint than the one that triggered the install, even if
      // `latest.current` is later updated by an in-flight render for a
      // different identity. `headers`/`fetch`/`credentials` are read LIVE off
      // the ref: that's the rotation guarantee (a refreshed access token must
      // never be captured stale), and it doesn't carry the same mis-binding
      // risk because it only changes the credentials used to authenticate
      // AS the same, already-fixed target.
      //
      // PR review, Serious finding — that endpoint-fixed/credentials-live
      // split has a mid-flight hazard of its own: if the identity switches
      // (Alice -> Bob) while `headers()` below is still pending, this
      // closure's `endpoint` still points at Alice's, but `latest.current`
      // now holds Bob's `headers`/`fetch`/`credentials` — so the await can
      // resolve to BOB's bearer token, which this function would then send to
      // ALICE's captured endpoint. The generation check on `installedKeyRef`
      // that normally guards this is applied to the token CACHE, by the
      // holder, only after this fetch resolves — it protects what gets
      // SERVED, not the request already sent over the wire. So this provider
      // must reconfirm — after every await, before doing anything that
      // touches the network or returns a token — that it is still the live
      // provider for the key it was installed under. A stale provider bails
      // out to `null` (anonymous), never throws, and never fires the
      // mismatched request.
      const current = latest.current;
      if (!current) return null;
      try {
        const headers = current.headers ? await current.headers() : undefined;
        // Re-check after the await: `disposed` flips the instant this
        // effect's own cleanup runs (a switch or unmount), and
        // `installedKeyRef` flips the instant a NEW install effect commits
        // for a different key — checking both, rather than relying on
        // `disposed` alone, means an effect whose cleanup hasn't fired yet
        // still can't slip a stale request through. Bail BEFORE `doFetch` is
        // ever called, so `headers()` resolving to a different identity's
        // credentials never reaches the network paired with this endpoint.
        if (disposed || installedKeyRef.current !== key) return null;
        const doFetch = current.fetch ?? fetch;
        const res = await doFetch(endpoint, {
          method: 'GET',
          cache: 'no-store',
          credentials: current.credentials ?? 'same-origin',
          ...(headers ? { headers } : {}),
        });
        // Same check again after the network round trip: a provider
        // invalidated WHILE the fetch was in flight must not hand back
        // whatever it received either — the token in `res` was minted for
        // whichever credentials were live when the request went out, and
        // this provider is no longer the one that's supposed to be serving.
        if (disposed || installedKeyRef.current !== key) return null;
        if (!res.ok) return null;
        const body = (await res.json()) as MintBody;
        return typeof body.token === 'string' ? body.token : null;
      } catch {
        // Recognition must never fail or stall a report. Every failure —
        // network, non-200, malformed body, a throwing headers callback —
        // resolves to "anonymous", exactly like a host that never wired
        // recognition up at all.
        return null;
      }
    };

    ctxValue.client.setIdentityToken(provider);
    installed.current = true;
    // The provider just installed is FOR `key` — record it, then arm the
    // guard so the holder refuses to serve its cache to anything rendered
    // under a different key (see the Serious-finding comment above `latest`).
    installedKeyRef.current = key;
    // This effect running IS the real commit confirming `key` — resolve any
    // outstanding suspicion. The reconcile effect above can't do this itself
    // for a SWITCH: it runs before this effect within the same commit's
    // passive phase (hooks fire in declaration order), so on the very commit
    // that performs a switch, `installedKeyRef` hasn't caught up yet when it
    // checks.
    suspectedRef.current = false;
    __internalClientState.get(ctxValue.client)?.identityToken.setGuard(guardRef.current);

    // Warm the token OFF the critical path. IDENTITY_PROVIDER_TIMEOUT_MS (2s)
    // bounds the whole provider call, and a `headers` callback that refreshes
    // a rotated access token now spends that budget too — so pay it here,
    // where the cost is latency, rather than at submit time, where the cost is
    // attribution.
    //
    // Routed through the adapter's existing reader rather than fetching
    // directly: the reader is already gated on `identity.enabled`, so a
    // project with no signing secret never calls the customer's endpoint, and
    // it shares the holder's cache, so this warm IS the fetch rather than a
    // duplicate of it.
    void settled()
      .then(() => {
        if (disposed) return;
        return ctxValue.adapter.__identityTokenReader.get(Date.now());
      })
      .catch(() => undefined);

    return () => { disposed = true; };
    // `latest` is a ref and deliberately absent. `ctxValue` is stable for the
    // provider's lifetime (useMemo(…, [])). `settled` is NOT stable — it's a
    // new arrow every render — but that's fine here: it's never read from the
    // deps array, only invoked once inside this effect run, so a stale
    // closure over it is never observable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, key]);
}
