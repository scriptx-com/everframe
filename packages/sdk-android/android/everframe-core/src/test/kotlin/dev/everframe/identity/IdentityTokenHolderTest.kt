// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Kotlin twin of packages/sdk-ios/Tests/EverframeTests/IdentityTokenHolderTests.swift
// (the COMMITTED version, post two-Critical-fix review — see
// IdentityTokenHolder.kt's module doc). Mirrors that file's 15
// holder-level behaviours case for case; the Swift file's remaining two
// tests (`testKillClearsTheIdentityToken`, `testStartClearsTheIdentityToken`)
// exercise `Everframe.shared`'s start()/kill() wiring, which is a later
// Android task's scope (the iOS twin of that wiring is Task 4 in the native
// identity plan; Android's mirror hasn't been reached yet) — nothing to port
// here until that wiring exists.
//
// Provider-exercising tests deliberately run under `runBlocking` (real time),
// NOT `kotlinx.coroutines.test.runTest`. `IdentityTokenHolder.get()`'s
// provider branch races an UNSTRUCTURED `async` launched from the holder's
// own `scope` (independent review round 10 — `CoroutineScope(SupervisorJob()
// + Dispatchers.IO)`, a real background dispatcher, replacing the previous
// `GlobalScope.async`) against `withTimeoutOrNull` on the CALLING
// coroutine's own dispatcher. Under `runTest`'s virtual-time
// `TestDispatcher`, once every test-scope coroutine is suspended (as they
// are here, waiting on a cross-thread `Gate`/`CompletableDeferred` signalled
// by that separate real dispatcher), `runTest` auto-advances virtual time on
// the assumption there is nothing left to wait for — which would fire the
// internal 2s timeout in test-time-zero, racing ahead of the real background
// thread and breaking every test below that depends on the provider
// genuinely being mid-flight. `runBlocking`'s single confined real thread
// has no such auto-advance and just genuinely blocks, which is what these
// tests need. Tests that never reach the provider branch (a `Token` source,
// or no source at all) use `runTest` — fast, and no real timing involved.
package dev.everframe.identity

import java.util.Base64
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class IdentityTokenHolderTest {

    /**
     * Build an unsigned-but-well-formed JWT with the given claims. The
     * holder never verifies, so a fake signature is the honest fixture
     * here — mirrors the Swift suite's `jwt(sub:exp:)`.
     */
    private fun jwt(sub: String? = null, expMs: Long? = null): String {
        val payload = buildJsonObject {
            sub?.let { put("sub", it) }
            expMs?.let { put("exp", it / 1000) }
        }
        val header = """{"alg":"HS256","typ":"JWT"}"""
        fun b64(s: String) = Base64.getUrlEncoder().withoutPadding().encodeToString(s.toByteArray(Charsets.UTF_8))
        return "${b64(header)}.${b64(payload.toString())}.not-a-real-signature"
    }

    /**
     * A "now" rounded to the whole second, reused for both building a
     * fixture's `exp` and for the matching `get(nowMs = ...)` call. JWT
     * `exp` is whole seconds (see `jwt` above); starting from an
     * already-round value makes the margin-boundary tests below (29s/31s)
     * exact instead of off by up to 999ms from `System.currentTimeMillis()`'s
     * sub-second component.
     */
    private fun freshNowMs(): Long = (System.currentTimeMillis() / 1000) * 1000

    @Test
    fun `serves a string token well before expiry`() = runTest {
        val now = freshNowMs()
        val holder = IdentityTokenHolder()
        val t = jwt(sub = "alice", expMs = now + 300_000)
        holder.set(IdentityTokenSource.Token(t))
        assertEquals(t, holder.get(now))
        assertEquals("alice", holder.currentSubject(now))
    }

    @Test
    fun `refuses a token inside the thirty second margin`() = runTest {
        val now = freshNowMs()
        val holder = IdentityTokenHolder()
        // 29s of life left — inside the margin, so presenting it buys
        // nothing: it may well have expired by the time it reaches the
        // server.
        holder.set(IdentityTokenSource.Token(jwt(sub = "alice", expMs = now + 29_000)))
        assertNull(holder.get(now))
    }

    @Test
    fun `serves a token just outside the margin`() = runTest {
        val now = freshNowMs()
        val holder = IdentityTokenHolder()
        holder.set(IdentityTokenSource.Token(jwt(sub = "alice", expMs = now + 31_000)))
        assertNotNull(holder.get(now))
    }

    @Test
    fun `an already expired token is absent not an error`() = runTest {
        val now = freshNowMs()
        val holder = IdentityTokenHolder()
        holder.set(IdentityTokenSource.Token(jwt(sub = "alice", expMs = now - 1_000)))
        assertNull(holder.get(now))
    }

    @Test
    fun `an undecodable token is treated as absent`() = runTest {
        val holder = IdentityTokenHolder()
        holder.set(IdentityTokenSource.Token("this is not a jwt"))
        assertNull(holder.get(freshNowMs()))
    }

    // Independent review, round 4 (Serious 2) — a token whose header or
    // signature segment contains a character outside the base64url alphabet
    // (a newline especially) used to decode FINE: `decodeIdentityClaims`
    // only ever inspected the payload segment. `set()`/`get()` then cached
    // and served it verbatim, reaching MultipartUploader.kt's OkHttp
    // `header(...)` call, which THROWS on illegal header characters —
    // taking the whole report down via `txGuardSuspend`'s catch-all
    // (`Cancelled("submit_guard_failed")`) rather than merely going
    // anonymous. Mutation-verified: reverting the character-safety check in
    // `decodeIdentityClaims` makes this fail (the malformed token would be
    // served rather than rejected).
    @Test
    fun `a token with an illegal header character in the signature segment is treated as absent`() = runTest {
        val now = freshNowMs()
        val holder = IdentityTokenHolder()
        val wellFormed = jwt(sub = "alice", expMs = now + 300_000)
        // Same header + payload as a perfectly valid token — only the
        // signature segment is corrupted with a bare newline, exactly the
        // character OkHttp's header(...) rejects.
        val malformed = wellFormed.substringBeforeLast('.') + ".bad\nsignature"
        holder.set(IdentityTokenSource.Token(malformed))
        assertNull(
            "a token with an illegal header character anywhere in it must be treated as absent, not cached/served verbatim",
            holder.get(now),
        )
    }

    @Test
    fun `a token with an illegal header character in the header segment is treated as absent`() = runTest {
        val now = freshNowMs()
        val holder = IdentityTokenHolder()
        val wellFormed = jwt(sub = "alice", expMs = now + 300_000)
        val malformed = "bad\nheader" + wellFormed.substring(wellFormed.indexOf('.'))
        holder.set(IdentityTokenSource.Token(malformed))
        assertNull(
            "a corrupted header segment must also be rejected, not just the signature segment",
            holder.get(now),
        )
    }

    @Test
    fun `an over-length token past the servers own ceiling is treated as absent`() = runTest {
        val now = freshNowMs()
        val holder = IdentityTokenHolder()
        // Same shape as the server identity-token verifier's own
        // IDENTITY_TOKEN_MAX_CHARS — refusing here is cheap and saves a
        // pointless round trip. Lower stakes than the character check: an
        // over-long token would only ever have been rejected server-side
        // (anonymous), never something that could throw and take the report
        // down.
        val tooLong = jwt(sub = "a".repeat(IDENTITY_TOKEN_MAX_CHARS), expMs = now + 300_000)
        assertTrue("fixture sanity: the built token must actually exceed the ceiling", tooLong.length > IDENTITY_TOKEN_MAX_CHARS)
        holder.set(IdentityTokenSource.Token(tooLong))
        assertNull(holder.get(now))
    }

    @Test
    fun `a token with no exp is treated as absent`() = runTest {
        val now = freshNowMs()
        val holder = IdentityTokenHolder()
        // No `exp` means we cannot know when to stop presenting it.
        // Refusing is the fail-closed direction; the verifier would reject
        // it anyway.
        holder.set(IdentityTokenSource.Token(jwt(sub = "alice", expMs = null)))
        assertNull(holder.get(now))
    }

    @Test
    fun `set null signs out immediately even mid lifetime`() = runTest {
        val now = freshNowMs()
        val holder = IdentityTokenHolder()
        holder.set(IdentityTokenSource.Token(jwt(sub = "alice", expMs = now + 300_000)))
        holder.set(null)
        assertNull(holder.get(now))
    }

    @Test
    fun `a provider is invoked and its result cached`() = runBlocking {
        val now = freshNowMs()
        val t = jwt(sub = "bob", expMs = now + 300_000)
        val counter = CallCounter()
        val holder = IdentityTokenHolder()
        holder.set(IdentityTokenSource.Provider { counter.bump(); t })

        val first = holder.get(now)
        val second = holder.get(now)
        assertEquals(t, first)
        assertEquals(t, second)
        assertEquals(
            "a cached, still-fresh token must not re-ask the provider",
            1,
            counter.value,
        )
    }

    // Independent review, round 4 (Serious 2) — the SAME rejection must
    // apply to a provider's freshly-resolved result, not just a one-shot
    // `Token` source: `get()`'s provider branch routes through the exact
    // same `decodeIdentityClaims` choke point.
    @Test
    fun `a provider result with an illegal header character is treated as absent, not cached`() = runBlocking {
        val now = freshNowMs()
        val wellFormed = jwt(sub = "alice", expMs = now + 300_000)
        val malformed = wellFormed.substringBeforeLast('.') + ".bad\nsignature"
        val holder = IdentityTokenHolder()
        holder.set(IdentityTokenSource.Provider { malformed })

        assertNull(
            "a provider result with an illegal header character must be treated as absent, not cached/served verbatim",
            holder.get(now),
        )
    }

    @Test
    fun `a provider is re asked once the cached token enters the margin`() = runBlocking {
        val now = freshNowMs()
        val stale = jwt(sub = "bob", expMs = now + 300_000)
        val fresh = jwt(sub = "bob", expMs = now + 3_000_000)
        val counter = CallCounter()
        val holder = IdentityTokenHolder()
        holder.set(
            IdentityTokenSource.Provider {
                val n = counter.bump()
                if (n == 1) stale else fresh
            },
        )

        holder.get(now)
        // Jump to 10s before the cached token's expiry — inside the margin.
        val later = now + 290_000
        val got = holder.get(later)
        assertEquals(fresh, got)
        assertEquals(2, counter.value)
    }

    @Test
    fun `a provider returning null resolves to anonymous`() = runBlocking {
        val holder = IdentityTokenHolder()
        holder.set(IdentityTokenSource.Provider { null })
        assertNull(holder.get(freshNowMs()))
    }

    // Independent review, round 14 (codex round 12), Serious 1 — `get()`'s
    // provider branch used to apply IDENTITY_REFRESH_MARGIN_MS to a token the
    // provider had JUST returned, exactly like a CACHED read. That is wrong:
    // web's `identity-token.ts` `get()` applies the margin only to a cached
    // read and a one-shot string SOURCE, deliberately never to a freshly
    // fetched provider result — see that function's own doc comment. A
    // freshly-fetched token is the newest thing available; there is nothing
    // better to refresh TO, so rejecting it only ever produces an anonymous
    // report. `ttlSeconds` up to 600 is a supported `@everframe/identity`
    // config, and `ttlSeconds: 30` — exactly this holder's own margin — is a
    // short, security-conscious, entirely legal choice; the pre-fix code
    // rejected every such token outright, so `commitIfCurrent` never even
    // ran: nothing was ever cached, and every report shipped anonymous
    // forever. Mutation-verified: reinstating the margin check on the fresh
    // branch (`exp - nowMs <= IDENTITY_REFRESH_MARGIN_MS` back in the
    // rejection condition) makes this fail.
    @Test
    fun `a freshly fetched provider token is used even when its own remaining life is inside the margin`() = runBlocking {
        val now = freshNowMs()
        val counter = CallCounter()
        val holder = IdentityTokenHolder()
        // 10s of remaining life — deep inside the 30s margin — but this is
        // the FIRST call: no cached token to fall back to, and refusing this
        // one buys nothing (there is no fresher token to be had by waiting).
        holder.set(
            IdentityTokenSource.Provider {
                counter.bump()
                jwt(sub = "alice", expMs = now + 10_000)
            },
        )

        val token = holder.get(now)
        assertEquals(
            "a freshly-fetched provider token must be used even when its own remaining life is inside the refresh margin",
            jwt(sub = "alice", expMs = now + 10_000),
            token,
        )
        assertEquals("alice", holder.currentSubject(now))
        assertEquals(2, counter.value) // one call from `get`, one from `currentSubject`'s own `get`
    }

    /**
     * Companion to the test above, at the boundary this fix must NOT touch:
     * a fresh provider result that is undecodable (no `exp` claim at all)
     * must still be rejected — the margin removal is scoped to the
     * expiry-vs-margin COMPARISON only, not the underlying decodability
     * check `commitIfCurrent`'s caller still performs above it.
     */
    @Test
    fun `a freshly fetched provider token with no exp is still absent`() = runBlocking {
        val now = freshNowMs()
        val holder = IdentityTokenHolder()
        holder.set(IdentityTokenSource.Provider { jwt(sub = "alice", expMs = null) })
        assertNull(
            "a fresh provider result with no exp claim must still be rejected — the fix removes the MARGIN comparison only, not the decodability check",
            holder.get(now),
        )
    }

    /**
     * Documents the OTHER end of web's own rule, deliberately: a fresh
     * provider result already PAST its own `exp` is still used — not
     * rejected — matching `identity-token.ts`'s own doc comment verbatim
     * ("a freshly-fetched result is cached and returned as-is even if it
     * happens to already be inside the margin ... intentional, not a gap").
     * This function is never the security boundary (see this file's module
     * doc): an actually-expired token is simply rejected server-side, same
     * as any other failure path here — so serving it costs nothing extra
     * over the alternative (anonymous). A future "harden this" edit that
     * adds an expiry check here would be REGRESSING native away from web's
     * behaviour, not fixing anything; this test exists to catch that.
     */
    @Test
    fun `a freshly fetched provider token already past its own exp is still used, matching web`() = runBlocking {
        val now = freshNowMs()
        val holder = IdentityTokenHolder()
        val expired = jwt(sub = "alice", expMs = now - 1_000)
        holder.set(IdentityTokenSource.Provider { expired })
        assertEquals(
            "web's get() never checks a fresh provider result's exp against `now` at all, only decodability — native must match, not add a stricter check web doesn't have",
            expired,
            holder.get(now),
        )
    }

    // Independent review, round 14 FOLLOW-UP, Serious 1 — the coordinator's
    // re-review: the get()-only fix above was NOT sufficient to close the
    // finding. `Everframe.captureUserSnapshot()` never calls `get()` at all —
    // it stamps `identitySubject` from `cachedSubject()`, a SEPARATE,
    // synchronous read that still applied the SAME margin to a CACHED
    // value. For a token whose own TTL never exceeds that margin, the
    // cached copy can never again clear it after the moment it's minted
    // (remaining life only decreases) — so `get()`'s fix alone moved the
    // blockage one step down the chain (from "never cached" to "cached but
    // never read back") rather than removing it. `resolveIdentityHeader`
    // short-circuits on `capturedSubject == null` BEFORE it ever calls
    // `get()`, so a 30s-TTL token still produced an anonymous report,
    // exactly the symptom the original finding described.
    @Test
    fun `cachedSubject accepts a cached token that is merely not yet expired even inside the margin`() = runTest {
        val now = freshNowMs()
        val holder = IdentityTokenHolder()
        // 10s of remaining life — deep inside the 30s margin, but not
        // expired. The margin decides whether `get()` should RE-ASK the
        // provider for something fresher; `cachedSubject()` has no such
        // option (synchronous, must never invoke the provider), so it must
        // not apply the same bar.
        holder.set(IdentityTokenSource.Token(jwt(sub = "alice", expMs = now + 10_000)))
        assertEquals(
            "cachedSubject() must stamp a subject from a cached token that is merely not yet expired — " +
                "safe because resolveIdentityHeader never presents THIS token, only compares its subject " +
                "against whatever get() independently and separately resolves at submit time",
            "alice",
            holder.cachedSubject(now),
        )
    }

    /** The boundary this fix must NOT move: an actually-expired cached token
     *  must still be refused — only the MARGIN moved to "not yet expired,"
     *  the underlying expiry check did not disappear. */
    @Test
    fun `cachedSubject still refuses an actually expired cached token`() = runTest {
        val now = freshNowMs()
        val holder = IdentityTokenHolder()
        holder.set(IdentityTokenSource.Token(jwt(sub = "alice", expMs = now - 1_000)))
        assertNull(
            "an actually-expired cached token must still be refused by cachedSubject()",
            holder.cachedSubject(now),
        )
    }

    // Kept for parity with the iOS suite's `testAHangingProviderIsBoundedAndDegradesToAnonymous`.
    // `delay()` cooperates with coroutine cancellation, so — same caveat as
    // that Swift test's own comment about `Task.sleep` — this test ALONE
    // does NOT prove the bound is real: a naive
    // `withTimeoutOrNull(IDENTITY_PROVIDER_TIMEOUT_MS) { fn() }` (no racing,
    // no unstructured scope) would also pass it, because `delay` throws
    // `CancellationException` the instant its enclosing coroutine is
    // cancelled. `a hanging non-cooperating provider is still bounded`
    // below, using a provider with NO suspension point at all, is the test
    // that actually distinguishes a real bound from a fake one — see its
    // comment.
    @Test
    fun `a hanging provider is bounded and degrades to anonymous`() = runBlocking {
        val holder = IdentityTokenHolder()
        holder.set(
            IdentityTokenSource.Provider {
                delay(10_000) // 10s, far past the 2s bound
                "never-arrives"
            },
        )
        val started = System.currentTimeMillis()
        val got = holder.get(System.currentTimeMillis())
        val elapsedMs = System.currentTimeMillis() - started
        assertNull("recognition is an enhancement, never a blocker", got)
        assertTrue(
            "must be bounded by IDENTITY_PROVIDER_TIMEOUT_MS, not by the provider (elapsed=${elapsedMs}ms)",
            elapsedMs < 5_000,
        )
    }

    // Independent review, round 3 (Serious 2) — a host provider is free to
    // use `withTimeout` (or any other cancellation-based primitive)
    // internally for its OWN auth call; that throws a genuine
    // `CancellationException` too, indistinguishable BY TYPE from real
    // structured cancellation of whatever coroutine is resolving it.
    // `get()` must still resolve `null` here — never let that exception
    // escape and be mistaken for real cancellation of the CALLER, which
    // would abandon whatever report is being submitted rather than merely
    // going anonymous. Mutation-verified: reverting `invokeSafely`'s
    // `isActive` check back to an unconditional `throw e` makes this fail
    // with an uncaught `TimeoutCancellationException` instead of a clean
    // `null` return.
    @Test
    fun `a provider whose internals throw CancellationException resolves to null, not a propagated exception`() = runBlocking {
        val holder = IdentityTokenHolder()
        holder.set(
            IdentityTokenSource.Provider {
                // Entirely ordinary: the host bounds its own auth call.
                // This throws a genuine kotlinx.coroutines.CancellationException
                // (TimeoutCancellationException) from INSIDE the provider.
                withTimeout(1) {
                    delay(10_000)
                    "never-arrives"
                }
            },
        )
        val got = holder.get(System.currentTimeMillis())
        assertNull("a provider failure — cancellation-shaped or not — must resolve null, never propagate", got)
    }

    @Test
    fun `current subject is null when no token is servable`() = runTest {
        val now = freshNowMs()
        val holder = IdentityTokenHolder()
        holder.set(IdentityTokenSource.Token(jwt(sub = "alice", expMs = now - 1_000)))
        assertNull(holder.currentSubject(now))
    }

    // MARK: - Generation guard (Critical 1 in the plan's own listing — see
    // IdentityTokenHolder.kt's `generation` doc). These close the
    // cross-identity leak: `get()`'s provider branch must not write
    // `cached`/`cachedExpMs` once `set()` has moved the holder on to a
    // different (or no) source while that provider call was still in
    // flight.

    @Test
    fun `set null mid flight discards the stale provider result and caches nothing`() = runBlocking {
        val now = freshNowMs()
        val staleToken = jwt(sub = "alice", expMs = now + 300_000)
        val entered = Gate()
        val release = Gate()
        val holder = IdentityTokenHolder()
        holder.set(
            IdentityTokenSource.Provider {
                entered.open()
                release.await()
                staleToken
            },
        )

        // Kick the provider call off, then wait until it's actually in
        // flight (blocked on `release`) before signing out underneath it.
        val inFlight = async { holder.get(now) }
        entered.await()

        holder.set(null) // sign-out while Alice's provider call is pending
        release.open() // let Alice's call resolve — too late

        val staleResult = inFlight.await()
        assertNull(
            "a provider result resolving after set(null) must be discarded, not served",
            staleResult,
        )

        // The discard must be real, not just this one call's return value —
        // nothing should have been left in the cache for a LATER call to
        // serve either.
        val after = holder.get(now)
        assertNull(
            "set(null) mid-flight must leave nothing cached for later calls to serve",
            after,
        )
    }

    @Test
    fun `switching providers mid flight never serves the previous ones token`() = runBlocking {
        val now = freshNowMs()
        val aliceToken = jwt(sub = "alice", expMs = now + 300_000)
        val bobToken = jwt(sub = "bob", expMs = now + 300_000)
        val entered = Gate()
        val release = Gate()
        val holder = IdentityTokenHolder()
        holder.set(
            IdentityTokenSource.Provider {
                entered.open()
                release.await()
                aliceToken
            },
        )

        val inFlight = async { holder.get(now) }
        entered.await()

        // Host switches identity while Alice's call is still pending.
        holder.set(IdentityTokenSource.Provider { bobToken })
        release.open() // let Alice's stale call resolve — too late

        val staleResult = inFlight.await()
        assertNull(
            "Alice's in-flight call, started before the switch, must never resolve as the answer",
            staleResult,
        )

        val current = holder.get(now)
        assertEquals(
            "only the NEW provider may answer — never the stale in-flight one, and never null forever",
            bobToken,
            current,
        )
    }

    // MARK: - Real bound on a non-cooperating provider (Critical 2 in the
    // plan's own listing — see `IdentityTokenHolder.providerDeferred`'s doc).
    //
    // The `delay`-based hanging-provider test above passed even when this
    // was ported naively from `withTaskGroup`/a bare `withTimeoutOrNull { fn() }`
    // wrapper, because `delay` — like `Task.sleep` on the Swift side —
    // honours cooperative cancellation. A host's real identity provider is
    // realistically a completion-handler API bridged via
    // `suspendCancellableCoroutine`, which has NO suspension point a
    // cancellation could land on and NO cancellation handler installed —
    // this test exercises exactly that shape, and is the one that actually
    // fails against a naive implementation (verified empirically — see
    // task-5-report.md).
    @Test
    fun `a hanging non-cooperating provider is still bounded`() = runBlocking {
        val holder = IdentityTokenHolder()
        holder.set(
            IdentityTokenSource.Provider {
                // A REAL blocking call with NO suspension point anywhere in
                // its 10s — unlike `delay()` above, there is nothing here
                // for coroutine cancellation to land on. A naive
                // `withTimeoutOrNull(IDENTITY_PROVIDER_TIMEOUT_MS) { fn() }`
                // executes this on the SAME thread its own timeout timer
                // would need to fire on, so that thread is synchronously
                // blocked for the full 10s and the timeout cannot even run —
                // proven empirically against exactly that naive
                // implementation (see task-5-report.md). This is the
                // "provider that does not cooperate with cancellation" the
                // task brief calls for; `suspendCancellableCoroutine` was
                // deliberately NOT used here — it resumes with
                // `CancellationException` on cancellation even with no
                // `invokeOnCancellation` handler installed, which would let
                // a naive implementation pass this test too and defeat its
                // purpose.
                Thread.sleep(10_000) // 10s, far past the 2s bound
                "never-arrives"
            },
        )
        val started = System.currentTimeMillis()
        val got = holder.get(System.currentTimeMillis())
        val elapsedMs = System.currentTimeMillis() - started
        assertNull("recognition is an enhancement, never a blocker", got)
        assertTrue(
            "must be bounded by IDENTITY_PROVIDER_TIMEOUT_MS (2s), not by a provider that ignores " +
                "cancellation (elapsed=${elapsedMs}ms)",
            elapsedMs < 4_000,
        )
    }

    // MARK: - Single-flight + cancellable scope (independent review, round
    // 10, P1 — the escalated twin of Task 5's deferred Minor). Each timeout
    // used to abandon the provider's `GlobalScope.async` job outright, and
    // every subsequent `get()`/reporter-open warm started ANOTHER one —
    // unbounded, indefinitely, since reporter-open warms repeat (not
    // one-shot) — and `kill()` had no way to reach any of them, since
    // `GlobalScope` jobs are not children of anything cancellable. Two
    // properties close that: (1) a provider call already in flight for the
    // CURRENT generation is joined, not duplicated, bounding outstanding
    // work to one per holder; (2) the holder's own `scope` is cancellable,
    // so `cancelOutstandingWork()` (wired into `Everframe.kill()`) can
    // actually reach it.
    //
    // Mutation-verified: reverting `providerDeferred` to unconditionally
    // launch `scope.async { invokeSafely(provider) }` (dropping the
    // generation/isActive join check) makes the invocation-count assertion
    // below fail (counter climbs past 1 instead of staying there); reverting
    // `cancelOutstandingWork()` to a no-op body makes the `cancelled.await`
    // below time out instead of completing.
    @Test
    fun `repeated calls join the same outstanding provider call, and cancelOutstandingWork cancels it`() = runBlocking {
        val now = freshNowMs()
        val counter = CallCounter()
        val entered = Gate()
        val cancelled = CompletableDeferred<Unit>()
        val holder = IdentityTokenHolder()
        holder.set(
            IdentityTokenSource.Provider {
                counter.bump()
                entered.open()
                try {
                    delay(10_000) // never arrives on its own — only cancellation ends it
                    "never-arrives"
                } catch (e: CancellationException) {
                    cancelled.complete(Unit)
                    throw e
                }
            },
        )

        // Install, then several "reporter-open" style warms — all started
        // before the first has any chance to resolve (each individually
        // bounded at ~2s by the round-1 fix, so plenty of overlap window).
        val calls = (1..4).map { async { holder.get(now) } }
        entered.await()

        assertEquals(
            "at most one outstanding provider call per holder, regardless of how many callers ask",
            1,
            counter.value,
        )

        val results = calls.map { it.await() }
        assertTrue("every joined caller still degrades to anonymous, none blocks past its own bound", results.all { it == null })

        // The provider is still running, orphaned, past every caller's own
        // 2s bound — proves those callers' timeouts don't extend to or
        // cancel the shared call themselves (round-1 behaviour, unchanged).
        assertTrue("provider must still be uncancelled at this point", !cancelled.isCompleted)

        // The kill-switch path: cancels the outstanding call directly.
        holder.cancelOutstandingWork()
        withTimeout(2_000) { cancelled.await() }

        // A later, independent call must not be permanently blocked by the
        // now-cancelled call — it launches its own fresh one.
        val afterCancel = holder.get(now)
        assertNull(afterCancel)
        assertEquals(
            "a call after cancelOutstandingWork() must be free to launch a fresh provider call",
            2,
            counter.value,
        )
    }
    @Test
    fun `captured kill jobs cancel the old provider while a newer source still resolves`() = runBlocking {
        val holder = IdentityTokenHolder()
        val now = freshNowMs()
        val enteredA = CompletableDeferred<Unit>()
        val cancelledA = CompletableDeferred<Unit>()
        val enteredB = CompletableDeferred<Unit>()
        val releaseB = CompletableDeferred<Unit>()
        val tokenB = jwt("B", now + 120_000)
        holder.set(IdentityTokenSource.Provider {
            enteredA.complete(Unit)
            try { kotlinx.coroutines.awaitCancellation() } finally { cancelledA.complete(Unit) }
        })
        val a = async { runCatching { holder.get(now) } }
        withTimeout(2_000) { enteredA.await() }
        val captured = holder.clearAndCaptureOutstandingWork()
        assertEquals(1, captured.size)
        holder.set(IdentityTokenSource.Provider {
            enteredB.complete(Unit); releaseB.await(); tokenB
        })
        val b = async { holder.get(now) }
        try {
            withTimeout(2_000) { enteredB.await() }
            captured.forEach { it.cancel() }
            withTimeout(2_000) { cancelledA.await() }
            releaseB.complete(Unit)
            assertEquals(tokenB, b.await())
            assertEquals("B", holder.cachedSubject(now))
            a.await()
            Unit
        } finally { releaseB.complete(Unit); holder.cancelOutstandingWork() }
    }

}

/** Thread-safe invocation counter for provider closures above. */
private class CallCounter {
    private val count = AtomicInteger(0)
    fun bump(): Int = count.incrementAndGet()
    val value: Int get() = count.get()
}

/**
 * A one-shot open/wait gate used to force a deterministic interleaving
 * between a test and a provider closure running concurrently: the provider
 * signals it has been ENTERED (so the test knows it's safely blocked) and
 * then waits to be RELEASED, letting the test perform a `set()` in between
 * with no race on when it lands relative to the provider call being in
 * flight. Kotlin twin of the Swift suite's `actor Gate` — a
 * [CompletableDeferred] already resumes every current AND future waiter
 * exactly once for free, so there is no need for Swift's explicit waiter
 * list.
 */
private class Gate {
    private val opened = CompletableDeferred<Unit>()
    fun open() {
        opened.complete(Unit)
    }

    suspend fun await() {
        opened.await()
    }
}
