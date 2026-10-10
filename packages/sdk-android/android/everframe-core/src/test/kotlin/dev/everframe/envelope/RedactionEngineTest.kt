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
            "com.example.survey.SurveyJobScheduler\$schedule\$1.invokeSuspend\$lambda\$0(SurveyJobScheduler.kt:30)",
            "kotlinx.coroutines.internal.DispatchedContinuation.resumeWith(DispatchedContinuation.kt:42)",
            "androidx.recyclerview.widget.RecyclerView.onLayout(RecyclerView.java:4577)",
            "MyAppModule.CheckoutViewModel.submitOrder(_:) + 120",
            "com.example.survey.SurveyJobScheduler.schedule.invokeSuspend(SurveyJobScheduler.kt:30)",
            "com.example.app.extension",
            "SurveyKit.SurveyJobScheduler.scheduleNextRun(_:)",
            "-[SurveyJobScheduler scheduleWithCompletion:]",
            "\$s9SurveyKit18SurveyJobSchedulerC8scheduleyyFTf4n_g",
        )) assertEquals(frame, RedactionEngine.redact(frame))
    }

    /** URL-encoded, glued (no word boundary: the eyJ payload marks the token) and JWE tokens. */
    @Test
    fun `glued URL-encoded and JWE tokens are redacted`() {
        val jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwZXJzb24ifQ.SflKxwRJSMeKKF2QT4fw"
        val dirJwe = "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..48V1_ALb6US04U3b.5eym8TW_c8SuK0ltJ3rpYIzOeDQz7TALvtu6UG9oMo4.XFBoMYUZodetZdvTiFvSkQ"
        val rsaJwe = "eyJhbGciOiJSU0EtT0FFUCIsImVuYyI6IkEyNTZHQ00ifQ.OKOawDo13gRp2ojaHV7LFpZcgV7T6DVZKTyKOMTYUmKoTCVJRgckCL9kiMT03JGeipsEdY3mx_etLbbWSrFr05kLzc.48V1_ALb6US04U3b.5eym8TW_c8SuK0ltJ3rpYIzOeDQz7TALvtu6UG9oMo4.XFBoMYUZodetZdvTiFvSkQ"
        for ((input, expected) in listOf(
            "state%3D$jwt&x=1" to "state%3D[REDACTED:JWT]&x=1",
            "%22$jwt%22" to "%22[REDACTED:JWT]%22",
            "Bearer%20$jwt" to "Bearer%20[REDACTED:JWT]",
            "x_$jwt" to "x_[REDACTED:JWT]",
            "_$jwt" to "_[REDACTED:JWT]",
            "{\"line\":\"auth\\n$jwt\"}" to "{\"line\":\"auth\\n[REDACTED:JWT]\"}",
            "jwe $dirJwe" to "jwe [REDACTED:JWT]",
            "token=$dirJwe&next=1" to "token=[REDACTED:JWT]&next=1",
            "token%3D$dirJwe" to "token%3D[REDACTED:JWT]",
            "x_$dirJwe" to "x_[REDACTED:JWT]",
            "session$rsaJwe" to "session[REDACTED:JWT]",
            "token%3D$rsaJwe" to "token%3D[REDACTED:JWT]",
        )) assertEquals(input, expected, RedactionEngine.redact(input))
    }

    /** A JSON header with whitespace: `{ ` → eyA, `{\n` → ewo, `{\t` → ewk, `{\r` → ew0. */
    @Test
    fun `tokens whose JSON header has whitespace are redacted`() {
        val encoder = java.util.Base64.getUrlEncoder().withoutPadding()
        fun b64(text: String) = encoder.encodeToString(text.toByteArray())
        val payload = b64("{\"sub\":\"1234567890\"}")
        for (header in listOf("{ \"alg\": \"HS256\" }", "{\n  \"alg\": \"HS256\"\n}", "{\t\"alg\":\"HS256\"}", "{\r\n\"alg\":\"HS256\"}")) {
            val token = "${b64(header)}.$payload.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
            assertEquals("token [REDACTED:JWT]", RedactionEngine.redact("token $token"))
            assertEquals("id%3D[REDACTED:JWT]", RedactionEngine.redact("id%3D$token"))
        }
    }

    /** Decided: short dotted names with these prefixes stay; a full JWT shape is masked (the accepted cost). */
    @Test
    fun `dotted names starting like a spaced JSON header keep their shape rule`() {
        for (name in listOf("ewok.something.else", "eyAudit.Foo.Bar", "com.example.ewokFactory.create(EwokFactory.kt:7)"))
            assertEquals(name, RedactionEngine.redact(name))
        assertEquals("[REDACTED:JWT]", RedactionEngine.redact("ewokFactory.createInstance.something"))
    }

    /** JwtScan gives exactly the plain regex result, and stays linear where the plain scan is quadratic. */
    @Test
    fun `the JWT scan matches the plain regex and stays linear`() {
        val rule = Regex(SharedData.redactionPatterns.single { it.id == "jwt" }.regex)
        var seed = 0x2545f491
        fun random(n: Int): Int { seed = seed xor (seed shl 13); seed = seed xor (seed ushr 17); seed = seed xor (seed shl 5); return Math.floorMod(seed, n) }
        val alphabet = "aZ09_-eyJwAok"
        val glue = listOf("", " ", "_", "-", "x", "%3D", "é", "\\n", ".", "=", "..")
        val prefixes = listOf("eyJ", "eyA", "ewo", "ewk", "ew0")
        var redacted = 0
        repeat(5_000) {
            val value = buildString {
                repeat(1 + random(3)) {
                    append(glue[random(glue.size)])
                    append((0..random(6)).joinToString(".") {
                        buildString { if (random(2) == 0) append(prefixes[random(prefixes.size)]); repeat(random(13)) { append(alphabet[random(alphabet.length)]) } }
                    })
                }
            }
            val expected = rule.replace(value, "[REDACTED:JWT]")
            assertEquals(value, expected, JwtScan.replace(rule.toPattern(), value, "[REDACTED:JWT]"))
            if (expected != value) redacted++
        }
        assertTrue("the corpus must exercise matches, got $redacted", redacted > 500)
        for (value in listOf("eyJ-".repeat(262_144), "eyJabcde.eyJabcde.".repeat(58_254), "-eyJ".repeat(262_143) + ".abcdefgh",
                "ewo-eyA-ewk-ew0-".repeat(65_536), "xewoabcde..abcdefgh.abcdefgh.".repeat(36_158))) {
            val started = System.nanoTime()
            RedactionEngine.redact(value)
            val ms = (System.nanoTime() - started) / 1_000_000
            assertTrue("a megabyte took $ms ms", ms < 2_000)
        }
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
