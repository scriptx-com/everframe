// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Vitals transport (web). Fire-and-forget delivery for VitalsChunk /
// SessionSummary payloads. Two paths:
//
//   - Normal (interval-flush) path: a `keepalive: true` fetch POST, with
//     EXACTLY ONE retry after 5s on a network error (rejected promise), a
//     5xx response, OR a 429 (rate-limited — Codex round-1 finding S3; a
//     limiter response is not a permanent rejection the way the rest of 4xx
//     is) — never on any OTHER 4xx, which IS a permanent rejection (bad key,
//     malformed payload) that retrying can't fix. A 429's own `Retry-After`
//     response header (seconds) is honored for that one retry's delay,
//     capped at `MAX_RETRY_AFTER_MS`; absent or unparseable falls back to the
//     same fixed 5s every other retry uses. Vitals are lossy by design: every
//     failure — including the retry's own — is swallowed rather than
//     surfaced or queued, unlike report submission (transport/submit.ts),
//     which enqueues into a durable outbox on a retryable failure.
//   - Unload path (`opts.beacon === true`): `navigator.sendBeacon`, because a
//     fetch started during pagehide/unload has no guarantee of completing.
//     sendBeacon can't set headers, so the apiKey rides in the body instead
//     of the Authorization header used on the fetch path; the blob is sent as
//     `text/plain` (not `application/json`) to keep it a CORS-simple request
//     with no preflight, which a fetch mid-unload can't afford to wait on. A
//     `false` return (queue full/refused) falls back to the fetch path so the
//     payload isn't silently dropped — best-effort, since a fetch begun
//     during unload can itself be cut short by the navigation.
//
// Kill-gate discipline matches the rest of the SDK (see
// packages/sdk-web/src/transport/submit.ts's identity-gating comments and
// companion/host-seam.ts's `hostSaysKilled`): `isKilled()` is read fresh at
// every send boundary rather than cached, INCLUDING the retry — up to 5s can
// pass between the first attempt and the retry, during which a `kill()` can
// land, and a killed client must produce zero further network traffic.
//
// Fix round 1 (review, Important) — `JSON.stringify` used to run unguarded,
// synchronously, ahead of any promise/try boundary. `VitalsPlayerEvent.data`
// is `Record<string, unknown>` (protocol/src/vitals.ts), so a BigInt or a
// circular reference placed there by an upstream caller made `JSON.stringify`
// THROW — synchronously out of `send()` on the first attempt, or out of the
// `setTimeout` callback (uncatchable by any caller) on the retry. Either way
// that breaks the "swallow all failures, fire-and-forget, return void"
// contract this module exists to provide. `safeSerialize` below is the single
// place `JSON.stringify` is called; every call site treats `undefined` as
// "drop this send silently" rather than letting the exception propagate.
import type { VitalsChunk, SessionSummary } from '@everframe/protocol';
import { IDENTITY_TOKEN_HEADER, presentableIdentityToken } from '@everframe/sdk-core';

const RETRY_DELAY_MS = 5_000;
// Codex round-1 finding S3 — the cap on how long a 429's `Retry-After` can
// push the single retry out. A server signaling a long backoff must not turn
// one dropped vitals send into a scheduled timer surviving well past the
// page's likely lifetime.
//
// Codex round-2 finding R3 — raised from 30s to 60s: the route's rate-limit
// window (the server vitals contract's RATE_LIMIT_WINDOW_MS) is a
// FIXED 60s window, and `Retry-After` on a 429 reflects time remaining in
// THAT window. A 30s cap retried into the same still-exhausted window every
// time — the retry landed before the window rolled over, got 429'd again,
// and (being the retry, `isRetry === true`) was never rescheduled: the send
// was PERMANENTLY dropped instead of succeeding on the next window. 60s
// matches the window exactly, so the one retry this module allows lands at
// or after the window has cleared.
const MAX_RETRY_AFTER_MS = 60_000;

// Codex round-5 item 1 — every failed send independently scheduled its own
// retry timer, holding that send's serialised body alive for up to
// MAX_RETRY_AFTER_MS (60s), with NO limit on how many could be outstanding
// at once. A customer calling `trackVitals` per media segment while offline
// produces one immediate send per full chunk (every 50 entries —
// collector.ts's `maxEntriesPerChunk`), each of which fails instantly and
// schedules a retry: 2,000 rejected sends became 2,000 live timers, each
// pinning a chunk-sized string — the exact "defeats the collector's own
// buffer bound" failure this whole SDK exists to avoid on the host page.
//
// Codex round-6 item 1 — round 5's cap counted only scheduled retry TIMERS,
// not the first-attempt fetch itself. If `fetch` (or an instrumentation
// wrapper / polyfill sitting on top of it) returns a promise that stays
// pending indefinitely, every flushed chunk still creates a brand-new
// request and retains its serialised body — the cap never engages because
// no retry is ever scheduled for a request that never settles. 2,000 sends
// against a stalled `fetch` produced 2,000 live in-flight requests. Both
// shapes now share ONE bound: `pending` below holds an entry for every
// scheduled retry timer AND every in-flight fetch, and the cap is enforced
// on that combined count.
//
// Bounded here at a small, fixed count rather than left to grow with
// however many sends the page happens to make. Each entry holds at most one
// chunk's serialised body, itself already capped near the collector's
// default 64 KB buffer bound (packages/sdk-core/src/vitals/collector.ts's
// `maxBufferBytes`) — so 20 outstanding entries bounds worst-case retained
// memory at roughly 20 chunks (~1.3 MB), a small, fixed cost regardless of
// how many `trackVitals`/sample/player-event sends actually failed or
// stalled, and negligible next to what an offline page already has resident.
//
// Codex round-7 item 2 — round 6's cap EVICTED the oldest entry to make room
// for a new one: shift it out of `pending`, cancel its timer or call
// `AbortController.abort()` on its fetch, then start the new request
// regardless. That bounds our own BOOKKEEPING array, but not the actual
// number of live requests: a fetch polyfill or instrumentation wrapper that
// ignores `AbortSignal` keeps its promise (and closure over the serialised
// body) alive whether or not we still track it — evicting our own entry
// doesn't free anything the wrapper itself is holding, it just makes room in
// `pending` for another real request to start on top of it. Reproduced
// concretely: 2,000 sends against such a wrapper aborted 1,980 signals, yet
// the wrapper still held all 2,000 pending promises — the exact "defeats the
// collector's own buffer bound" failure this cap exists to prevent, just one
// level further down the stack.
//
// Fixed by moving the cap from EVICTION to ADMISSION: once `pending.length`
// is already at `MAX_OUTSTANDING`, a new send or retry is refused outright —
// no entry is created, no timer is scheduled, `fetchFn` is never called —
// rather than displacing an existing entry to make room. Vitals are lossy by
// design (module doc above), so dropping the chunk is the correct outcome
// under sustained pressure; nothing is aborted anymore, since aborting
// something we cannot force a foreign wrapper to release was never actually
// bounding memory, only our own accounting of it. An entry now leaves
// `pending` only when its OWN fetch settles or its OWN retry timer fires —
// so a page whose `fetch` never settles at all simply stops issuing new
// vitals requests once the first `MAX_OUTSTANDING` are outstanding, which is
// the real bound this module promises.
const MAX_OUTSTANDING = 20;

export interface VitalsTransportDeps {
  /** `${apiUrl}/api/ingest/vitals` */
  endpoint: string;
  apiKey: string;
  /** Re-checked at every send boundary — see module doc. */
  isKilled(): boolean;
  /** Default: global `fetch`. */
  fetchFn?: typeof fetch;
  /** Default: `navigator.sendBeacon.bind(navigator)`, when available. */
  beaconFn?: (url: string, data: BodyInit) => boolean;
}

function defaultBeaconFn(): ((url: string, data: BodyInit) => boolean) | undefined {
  if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') {
    return undefined;
  }
  return navigator.sendBeacon.bind(navigator);
}

/**
 * `JSON.stringify`, guarded. `undefined` on failure (BigInt, circular
 * reference, etc.) rather than letting the exception propagate — see the
 * "Fix round 1" module note above for why this must never throw.
 */
function safeSerialize(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * Codex round-1 finding S3 — a 429 used to be swallowed with NO retry at all
 * (only `res.status >= 500` scheduled one), so a per-key/per-IP rate limit
 * dropped every vitals send hit during the limited window permanently. 429 is
 * now retried exactly like a 5xx, but a well-behaved limiter's `Retry-After`
 * (seconds) is honored instead of blindly retrying into the same window:
 * absent or unparseable falls back to the normal `RETRY_DELAY_MS`, and any
 * parsed value is capped at `MAX_RETRY_AFTER_MS` either way.
 */
function retryDelayForResponse(res: Response): number {
  const header = res.headers.get('retry-after');
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
    }
  }
  return RETRY_DELAY_MS;
}

export function createVitalsTransport(
  deps: VitalsTransportDeps,
): (
  body: VitalsChunk | SessionSummary,
  opts: { beacon: boolean; identityToken?: string },
) => void {
  // Bound to globalThis, matching sdk-core's http.ts default — an unbound
  // `fetch` reference can throw "Illegal invocation" in some environments.
  const fetchFn = deps.fetchFn ?? globalThis.fetch.bind(globalThis);
  const beaconFn = deps.beaconFn ?? defaultBeaconFn();

  /**
   * Task 11 — the identity token to present for THIS send, or `undefined`.
   *
   * HANDED IN WITH THE PAYLOAD, never fetched here (round-4 finding 5). This
   * module used to call an `identityToken()` dep of its own, which meant the
   * credential and the summary's `user` block came from two separate reads of
   * the host's provider and could describe two different moments — a cached
   * token one millisecond inside `IDENTITY_REFRESH_MARGIN_MS` produced a body
   * claiming Alice with no credential beside it, an unverified person where a
   * verified one was intended. The collector now reads identity ONCE per
   * summary and passes both halves down together (sdk-core's
   * `VitalsIdentitySnapshot`); this function only decides whether the value it
   * was handed may go on the wire.
   *
   * SUMMARIES ONLY, deliberately. The ingest route resolves identity in its
   * summary branch and nowhere else (the server vitals contract —
   * `resolveVitalsIdentity` is called there only), so a token on a chunk is
   * dead weight on the 30-second chunk cadence — the same argument the
   * collector uses for never stamping `user` onto a chunk. On the BEACON path
   * it would additionally be harmful: the collector sizes its chunk byte
   * budget against `BEACON_WRAPPER_FIXED_BYTES` + the apiKey length
   * (packages/sdk-core/src/vitals/collector.ts), which accounts for
   * `{"apiKey":"…","payload":…}` and nothing else, so an extra
   * `,"identityToken":"<jwt>"` on a max-size chunk would push the body past
   * the browser's 64 KiB `sendBeacon` limit and get the send refused — the
   * exact regression Codex round-3 item 8 fixed. A summary is tiny, so it has
   * no such budget to blow.
   *
   * Never throws: the holder is host-adjacent code, and this module's cardinal
   * invariant is that a failed send is swallowed, not surfaced. A throw here
   * degrades to "anonymous", exactly like no token having been set.
   */
  function tokenFor(
    body: VitalsChunk | SessionSummary,
    token: string | undefined,
  ): string | undefined {
    if (body.kind !== 'summary') return undefined;
    // BACKSTOP, not the gate (adversarial review of PR #218 round 3, findings
    // 1 and 3). An unpresentable token — over-length, or carrying a character
    // an HTTP header value forbids — costs the SUMMARY rather than just the
    // attribution: a 70 KB claim produced a 94,008-byte beacon body past
    // `sendBeacon`'s 64 KiB ceiling and a 431 on the fetch fallback, and an
    // embedded newline made `fetch` refuse the header before sending anything,
    // twice, retry included.
    //
    // The same rejection normally happens one layer up, where the identity
    // provider is read (`vitals/index.ts`'s `gateIdentity`), which under
    // `setupVitals` means this check never fires. It stays because
    // `opts.identityToken` is whatever the CALLER put there, and wiring
    // `createVitalsCollector` straight to this transport is a supported entry
    // point — a host or test doing so must still never lose a payload to a
    // malformed credential. It also NORMALIZES, for the same reason the gate
    // does (round-4 finding 2): what goes in the header and the beacon body is
    // `presentableIdentityToken`'s trimmed return value, never the caller's
    // padding.
    if (token === undefined) return undefined;
    return presentableIdentityToken(token) ?? undefined;
  }

  /**
   * The other half of that rejection, and it is not optional (round-5 finding
   * 3, reproduced through the real collector and transport). Dropping a
   * credential while the body still claims a person turns a
   * presented-but-failed identity into an ordinary UNVERIFIED one — the exact
   * downgrade invariant 1 forbids, and a persistent row in the directory.
   *
   * `gateIdentity` enforces this at the layer above by withholding both halves
   * together, but it only sees the `setupVitals` path. Enforcing the same rule
   * here means NO wiring can express "rejected credential, but keep the weaker
   * claim": whichever layer rejects the token, the claim goes with it.
   *
   * Narrow on purpose. It fires only when the caller actually SUPPLIED a token
   * that `tokenFor` then refused — a summary with no token offered at all is
   * the self-declared tier working as designed and keeps its `user` block, and
   * chunks never carry one.
   */
  function bodyFor(
    body: VitalsChunk | SessionSummary,
    supplied: string | undefined,
    screened: string | undefined,
  ): VitalsChunk | SessionSummary {
    if (body.kind !== 'summary') return body;
    if (supplied === undefined || screened !== undefined) return body;
    if (body.user === undefined) return body;
    const { user: _rejectedClaim, ...withoutClaim } = body;
    return withoutClaim;
  }

  // Codex round-5 item 1 / round-6 item 1 / round-7 item 2 — every
  // currently-outstanding entry, oldest first: a scheduled retry timer OR an
  // in-flight fetch. Per round-7 item 2, this array is now purely an
  // ADMISSION-control record — every push happens only after the length
  // check below has already confirmed there is room, so it never itself
  // exceeds `MAX_OUTSTANDING`; nothing here ever evicts another entry to
  // make room; an entry leaves ONLY when its own fetch settles or its own
  // retry timer fires.
  type PendingEntry =
    | { kind: 'retry'; timer: ReturnType<typeof setTimeout> }
    | { kind: 'inflight' };
  const pending: PendingEntry[] = [];

  function untrackPending(entry: PendingEntry): void {
    const i = pending.indexOf(entry);
    if (i !== -1) pending.splice(i, 1);
  }

  /**
   * Schedules exactly one retry, the same way every call site already did
   * with a bare `setTimeout` — except now admission-controlled (Codex
   * round-7 item 2) against the SAME shared cap as in-flight fetches: if the
   * ceiling is already occupied, the retry is dropped outright rather than
   * scheduled, exactly like `sendViaFetch` below refusing to start a new
   * request.
   *
   * THE RETRY CARRIES THE ORIGINAL TOKEN (adversarial review of PR #218,
   * finding 2 — this REVERSES an earlier fix round that dropped it).
   *
   * The token is still read exactly ONCE per `send()`, never re-read here:
   * a retry can land up to `MAX_RETRY_AFTER_MS` (60s) later, and re-asking
   * the holder at that point risks attributing a summary built under one
   * account to whoever signed in during the delay. That part of the earlier
   * reasoning stands and is why `identityToken` is threaded through as a
   * captured value rather than re-derived.
   *
   * What was WRONG was dropping it. The worry was that a 60s-delayed retry
   * could present a token past its `exp` (`peek()` only guarantees
   * `IDENTITY_REFRESH_MARGIN_MS`, 30s, of remaining life) and so resolve
   * ANONYMOUS under the route's presented-but-failed rule
   * (`the server vitals identity contract`) instead of falling back to the
   * self-declared `user` block in the same body. But that trade is upside
   * down:
   *
   *   - Dropping the token GUARANTEES the downgrade on EVERY ordinary
   *     429/503 retry, even when the token is still perfectly valid — the
   *     route reads the `user` block and mints/attaches an UNVERIFIED twin of
   *     a person the verified tier already knows. Twins persist.
   *   - Worse, if the first attempt actually COMMITTED and only its response
   *     was lost, the retry's unverified attribution OVERWRITES the verified
   *     one already on the row ("last non-null claim wins", vitals-route.ts).
   *   - Threading it costs, at worst, the expired case: the route sees a
   *     presented-but-failed token, resolves the summary anonymous, and
   *     creates NO row at all. Transient, self-healing, nothing to clean up —
   *     which is exactly the outcome the no-fallback rule is designed to
   *     produce.
   *
   * Clamping `MAX_RETRY_AFTER_MS` below the 30s margin remains rejected for
   * the original reason: Codex round-2 finding R3 raised the cap to 60s to
   * match the route's rate-limit window (`RATE_LIMIT_WINDOW_MS`), and
   * shrinking it would send retries back into the same exhausted window.
   */
  function scheduleRetry(
    serializedBody: string,
    delayMs: number,
    identityToken: string | undefined,
  ): void {
    if (pending.length >= MAX_OUTSTANDING) return; // ceiling occupied — drop, vitals are lossy

    const entry: PendingEntry = { kind: 'retry', timer: undefined as unknown as ReturnType<typeof setTimeout> };
    entry.timer = setTimeout(() => {
      // Codex round-7 item 3 — this timer callback is a bare, unguarded
      // entry point into foreign-adjacent code (it calls back into
      // `sendViaFetch`, which in turn calls the host's own `fetchFn`), with
      // no promise chain a caller could ever catch. A throw here — from
      // `sendViaFetch` itself, or propagating up through it from `fetchFn` —
      // would otherwise surface as an uncaught exception in the host page.
      // DEFE-02.
      //
      // Verification-pass finding — `untrackPending(entry)` used to run
      // AHEAD of this try, on the bare assumption that `Array.prototype`
      // bookkeeping can't throw. It can: a poisoned/frozen `pending` array,
      // or an instrumented `indexOf`/`splice`, throws here exactly like any
      // other foreign-adjacent call, and a throw at this point — before the
      // try below is ever entered — would escape the timer callback
      // uncaught. Moved inside the guard so it shares the same net as the
      // `sendViaFetch` call it was always meant to run alongside.
      try {
        untrackPending(entry);
        // The SAME token the first attempt captured — see this function's
        // own doc-comment for why it is threaded rather than dropped, and
        // why it is never re-read here.
        sendViaFetch(serializedBody, true, identityToken);
      } catch {
        /* swallow — DEFE-02 */
      }
    }, delayMs);
    pending.push(entry);
  }

  // `serializedBody` is the JSON string computed ONCE by `send()` below —
  // the retry reuses it rather than re-stringifying (also sidesteps
  // re-running a `JSON.stringify` that could throw a second time).
  // `isRetry` distinguishes the first attempt (may schedule ONE retry) from
  // the retry itself (never schedules another, whatever the outcome).
  function sendViaFetch(serializedBody: string, isRetry: boolean, identityToken?: string): void {
    if (deps.isKilled()) return; // re-checked here so the retry path is covered too

    // Codex round-7 item 2 — admission, not eviction. Once the ceiling is
    // already occupied, refuse to start ANOTHER request at all rather than
    // evicting an existing entry to make room: see the module-level comment
    // on `MAX_OUTSTANDING` for why eviction alone never actually bounded the
    // number of LIVE requests against a fetch polyfill/wrapper that ignores
    // `AbortSignal`. Dropping the chunk here is the correct, lossy-by-design
    // outcome under sustained pressure.
    if (pending.length >= MAX_OUTSTANDING) return;

    const entry: PendingEntry = { kind: 'inflight' };
    pending.push(entry);

    // Codex round-7 item 3 — `fetchFn` is foreign code: the host page's own
    // `fetch`, or an instrumentation wrapper/polyfill on top of it. A
    // REJECTED promise is already handled by the second `.then` callback
    // below, but this collector's cardinal invariant — never throw into the
    // host page — also has to cover a wrapper that throws SYNCHRONOUSLY
    // instead of rejecting (e.g. a circuit breaker that opens after a prior
    // failure and throws on the very next call). That throw happens outside
    // any promise chain, so only a try/catch around the call itself stops it
    // from escaping as an uncaught exception. Reproduced concretely: a
    // wrapper that rejects the first call, then throws synchronously on the
    // retry, surfaced as an uncaught exception. DEFE-02.
    //
    // Third attempt at this guarantee — solved structurally this time rather
    // than with another targeted wrapper. Round 7 guarded the retry timer
    // entry point, this synchronous `fetchFn` call, and the act of attaching
    // `.then` — but never the asynchronous fulfillment/rejection CALLBACKS
    // themselves. Reproduced concretely with a 429 response whose
    // instrumented `headers.get()` throws: that throw happens inside the
    // fulfillment callback below, well after `fetchFn`'s own promise has
    // already resolved, which rejects the promise `.then()` returns — a
    // promise nothing in this module (or its caller, `send()`, which returns
    // `void`) ever holds a reference to. An unheld, rejected promise is an
    // `unhandledrejection` in the host page, which is exactly the class of
    // failure this module's cardinal invariant forbids. Two independent
    // layers close it, deliberately redundant with each other so neither one
    // alone has to be the only thing standing between this module and that
    // invariant:
    //   1. Each callback body is now individually try/catched, so a throw
    //      from EITHER — the fulfillment path (headers.get(), status
    //      comparisons, retryDelayForResponse, scheduleRetry) or the
    //      rejection path (untrackPending, scheduleRetry) — never leaves the
    //      handler at all.
    //   2. A terminal `.catch(() => {})` is chained onto whatever `.then()`
    //      returns. This is the structural half: it makes "no path off this
    //      promise chain goes unhandled" true BY CONSTRUCTION, independent of
    //      whether every current or future throw site inside the handlers
    //      above is individually enumerated and wrapped correctly. Layer 1
    //      keeps `untrackPending`/`scheduleRetry` bookkeeping running even
    //      when a handler body throws partway through; layer 2 is the actual
    //      guarantee against an unhandled rejection.
    try {
      fetchFn(deps.endpoint, {
        method: 'POST',
        headers: {
          // Task 11 — captured ONCE by `send()` below rather than re-read
          // here, so the first attempt's header reflects whoever was signed
          // in when the summary was built (an account switch during the
          // retry delay must not re-attribute a summary that was already
          // built). The retry presents that SAME captured value — see
          // `scheduleRetry`'s doc-comment for why threading it beats
          // dropping it.
          authorization: 'Bearer ' + deps.apiKey,
          'content-type': 'application/json',
          ...(identityToken !== undefined ? { [IDENTITY_TOKEN_HEADER]: identityToken } : {}),
        },
        body: serializedBody,
        keepalive: true,
      })
        .then(
          (res) => {
            try {
              untrackPending(entry);
              // 429 retried exactly like a 5xx (Codex round-1 finding S3), but
              // with the server's own `Retry-After` honored instead of the
              // fixed delay. `res.headers.get` is foreign code (an
              // instrumentation wrapper can throw from it — the reproduced
              // 429 case) so it runs inside this try, not ahead of it.
              if (!isRetry && (res.status >= 500 || res.status === 429)) {
                const delay = res.status === 429 ? retryDelayForResponse(res) : RETRY_DELAY_MS;
                scheduleRetry(serializedBody, delay, identityToken);
              }
              // 2xx, other 4xx, or the retry's own outcome — swallowed either way; vitals are lossy.
            } catch {
              // A throw anywhere above (most notably `res.headers.get`) must
              // not reject the promise `.then()` returns — see the module
              // note above.
            }
          },
          (reason: unknown) => {
            try {
              untrackPending(entry);
              // A genuine network error, or an in-flight fetch being
              // aborted (host page navigation, an AbortController the host
              // attached, etc.) — both arrive here as a rejection, on either
              // the first attempt or the retry, and are treated identically:
              // one retry on the first attempt, none on the retry itself.
              // `reason` itself is never inspected; abort vs. network-error
              // both fall into the same lossy-by-design "swallow it" bucket.
              void reason;
              if (!isRetry) {
                scheduleRetry(serializedBody, RETRY_DELAY_MS, identityToken);
              }
            } catch {
              // A throw from this handler's own body (e.g. a future change
              // to `scheduleRetry`) must not reject the promise `.then()`
              // returns either.
            }
          },
        )
        .catch(() => {
          // Terminal safety net (see module note above): guarantees no
          // path off this promise chain is ever left unhandled, regardless
          // of what the two callbacks above do or fail to guard themselves.
        });
    } catch {
      // Synchronous throw from `fetchFn` itself (or from `.then`/`.catch` not
      // being a function on whatever it returned) — release the slot this
      // send occupied, and treat it exactly like the async rejection above:
      // one retry on the first attempt, none on the retry itself. DEFE-02.
      //
      // Verification-pass finding — `scheduleRetry` itself calls the host's
      // `setTimeout`, foreign code exactly like `fetchFn`. This catch block
      // is already the outermost guard around this synchronous-throw path
      // (nothing wraps `send()`'s call into `sendViaFetch`), so an
      // unguarded `setTimeout` throwing here — reproduced concretely with a
      // disabled global `setTimeout` — escaped `send()` into the host page.
      // The rejection handler above already nests its own `scheduleRetry`
      // call inside its try; this mirrors that discipline for the
      // synchronous-throw path so no call site of `scheduleRetry` is left
      // unguarded.
      untrackPending(entry);
      if (!isRetry) {
        try {
          scheduleRetry(serializedBody, RETRY_DELAY_MS, identityToken);
        } catch {
          /* swallow — DEFE-02 */
        }
      }
    }
  }

  return function send(
    body: VitalsChunk | SessionSummary,
    opts: { beacon: boolean; identityToken?: string },
  ): void {
    if (deps.isKilled()) return; // drop silently — neither fetchFn nor beaconFn is called

    // Task 11 — the ONE token the collector read for this payload, screened
    // once and then used by both paths below (including the fetch fallback
    // after a refused beacon) so a single send never presents two different
    // credentials, and the retry presents the same one again.
    const identityToken = tokenFor(body, opts.identityToken);
    // A token the caller supplied and `tokenFor` refused takes the
    // self-declared `user` block down with it — see `bodyFor`. Computed once
    // here so the beacon body, the fetch body and the retry all carry the
    // identical payload.
    const outgoing = bodyFor(body, opts.identityToken, identityToken);

    if (opts.beacon) {
      // `sendBeacon` cannot set headers — which is exactly why `apiKey`
      // already rides in the body here. The identity token gets the same
      // treatment; the route reads it off the validated
      // `VitalsIngestRequest.identityToken` and prefers the header when both
      // are present.
      const beaconJson = safeSerialize(
        identityToken !== undefined
          ? { apiKey: deps.apiKey, identityToken, payload: outgoing }
          : { apiKey: deps.apiKey, payload: outgoing },
      );
      // Unserializable — the fetch fallback below would stringify the same
      // `outgoing`, via the same underlying data, and fail identically, so
      // drop here rather than falling through to a guaranteed-to-fail fetch.
      if (beaconJson === undefined) return;
      const blob = new Blob([beaconJson], { type: 'text/plain;charset=UTF-8' });
      if (beaconFn?.(deps.endpoint, blob) === true) return;
      // beaconFn missing or refused (returned false) — fall back to fetch.
    }

    const fetchJson = safeSerialize({ payload: outgoing });
    if (fetchJson === undefined) return; // unserializable — drop silently
    sendViaFetch(fetchJson, false, identityToken);
  };
}
