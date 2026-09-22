// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Independent review, round 15, Critical — `setIdentityToken` replaced the
// credential holder and nothing else. It did not discard an active or
// frozen replay, nor clear breadcrumbs, logs, network metadata, or network
// bodies. So: Alice uses the app, signs out, Bob signs in, and Bob could
// immediately submit ALICE's retained capture history — stamped with Bob's
// server-VERIFIED identity. `ReplayLifecycle.forceDiscard()` was already
// documented as the zeroization boundary for exactly this ("logout/identity
// change") but nothing ever called it.
//
// Round 15's first fix went further than sign-out: it also discarded on any
// CONFIRMED identity change inferred from Token/Provider (comparing the new
// subject against the previous one). Round 16 (independent review, codex
// round 14) re-review found that attempt itself produced three further
// Criticals — an already-open reporter keeps the previous user's
// screenshot/UI-tree regardless of what the ring buffers do; the
// provider-form comparison was a ONE-SHOT check tied to the first warm
// attempt, so a transient failure permanently lost it; and even the
// synchronous Token path published the new identity before the evidence
// wipe completed, so a concurrent capture could observe the new subject
// alongside the old evidence. The ruling: narrow the discard to sign-out
// only — the one case that is unambiguous and free of all three findings
// (`null` always resolves to ANONYMOUS, never to a DIFFERENT verified
// identity, so the worst case in the identical race window is "ships with
// less evidence," never "attributed to the wrong verified person"). See
// `TraceItX.kt`'s `setIdentityToken` for the full account and
// `the user-recognition contract` for the accepted-limitation writeup.
//
// This suite therefore covers TWO things: (1) sign-out still discards, the
// part that stayed fixed, and (2) the residual — an account switch to a
// DIFFERENT verified identity does NOT discard, documented here as a
// regression pin so a future re-attempt at inferring the comparison cannot
// silently reintroduce it without this test (and the docs) being revisited.
// Both drive the fix end to end: capture evidence as Alice, install Bob (or
// sign out), build a REAL envelope from whatever the buffers hold
// afterward, submit it through the REAL `ReportSubmitter` to a REAL
// `MockWebServer`, and inspect what actually arrived on the wire
// (MockWebServer's own `RecordedRequest.body`).
package com.traceitx

import com.traceitx.outbox.JceTestOutboxKeyProvider
import com.traceitx.outbox.JvmOutboxFileOps

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.traceitx.capture.ResourceRingBuffer
import com.traceitx.capture.sharedBreadcrumbBuffer
import com.traceitx.capture.sharedLogBuffer
import com.traceitx.capture.sharedNetworkBodyBuffer
import com.traceitx.capture.sharedNetworkBuffer
import com.traceitx.capture.sharedResourceBuffer
import com.traceitx.config.CaptureConfig
import com.traceitx.config.IdentityConfigWire
import com.traceitx.config.ReplayConfig
import com.traceitx.config.ReportResult
import com.traceitx.config.TraceItXConfig
import com.traceitx.envelope.EnvelopeBuilder
import com.traceitx.identity.IDENTITY_TOKEN_HEADER
import com.traceitx.identity.IdentityTokenSource
import com.traceitx.identity.decodeIdentityClaims
import com.traceitx.identity.resolveIdentityHeader
import com.traceitx.outbox.JSONLOutbox
import com.traceitx.protocol.generated.BreadcrumbKind
import com.traceitx.shared.SharedData
import com.traceitx.transport.ReportSubmitter
import java.io.File
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class AccountSwitchEvidenceDiscardTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private lateinit var server: MockWebServer

    private fun validConfig(): TraceItXConfig = TraceItXConfig(
        appId = "test-app-id",
        sdkKey = "txx_live_test1234567890",
        capture = CaptureConfig(logs = false),
    )

    private fun jwt(sub: String, expMs: Long): String {
        val payload = buildJsonObject {
            put("sub", sub)
            put("exp", expMs / 1000)
        }
        val header = """{"alg":"HS256","typ":"JWT"}"""
        fun b64(s: String) = Base64.getUrlEncoder().withoutPadding().encodeToString(s.toByteArray(Charsets.UTF_8))
        return "${b64(header)}.${b64(payload.toString())}.not-a-real-signature"
    }

    private fun makeOutbox(): JSONLOutbox = JSONLOutbox(File(tmp.newFolder("com.traceitx"), "outbox.jsonl"), keys = JceTestOutboxKeyProvider(), ops = JvmOutboxFileOps())

    @Before
    fun setUp() {
        SharedData.init(context)
        server = MockWebServer()
        server.start()
        sharedBreadcrumbBuffer.applyConfig(null)  // all kinds enabled, boot-time defaults
        sharedBreadcrumbBuffer.clear()
        sharedLogBuffer.clear()
        sharedNetworkBuffer.clear()
        sharedNetworkBodyBuffer.clear()
        sharedResourceBuffer.clear()
    }

    @After
    fun tearDown() {
        TraceItX.kill()
        sharedBreadcrumbBuffer.applyConfig(null)
        sharedBreadcrumbBuffer.clear()
        sharedLogBuffer.clear()
        sharedNetworkBuffer.clear()
        sharedNetworkBodyBuffer.clear()
        sharedResourceBuffer.clear()
        server.shutdown()
    }

    private fun buildEnvelope(): ByteArray {
        val logRows = sharedLogBuffer.snapshot().map {
            EnvelopeBuilder.LogRow(timestamp = it.timestamp, level = it.level, tag = it.tag, message = it.message)
        }
        return EnvelopeBuilder().buildEncoded(
            sdkVersion = "test",
            logs = logRows,
            breadcrumbs = sharedBreadcrumbBuffer.snapshotForCrash(),
        ).bytes
    }

    // -------------------------------------------------------------------
    // The residual, documented as a regression pin (round 16) — an account
    // switch to a DIFFERENT verified identity does NOT discard the
    // previous user's evidence. See this file's own module doc and
    // `the user-recognition contract` for the full accepted-limitation
    // writeup. If this test starts failing because evidence IS being
    // discarded again, that is not automatically a regression — it means
    // someone re-added the inferred comparison, and BOTH this test AND the
    // docs need to be revisited together, not just one of them.
    // -------------------------------------------------------------------

    /**
     * Mutation-verified (inverted from round 15's original intent):
     * reinstating round 15's discard-on-change logic makes this fail — the
     * built envelope (and the server's recorded body) would then be empty
     * of Alice's markers instead of containing them.
     */
    @Test
    fun `an account switch to a different verified identity does not discard the previous users evidence`() {
        TraceItX.start(context, validConfig())
        TraceItX.__replayConfigOverrideForTesting = ReplayConfig(
            replayEnabled = false, replayDurationSec = 30, samplingRate = 1.0,
            identity = IdentityConfigWire(enabled = true),
        )

        // 1. Capture as Alice: install her verified identity, then capture
        //    evidence while she is the active subject.
        TraceItX.setIdentityToken(IdentityTokenSource.Token(jwt(sub = "alice", expMs = System.currentTimeMillis() + 300_000)))
        sharedBreadcrumbBuffer.add(kind = BreadcrumbKind.Tap, message = "alice-breadcrumb-marker")
        sharedLogBuffer.push(com.traceitx.capture.LogRingBuffer.Entry(
            timestamp = System.currentTimeMillis(), level = "info", tag = null, message = "alice-log-marker",
        ))

        // Fixture sanity — the evidence really is there before the switch.
        assertFalse("fixture sanity: Alice's breadcrumb must be captured", sharedBreadcrumbBuffer.snapshotForCrash().isEmpty())
        assertFalse("fixture sanity: Alice's log line must be captured", sharedLogBuffer.snapshot().isEmpty())

        // 2. Bob signs in — a DIFFERENT verified subject, via the PROVIDER
        //    form. No discard is expected here anymore (round 16).
        val invoked = CountDownLatch(1)
        TraceItX.setIdentityToken(
            IdentityTokenSource.Provider {
                invoked.countDown()
                jwt(sub = "bob", expMs = System.currentTimeMillis() + 300_000)
            },
        )

        assertTrue(
            "fixture sanity: the warm must actually have invoked the provider",
            invoked.await(5, TimeUnit.SECONDS),
        )

        // Give a (no longer expected) discard a fair chance to land before
        // asserting its absence, same bounded-wait discipline this branch
        // always uses to check a negative.
        Thread.sleep(300)

        // 3. THE residual: Alice's evidence is still there.
        assertFalse(
            "accepted limitation: an account switch does not discard the previous user's breadcrumbs",
            sharedBreadcrumbBuffer.snapshotForCrash().isEmpty(),
        )
        assertFalse(
            "accepted limitation: an account switch does not discard the previous user's log lines",
            sharedLogBuffer.snapshot().isEmpty(),
        )

        // 4. Submit — build a REAL envelope from whatever the buffers hold
        //    NOW (post-switch, still Alice's), through the SAME builder
        //    production uses.
        val envelopeBytes = buildEnvelope()
        val envelopeText = String(envelopeBytes, Charsets.UTF_8)
        assertTrue(
            "accepted limitation: the envelope built after the account switch still carries Alice's evidence",
            envelopeText.contains("alice-breadcrumb-marker") && envelopeText.contains("alice-log-marker"),
        )

        val captured = TraceItX.captureUserSnapshot()
        assertEquals("fixture sanity: the capture must be stamped under Bob, not Alice", "bob", captured.identitySubject)
        val identityToken = runBlocking {
            resolveIdentityHeader(
                capturedSubject = captured.identitySubject,
                holder = TraceItX._identityHolder,
                config = TraceItX.currentReplayConfig(),
                nowMs = System.currentTimeMillis(),
            )
        }

        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        val submitter = ReportSubmitter(
            config = validConfig(),
            outbox = makeOutbox(),
            endpointOverride = server.url("/api/ingest").toString(),
        )
        val result = runBlocking {
            submitter.submit(
                envelopeBytes = envelopeBytes,
                idempotencyKey = "idem-account-switch",
                attachments = emptyList(),
                identitySubject = captured.identitySubject,
                identityToken = identityToken,
            )
        }
        assertTrue("the report must still submit after an account switch — got $result", result is ReportResult.Submitted)

        // 5. The strongest evidence available: what the SERVER actually
        //    received on the wire, not merely the bytes handed to submit()
        //    — this documents the EXACT exposure precisely: Alice's own
        //    breadcrumb/log markers, attached to a request carrying Bob's
        //    server-VERIFIED identity header.
        val recorded = server.takeRequest()
        val bodyText = recorded.body.readUtf8()
        assertTrue(
            "accepted limitation: Alice's evidence reaches the wire in the request body Bob's report submits",
            bodyText.contains("alice-breadcrumb-marker") && bodyText.contains("alice-log-marker"),
        )
        val sentToken = recorded.getHeader(IDENTITY_TOKEN_HEADER)
        assertNotNull("fixture sanity: the report must carry Bob's identity header", sentToken)
        assertEquals(
            "accepted limitation, precisely: the wire request carries ALICE's evidence under BOB's verified identity header",
            "bob",
            sentToken?.let { decodeIdentityClaims(it)?.sub },
        )
    }

    // -------------------------------------------------------------------
    // The part that stayed fixed: sign-out.
    // -------------------------------------------------------------------

    @Test
    fun `sign out always discards captured evidence`() {
        TraceItX.start(context, validConfig())
        TraceItX.setIdentityToken(IdentityTokenSource.Token(jwt(sub = "alice", expMs = System.currentTimeMillis() + 300_000)))
        sharedBreadcrumbBuffer.add(kind = BreadcrumbKind.Tap, message = "alice-breadcrumb-marker")
        assertFalse("fixture sanity", sharedBreadcrumbBuffer.snapshotForCrash().isEmpty())

        TraceItX.setIdentityToken(null)

        assertTrue(
            "sign-out (null) must always discard captured evidence",
            sharedBreadcrumbBuffer.snapshotForCrash().isEmpty(),
        )
    }

    /**
     * Round-1 review, Important 2 — the identical finding iOS already fixed
     * for its resource ring buffer, carried into Android here. Nothing
     * captured before a sign-out may ship under the next signed-in
     * identity; a new account must not be able to submit the previous
     * account's resource samples.
     */
    @Test
    fun `sign out always discards captured resource samples`() {
        TraceItX.start(context, validConfig())
        TraceItX.setIdentityToken(IdentityTokenSource.Token(jwt(sub = "alice", expMs = System.currentTimeMillis() + 300_000)))
        sharedResourceBuffer.push(ResourceRingBuffer.Entry(t = System.currentTimeMillis(), cpu = 0.1, mem = 4096L))
        assertFalse("fixture sanity", sharedResourceBuffer.snapshot().isEmpty())

        TraceItX.setIdentityToken(null)

        assertTrue(
            "sign-out (null) must always discard captured resource samples",
            sharedResourceBuffer.snapshot().isEmpty(),
        )
    }
}
