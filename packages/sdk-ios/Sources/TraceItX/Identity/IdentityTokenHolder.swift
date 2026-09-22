// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Reporter identity recognition (spec 2026-08-06), iOS side. Swift twin of
// packages/sdk-core/src/reporter/identity-token.ts — the constants and the
// posture are copied from there deliberately, so web and native cannot drift
// on when a token stops being presentable.
//
// The host's backend signs a short-lived JWT identifying the person using the
// app and hands it here. This file holds it IN MEMORY ONLY — it lives at most
// ten minutes, so writing it to storage would only create a place for it to
// leak.
//
// The `exp` read below is a DECODE, not a verification: this SDK holds no
// secret and is not a security boundary. the server identity-token verifier is
// the only place the signature is actually checked. We read `exp` purely to
// know when to stop presenting a token, and `sub` so the capture-time subject
// gate can compare identities. Do NOT "harden" this into something that
// validates signatures or rejects malformed tokens on security grounds — an
// undecodable or expired token is simply treated as ABSENT, exactly like a
// host that never called setIdentityToken, so the report still submits
// (anonymously). Recognition must never fail or stall a report.
//
// DELIBERATELY NOT ON `TraceItX.swift`: that file is `canImport(UIKit)`-gated,
// so anything living there is unreachable from `swift test` on macOS — which
// is the only place this SDK's tests run in CI.
import Foundation

/// The header ingest reads the token from.
public let IDENTITY_TOKEN_HEADER = "X-TX-Identity-Token"

/// How far ahead of `exp` a cached token is considered too stale to present.
/// A token inside this margin resolves to `nil` rather than being presented —
/// one that may well have expired by the time it reaches the server buys
/// nothing.
public let IDENTITY_REFRESH_MARGIN: TimeInterval = 30

/// Upper bound on how long we wait for a host-supplied provider. The whole
/// point of this feature is that identity is an enhancement, never a blocker.
public let IDENTITY_PROVIDER_TIMEOUT: TimeInterval = 2

/// Mirrors `the server identity-token verifier`'s `IDENTITY_TOKEN_MAX_CHARS`
/// (and the Android twin's `IDENTITY_TOKEN_MAX_CHARS`) — the server rejects
/// anything longer outright. An over-long token here is only ever an
/// ANONYMOUS outcome (the header attaches and the server refuses it), never
/// a lost report — refusing it in the holder instead is cheap and just
/// saves a pointless round trip.
public let IDENTITY_TOKEN_MAX_CHARS = 4096

/// What a host can hand to `TraceItX.shared.setIdentityToken(...)`.
public enum IdentityTokenSource: Sendable {
    /// A JWT string. Presented until it nears expiry, then dropped — a one-shot
    /// value cannot be re-asked, so the user goes back to anonymous rather than
    /// the SDK presenting a stale token.
    case token(String)
    /// Re-invoked as the cached token nears expiry, bounded by
    /// `IDENTITY_PROVIDER_TIMEOUT`.
    case provider(@Sendable () async -> String?)
}

public final class IdentityTokenHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var source: IdentityTokenSource?
    private var cached: String?
    private var cachedExp: Date?
    /// Bumped on every `set()` call. `get()`'s provider branch captures this
    /// BEFORE awaiting the host's provider and re-checks it (under the same
    /// lock as the cache write) once the provider resolves — Swift twin of
    /// `generation` in identity-token.ts (PR review Finding 1, 2026-08-06
    /// identity spec). Without this, a provider call started under one
    /// source (or user) whose result lands AFTER a concurrent `set()` has
    /// moved the holder on to a different source — including `set(nil)`
    /// sign-out — would repopulate the cache with the stale identity's
    /// token: e.g. Alice's provider call is still in flight when the host
    /// signs out or switches to Bob; without this guard Alice's real, valid
    /// token would overwrite the cache `set()` just cleared, and the next
    /// `get()` would serve Alice's token as Bob's — a cross-user
    /// bearer-credential leak, exactly what this feature exists to prevent.
    private var generation = 0

    /// Independent review, round 10, P1 — single-flight tracking: at most
    /// ONE outstanding provider call per `generation`. Before this, `get()`
    /// launched a fresh unstructured `Task { }` on EVERY call with no
    /// tracking at all — a never-resolving provider, re-asked on every
    /// install and every reporter-open (which repeats, unlike a one-shot
    /// warm), accumulated one abandoned `Task` per call, INDEFINITELY, and
    /// `kill()` had no way to reach any of them.
    ///
    /// Independent review, round 11, P1(a) — round 10's fix bounded
    /// INVOCATIONS but not WAITERS, and only tracked the MOST RECENT call —
    /// see `ProviderCall`'s doc comment below for why `Task.value` cannot be
    /// safely awaited from more than one place if a caller must be able to
    /// give up early, and `outstandingCalls`' doc comment for why a single
    /// "current" handle isn't enough for `kill()` either. Both are fixed
    /// together here: `currentCall` is which call a NEW request for THIS
    /// `generation` may JOIN (unchanged in spirit from round 10's
    /// `inFlightTask`, now a `ProviderCall` instead of a raw `Task`);
    /// `outstandingCalls` is EVERY call not yet finished, across ALL
    /// generations, which is what `cancelOutstandingWork()` actually
    /// iterates.
    ///
    /// `currentCallTicket` plays the same "is this still the current one"
    /// role round 10's `inFlightTicket` played (Swift's `Task` has no
    /// `isActive`/`isCompleted` public property, unlike Kotlin's
    /// `Deferred.isActive`), but is now a DEDICATED field rather than double-
    /// duty with the monotonic counter itself (`nextTicket`) — separating
    /// "which ticket am I on" from "which ticket is currently joinable"
    /// keeps `clearOutstanding(ticket:)` (below) correct independent of how
    /// many OTHER calls have launched since.
    ///
    /// Keyed by `generation`, not merely "is something in flight": a `set()`
    /// call moves the holder on to a different source `generation` and this
    /// must NOT let a later caller join a call still running against the OLD
    /// (now-stale) provider — that would return the wrong provider's answer
    /// entirely, not just a stale one.
    private var inFlightGeneration: Int?
    private var currentCallTicket: Int?
    private var currentCall: ProviderCall?
    private var nextTicket = 0

    /// Independent review, round 11, P1(a) — EVERY provider call not yet
    /// finished, keyed by its own ticket, across ALL generations. Round 10's
    /// `cancelOutstandingWork()` only ever reached `inFlightTask`, the SINGLE
    /// most-recently-launched call: a `set()` superseding the source while an
    /// OLDER generation's call was still running overwrote that one handle,
    /// leaving the older call permanently unreachable — `kill()` (the switch
    /// that exists to make the SDK stop doing anything) could cancel the
    /// newest outstanding call and nothing else. `providerCall(_:generation:)`
    /// inserts into this dictionary the moment it launches a FRESH call
    /// (never on a joined one — nothing new to track); `clearOutstanding(
    /// ticket:)` removes the entry the moment that specific call finishes,
    /// regardless of whether it was ever superseded. `cancelOutstandingWork()`
    /// cancels every entry still present, which is exactly "every call that
    /// hasn't finished yet," independent of `currentCall`/`currentCallTicket`
    /// above (which only ever describe the SINGLE call new requests may
    /// join).
    private var outstandingCalls: [Int: ProviderCall] = [:]

    public init() {}

    /// Install or clear the token source. `nil` is sign-out: it drops the
    /// cached token immediately, even mid-lifetime. Always bumps
    /// `generation`, so any in-flight `get()` provider call started under
    /// the previous source discards its result instead of repopulating this
    /// cache (see `generation`'s doc above).
    public func set(_ source: IdentityTokenSource?) {
        lock.lock(); defer { lock.unlock() }
        self.source = source
        self.cached = nil
        self.cachedExp = nil
        self.generation += 1
        if case .token(let t) = source {
            // A one-shot string IS the cache — there is nothing to re-ask.
            if let claims = decodeIdentityClaims(t), let exp = claims.exp {
                self.cached = t
                self.cachedExp = exp
            }
            // An undecodable or exp-less string caches nothing, so `get`
            // resolves nil: absent, not an error.
        }
    }

    /// Cancel EVERY outstanding provider call — called from `TraceItX.kill()`
    /// (independent review, round 10, P1; widened round 11, P1(a) to reach
    /// every superseded call, not only the most recent). Does not tear down
    /// anything else about this holder: this same instance is owned for the
    /// whole process lifetime by the `TraceItX` singleton (never
    /// reconstructed per `start()`/`kill()` cycle), so a later
    /// `start()`/`setIdentityToken` call after this must still be able to
    /// launch a fresh provider call. `set(nil)` (already called by `kill()`
    /// immediately before this) bumps `generation`, which alone would keep
    /// any NEW caller from ever joining a cancelled call — this additionally
    /// delivers the actual cancellation signal to EVERY call still tracked in
    /// `outstandingCalls`, so a well-behaved host provider that polls
    /// `Task.isCancelled` stops promptly instead of running to completion
    /// orphaned, closing the gap `kill()` (a switch that exists to make the
    /// SDK stop doing anything) already closed everywhere else.
    public func cancelOutstandingWork() {
        lock.lock()
        let calls = Array(outstandingCalls.values)
        lock.unlock()
        for call in calls { call.cancel() }
    }

    /// Test-only (independent review, round 11, P1(a)) — sums
    /// `ProviderCall.waiterCountForTesting` across every call still tracked
    /// in `outstandingCalls`. `internal`, not `public` — reachable only via
    /// `@testable import`, matching this file's/TraceItX.swift's other
    /// double-underscore "SDK-internal, test seam" declarations
    /// (`__replayConfigOverrideForTesting` et al.). Lets a test assert
    /// directly that repeated, timed-out `get(now:)` calls against a
    /// never-resolving provider leave nothing registered, rather than only
    /// inferring it indirectly from timing.
    internal func __outstandingWaiterCountForTesting() -> Int {
        lock.lock()
        let calls = Array(outstandingCalls.values)
        lock.unlock()
        return calls.reduce(0) { $0 + $1.waiterCountForTesting }
    }

    /// Single-flight accessor (independent review, round 10, P1; round 11,
    /// P1(a) — now returns a `ProviderCall`, not a raw `Task`, so MANY
    /// callers can each wait under their own bound without leaking; see that
    /// type's doc comment): if a provider call for THIS `generation` is
    /// already running, join it instead of launching a second one — this is
    /// what bounds outstanding work to one per holder regardless of how
    /// pathological the host's provider is (never resolving, blocking, or
    /// otherwise). Each caller still races `ProviderCall.value(timeout:)`
    /// against its OWN `IDENTITY_PROVIDER_TIMEOUT` window in `get(now:)` —
    /// joining does not extend or reset that bound for a caller that arrives
    /// partway through an already-running call; it simply stops waiting at
    /// ITS OWN 2s mark either way, exactly as if it had launched its own
    /// (the round-1 fix, unchanged).
    ///
    /// A DIFFERENT generation (a `set()` landed since the running call
    /// started) never joins the old one — launched for the OLD provider,
    /// joining it would return THAT provider's answer under the NEW
    /// generation, which is simply the wrong provider being asked. A fresh
    /// call is launched instead, exactly as if nothing had been in flight,
    /// and the OLD one keeps running — tracked in `outstandingCalls` and so
    /// still cancellable via `cancelOutstandingWork()`, but this fresh
    /// request does not itself cancel it — that is `kill()`'s job
    /// specifically, not every `set()`, matching this file's existing
    /// "orphaned but off the critical path" posture for a superseded call
    /// outside of a kill.
    private func providerCall(_ fn: @escaping @Sendable () async -> String?, generation: Int) -> ProviderCall {
        lock.lock(); defer { lock.unlock() }
        if inFlightGeneration == generation, let existing = currentCall {
            return existing
        }
        nextTicket += 1
        let ticket = nextTicket
        let call = ProviderCall()
        outstandingCalls[ticket] = call
        call.start { [weak self] in
            let result = await fn()
            self?.clearOutstanding(ticket: ticket)
            return result
        }
        inFlightGeneration = generation
        currentCallTicket = ticket
        currentCall = call
        return call
    }

    /// Self-clearing hook for `providerCall(_:generation:)` above: a call
    /// removes itself from `outstandingCalls` the moment it finishes,
    /// unconditionally — that dictionary tracks every not-yet-finished call
    /// regardless of whether it is still the "current" (joinable) one, so
    /// this half needs no ticket comparison. `currentCall`/`currentCallTicket`
    /// are cleared too, but ONLY if `ticket` still matches
    /// `currentCallTicket` — i.e. only if no fresher call (a later `set()`'s
    /// new generation) has already replaced it as the joinable one. Without
    /// that guard a slow, superseded call finishing late could clear a
    /// NEWER call's "current" tracking out from under it, making a live
    /// in-flight call look like nothing is joinable.
    private func clearOutstanding(ticket: Int) {
        lock.lock(); defer { lock.unlock() }
        outstandingCalls.removeValue(forKey: ticket)
        if currentCallTicket == ticket {
            currentCall = nil
            currentCallTicket = nil
        }
    }

    /// The token to present right now, or `nil` for "send anonymously".
    public func get(now: Date) async -> String? {
        let (snapshotSource, snapshotCached, snapshotExp, startGeneration) = readState()

        if let cached = snapshotCached, let exp = snapshotExp,
           exp.timeIntervalSince(now) > IDENTITY_REFRESH_MARGIN {
            return cached
        }

        guard case .provider(let fn)? = snapshotSource else {
            // No provider to re-ask: a stale one-shot token is dropped rather
            // than presented.
            return nil
        }

        let call = providerCall(fn, generation: startGeneration)
        let fresh = await call.value(timeout: IDENTITY_PROVIDER_TIMEOUT)
        guard let fresh,
              let claims = decodeIdentityClaims(fresh),
              let exp = claims.exp
        else { return nil }
        // Independent review, round 14, Serious 1 — no margin check here,
        // deliberately. It is absent for a token a provider call just now
        // returned, matching `identity-token.ts`'s `get()` (see its own doc
        // comment on this exact point): a freshly-fetched result is the
        // newest thing available, so there is nothing better to refresh TO —
        // rejecting it for being "already inside the margin" would only ever
        // produce an anonymous report, never a fresher token. The margin
        // still gates every CACHED read (the check at the top of this
        // function) and a one-shot string SOURCE (`set()`'s own decode) —
        // both of which have a genuine "ask again" option this branch does
        // not. A provider that hands back a token already inside (or past)
        // the margin will simply be re-asked on the VERY NEXT `get()` call,
        // once this one's cache read fails the same check that gated the
        // old, over-eager version of this branch.

        // Generation check + cache write happen together, under one lock
        // acquisition, in a plain synchronous helper — both so a `set()`
        // landing between the check and the write can't slip a stale write
        // through (TOCTOU), and so the lock is never taken across an
        // `await` (NSLock inside an `async` function is a warning today,
        // an error under Swift 6 language mode).
        return commitIfCurrent(generation: startGeneration, token: fresh, exp: exp)
    }

    /// The `sub` of whatever `get(now:)` would return, or `nil`. Used to stamp
    /// the identity a report is being captured under.
    public func currentSubject(now: Date) async -> String? {
        guard let token = await get(now: now) else { return nil }
        return decodeIdentityClaims(token)?.sub
    }

    /// The `sub` of the CACHED token if it is still presentable, without invoking
    /// a provider. Capture boundaries (`TraceItX.captureUserSnapshot()`) are
    /// synchronous and must never block on the network, so a cold cache stamps
    /// the report anonymous — the fail-closed direction, and the warm-up path
    /// (`get`/`currentSubject`, called elsewhere off the capture boundary)
    /// exists to keep a cold cache off the common case.
    ///
    /// Independent review, round 14 follow-up, Serious 1 (closing the finding
    /// for real) — gated on merely NOT YET EXPIRED (`exp` still in the
    /// future), not on `IDENTITY_REFRESH_MARGIN`. The margin's job is
    /// deciding whether to RE-ASK the provider for something fresher — a
    /// decision only `get(now:)` (async, allowed to await a re-ask) can act
    /// on. This function has no such option (synchronous, must never invoke
    /// the provider — see the doc above), so applying the SAME margin here
    /// bought nothing and cost everything for a `ttlSeconds` at or below the
    /// margin: `get(now:)`'s own fresh-provider branch was fixed earlier
    /// this round to cache such a token, but THIS check then rejected the
    /// cache on every read anyway (mathematically guaranteed for TTL <=
    /// margin — remaining life only decreases from the moment a token is
    /// minted, so it can never again exceed a margin equal to its own total
    /// lifetime) — moving the blockage one step down the chain rather than
    /// removing it, exactly the residual the coordinator called out.
    ///
    /// Safe to widen: `resolveIdentityHeader` never presents THIS token —
    /// `capturedSubject` (this function's return value) is used ONLY to be
    /// COMPARED against the `sub` of whatever `get` independently and
    /// separately resolves at submit time (`IdentityGate.swift`). `get`'s
    /// own margin-gated cache check (unchanged, still
    /// `> IDENTITY_REFRESH_MARGIN`) is what actually decides whether the
    /// token that reaches the wire is fresh enough — stamping a subject here
    /// from a near-expiry token costs nothing beyond a comparison; if the
    /// token has genuinely gone stale by submit time, `get` re-asks or
    /// returns `nil` and the report goes out anonymous, exactly as it does
    /// today.
    public func cachedSubject(now: Date) -> String? {
        lock.lock(); defer { lock.unlock() }
        guard let cached, let exp = cachedExp, exp > now else { return nil }
        return decodeIdentityClaims(cached)?.sub
    }

    private func readState() -> (IdentityTokenSource?, String?, Date?, Int) {
        lock.lock(); defer { lock.unlock() }
        return (source, cached, cachedExp, generation)
    }

    /// Write a freshly-resolved provider result into the cache, but only if
    /// `generation` still matches what `get()` captured before awaiting the
    /// provider — otherwise a `set()` moved the holder on while that call
    /// was in flight, and the result is discarded outright: return `nil`
    /// and cache nothing, exactly as if the call had never happened.
    private func commitIfCurrent(generation: Int, token: String, exp: Date) -> String? {
        lock.lock(); defer { lock.unlock() }
        guard generation == self.generation else { return nil }
        self.cached = token
        self.cachedExp = exp
        return token
    }
}

/// A plain lock-protected `Bool`, synchronously readable/writable from any
/// thread or actor. See `TraceItX._identityEnabledFlag`'s doc comment for
/// why this exists: `captureUserSnapshot()` needs a synchronous way to know
/// whether identity is currently enabled for the project, and the live
/// config lives behind a `@MainActor`-isolated `ReplaySession`.
public final class IdentityEnabledFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false

    public init() {}

    public func get() -> Bool {
        lock.lock(); defer { lock.unlock() }
        return value
    }

    /// Independent review, round 11, P1(b) — `guard`, when non-nil, is
    /// evaluated INSIDE `lock`, the very first thing done after acquiring
    /// it, before the write — mirroring `NetworkBodyCaptureGate.applyConfig`'s
    /// own `` `guard` `` parameter (round-8 review Finding F39) exactly,
    /// rather than inventing a variant. `ReplaySession.refreshConfigNow()`
    /// is `@MainActor` but `TraceItX.start()`/`kill()` are synchronous and
    /// NOT actor-isolated, so they can run on a background thread while a
    /// refresh is mid-flight: this session's OWN epoch check earlier in
    /// `refreshConfigNow()` (`TraceItX.shared.currentStartEpoch ==
    /// startEpochAtCreation`) is a ONE-OFF check, taken before this write,
    /// not AT it — a superseding `start()`/`kill()` landing in the gap
    /// between that check and this call (there is no `await` between them
    /// in production, but the two run on genuinely DIFFERENT threads, so
    /// "no `await`" does not mean "no race") would bump the epoch, reset
    /// this flag to `false` on its own thread, and then have this now-stale
    /// write silently overwrite it back to whatever the OLD (superseded, or
    /// already-killed) session's own `isIdentityEnabled(latest)` says —
    /// re-enabling identity for a project the SDK has already moved on
    /// from, or a killed session that should present nothing. Evaluating
    /// the guard freshly, atomically with the mutation, closes that window
    /// regardless of how much real time elapses between the caller's
    /// earlier check and this call. `nil` (the default) skips the check
    /// entirely, so `start()`/`kill()`'s own unconditional `set(false)`
    /// calls — the authoritative epoch-bump-and-reset itself, already
    /// synchronous with the bump, needing no re-check — are unaffected.
    public func set(_ newValue: Bool, guard: (() -> Bool)? = nil) {
        lock.lock(); defer { lock.unlock() }
        if let `guard`, !`guard`() { return }
        value = newValue
    }
}

/// Wraps a single in-flight provider invocation so MANY callers can each
/// wait for its result under their OWN independent timeout, without any of
/// them leaving a `Task` suspended past that timeout — `get(now:)`'s
/// `IdentityTokenHolder.providerCall(_:generation:)` is the only producer of
/// these; `IdentityTokenHolder.get(now:)` is the only caller of `value(
/// timeout:)`.
///
/// Independent review, round 11, P1(a) — round 10 introduced single-flight
/// joining (bounding INVOCATIONS to one per generation) via a plain
/// `Task<String?, Never>`, raced per-caller against a timeout using the
/// module's then-existing `withTimeout(_:_:)` — `{ await task.value }` was
/// passed as `withTimeout`'s `work`, so every JOINING caller's own call to
/// `get(now:)` still spawned a fresh unstructured bridging `Task { let
/// result = await work(); … }` around that shared `.value`. `Task.value`
/// cannot be interrupted from the awaiting side — Swift's cooperative
/// cancellation does not propagate through `await someTask.value` at all —
/// so a caller whose own 2s timer won the race left that bridging `Task`
/// permanently suspended whenever the underlying provider never completed.
/// Every reporter-open warm joining the same single-flighted call still
/// left behind ANOTHER one of these immortal waiters: the leak simply moved
/// from "one provider call per warm" (round 10's own fix target) to "one
/// waiter per warm" — the identical unbounded-accumulation defect, one
/// layer up.
///
/// This closes it by never spawning a `Task` to "wait": each caller
/// instead registers a plain, synchronous callback (`waiters[id]`) and
/// races it against its OWN bounded timer `Task` (which always completes
/// after `seconds` — sleeping, never awaiting anything indefinite — so it
/// can never itself leak). The result, whenever the work actually
/// finishes, is delivered to every STILL-registered waiter via broadcast
/// (`deliver`); a waiter that times out first simply removes its own
/// callback and resumes locally, leaving nothing behind regardless of
/// whether — or when — the underlying work ever completes.
///
/// A useful side effect: because `deliver` fans out to every registered
/// waiter immediately, `cancelOutstandingWork()` cancelling this call's
/// `task` now unblocks every CURRENTLY-waiting caller right away too (once
/// the cancelled work actually finishes, which a well-behaved provider that
/// polls `Task.isCancelled` does promptly) — an improvement over the old
/// shape, where cancelling could never un-stick an already-suspended
/// `task.value` waiter at all.
private final class ProviderCall: @unchecked Sendable {
    private let lock = NSLock()
    /// `nil` = still pending; `.some(x)` = resolved to `x` (`x` itself may
    /// be `nil`, hence the double optional).
    private var resolved: String??
    private var waiters: [Int: (String?) -> Void] = [:]
    private var nextWaiterId = 0
    private var task: Task<Void, Never>!

    /// Must be called exactly once, immediately after `init()` — kept
    /// separate from `init` because a `Task` created INSIDE `init` cannot
    /// safely capture a not-yet-fully-initialized `self` weakly; by the time
    /// `start(_:)` runs, `self` is fully constructed and safe to capture.
    func start(_ fn: @escaping @Sendable () async -> String?) {
        task = Task { [weak self] in
            let result = await fn()
            self?.deliver(result)
        }
    }

    /// Deliver `fn`'s cancellation request to the underlying work — does
    /// NOT itself resolve any waiter; a well-behaved provider that observes
    /// the cancellation and returns promptly still resolves normally via
    /// `deliver`, broadcasting to whoever is still registered.
    func cancel() { task.cancel() }

    private func deliver(_ value: String?) {
        lock.lock()
        resolved = .some(value)
        let toNotify = waiters
        waiters = [:]
        lock.unlock()
        for notify in toNotify.values { notify(value) }
    }

    // Plain synchronous helpers below, each its own lock acquisition — kept
    // OUT of `value(timeout:)`'s own body (an `async` function) rather than
    // calling `lock.lock()`/`unlock()` there directly: `NSLock`'s methods
    // are flagged unavailable from asynchronous contexts (a warning today,
    // an error under the Swift 6 language mode) regardless of whether an
    // `await` actually separates the pair — mirrors the identical reason
    // `IdentityTokenHolder.readState()`/`commitIfCurrent(...)` above are
    // their own plain functions rather than inlined into `get(now:)`.

    private func allocateWaiterId() -> Int {
        lock.lock(); defer { lock.unlock() }
        let id = nextWaiterId
        nextWaiterId += 1
        return id
    }

    /// Check-and-register, ATOMICALLY under one lock acquisition — NOT two
    /// separate calls (a `fastResolved()` check followed by a SEPARATE
    /// `registerWaiter(_:_:)`, which is what an earlier version of this
    /// class did). That two-step shape had a genuine, empirically-hit race:
    /// `start(_:)`'s `Task` runs concurrently and can call `deliver(_:)` —
    /// which snapshots-then-clears `waiters` — in the WINDOW between this
    /// caller's own "not yet resolved" check and its registration actually
    /// landing. When that happens, `deliver` sees an EMPTY `waiters` (this
    /// caller hasn't registered yet), notifies nobody, and this caller's
    /// registration then lands into a dictionary NO FUTURE EVENT will ever
    /// consult again (there is only ever one `deliver` call per
    /// `ProviderCall`) — the caller silently falls through to its own
    /// timeout instead of receiving the result that, in truth, was already
    /// available. Returning the ALREADY-resolved value directly from here
    /// (instead of registering in that case) closes the window: either this
    /// runs completely before `deliver` (registers, and will be notified
    /// normally later) or completely after it (`deliver` already holds the
    /// lock or already released it with `resolved` set, so this sees it and
    /// never registers at all) — `deliver` takes the SAME lock, so no third
    /// interleaving exists.
    private func resolvedOrRegister(_ id: Int, _ callback: @escaping (String?) -> Void) -> String?? {
        lock.lock(); defer { lock.unlock() }
        if case .some(let v) = resolved {
            return .some(v)
        }
        waiters[id] = callback
        return nil
    }

    private func removeWaiter(_ id: Int) {
        lock.lock(); defer { lock.unlock() }
        waiters.removeValue(forKey: id)
    }

    /// Test-only introspection (independent review, round 11, P1(a)) — how
    /// many callers are CURRENTLY registered to be notified when this call
    /// resolves. Exists purely to make "repeated, timed-out joins leave
    /// nothing behind" directly assertable: Swift's `Task` type has no
    /// portable way to count live, suspended tasks from outside, so this
    /// counts the one piece of this mechanism's OWN bookkeeping that stands
    /// in for it — by construction, a waiter still registered here is the
    /// only thing that could still resolve a caller's `value(timeout:)`,
    /// so once every caller has either been delivered a result or given up
    /// via its own timer, this must read zero.
    var waiterCountForTesting: Int {
        lock.lock(); defer { lock.unlock() }
        return waiters.count
    }

    /// Wait for the result, giving up after `seconds` — bounds THIS
    /// CALLER's own wait, independent of every other waiter and of whether
    /// the underlying work ever completes. Unlike awaiting `task.value`
    /// directly, giving up here leaves nothing running: no `Task` is
    /// spawned to wait on anything indefinite, only a plain callback that
    /// either side (delivery or this caller's own timer) removes the
    /// instant it resolves.
    func value(timeout seconds: TimeInterval) async -> String? {
        let id = allocateWaiterId()

        return await withCheckedContinuation { (continuation: CheckedContinuation<String?, Never>) in
            let box = ResumeOnce(continuation)
            // Atomic check-and-register — see `resolvedOrRegister`'s own doc
            // comment for the race this closes: a SEPARATE check-then-
            // register (two lock acquisitions) can lose a `deliver` that
            // lands in between, leaving this caller registered into a
            // dictionary nothing will ever consult again.
            if case .some(let v) = resolvedOrRegister(id, { value in Task { await box.resume(with: value) } }) {
                Task { await box.resume(with: v) }
                return
            }
            // Bounded timer — always completes after `seconds` on its own,
            // regardless of the provider, so this Task can never itself
            // leak the way the old bridging `Task { await task.value }`
            // could.
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                self?.removeWaiter(id)
                await box.resume(with: nil)
            }
        }
    }
}

/// Lets exactly one of two racing resumptions win; the second (and any
/// further) call to `resume` is a silent no-op. An actor rather than a lock
/// because every caller is already in an `async` context (see
/// `ProviderCall.value(timeout:)` above, its only user since round 11 —
/// previously also used by the module-level `withTimeout(_:_:)` this
/// replaced) — no synchronous call site needs this.
///
/// `T: Sendable` (fix round 2) — without it, `resume(returning:)` sending
/// `value` out to the continuation's original context is flagged
/// `#SendingRisksDataRace` ("error in the Swift 6 language mode"): the
/// compiler has no proof the value is safe to hand across the actor
/// boundary. The one real instantiation (`String?`, in `ProviderCall.value(
/// timeout:)`) is `Sendable` too — `Optional` is conditionally `Sendable`
/// when its wrapped type is — so stating the constraint here costs nothing
/// and lets the compiler actually verify what was already true.
private actor ResumeOnce<T: Sendable> {
    private var continuation: CheckedContinuation<T, Never>?

    init(_ continuation: CheckedContinuation<T, Never>) {
        self.continuation = continuation
    }

    func resume(with value: T) {
        guard let c = continuation else { return }
        continuation = nil
        c.resume(returning: value)
    }
}

/// The base64url alphabet plus the JWT part separator `.` — every character
/// a well-formed, header-safe token may ever contain. Used by
/// `decodeIdentityClaims` below to reject anything else outright, BEFORE
/// the token is ever cached or handed to `URLRequest.setValue`.
private let tokenSafeCharacters: Set<Character> =
    Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.")

/// Non-verifying decode of a JWT's `sub` and `exp`. Returns `nil` for anything
/// that is not a well-formed three-part JWT with a JSON payload — callers treat
/// that as "absent".
///
/// Independent review, round 4 (Serious 2, Android-side finding; checked
/// here per the coordinator's explicit ask) — this is the single choke
/// point both `IdentityTokenHolder.set(_:)` (the one-shot `.token` source)
/// and `IdentityTokenHolder.get(now:)` (a provider's fresh result) already
/// route every candidate token through before caching/returning it, so the
/// character/length checks below close the hazard at its one source,
/// mirroring the identical fix in the Kotlin twin's `decodeIdentityClaims`.
///
/// This used to decode-check ONLY the payload segment (`parts[1]`) — the
/// header and signature segments were never inspected at all, so e.g.
/// `"bad\n.<valid-payload>.sig"` decoded fine and was cached/served
/// verbatim by `set`/`get`. On Android that reached OkHttp's `header(...)`
/// call, which THROWS on illegal header characters, taking the whole report
/// down via `txGuardSuspend`'s catch-all. Empirically verified this does
/// NOT reproduce the identical "lost report" failure mode here:
/// `URLRequest.setValue(_:forHTTPHeaderField:)` cannot throw (it is not a
/// `throws` function), and for a value containing `\n`/`\r` it silently
/// declines to set the field at all — `allHTTPHeaderFields` simply never
/// gains the key (see `IdentityTokenHolderTests.swift`'s
/// `testFoundationSilentlyDropsAHeaderValueContainingCRLF`, which pins this
/// empirically rather than assuming it). But other out-of-alphabet bytes
/// (a tab, a NUL) are NOT rejected by `setValue` and pass through onto the
/// wire as a corrupted, unverifiable header value — harmless to report
/// delivery, but needless garbage a well-formed decode should never have
/// accepted as a real token in the first place. Rejecting the full
/// character set here — not just relying on `setValue`'s own best-effort
/// behavior — keeps this file symmetric with its Kotlin/TypeScript twins
/// (this file's own header: "the constants and posture are copied from
/// there deliberately, so web and native cannot drift"), and is
/// unconditionally cheap.
func decodeIdentityClaims(_ jwt: String) -> (sub: String?, exp: Date?)? {
    guard !jwt.isEmpty, jwt.count <= IDENTITY_TOKEN_MAX_CHARS else { return nil }
    guard jwt.allSatisfy({ tokenSafeCharacters.contains($0) }) else { return nil }
    let parts = jwt.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 3 else { return nil }
    guard let payload = base64UrlDecode(String(parts[1])) else { return nil }
    guard let obj = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else { return nil }
    let sub = obj["sub"] as? String
    let exp = (obj["exp"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue) }
    return (sub, exp)
}

/// Base64url decode with padding restored. Foundation's decoder rejects
/// unpadded input and the base64url alphabet, so both are normalised first.
private func base64UrlDecode(_ s: String) -> Data? {
    var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while t.count % 4 != 0 { t.append("=") }
    return Data(base64Encoded: t)
}
