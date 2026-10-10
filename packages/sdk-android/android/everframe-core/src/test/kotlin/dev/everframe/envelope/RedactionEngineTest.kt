// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// RedactionEngine tests — default-deny pipeline (PRIV-01..03 / T-05-02-I).
// Robolectric is required because SharedData reads `Context.assets`.
package dev.everframe.envelope

import androidx.test.core.app.ApplicationProvider
import dev.everframe.shared.SharedData
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class RedactionEngineTest {

    @Before
    fun setUp() {
        SharedData.init(ApplicationProvider.getApplicationContext())
    }

    @Test
    fun `JWT is redacted`() {
        val input = "token: eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
        val out = RedactionEngine.redact(input)
        assertTrue("expected JWT redacted, got: $out", out.contains("[REDACTED:JWT]"))
        assertFalse(out.contains("eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3ODkwIn0"))
    }

    /** Stack frames are what a crash report is for: the JWT rule must never eat dotted names. */
    @Test
    fun `dotted class package and module names are not JWTs`() {
        for (frame in listOf(
            "dev.everframe.crashdefault.MainActivity\$onCreate\$2.run\$lambda\$0(SourceFile:5)",
            "kotlinx.coroutines.internal.DispatchedContinuation.resumeWith(DispatchedContinuation.kt:42)",
            "androidx.recyclerview.widget.RecyclerView.onLayout(RecyclerView.java:4577)",
            "MyAppModule.CheckoutViewModel.submitOrder(_:) + 120",
            "com.example.survey.SurveyJobScheduler.schedule.invokeSuspend(SurveyJobScheduler.kt:30)",
        )) assertEquals(frame, RedactionEngine.redact(frame))
    }

    @Test
    fun `Bearer token is redacted`() {
        val out = RedactionEngine.redact("Authorization: Bearer abc123def456")
        assertTrue("expected bearer redacted, got: $out", out.contains("[REDACTED]"))
        assertFalse(out.contains("Bearer abc123def456"))
    }

    @Test
    fun `Luhn-valid CC is masked`() {
        // 4242 4242 4242 4242 — Luhn-valid Visa test card.
        val out = RedactionEngine.redact("My card is 4242424242424242")
        assertTrue("expected CC redacted, got: $out", out.contains("[REDACTED:CC]"))
        assertFalse(out.contains("4242424242424242"))
    }

    @Test
    fun `Luhn-invalid number is NOT masked`() {
        // 4242424242424241 — Luhn-invalid (last digit corrupted).
        val out = RedactionEngine.redact("Order ref 4242424242424241 today")
        assertTrue("expected raw number preserved, got: $out", out.contains("4242424242424241"))
        assertFalse(out.contains("[REDACTED:CC]"))
    }

    @Test
    fun `filterHeaders default-denies non-allowlisted`() {
        val input = mapOf(
            "Authorization" to "Bearer x",
            "Content-Type" to "application/json",
            "X-Custom-Token" to "secret-do-not-leak"
        )
        val out = RedactionEngine.filterHeaders(input)
        assertEquals("[REDACTED]", out["Authorization"])
        assertEquals("application/json", out["Content-Type"])
        assertNull("X-Custom-Token must be DROPPED, not retained", out["X-Custom-Token"])
    }

    @Test
    fun `filterHeaders is case-insensitive on lookup`() {
        val out = RedactionEngine.filterHeaders(mapOf("AUTHORIZATION" to "Bearer x", "content-type" to "text/plain"))
        assertEquals("[REDACTED]", out["AUTHORIZATION"])
        assertEquals("text/plain", out["content-type"])
    }
}
