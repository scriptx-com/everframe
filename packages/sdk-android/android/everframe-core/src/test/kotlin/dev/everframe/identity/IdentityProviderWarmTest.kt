// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Final whole-branch review, Critical 1 — the PROVIDER form of
// `setIdentityToken` could never attach a header, on either platform, and the
// documentation actively recommends it ("Use the provider form"). Kotlin twin
// of iOS `IdentityProviderWarmTests.swift` — see that file's header for the
// full defect chain.
//
// The fix: `Everframe.setIdentityToken` kicks off a detached warm
// (`_identityHolder.currentSubject(nowMs:)`, on `sdkScope`) when a non-null
// source is installed. This suite drives the fix END TO END — through
// `Everframe.setIdentityToken` -> the detached warm -> `captureUserSnapshot()`
// -> `resolveIdentityHeader` — not the holder in isolation
// (`IdentityTokenHolderTest` already covers the holder's own `get`/
// `currentSubject` behaviour).
package dev.everframe.identity

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.everframe.Everframe
import dev.everframe.capture.sharedBreadcrumbBuffer
import dev.everframe.capture.sharedNetworkBodyBuffer
import dev.everframe.capture.sharedNetworkBuffer
import dev.everframe.config.CaptureConfig
import dev.everframe.config.IdentityConfigWire
import dev.everframe.config.ReplayConfig
import dev.everframe.config.EverframeConfig
import dev.everframe.shared.SharedData
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class IdentityProviderWarmTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()

    private fun validConfig(): EverframeConfig = EverframeConfig(
        appId = "test-app-id",
        sdkKey = "txx_live_test1234567890",
        capture = CaptureConfig(logs = false),
    )

    private fun enabledIdentityConfig(): ReplayConfig = ReplayConfig(
        replayEnabled = true,
        replayDurationSec = 30,
        samplingRate = 1.0,
        identity = IdentityConfigWire(enabled = true),
    )

    /** Build an unsigned-but-well-formed JWT. The holder never verifies. */
    private fun jwt(sub: String, expMs: Long): String {
        val payload = buildJsonObject {
            put("sub", sub)
            put("exp", expMs / 1000)
        }
        val header = """{"alg":"HS256","typ":"JWT"}"""
        fun b64(s: String) = Base64.getUrlEncoder().withoutPadding().encodeToString(s.toByteArray(Charsets.UTF_8))
        return "${b64(header)}.${b64(payload.toString())}.not-a-real-signature"
    }

    @Before
    fun setUp() {
        SharedData.init(context)
    }

    @After
    fun tearDown() {
        Everframe.kill()
        sharedBreadcrumbBuffer.applyConfig(null)
        sharedBreadcrumbBuffer.clear()
        sharedNetworkBodyBuffer.clear()
        sharedNetworkBuffer.clear()
    }

    /** Poll `captureUserSnapshot()` until it stamps a subject or a budget
     *  expires — there is no synchronous signal for "the detached warm
     *  coroutine launched by `setIdentityToken` has finished." */
    private fun pollForCapturedSubject(): dev.everframe.TXCapturedUser {
        val deadline = System.currentTimeMillis() + 5_000
        var captured = Everframe.captureUserSnapshot()
        while (captured.identitySubject == null && System.currentTimeMillis() < deadline) {
            Thread.sleep(20)
            captured = Everframe.captureUserSnapshot()
        }
        return captured
    }

    /**
     * THE test that would have caught the defect: install a PROVIDER (not a
     * one-shot token — `IdentityTokenSource.Token` already self-caches inside
     * `set()` and was never the broken case), let the warm happen, capture a
     * report, and assert the gate actually resolves the header. Mutation-
     * verified: fails (times out with `identitySubject == null`) against the
     * pre-fix `setIdentityToken`, which only called `_identityHolder.set(source)`.
     */
    @Test
    fun `installing a provider warms the cache so the next capture stamps the subject`() {
        val now = System.currentTimeMillis()
        val token = jwt(sub = "carol", expMs = now + 300_000)
        val invoked = CountDownLatch(1)

        Everframe.start(context, validConfig())
        // Fix round 3, Serious 3 — the warm now refuses to invoke the
        // provider at all unless identity is enabled for the live config, so
        // this fixture must arm that (a project with identity disabled is
        // covered by its own dedicated test below).
        Everframe.__replayConfigOverrideForTesting = enabledIdentityConfig()
        Everframe.setIdentityToken(
            IdentityTokenSource.Provider {
                invoked.countDown()
                token
            },
        )

        // Not vacuous: the provider really was invoked as part of the warm.
        assertTrue(
            "setIdentityToken must kick off a warm that invokes the provider",
            invoked.await(5, TimeUnit.SECONDS),
        )

        val captured = pollForCapturedSubject()
        assertEquals(
            "installing a provider must warm the cache so the very next capture stamps the subject, not null forever",
            "carol",
            captured.identitySubject,
        )

        val header = runBlocking {
            resolveIdentityHeader(
                capturedSubject = captured.identitySubject,
                holder = Everframe._identityHolder,
                config = enabledIdentityConfig(),
                nowMs = System.currentTimeMillis(),
            )
        }
        assertEquals(
            "the gate must attach the token once the provider form has been given a chance to warm",
            token,
            header,
        )
    }

    // -------------------------------------------------------------------
    // Round 14 (codex round 12), Serious 1 — a provider token whose own TTL
    // is at or below IDENTITY_REFRESH_MARGIN_MS (30s). `ttlSeconds: 30` is a
    // supported `@everframe/identity` configuration, exactly the kind of
    // short-lived token a security-conscious customer would choose. Before
    // the fix, `IdentityTokenHolder.get()`'s provider branch applied the
    // SAME margin check to a token the provider had JUST returned, so this
    // scenario failed at the very first step: `commitIfCurrent` never ran,
    // nothing was EVER cached, and the warm was permanently useless for any
    // such provider — matching the finding's "never work at all."
    //
    // FOLLOW-UP (same round, coordinator re-review): the `get()`-only fix
    // above did NOT close this finding. `Everframe.captureUserSnapshot()`
    // never calls `get()` — it stamps `identitySubject` from the SEPARATE,
    // synchronous `cachedSubject(nowMs)`, which applied the SAME margin to a
    // CACHED value. For a token whose own TTL never exceeds that margin the
    // cached copy can never again clear it (remaining life only decreases
    // from the moment it's minted), so the fix above moved the blockage one
    // step down the chain — from "never cached" to "cached but never read
    // back" — rather than removing it; `resolveIdentityHeader` still
    // short-circuited on `capturedSubject == null` before ever reaching
    // `get()`. Closed by widening `cachedSubject()`'s own bar from
    // "clears the margin" to "merely not yet expired" (see that function's
    // own doc comment in `IdentityTokenHolder.kt` for why that's safe: this
    // function's return value is only ever COMPARED against whatever `get()`
    // independently resolves at submit time, never presented itself).
    // -------------------------------------------------------------------

    /**
     * THE test that actually proves the finding is closed — drives the
     * REAL capture path (`Everframe.captureUserSnapshot()`, via
     * [pollForCapturedSubject], the SAME helper the ordinary-TTL test above
     * uses), not the holder's `currentSubject`/`get` directly. A
     * holder-level test alone could not have caught the residual: the
     * holder was never the blocking step once `get()` was fixed —
     * `cachedSubject()` was. Mutation-verified: reinstating the margin
     * comparison in `cachedSubject()` makes this fail (`captured
     * .identitySubject` stays null, the poll runs out its budget, and the
     * header assertion never even gets a subject to work with).
     */
    @Test
    fun `a provider token with a thirty second ttl still warms is stamped at capture and attaches the header`() {
        val invoked = CountDownLatch(1)

        Everframe.start(context, validConfig())
        Everframe.__replayConfigOverrideForTesting = enabledIdentityConfig()
        Everframe.setIdentityToken(
            IdentityTokenSource.Provider {
                invoked.countDown()
                // Exactly a 30s TTL from the moment the provider is asked —
                // the shortest supported configuration, and the one both
                // halves of this finding rejected outright before their
                // respective fixes.
                jwt(sub = "kim", expMs = System.currentTimeMillis() + 30_000)
            },
        )

        assertTrue(
            "setIdentityToken must kick off a warm that invokes the provider",
            invoked.await(5, TimeUnit.SECONDS),
        )

        val captured = pollForCapturedSubject()
        assertEquals(
            "a 30s-TTL provider token must still warm the cache AND be stamped by the real, synchronous " +
                "captureUserSnapshot() capture path — not just usable via the holder's own async get()",
            "kim",
            captured.identitySubject,
        )

        val header = runBlocking {
            resolveIdentityHeader(
                capturedSubject = captured.identitySubject,
                holder = Everframe._identityHolder,
                config = enabledIdentityConfig(),
                nowMs = System.currentTimeMillis(),
            )
        }
        assertTrue(
            "the header must attach end to end for a 30s-TTL provider token, not just a long-lived one",
            header != null,
        )
    }

    /** The one-shot `Token` form already self-caches inside `set()` —
     *  pinned so a future change to the warm logic cannot regress it. */
    @Test
    fun `installing a one-shot token still warms the cache immediately`() {
        val now = System.currentTimeMillis()
        val token = jwt(sub = "dave", expMs = now + 300_000)

        Everframe.start(context, validConfig())
        // Independent review, round 4 (Serious 3) — captureUserSnapshot()
        // now also gates the stamp on isIdentityEnabled(currentReplayConfig());
        // this test's own point is the one-shot self-cache timing, not that
        // gate, so arm it the same way the sibling tests in this file do.
        Everframe.__replayConfigOverrideForTesting = enabledIdentityConfig()
        Everframe.setIdentityToken(IdentityTokenSource.Token(token))

        // No polling needed — Token self-caches synchronously inside set(),
        // before setIdentityToken even returns.
        val captured = Everframe.captureUserSnapshot()
        assertEquals("dave", captured.identitySubject)
    }

    /** Clearing identity must not stamp a subject on the next capture. */
    @Test
    fun `clearing identity stamps no subject`() {
        Everframe.start(context, validConfig())
        Everframe.setIdentityToken(
            IdentityTokenSource.Token(jwt(sub = "eve", expMs = System.currentTimeMillis() + 300_000)),
        )
        Everframe.setIdentityToken(null)

        val captured = Everframe.captureUserSnapshot()
        assertNull(captured.identitySubject)
    }

    // -------------------------------------------------------------------
    // Fix round 2: the install warm alone is NOT sufficient.
    //
    // Re-review finding: the warm added above fires only at install and
    // nothing ever re-warms. Once the install-warmed token ages inside
    // IDENTITY_REFRESH_MARGIN_MS, cachedSubject(nowMs:) reads null again and
    // NOTHING re-invokes the provider — resolveIdentityHeader short-circuits
    // on a null captured subject before it ever reaches holder.get(nowMs:).
    // The original dead-end chain reasserts itself verbatim after at most
    // one token lifetime (<=10 minutes) per setIdentityToken call.
    //
    // Fix: Everframe.__warmIdentityToken() — the same warm setIdentityToken
    // already fires — is now also called at reporter-open
    // (TXReporterPresenter.openReporter / CompanionCaptureBridge
    // .onReportRequest, proven wired in TXReporterPresenterIdentityWarmTest
    // and CompanionCaptureBridgeIdentityWarmTest).
    // -------------------------------------------------------------------

    /**
     * THE test that must exist per the re-review: age the cached token PAST
     * its own expiry, then capture, and assert the header still attaches.
     * Reproduces the re-reviewer's own probe first (fixture sanity — proves
     * aging alone really does go stale), then drives the actual fix
     * (`__warmIdentityToken()`, what reporter-open now calls) and proves it
     * recovers. Mutation-verified: gutting `__warmIdentityToken()` to a
     * no-op reproduces the re-reviewer's exact dead end at the final
     * assertions.
     *
     * Round 14 follow-up (Serious 1) note on the fixture: this test used to
     * age the first token to ~28.5s remaining — INSIDE the 30s margin but
     * NOT expired — and treat that as "stale." `cachedSubject()` no longer
     * agrees: it now accepts any not-yet-expired cached token (see that
     * function's own doc comment), so a merely-inside-the-margin token is
     * exactly the case this round's fix was FOR, not a staleness case
     * anymore. The fixture now uses a genuinely short (6s) first TTL and
     * sleeps past it, so "stale" here means what `cachedSubject()` actually
     * treats as stale post-fix: really expired, not merely inside the
     * margin. The test's own PURPOSE — reporter-open's rewarm recovers an
     * aged cache — is unchanged; only the fixture's definition of "aged"
     * moved to match the fixed code.
     */
    @Test
    fun `reporter-open rewarms an aged token before the next capture`() {
        val callCount = java.util.concurrent.atomic.AtomicInteger(0)
        // First call: a token valid only 6s — long enough to clear the
        // install-warm's own poll (typically well under a second), short
        // enough to have GENUINELY expired after a few seconds of real
        // sleep. Every subsequent call: a fresh, long-lived token — what a
        // real provider would return on re-ask.
        Everframe.start(context, validConfig())
        // Fix round 3, Serious 3 — arm identity-enabled so the warm's own
        // gate lets it through (see the dedicated disabled-project test
        // below for the negative case).
        Everframe.__replayConfigOverrideForTesting = enabledIdentityConfig()
        Everframe.setIdentityToken(
            IdentityTokenSource.Provider {
                val n = callCount.incrementAndGet()
                val expMs = System.currentTimeMillis() + if (n == 1) 6_000 else 300_000
                jwt(sub = "frank", expMs = expMs)
            },
        )

        // Let the install warm (round 1) settle.
        var captured = pollForCapturedSubject()
        assertEquals("fixture sanity: the install warm must land first", "frank", captured.identitySubject)
        assertEquals("fixture sanity: exactly one call so far", 1, callCount.get())

        // Age PAST actual expiry — real wall-clock sleep, no clock injection
        // in this holder by design. 6s of validity minus ~6.5s of sleep
        // leaves the token genuinely expired, not merely inside the margin.
        Thread.sleep(6_500)

        // Reproduces the re-reviewer's probe exactly: with nothing to
        // re-warm it, the cache is stale (now: actually expired) and
        // captureUserSnapshot() stamps null again — the original dead end,
        // verbatim.
        val staleCaptured = Everframe.captureUserSnapshot()
        assertNull(
            "fixture sanity: aging past actual expiry must go stale, or this test proves nothing",
            staleCaptured.identitySubject,
        )
        assertEquals("fixture sanity: nothing has re-invoked the provider yet", 1, callCount.get())

        // THE FIX under test: this is exactly what
        // TXReporterPresenter.openReporter and
        // CompanionCaptureBridge.onReportRequest now call at reporter-open.
        Everframe.__warmIdentityToken()

        captured = pollForCapturedSubject()
        assertEquals(
            "reporter-open must re-warm an aged token so the NEXT capture stamps the subject again",
            "frank",
            captured.identitySubject,
        )
        assertEquals(
            "not vacuous: the provider must actually have been RE-invoked, not just re-read a stale cache",
            2,
            callCount.get(),
        )

        val header = runBlocking {
            resolveIdentityHeader(
                capturedSubject = captured.identitySubject,
                holder = Everframe._identityHolder,
                config = enabledIdentityConfig(),
                nowMs = System.currentTimeMillis(),
            )
        }
        assertTrue(
            "the header must attach once reporter-open has re-warmed an aged token",
            header != null,
        )
    }

    // -------------------------------------------------------------------
    // Fix round 3, Serious 3: the warm must respect `identity.enabled`.
    //
    // Independent review finding: `__warmIdentityToken()` invoked the host's
    // provider UNCONDITIONALLY — before config exists, and for projects
    // where identity is disabled. That breaks the guarantee the whole
    // `identity.enabled` gate exists for ("a project with no signing secret
    // never calls the customer's endpoint"): installing a provider fired the
    // host's auth/network work for every project, including ones that will
    // never present a header, and cached a subject a subsequent capture
    // could persist into the outbox even though identity is off.
    // -------------------------------------------------------------------

    /**
     * THE test that must exist per the re-review: with identity disabled
     * (the default — no override armed, matching a project with no signing
     * secret, or one whose config simply hasn't fetched yet), installing a
     * provider must never invoke it. Mutation-verified: reverting the
     * `isIdentityEnabled` guard in `__warmIdentityToken()` makes this fail
     * (the provider IS invoked).
     */
    @Test
    fun `installing a provider does not invoke it when identity is disabled for the project`() {
        val invoked = java.util.concurrent.atomic.AtomicBoolean(false)

        Everframe.start(context, validConfig())
        // Deliberately NOT arming __replayConfigOverrideForTesting —
        // currentReplayConfig() therefore resolves the fail-closed
        // ReplayConfig.OFF default, exactly like a project with no signing
        // secret, or the brief pre-fetch window before ANY project's config
        // has settled.
        Everframe.setIdentityToken(
            IdentityTokenSource.Provider {
                invoked.set(true)
                jwt(sub = "henry", expMs = System.currentTimeMillis() + 300_000)
            },
        )

        // No timer, no wait — per the fix's own constraint, a disabled
        // project's warm must SKIP, not queue or retry. A generous but
        // bounded sleep is the only way to assert a negative ("this never
        // happens") for a fire-and-forget launched coroutine;
        // currentReplayConfig() resolving OFF is synchronous, so this is not
        // racing anything slow.
        Thread.sleep(300)

        assertEquals(
            "identity is disabled for this project (no override armed) — the warm must never invoke the provider",
            false,
            invoked.get(),
        )
        val captured = Everframe.captureUserSnapshot()
        assertNull("not vacuous: nothing should have been cached either", captured.identitySubject)
    }

    /**
     * Companion case: reporter-open's re-warm call site must respect the
     * SAME gate — driven through the actual `__warmIdentityToken()` entry
     * point reporter-open calls, not a bespoke path.
     */
    @Test
    fun `reporter-open warm does not invoke the provider when identity is disabled`() {
        val invoked = java.util.concurrent.atomic.AtomicBoolean(false)

        Everframe.start(context, validConfig())
        Everframe.setIdentityToken(
            IdentityTokenSource.Provider {
                invoked.set(true)
                jwt(sub = "iris", expMs = System.currentTimeMillis() + 300_000)
            },
        )

        // Exactly what TXReporterPresenter.openReporter /
        // CompanionCaptureBridge.onReportRequest call at reporter-open —
        // invoked explicitly a second time here to isolate it as its own
        // assertion, even though the install call above already exercises
        // the identical gate.
        Everframe.__warmIdentityToken()
        Thread.sleep(300)

        assertEquals(
            "reporter-open's re-warm must also refuse to invoke the provider when identity is disabled",
            false,
            invoked.get(),
        )
    }
}
