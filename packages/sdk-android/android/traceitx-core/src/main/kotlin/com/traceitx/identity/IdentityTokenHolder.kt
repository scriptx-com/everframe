// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Reporter identity recognition (spec 2026-08-06), Android side. Kotlin twin
// of packages/sdk-core/src/reporter/identity-token.ts (and Swift twin
// packages/sdk-ios/Sources/TraceItX/Identity/IdentityTokenHolder.swift) — the
// constants and the posture are copied from there deliberately, so web and
// native cannot drift on when a token stops being presentable.
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
// Deliberately a standalone class, not living on the `TraceItX` singleton —
// mirrors the iOS file's own "unreachable from swift test" rationale in
// spirit: keeping this pure Kotlin + kotlinx.coroutines (no Android framework
// dependency) means its 15-test suite runs as plain JVM unit tests, no
// Robolectric required.
package com.traceitx.identity

import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The header ingest reads the token from. */
const val IDENTITY_TOKEN_HEADER = "X-TX-Identity-Token"

/**
 * How far ahead of `exp` a cached token is considered too stale to present.
 * A token inside this margin resolves to `null` rather than being presented —
 * one that may well have expired by the time it reaches the server buys
 * nothing.
 */
const val IDENTITY_REFRESH_MARGIN_MS: Long = 30_000

/**
 * Upper bound on how long we wait for a host-supplied provider. The whole
 * point of this feature is that identity is an enhancement, never a blocker.
 */
const val IDENTITY_PROVIDER_TIMEOUT_MS: Long = 2_000

/**
 * Mirrors `the server identity-token verifier`'s `IDENTITY_TOKEN_MAX_CHARS` —
 * the server rejects anything longer outright. An over-long token here is
 * only ever an ANONYMOUS outcome (the header attaches and the server
 * refuses it), never a lost report — refusing it in the holder instead is
 * cheap and just saves a pointless round trip.
 */
const val IDENTITY_TOKEN_MAX_CHARS: Int = 4096

/** What a host can hand to [IdentityTokenHolder.set]. */
sealed interface IdentityTokenSource {
    /**
     * A JWT string. Presented until it nears expiry, then dropped — a
     * one-shot value cannot be re-asked, so the user goes back to anonymous
     * rather than the SDK presenting a stale token.
     */
    data class Token(val jwt: String) : IdentityTokenSource

    /**
     * Re-invoked as the cached token nears expiry, bounded by
     * [IDENTITY_PROVIDER_TIMEOUT_MS]. A plain `class`, not `data class` —
     * matches the Swift twin's associated-closure enum case: a function
     * value has no meaningful structural equals/hashCode.
     */
    class Provider(val fn: suspend () -> String?) : IdentityTokenSource
}

/** Decoded (never verified) claims of interest from a JWT payload. */
internal data class IdentityClaims(val sub: String?, val expMs: Long?)

/**
 * In-memory holder for the host-supplied identity token. `get()` never
 * throws — every failure path (a throwing provider, a hung provider, a
 * malformed token, a non-string result) resolves `null`, exactly as if
 * `set()` had never been called: the report proceeds anonymously.
 */
class IdentityTokenHolder {
    private val lock = ReentrantLock()
    private var source: IdentityTokenSource? = null
    private var cached: String? = null
    private var cachedExpMs: Long? = null

    /**
     * Bumped on every [set] call. [get]'s provider branch captures this
     * BEFORE suspending on the host's provider and re-checks it (under the
     * same lock as the cache write, in [commitIfCurrent]) once the provider
     * resolves — Kotlin twin of `generation` in identity-token.ts and
     * `IdentityTokenHolder.swift`. Without this, a provider call started
     * under one source (or user) whose result lands AFTER a concurrent
     * [set] has moved the holder on to a different source — including
     * `set(null)` sign-out — would repopulate the cache with the stale
     * identity's token: e.g. Alice's provider call is still in flight when
     * the host signs out or switches to Bob; without this guard Alice's
     * real, valid token would overwrite the cache `set()` just cleared, and
     * the next [get] would serve Alice's token as Bob's — a cross-user
     * bearer-credential leak, exactly what this feature exists to prevent.
     */
    private var generation = 0

    /** Process scope. Kill captures exact children while clearing the source, then cancels outside locks. */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /**
     * Single-flight tracking (independent review, round 10, P1) — at most
     * ONE outstanding provider call per [generation]. Previously [get]
     * launched a fresh unstructured `GlobalScope.async` job on EVERY call
     * with no tracking at all: a never-resolving provider, re-asked on every
     * install and every reporter-open (which repeats, unlike a one-shot
     * warm), used to accumulate one abandoned `GlobalScope` job per call,
     * INDEFINITELY — each pinning a `Dispatchers.IO` thread for as long as
     * the provider itself blocks, which can starve the SDK's (and the
     * HOST APP's) I/O work, and `kill()` had no way to reach any of them.
     *
     * Keyed by `generation`, not merely "is something in flight": a
     * `set()` call moves the holder on to a different source `generation`
     * and this must NOT let a later caller join a call still running
     * against the OLD (now-stale) provider — that would return the wrong
     * provider's answer entirely, not just a stale one. [Deferred.isActive]
     * is what makes "still in flight" cheap to check on this platform — it
     * is `false` the instant the deferred completes (or is cancelled),
     * exactly the plain synchronous "should I launch a new one" signal a
     * `set()`/timeout-driven re-ask needs; Swift has no equivalent
     * property on `Task`, which is why `IdentityTokenHolder.swift`'s twin
     * of this needs its own explicit self-clearing instead.
     */
    private var inFlightGeneration: Int? = null
    private var inFlightDeferred: Deferred<String?>? = null

    /**
     * Install or clear the token source. `null` is sign-out: it drops the
     * cached token immediately, even mid-lifetime. Always bumps
     * [generation], so any in-flight [get] provider call started under the
     * previous source discards its result instead of repopulating this
     * cache (see [generation]'s doc above).
     */
    fun set(source: IdentityTokenSource?) {
        lock.withLock {
            this.source = source
            this.cached = null
            this.cachedExpMs = null
            this.generation += 1
            // A one-shot string IS the cache — there is nothing to re-ask.
            if (source is IdentityTokenSource.Token) {
                val claims = decodeIdentityClaims(source.jwt)
                val exp = claims?.expMs
                if (claims != null && exp != null) {
                    this.cached = source.jwt
                    this.cachedExpMs = exp
                }
                // An undecodable or exp-less string caches nothing, so `get`
                // resolves null: absent, not an error.
            }
        }
    }

    /** Cancel all currently running providers for standalone holder owners. Facade kill uses an exact snapshot. */
    fun cancelOutstandingWork() {
        scope.coroutineContext[Job]?.cancelChildren()
    }

    /** Called at kill publication. No cancellation or host callbacks under the caller's lock. */
    internal fun clearAndCaptureOutstandingWork(): List<Job> = lock.withLock {
        set(null)
        scope.coroutineContext[Job]?.children?.toList().orEmpty()
    }

    /** The token to present right now, or `null` for "send anonymously". */
    suspend fun get(nowMs: Long): String? {
        val snapshot = readState()

        val snapshotCached = snapshot.cached
        val snapshotExpMs = snapshot.cachedExpMs
        if (snapshotCached != null && snapshotExpMs != null &&
            snapshotExpMs - nowMs > IDENTITY_REFRESH_MARGIN_MS
        ) {
            return snapshotCached
        }

        val provider = (snapshot.source as? IdentityTokenSource.Provider)
            // No provider to re-ask: a stale one-shot token is dropped
            // rather than presented.
            ?: return null

        val deferred = providerDeferred(provider, snapshot.generation)
        val fresh = withTimeoutOrNull(IDENTITY_PROVIDER_TIMEOUT_MS) { deferred.await() }
        val claims = fresh?.let { decodeIdentityClaims(it) }
        val exp = claims?.expMs
        if (fresh == null || claims == null || exp == null) {
            return null
        }
        // Independent review, round 14, Serious 1 — the refresh margin does
        // NOT apply here. It is deliberately absent for a token a provider
        // call just now returned, matching `identity-token.ts`'s `get()`
        // (see its own doc comment on this exact point): a freshly-fetched
        // result is the newest thing available, so there is nothing better
        // to refresh TO — rejecting it for being "already inside the margin"
        // would only ever produce an anonymous report, never a fresher
        // token. The margin still gates every CACHED read (the check at the
        // top of this function) and a one-shot string SOURCE (`set()`'s own
        // decode, above) — both of which have a genuine "ask again" option
        // this branch does not. A provider that hands back a token already
        // inside (or past) the margin will simply be re-asked on the VERY
        // NEXT `get()` call, once this one's cache read fails the same
        // check that gated the old, over-eager version of this branch.

        // Generation check + cache write happen together, under one lock
        // acquisition, in a plain synchronous helper — both so a `set()`
        // landing between the check and the write can't slip a stale write
        // through (TOCTOU), and so the lock is never held across a suspend
        // point.
        return commitIfCurrent(snapshot.generation, fresh, exp)
    }

    /**
     * Single-flight accessor (independent review, round 10, P1): if a
     * provider call for THIS `generation` is already running, join it
     * instead of launching a second one — this is what bounds outstanding
     * work to one per holder regardless of how pathological the host's
     * provider is (never resolving, blocking a thread, or otherwise). Each
     * caller still races the returned deferred against its OWN
     * [IDENTITY_PROVIDER_TIMEOUT_MS] window in [get] above via
     * `withTimeoutOrNull` — joining does not extend or reset that bound for
     * a caller that arrives partway through an already-running call; it
     * simply stops waiting at ITS OWN 2s mark either way, exactly as if it
     * had launched its own (the round-1 fix, unchanged).
     *
     * A DIFFERENT generation (a `set()` landed since the running call
     * started) never joins the old one — seen the launched-for the OLD
     * provider, joining it would return THAT provider's answer under the
     * NEW generation, which is simply the wrong provider being asked. A
     * fresh deferred is launched instead, exactly as if nothing had been in
     * flight, and the OLD one keeps running (now cancellable via
     * [cancelOutstandingWork], but this fresh call does not itself cancel
     * it — that is `kill()`'s job specifically, not every `set()`, matching
     * this file's existing "orphaned but off the critical path" posture
     * for a superseded call outside of a kill).
     */
    private fun providerDeferred(provider: IdentityTokenSource.Provider, generation: Int): Deferred<String?> =
        lock.withLock {
            if (this.generation != generation) return@withLock kotlinx.coroutines.CompletableDeferred(null)
            val existingGeneration = inFlightGeneration
            val existing = inFlightDeferred
            if (existingGeneration == generation && existing != null && existing.isActive) {
                return@withLock existing
            }
            val fresh = scope.async { invokeSafely(provider) }
            inFlightGeneration = generation
            inFlightDeferred = fresh
            fresh
        }

    /** The `sub` of whatever [get] would return, or `null`. Used to stamp
     *  the identity a report is being captured under. */
    suspend fun currentSubject(nowMs: Long): String? {
        val token = get(nowMs) ?: return null
        return decodeIdentityClaims(token)?.sub
    }

    /**
     * The `sub` of the CACHED token if it is still presentable, without
     * invoking a provider. Capture boundaries are synchronous and must
     * never block on the network, so a cold cache stamps the report
     * anonymous — the fail-closed direction, and the warm-up path
     * ([get]/[currentSubject], called elsewhere off the capture boundary)
     * exists to keep a cold cache off the common case.
     *
     * Independent review, round 14 follow-up, Serious 1 (closing the finding
     * for real) — gated on merely NOT YET EXPIRED (`exp > nowMs`), not on
     * [IDENTITY_REFRESH_MARGIN_MS]. The margin's job is deciding whether to
     * RE-ASK the provider for something fresher — a decision only [get]
     * (async, allowed to await a re-ask) can act on. This function has no
     * such option (synchronous, must never invoke the provider — see the
     * doc above), so applying the SAME margin here bought nothing and cost
     * everything for a `ttlSeconds` at or below the margin: `get()`'s own
     * fresh-provider branch was fixed earlier this round to cache such a
     * token, but THIS check then rejected the cache on every read anyway
     * (mathematically guaranteed for TTL <= margin — remaining life only
     * decreases from the moment a token is minted, so it can never again
     * exceed a margin equal to its own total lifetime) — moving the
     * blockage one step down the chain rather than removing it, exactly the
     * residual the coordinator called out.
     *
     * Safe to widen: [resolveIdentityHeader] never presents THIS token —
     * `capturedSubject` (this function's return value) is used ONLY to be
     * COMPARED against the `sub` of whatever [get] independently and
     * separately resolves at submit time (`IdentityGate.kt`). [get]'s own
     * margin-gated cache check (unchanged, still `> IDENTITY_REFRESH_MARGIN_MS`)
     * is what actually decides whether the token that reaches the wire is
     * fresh enough — stamping a subject here from a near-expiry token costs
     * nothing beyond a comparison; if the token has genuinely gone stale by
     * submit time, `get()` re-asks or returns null and the report goes out
     * anonymous, exactly as it does today.
     */
    fun cachedSubject(nowMs: Long): String? = lock.withLock {
        val c = cached
        val exp = cachedExpMs
        if (c != null && exp != null && exp > nowMs) {
            decodeIdentityClaims(c)?.sub
        } else {
            null
        }
    }

    private data class State(
        val source: IdentityTokenSource?,
        val cached: String?,
        val cachedExpMs: Long?,
        val generation: Int,
    )

    private fun readState(): State = lock.withLock {
        State(source, cached, cachedExpMs, generation)
    }

    /**
     * Write a freshly-resolved provider result into the cache, but only if
     * `generation` still matches what [get] captured before suspending on
     * the provider — otherwise a `set()` moved the holder on while that call
     * was in flight, and the result is discarded outright: return `null`
     * and cache nothing, exactly as if the call had never happened.
     */
    private fun commitIfCurrent(generation: Int, token: String, expMs: Long): String? = lock.withLock {
        if (generation != this.generation) return@withLock null
        this.cached = token
        this.cachedExpMs = expMs
        token
    }
}

/**
 * Invoke a provider function, catching anything it throws and resolving
 * `null` instead. Unlike the Swift twin — where `IdentityTokenSource
 * .provider`'s closure type is non-throwing at the *compiler* level — Kotlin
 * has no non-throwing function-type modifier, so `IdentityTokenSource
 * .Provider.fn` could legally throw; this closes that gap the same way the
 * TS twin does (`identity-token.ts`'s `Promise.resolve().then(...)` +
 * `try`/`catch` around the await).
 *
 * Independent review, round 3 (Serious 2) — [CancellationException] is NOT
 * unconditionally rethrown here anymore. This function's caller
 * ([IdentityTokenHolder.providerDeferred]) runs `provider.fn()` inside its
 * own coroutine, launched from the holder's own [IdentityTokenHolder.scope]
 * (`Dispatchers.IO`, independent review round 10) — an entirely ordinary
 * host provider implementation can use `withTimeout` (or any other
 * cancellation-based primitive) internally for its OWN auth call, and that
 * throws a [CancellationException] too, indistinguishable BY TYPE from real
 * structured cancellation of the job `invokeSafely` is running in. The
 * previous unconditional rethrow turned an ordinary provider failure into
 * what looked like cancellation of the whole submit flow's coroutine: left
 * uncaught, a `CancellationException` escaping a coroutine body marks that
 * coroutine Cancelled rather than Failed, which the reporter's safety
 * wrapper then reports as `Cancelled("submit_guard_failed")` — the report is
 * neither uploaded nor enqueued, only dropped. Recognition must never fail,
 * stall, or drop a report; losing attribution is the accepted failure,
 * losing the report is not.
 *
 * [currentCoroutineContext].[isActive] distinguishes the two cases: if OUR
 * OWN ambient job (the [IdentityTokenHolder.scope] child this suspend
 * function is actually executing in) has genuinely been cancelled —
 * including by [IdentityTokenHolder.cancelOutstandingWork], i.e. `kill()`
 * (independent review, round 10) — `isActive` is already `false` by the time
 * control reaches this `catch` — that IS real structured cancellation, and
 * it is rethrown so it propagates normally (swallowing it here would
 * otherwise leak a coroutine nobody ever learns finished). If our own job is
 * still active, the `CancellationException` originated INSIDE
 * `provider.fn()` — e.g. its own internal `withTimeout` firing as a child of
 * this job — and is just another provider failure: resolves `null`, exactly
 * like every other one.
 */
private suspend fun invokeSafely(provider: IdentityTokenSource.Provider): String? =
    try {
        provider.fn()
    } catch (e: CancellationException) {
        if (currentCoroutineContext().isActive) null else throw e
    } catch (e: Throwable) {
        null
    }

private val BASE64URL_ALPHABET =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
private val BASE64URL_REVERSE: Map<Char, Int> =
    BASE64URL_ALPHABET.withIndex().associate { (i, c) -> c to i }

/**
 * Hand-rolled base64url decode (mirrors `identity-token.ts`'s own hand-rolled
 * decoder — no `android.util.Base64` so this stays a plain-JVM-testable
 * class with no Android framework or Robolectric dependency, and no
 * `java.util.Base64` so it stays usable below this module's API 24 floor,
 * which predates that class). `null` for anything outside the base64url
 * alphabet; callers treat that as "undecodable".
 */
private fun base64UrlDecodeOrNull(input: String): ByteArray? {
    val clean = input.trimEnd('=')
    val bytes = ArrayList<Byte>(clean.length * 6 / 8 + 1)
    var buffer = 0
    var bits = 0
    for (ch in clean) {
        val value = BASE64URL_REVERSE[ch] ?: return null
        buffer = (buffer shl 6) or value
        bits += 6
        if (bits >= 8) {
            bits -= 8
            bytes.add(((buffer shr bits) and 0xff).toByte())
        }
    }
    return bytes.toByteArray()
}

/**
 * Non-verifying decode of a JWT's `sub` and `exp` (as epoch milliseconds).
 * Returns `null` for anything that is not a well-formed three-part JWT with
 * a JSON-object payload — callers treat that as "absent".
 *
 * Independent review, round 4 (Serious 2) — this is also the single choke
 * point BOTH `IdentityTokenHolder.set()` (the one-shot `Token` source) and
 * `IdentityTokenHolder.get()` (a provider's fresh result) already route
 * every candidate token through before caching/returning it, so the
 * header/signature-character check below closes the hazard at its one
 * source rather than needing two separate call-site guards.
 *
 * This used to decode-check ONLY the payload segment (`parts[1]`) — the
 * header and signature segments (`parts[0]`/`parts[2]`) were never
 * inspected at all. A string like `"bad\n.<valid-payload>.sig"` therefore
 * split into exactly 3 parts, decoded a valid payload, and was accepted —
 * `set()`/`get()` then cached and served it VERBATIM, reaching
 * `MultipartUploader.kt`'s OkHttp `header(...)` call, which THROWS on
 * illegal header characters (a bare newline included). That throw
 * propagated into the submit path and `txGuardSuspend` caught it as a
 * generic `Throwable`, collapsing the WHOLE report to
 * `Cancelled("submit_guard_failed")` — lost, not merely unattributed. Same
 * rule as the provider-cancellation fix the round before this one: a bad
 * token must degrade to anonymous, never take the report down with it.
 *
 * The check is a full-string scan rather than three separate per-segment
 * scans: every character must be in the base64url alphabet or be one of
 * the two `.` part separators. Anything outside that set — a newline,
 * anything else `Headers.checkNameAndValue` would reject — makes the WHOLE
 * token unsafe to ever place in a header, so it is rejected here, at
 * decode time, before either caching call site ever sees it: treated
 * exactly like an undecodable token, i.e. "absent", not an error.
 *
 * Also rejects anything past the server's own length ceiling
 * ([IDENTITY_TOKEN_MAX_CHARS]) — cheap to catch here and saves a pointless
 * round trip; unlike the character check this one is lower stakes, since an
 * over-long token would only ever have been REJECTED server-side (an
 * anonymous outcome), never something that could throw out of this SDK and
 * take the report down with it.
 */
internal fun decodeIdentityClaims(jwt: String): IdentityClaims? {
    if (jwt.isEmpty() || jwt.length > IDENTITY_TOKEN_MAX_CHARS) return null
    if (!jwt.all { it in BASE64URL_REVERSE || it == '.' }) return null
    val parts = jwt.split(".")
    if (parts.size != 3) return null
    val payloadBytes = base64UrlDecodeOrNull(parts[1]) ?: return null
    val payloadJson = String(payloadBytes, Charsets.UTF_8)
    val obj = try {
        Json.parseToJsonElement(payloadJson) as? JsonObject ?: return null
    } catch (e: Exception) {
        return null
    }

    val subElement = obj["sub"]
    val sub = if (subElement is JsonPrimitive && subElement.isString) subElement.content else null

    val expElement = obj["exp"]
    val expMs = if (expElement is JsonPrimitive && !expElement.isString) {
        expElement.content.toDoubleOrNull()?.let { (it * 1000).toLong() }
    } else {
        null
    }

    return IdentityClaims(sub = sub, expMs = expMs)
}
