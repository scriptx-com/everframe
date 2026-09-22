// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Final whole-branch review, fix round 2, Critical 1 — the install warm
// (`TraceItX.setIdentityToken`) alone was not sufficient: once the cached
// token ages inside `IDENTITY_REFRESH_MARGIN_MS`, NOTHING re-invokes the
// provider, and the original dead-end chain
// (`cachedSubject` -> null -> capture stamps anonymous -> `resolveIdentityHeader`
// short-circuits before `holder.get`) reasserts itself. The fix adds a
// SECOND call site — `TraceItX.__warmIdentityToken()` at reporter-open — and
// `IdentityProviderWarmTest.kt` (`:traceitx-core`) proves the underlying
// mechanism recovers an aged token. This suite proves the PRODUCTION wiring:
// `TXReporterPresenter.openReporter` actually calls it, not just that the
// mechanism works in isolation.
//
// Driven for real (Robolectric), not source-gated — unlike iOS's
// `TXReporterPresenter.swift`, this file has no UIKit-equivalent
// reachability problem. `openReporter` calls `TraceItX.__warmIdentityToken()`
// BEFORE it ever touches `ScreenshotCapture.captureBeforeReporter` — headless
// Robolectric capture commonly fails/returns null with no real window
// surface, which would short-circuit `openReporter` to
// `Cancelled("capture_failed")`, but that happens AFTER the warm call, so
// this test does not depend on capture (or the Dialog it would otherwise
// show) succeeding at all.
package com.traceitx.ui

import android.app.Activity
import com.traceitx.TraceItX
import com.traceitx.config.CaptureConfig
import com.traceitx.config.Environment
import com.traceitx.config.TraceItXConfig
import com.traceitx.identity.IdentityTokenSource
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class TXReporterPresenterIdentityWarmTest {

    @After
    fun tearDown() {
        TraceItX.kill()
    }

    private fun jwt(sub: String, expMs: Long): String {
        val payload = buildJsonObject {
            put("sub", sub)
            put("exp", expMs / 1000)
        }
        val header = """{"alg":"HS256","typ":"JWT"}"""
        fun b64(s: String) = java.util.Base64.getUrlEncoder().withoutPadding()
            .encodeToString(s.toByteArray(Charsets.UTF_8))
        return "${b64(header)}.${b64(payload.toString())}.not-a-real-signature"
    }

    /** Poll `TraceItX.captureUserSnapshot()` until it stamps a subject or a
     *  budget expires. */
    private fun pollForCapturedSubject(budgetMs: Long = 5_000): com.traceitx.TXCapturedUser {
        val deadline = System.currentTimeMillis() + budgetMs
        var captured = TraceItX.captureUserSnapshot()
        while (captured.identitySubject == null && System.currentTimeMillis() < deadline) {
            Thread.sleep(20)
            captured = TraceItX.captureUserSnapshot()
        }
        return captured
    }

    @Test
    fun `openReporter re-warms an aged identity token before capture`() {
        val controller = Robolectric.buildActivity(Activity::class.java).create()
        val activity = controller.get()

        val callCount = AtomicInteger(0)
        TraceItX.start(
            activity,
            TraceItXConfig(
                appId = "test-app-id",
                sdkKey = "txx_live_test1234567890",
                environment = Environment.production,
                capture = CaptureConfig(logs = false),
            ),
        )
        // Fix round 3, Serious 3 — the warm now refuses to invoke the
        // provider at all unless identity is enabled for the live config.
        TraceItX.__replayConfigOverrideForTesting = com.traceitx.config.ReplayConfig(
            replayEnabled = false,
            replayDurationSec = 30,
            samplingRate = 1.0,
            identity = com.traceitx.config.IdentityConfigWire(enabled = true),
        )
        // Round 14 follow-up (Serious 1) — this used to use a 33s first TTL
        // and treat ~28.5s-remaining (inside the 30s margin, NOT expired) as
        // "stale." `cachedSubject()` no longer agrees: it now accepts any
        // not-yet-expired cached token (see that function's own doc comment
        // in IdentityTokenHolder.kt), so a merely-inside-the-margin token is
        // exactly the case that round's fix was FOR, not a staleness case
        // anymore. A 6s first TTL, aged past with a 6.5s sleep, is
        // genuinely expired — what "stale" now means post-fix.
        TraceItX.setIdentityToken(
            IdentityTokenSource.Provider {
                val n = callCount.incrementAndGet()
                val expMs = System.currentTimeMillis() + if (n == 1) 6_000 else 300_000
                jwt(sub = "grace", expMs = expMs)
            },
        )

        // Let the install warm (round 1) settle.
        var captured = pollForCapturedSubject()
        assertEquals("fixture sanity: the install warm must land first", "grace", captured.identitySubject)
        assertEquals(1, callCount.get())

        // Age PAST actual expiry (not merely past the margin — see above).
        Thread.sleep(6_500)
        val staleCaptured = TraceItX.captureUserSnapshot()
        assertNull(
            "fixture sanity: aging past actual expiry must go stale first",
            staleCaptured.identitySubject,
        )
        assertEquals("fixture sanity: nothing has re-invoked the provider yet", 1, callCount.get())

        // THE REAL PRODUCTION ENTRY POINT — fire-and-forget: capture very
        // likely fails in headless Robolectric (no real window surface),
        // short-circuiting to Cancelled("capture_failed") — but the warm
        // call happens BEFORE that check, so this test does not depend on
        // openReporter completing, let alone succeeding.
        CoroutineScope(Dispatchers.IO).launch {
            TXReporterPresenter().openReporter(activity)
        }

        captured = pollForCapturedSubject()
        assertEquals(
            "TXReporterPresenter.openReporter must re-warm an aged token before the next capture",
            "grace",
            captured.identitySubject,
        )
        assertEquals(
            "not vacuous: the provider must actually have been RE-invoked, not just re-read a stale cache",
            2,
            callCount.get(),
        )
    }
}
