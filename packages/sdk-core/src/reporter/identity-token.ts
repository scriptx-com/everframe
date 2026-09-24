// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Reporter identity recognition (spec 2026-08-06), SDK side.
//
// The host app's backend signs a short-lived JWT identifying the person using
// the app and hands it to the SDK via `tx.setIdentityToken(...)`. This file
// holds that token in memory (never persisted — it lives at most 10 minutes,
// so writing it to storage would only create a place for it to leak) and
// decides when it's safe to attach it to a request.
//
// The `exp` read below is a DECODE, not a verification: this SDK holds no
// secret and is not a security boundary — the server (the ingest API/src/reporter/
// identity.ts) is the only place the signature is actually checked. We read
// `exp` purely to know when to stop presenting a token and re-ask the host's
// provider instead. Do NOT "harden" this into something that validates the
// signature or rejects malformed tokens on security grounds — an undecodable
// or expired-looking token is simply treated as ABSENT, exactly like a host
// that never called setIdentityToken at all, so the report still submits
// (anonymously). Recognition must never fail or stall a report.
export const IDENTITY_TOKEN_HEADER = 'X-Everframe-Identity-Token';

/**
 * Longest identity token this SDK will ever present — the SERVER'S ceiling,
 * mirrored client-side. `hasPlausibleIdentityTokenShape`
 * (`the server identity-token verifier`, `IDENTITY_TOKEN_MAX_CHARS = 4096`)
 * refuses anything longer as `malformed` before it reaches verification, so a
 * token past this was never going to authenticate anyone.
 *
 * Duplicated rather than imported, the same way the vitals collector
 * duplicates `SELF_DECLARED_SUBJECT_MAX`: a published SDK cannot depend on the
 * API package, and a shipped SDK's copy of a server constant is a copy by
 * nature — it rides in customers' apps for months after the server changes.
 * Keep the two in sync; if they ever drift, the server's is authoritative and
 * this one is merely conservative.
 *
 * Why bound it at all (adversarial review of PR #218 round 2, finding 6 —
 * measured): a validly signed JWT carrying a 70 KB extra claim sails through
 * the holder, and on the vitals path it produced a 94,008-byte beacon body,
 * past `sendBeacon`'s 64 KiB ceiling, while the fetch fallback sent the same
 * token as a header and a real server answered 431 before reading the body.
 * Identity data may cost ATTRIBUTION; it may never cost the payload carrying
 * it (the design spec's invariant 2). Dropping an over-long token costs
 * nothing that would have worked anyway.
 */
export const IDENTITY_TOKEN_MAX_CHARS = 4096;

/**
 * Compact JWS serialization: three non-empty base64url segments. The same
 * expression as the server's `COMPACT_JWS_RE`
 * (`the server identity-token verifier`), duplicated for the same reason as the
 * length above.
 */
const COMPACT_JWS_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * The form of this string that may be PUT ON THE WIRE as an identity token, or
 * `null` if none is.
 *
 * A shape test, never a validity test — this SDK holds no secret and verifies
 * nothing (see the module doc). It answers one narrow question: would
 * presenting this value cost something other than the attribution?
 *
 *   - LENGTH. A validly signed JWT carrying a 70 KB extra claim produced a
 *     94,008-byte beacon body, past `sendBeacon`'s 64 KiB ceiling, and a 431
 *     from a real server on the fetch fallback (round-2 finding 6, measured).
 *   - HEADER SAFETY, which is the same test (round-3 finding 3, reproduced
 *     against native Request validation): a three-segment token with a valid
 *     future `exp` and an embedded NEWLINE in its signature passed the length
 *     bound, then `fetch` rejected the header before sending anything — two
 *     TypeErrors, zero deliveries, and the retry reused the same bad header.
 *     The base64url alphabet contains no CR, LF, NUL or any other character an
 *     HTTP header value forbids, so the compact-JWS test IS the header-safety
 *     test; there is no second predicate to keep in step with this one.
 *
 * IT TRIMS FIRST, AND RETURNS WHAT TO SEND (round-4 finding 2, reproduced).
 * An earlier version judged the exact string and answered yes/no, on the
 * argument that what we send is what we validate. That cost a WORKING
 * credential: a provider returning `' ' + jwt + ' '` — trivially produced by a
 * template literal or a header echoed back with its padding — was cached by
 * the holder, refused here, and the caller then withheld the `user` block too,
 * leaving a session anonymous that had a perfectly usable token. Native
 * `Request` normalizes surrounding spaces, so that value authenticated fine
 * before this gate existed.
 *
 * Returning the TRIMMED string rather than a boolean is what keeps the two
 * halves from drifting: there is one normalized value, and every consumer
 * (the holder's cache, the fetch header, the beacon body) uses the one this
 * function handed back. Surrounding whitespace is now normalized away;
 * INTERIOR CR/LF and everything else outside the base64url alphabet is still
 * refused, because that is the case that breaks a header.
 *
 * Anything this rejects would have been refused server-side as `malformed`
 * before verification anyway, so refusing it here loses no attribution that
 * was ever going to happen. What the CALLER must then do is the other half of
 * invariant 1: a token that was configured and rejected here is a
 * presented-but-failed credential, so the self-declared `user` block beside it
 * is withheld too (sdk-web's `vitals/index.ts`) — never silently downgraded to
 * the weaker claim.
 */
export function presentableIdentityToken(token: string): string | null {
  const trimmed = token.trim();
  if (trimmed.length > IDENTITY_TOKEN_MAX_CHARS) return null;
  return COMPACT_JWS_RE.test(trimmed) ? trimmed : null;
}

/**
 * How far ahead of `exp` a cached/one-shot token is considered too stale to
 * present. A one-shot string source (no re-ask possible) inside this margin
 * resolves to `null`, not the near-expired token — presenting a token that
 * may well have expired by the time it reaches the server buys nothing.
 */
export const IDENTITY_REFRESH_MARGIN_MS = 30_000;

/**
 * Upper bound on how long we wait for a host-supplied provider function. The
 * whole point of this feature is that identity is an enhancement, never a
 * blocker — a hung provider must not hang (or meaningfully delay) a report.
 */
export const IDENTITY_PROVIDER_TIMEOUT_MS = 2_000;

/**
 * What a host can hand to `tx.setIdentityToken(...)`:
 *   - a JWT string: presented until it nears expiry, then dropped (a one-shot
 *     value cannot be re-asked, so the user goes back to anonymous rather
 *     than the SDK presenting a stale/expired token);
 *   - a provider function: re-invoked as the cached token nears expiry,
 *     bounded by `IDENTITY_PROVIDER_TIMEOUT_MS`;
 *   - `null`: sign-out — clears any cached token and stops presenting one.
 */
export type IdentityTokenSource =
  | string
  | (() => string | null | Promise<string | null>)
  | null;

/**
 * The narrow read surface transport code needs (`submitReport`,
 * `createReporterApi`, and the web adapter's `__identityTokenReader` seam).
 * Kept separate from the concrete `IdentityTokenHolder` class so a caller
 * that needs to GATE access (e.g. on the config response's `identity.enabled`
 * before ever touching the real holder) can hand transport code a small
 * wrapper object instead of the holder itself.
 */
export interface IdentityTokenReader {
  get(now: number): Promise<string | null>;
}

const BASE64URL_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BASE64URL_REVERSE: Readonly<Record<string, number>> = (() => {
  const map: Record<string, number> = {};
  for (let i = 0; i < BASE64URL_ALPHABET.length; i++) {
    map[BASE64URL_ALPHABET[i]!] = i;
  }
  return map;
})();

/**
 * Hand-rolled base64url decode (no `atob` — DOM-only — and no `Buffer` —
 * Node-only; sdk-core stays reachable from both plus RN/other hosts, same
 * doctrine as device-token.ts's hand-rolled ENCODE). Throws on any character
 * outside the base64url alphabet; callers treat that as "undecodable".
 */
function base64UrlDecodeToBytes(input: string): Uint8Array {
  const clean = input.replace(/=+$/, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const value = BASE64URL_REVERSE[ch];
    if (value === undefined) throw new Error('invalid base64url character');
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

/**
 * Decode (never verify) a JWT's payload object. `null` for anything that
 * isn't a well-formed `header.payload.signature` string with a JSON-object
 * payload — malformed input is never thrown, only reported as absent.
 * Shared by `decodeExpMs` and `decodeSub` below; like the rest of this file,
 * this is a DECODE, not a verification (see the module doc).
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const payloadSegment = parts[1];
  if (!payloadSegment) return null;
  let payload: unknown;
  try {
    const bytes = base64UrlDecodeToBytes(payloadSegment);
    const json = new TextDecoder().decode(bytes);
    payload = JSON.parse(json);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return payload as Record<string, unknown>;
}

/**
 * Decode (never verify) a JWT's `exp` claim, in epoch milliseconds. `null`
 * for anything that isn't a well-formed token with a numeric `exp` in its
 * payload — malformed input is never thrown, only reported as absent.
 */
function decodeExpMs(token: string): number | null {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  const exp = payload.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  return exp * 1000;
}

/**
 * Decode (never verify) a JWT's `sub` claim. `null` for anything malformed
 * or missing a non-empty string `sub`.
 *
 * Used ONLY by `packages/sdk-react/src/transport/submit.ts` to detect
 * whether the identity active when an outbox entry was queued still matches
 * the identity active when it drains — an outbox entry never carries a
 * verified attribution of its own (see that file's module doc for the full
 * design). This is never used to attribute a report server-side; that's the
 * server's OWN verified decode (`the server identity-token verifier`).
 */
export function decodeSub(token: string): string | null {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  const sub = payload.sub;
  return typeof sub === 'string' && sub.length > 0 ? sub : null;
}

/** Race `p` against a timer; rejects on timeout so the caller's catch handles both uniformly. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('identity token provider timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e as Error);
      },
    );
  });
}

/**
 * In-memory holder for the host-supplied identity token. Never throws out of
 * `get()` — every failure path (throwing provider, hung provider, malformed
 * token, non-string result) resolves `null`, which callers treat exactly like
 * "no token was ever set": the report/call proceeds anonymously.
 */
export class IdentityTokenHolder implements IdentityTokenReader {
  private source: IdentityTokenSource = null;
  private cachedToken: string | null = null;
  private cachedExpMs: number | null = null;
  /**
   * Bumped on every `set()` call. `get()`'s provider branch captures this
   * BEFORE awaiting the host's provider and re-checks it on resolution — see
   * that branch's comment for the race this closes (PR review Finding 1,
   * 2026-08-06 identity spec): a provider call started for one identity must
   * never write its result into the cache once `set()` has moved the holder
   * on to a different (or no) identity while that call was in flight.
   */
  private generation = 0;

  /**
   * Optional validity predicate. Installed by a caller (sdk-react's
   * `useIdentityProp`) that needs to refuse a cached token whose identity no
   * longer matches the one currently being rendered — see `setGuard` below.
   */
  private guard: (() => boolean) | null = null;

  /**
   * Install a validity predicate, or clear it with `null`.
   *
   * When set and returning false, `get()` and `peek()` resolve `null` WITHOUT
   * clearing the cache and WITHOUT invoking the source. Non-destructive by
   * design: the caller uses this to refuse a token whose identity no longer
   * matches the one currently being rendered, and a refusal that turns out to
   * be spurious costs one anonymous read rather than destroying a live token.
   */
  setGuard(guard: (() => boolean) | null): void {
    this.guard = guard;
  }

  /**
   * Consult `guard`, treating a throw as "not valid" — `get()`/`peek()` never
   * throw (see the class doc), so a caller-supplied predicate must not be
   * able to break that contract either.
   */
  private guardAllows(): boolean {
    if (this.guard === null) return true;
    try {
      return this.guard();
    } catch {
      return false;
    }
  }

  /** Replace the source. Always drops any cached token — a stale cache from
   *  the PREVIOUS source (e.g. a different signed-in user) must never survive
   *  a call to `set()`, including `set(null)` (sign-out). Also bumps
   *  `generation` so any in-flight `get()` provider call started under the
   *  old source discards its result instead of repopulating this cache. */
  set(source: IdentityTokenSource): void {
    this.source = source;
    this.cachedToken = null;
    this.cachedExpMs = null;
    this.generation++;
  }

  /** True once `set()` has been called with a non-null source (a token
   *  string or provider function) and hasn't since been cleared. Used ONLY
   *  by `packages/sdk-react/src/provider.tsx`'s mount-time outbox drain to
   *  decide whether it's worth a BOUNDED wait for config resolution before
   *  draining — see that call site's comment for the race this closes
   *  (PR review Finding 2, 2026-08-06 identity spec). Not used for anything
   *  that affects what token is presented. */
  hasSource(): boolean {
    return this.source !== null;
  }

  /**
   * "AN IDENTITY TOKEN IS CONFIGURED, AND THERE IS NO USABLE ONE RIGHT NOW."
   * Exactly two observable facts, read at the moment the question is asked:
   * a source is set, and `peek(now)` has nothing to present.
   *
   * WHY IT EXISTS (adversarial review of PR #218 round 2, finding 3 —
   * reproduced with a correctly signed token and no report filed: TWO identity
   * rows for one fresh session). The vitals collector reads identity
   * synchronously and cache-only, so on a fresh page its first summary goes
   * out before any warm can land. With `setUser` also set, that summary
   * carried the self-declared `user` block and minted an UNVERIFIED person;
   * the next summary carried the now-warm token and minted the VERIFIED one.
   * A persistent twin, from nothing but a cold cache.
   *
   * The collector uses this to WITHHOLD the self-declared block whenever the
   * verified tier is configured but unavailable, which trades an anonymous
   * summary for never creating the twin. It is a scheduling hint, never an
   * access decision: nothing here gates which token is presented.
   *
   * IT IS STATELESS ON PURPOSE — rounds 2 through 5 are why. Every earlier
   * version kept a "this source has settled on nobody" flag beside the cache
   * and tried to decide when to re-arm it. Each round found another ordering
   * that desynchronized the flag from reality, and each one failed in the
   * SAME dangerous direction: the `user` block going out with no credential
   * beside it, minting the unverified twin this predicate exists to prevent
   * (round 3: a latch that survived a cache aging into the refresh margin, and
   * a provider that failed then recovered; round 4: one of two overlapping
   * calls concluding "nobody" ahead of its sibling's token; round 5: a
   * provider that answered null and then started returning undecodable tokens,
   * never clearing the flag, and overlapping calls resolving token-first,
   * null-last). Four fix waves, four new regressions. There is no flag here
   * now, so there is no re-arming rule, no resolution ordering, and no
   * in-flight bookkeeping that can disagree with the cache.
   *
   * THE KNOWN COST, stated plainly: a host that configures an identity token
   * source whose provider PERMANENTLY yields `null` — a signed-out viewer, in
   * an app that wires the provider unconditionally — never gets a self-declared
   * `user` block either. Those sessions stay ANONYMOUS rather than unverified.
   * That is the correct trade under the design spec's invariant 1: transient
   * (or even permanent) anonymity is the safe failure, while a persistent
   * unverified twin of a person the verified tier already knows is the precise
   * harm this feature exists to avoid. A host that wants the self-declared
   * tier for signed-out viewers expresses that the way the API already
   * provides: `setIdentityToken(null)` when nobody is signed in, which clears
   * the source and makes this `false`.
   */
  hasUnresolvedSource(now: number): boolean {
    return this.source !== null && this.peek(now) === null;
  }

  /**
   * Cache-only, SYNCHRONOUS read: the currently cached token if one is
   * present and not past the refresh margin, `null` otherwise. NEVER invokes
   * the host's provider and never awaits anything — this is `get()`'s cache
   * check (the block at the top of that method) split out on its own, with
   * no fallback to `source` at all.
   *
   * PR review, round 3 (Serious, crash-sink half) — for a call site that
   * needs "the identity that was already live a moment ago" (e.g. capturing
   * the subject to attribute a crash report to), asking `get()` is the wrong
   * tool even though it would often return the same answer: `get()` can
   * invoke the host's provider and wait up to `IDENTITY_PROVIDER_TIMEOUT_MS`
   * for it, which a crash sink must never do (identity is an enhancement,
   * never a blocker — see the module doc). `peek()` costs nothing and is
   * always safe to call on any hot path.
   */
  peek(now: number): string | null {
    if (!this.guardAllows()) return null;
    if (
      this.cachedToken !== null &&
      this.cachedExpMs !== null &&
      this.cachedExpMs - now > IDENTITY_REFRESH_MARGIN_MS
    ) {
      return this.cachedToken;
    }
    return null;
  }

  /**
   * Resolve the token to present right now, or `null` if none should be
   * presented: no source, undecodable, provider threw/timed out/returned
   * non-string, or — for an already-CACHED token (a previous call's result,
   * whether from a one-shot string or an earlier provider call) — inside the
   * refresh margin.
   *
   * Note this margin check does NOT apply to a token a provider call just
   * now returned: a freshly-fetched result is cached and returned as-is even
   * if it happens to already be inside the margin (e.g. the host's provider
   * handed back a nearly-expired token). That's intentional, not a gap — the
   * NEXT `get()` call will see the cache fail the margin check and re-ask the
   * provider immediately (this function is never the security boundary; a
   * too-stale token is simply rejected server-side and the request proceeds
   * anonymously, same as any other failure path here).
   */
  async get(now: number): Promise<string | null> {
    if (!this.guardAllows()) return null;
    if (
      this.cachedToken !== null &&
      this.cachedExpMs !== null &&
      this.cachedExpMs - now > IDENTITY_REFRESH_MARGIN_MS
    ) {
      return this.cachedToken;
    }

    const source = this.source;
    if (source === null) return null;

    if (typeof source === 'string') {
      // One-shot value: decode fresh (nothing to cache across calls beyond
      // what's already checked above) — a source string can never be
      // re-asked, so once it's inside the margin it's just gone.
      //
      // TRIMMED first, like every other value that becomes a presented token
      // (see `presentableIdentityToken`): the cache, the header and the beacon
      // body must all carry the one normalized string, never the host's
      // padding.
      const value = source.trim();
      const expMs = decodeExpMs(value);
      if (expMs === null) return null;
      if (expMs - now <= IDENTITY_REFRESH_MARGIN_MS) return null;
      this.cachedToken = value;
      this.cachedExpMs = expMs;
      return value;
    }

    // Provider function — bounded by IDENTITY_PROVIDER_TIMEOUT_MS. Wrapped in
    // a resolved-promise chain so a SYNCHRONOUS throw from `source()` becomes
    // a rejection here rather than throwing out of `get()` itself.
    //
    // PR review Finding 1 (2026-08-06 identity spec) — capture the
    // generation BEFORE awaiting. A concurrent `set()` (sign-out, or a
    // switch to a different user/provider/token) while this call is in
    // flight must not let this call's — now stale — result land in the
    // cache: e.g. Alice's provider call is still pending when the host signs
    // out or switches to Bob; Alice's token must never overwrite the cache
    // `set()` just cleared (or repopulate it with Alice's identity under
    // Bob). Checked again right after the await resolves, before touching
    // ANY state derived from the result.
    const startGeneration = this.generation;
    let raw: string | null | undefined;
    try {
      raw = await withTimeout(
        Promise.resolve().then(() => source()),
        IDENTITY_PROVIDER_TIMEOUT_MS,
      );
    } catch {
      // Threw or timed out: nothing to cache, and the caller reads anonymous.
      // `hasUnresolvedSource` needs no notification — it re-derives its answer
      // from the cache, which this call simply left untouched.
      return null;
    }
    if (this.generation !== startGeneration) {
      // Stale: `set()` moved the holder on while this call was in flight.
      // Discard outright — return null and cache nothing, exactly as if this
      // call had never happened. The generation that owns this result is
      // gone; there is nothing safe to do with `raw` here.
      return null;
    }
    if (!this.guardAllows()) {
      // PR review (Serious, identity recognition) — the guard was consulted
      // at the top of this method, before the await above. A concurrent
      // identity switch (e.g. the app's render-phase signal flipping from
      // Alice to Bob) while the provider call was in flight must not let
      // Alice's now-stale result land in the cache or reach the caller, who
      // is by now operating as Bob. Re-check right alongside the generation
      // check above, for the same reason: discard outright, exactly as if
      // this call had never happened.
      return null;
    }
    // "Nobody is signed in" — no token to cache, and nothing else to record.
    // The host says so by returning `null` from a provider it keeps wired; the
    // session then stays anonymous rather than falling back to the weaker
    // self-declared claim. `hasUnresolvedSource` explains why that is the
    // trade, and how a host opts out of it (`setIdentityToken(null)`).
    if (raw === null || raw === undefined) return null;
    // A non-string is a broken provider: same outcome, nothing cached.
    if (typeof raw !== 'string') return null;
    // Normalized once, here, so the cache and every consumer of it hold the
    // exact string that goes on the wire — see `presentableIdentityToken`.
    const value = raw.trim();
    const expMs = decodeExpMs(value);
    if (expMs === null) return null;
    this.cachedToken = value;
    this.cachedExpMs = expMs;
    return value;
  }
}
