// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// External review, finding 3 (Serious) — the in-app Android reporter's half.
//
// `ReporterDialog.submitBaked` used to read `Everframe.currentUser` inline,
// after per-shot annotation baking, WebP/JPEG/PNG encoding, SHA-256 hashing,
// replay gzip and ring-buffer snapshotting had all already run. Those stages
// execute on `Dispatchers.Default` for hundreds of milliseconds to seconds
// AFTER the user tapped Send, so a `setUser` call landing in that window (a
// sign-out/sign-in, an account switch) permanently regrouped A's report under
// B. The fix snapshots the user in `show()`'s `onSubmit` lambda — synchronously,
// on the Send tap, before the coroutine is even launched — and threads it in as
// `submitBaked(capturedSession = …)`.
//
// Driven for real rather than gated as source: `submitBaked` is `internal` and
// this module's unit tests are Robolectric-capable, so the whole path (bake →
// encode → EnvelopeBuilder → ReportSubmitter) actually runs. The unit-test
// environment has no ingest server, so `ReportSubmitter` classifies the
// connection failure as retryable and enqueues the envelope to the `JSONLOutbox`
// — which is exactly where we read the produced bytes from (the same technique
// `CompanionSubmissionComposerTest` uses for the sibling path).
package dev.everframe.ui

import android.graphics.Bitmap
import dev.everframe.Everframe
import dev.everframe.capture.NetworkRingBuffer
import dev.everframe.capture.ResourceRingBuffer
import dev.everframe.capture.sharedNetworkBuffer
import dev.everframe.capture.sharedResourceBuffer
import dev.everframe.capture.ScreenshotCapture
import dev.everframe.config.Environment
import dev.everframe.config.ReportResult
import dev.everframe.config.TXUser
import dev.everframe.config.EverframeConfig
import dev.everframe.identity.IdentityTokenSource
import dev.everframe.outbox.JSONLOutbox
import dev.everframe.outbox.OutboxEntry
import dev.everframe.ui.details.ReporterIncludes
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class ReporterDialogSubmitBoundaryTest {

    @After
    fun tearDown() {
        ReporterDialog.__submitterFactoryForTesting = null
        Everframe.kill()
        Everframe.__replayConfigOverrideForTesting = null
        sharedResourceBuffer.clear()
    }

    // --- Report Resource Window (spec 2026-09-05) — gap class 3: this is the
    // PRIMARY "user-submitted bug report" build site, not just the crash
    // path. ---

    @Test
    fun `submitBaked stamps payload_resources from the shared ring buffer`() {
        // Pushed from the `afterCapture` seam, i.e. AFTER `start()` — the
        // ring's push is gated on `Everframe.captureGate`, which is closed
        // until then, so a push before the drive is silently a no-op.
        // Timestamped at "now" because snapshot() evicts against the real
        // clock: a fixed historical timestamp would be gone before
        // submitBaked ever reads it.
        val entry = submitAndCaptureOutboxEntry(userAtSendTap = null, afterCapture = {
            sharedResourceBuffer.push(ResourceRingBuffer.Entry(t = System.currentTimeMillis(), cpu = 0.1, mem = 512L))
        })
        val env = Json.parseToJsonElement(String(entry.envelopeBytes)).jsonObject
        val resources = env["payload"]!!.jsonObject["resources"]!!.jsonArray
        assertEquals(1, resources.size)
        assertEquals(512.0, resources[0].jsonObject["mem"]!!.jsonPrimitive.double, 0.0)
    }

    @Test
    fun `envelope carries the user captured at the Send tap, not a later account switch`() {
        val alice = TXUser(id = "alice", email = "alice@x.com", displayName = "Alice")

        val entry = submitAndCaptureEnvelopeBytes(
            userAtSendTap = alice,
            // The account switch. Happens before the (slow) submit work even
            // starts, which is strictly stronger than a mid-bake swap: ANY live
            // `Everframe.currentUser` read anywhere inside submitBaked would
            // return bob.
            afterCapture = { Everframe.setUser(TXUser(id = "bob", email = "bob@x.com")) },
        )

        // Not vacuous: the live singleton really did switch.
        assertEquals("bob", Everframe.currentUser?.id)

        val user = Json.parseToJsonElement(String(entry))
            .jsonObject["reporter"]!!.jsonObject["user"]!!.jsonObject
        assertEquals("alice", user["id"]!!.jsonPrimitive.content)
        assertEquals("alice@x.com", user["email"]!!.jsonPrimitive.content)
        assertEquals("Alice", user["displayName"]!!.jsonPrimitive.content)
    }

    /**
     * Native identity Task 8b. `submitBaked`'s call to `ReportSubmitter.submit`
     * is `canImport(UIKit)`-gated on iOS with no macOS test reaching it — but
     * this module's unit tests ARE Robolectric-capable, so the real path
     * (identity token set → captured at the Send tap → threaded into
     * `submit(identitySubject:)` → persisted onto the queued `OutboxEntry`
     * when the ingest connection fails, exactly like the no-server unit-test
     * environment here) is directly observable. This is the strongest
     * evidence available for THIS call site: it proves the subject that would
     * drive `X-TX-Identity-Token` on drain actually reaches the entry, not
     * just that `resolveIdentityHeader` makes the right call in isolation.
     */
    @Test
    fun `a queued entry carries the identity subject captured at the Send tap`() {
        val entry = submitAndCaptureOutboxEntry(
            userAtSendTap = null,
            afterCapture = { },
            identityTokenAtSendTap = jwt(sub = "alice", expMs = System.currentTimeMillis() + 300_000),
            identityEnabledAtSendTap = true,
        )
        assertEquals(
            "the subject captured at Send must reach the queued entry",
            "alice",
            entry.identitySubject,
        )
    }

    @Test
    fun `a queued entry captured with nobody signed in carries no identity subject`() {
        val entry = submitAndCaptureOutboxEntry(
            userAtSendTap = null,
            afterCapture = { },
        )
        assertNull(entry.identitySubject)
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

    /**
     * External review, finding 1 (Serious). The Send-tap snapshot above fixed
     * WHO the report belongs to, but not WHERE it goes: `submitBaked` reads
     * `Everframe.currentConfig` — which carries the SDK key, i.e. the project
     * the envelope is uploaded to — after the tap. A `start(projectB)` during
     * that window left the snapshot perfectly intact (`start()` clears the LIVE
     * user, not one already captured), so alice was uploaded under project B's
     * key: a falsely attributed person in a DIFFERENT customer's project.
     *
     * The snapshot now carries the session epoch it was taken in, and
     * `resolve()` discards it once a superseding `start()`/`kill()` has run.
     * The report still ships — anonymously. Losing attribution always beats
     * attributing to the wrong project.
     */
    @Test
    fun `a user captured at Send is dropped when another project starts mid-prep`() {
        val entry = submitAndCaptureEnvelopeBytes(
            userAtSendTap = TXUser(id = "alice", email = "alice@x.com", displayName = "Alice"),
            // Reconfigure onto a DIFFERENT customer's project while the submit
            // work would still be running.
            afterCapture = { ctx ->
                Everframe.start(
                    ctx,
                    EverframeConfig(
                        appId = "other-customer-app-id",
                        sdkKey = "txx_live_projectB098765432",
                        environment = Environment.production,
                    ),
                )
            },
        )

        // Not vacuous: the envelope really was built under project B's config —
        // this is the upload that would have carried alice.
        assertEquals("txx_live_projectB098765432", Everframe.currentConfig?.sdkKey)

        val reporter = Json.parseToJsonElement(String(entry)).jsonObject["reporter"]!!.jsonObject
        assertNull(
            "project A's user must never be uploaded under project B's SDK key",
            reporter["user"],
        )
    }

    /**
     * Follow-ups item 9 — the half the case above could not reach.
     *
     * Dropping the user was never the whole exposure. `submitBaked` read
     * `Everframe.currentConfig` on the far side of the Send tap, so the same
     * `start(projectB)` that made `resolve()` correctly return null ALSO
     * repointed the upload: the envelope went to project B carrying project
     * A's screenshot, UI tree, breadcrumbs and network rows. Anonymously,
     * which is not a mitigation — an anonymous screenshot of A's app sitting
     * in B's inbox is the same disclosure.
     *
     * Asserted on the enqueued entry's `sdkKey`, which is the field the drain
     * submits under (register item 1's key binding) — i.e. the project this
     * report actually reaches.
     */
    @Test
    fun `a report is enqueued under the project it was captured in`() {
        val entry = submitAndCaptureOutboxEntry(
            userAtSendTap = TXUser(id = "alice", email = "alice@x.com", displayName = "Alice"),
            afterCapture = { ctx ->
                Everframe.start(
                    ctx,
                    EverframeConfig(
                        appId = "other-customer-app-id",
                        sdkKey = "txx_live_projectB098765432",
                        environment = Environment.production,
                    ),
                )
            },
        )

        // Not vacuous: project B really is the live session, so a fix that
        // re-read the live config would be caught here rather than passing.
        assertEquals(
            "precondition: project B must be live",
            "txx_live_projectB098765432",
            Everframe.currentConfig?.sdkKey,
        )
        assertEquals(
            "the report must ship under the key of the project it was captured in",
            "txx_live_test1234567890",
            entry.sdkKey,
        )
    }

    /**
     * Follow-ups item 9, SECOND ROUND (external review 2026-08-13, codex).
     *
     * Routing by the captured config closed the direction that mattered and
     * opened a narrower one in reverse: `submitBaked` pins project A's key and
     * then reads `sharedNetworkBuffer` LIVE, well after the Send tap. Project
     * B's rows — captured after the switch, into a ring `start(B)` had just
     * cleared — would have shipped under A's key.
     *
     * The row is pushed AFTER the switch, so it is unambiguously B's: there is
     * no reading of this test where a passing assertion is compatible with the
     * leak.
     */
    @Test
    fun `a report does not carry network rows captured by the next project`() {
        val entry = submitAndCaptureOutboxEntry(
            userAtSendTap = TXUser(id = "alice", email = "alice@x.com", displayName = "Alice"),
            afterCapture = { ctx ->
                Everframe.start(
                    ctx,
                    EverframeConfig(
                        appId = "other-customer-app-id",
                        sdkKey = "txx_live_projectB098765432",
                        environment = Environment.production,
                    ),
                )
                // Project B's traffic, captured entirely under B's session.
                sharedNetworkBuffer.push(
                    NetworkRingBuffer.Entry(
                        timestamp = 1_700_000_000_000L,
                        method = "GET",
                        url = "https://project-b-only.example.invalid/secret",
                        status = 200,
                        durationMs = 12L,
                        requestHeaders = emptyMap(),
                        responseHeaders = emptyMap(),
                        errorMessage = null,
                    ),
                )
            },
        )

        assertEquals("txx_live_test1234567890", entry.sdkKey)
        assertFalse(
            "project B's network row must not ride project A's report",
            String(entry.envelopeBytes).contains("project-b-only.example.invalid"),
        )
    }

    /**
     * Final whole-branch review, Important 2 (in-app reporter path).
     * `ReporterDialog.submitBaked` now threads `capturedSession.user
     * .startEpoch` into `Everframe.__resolveIdentityToken`, so a
     * `start(projectB)` landing between the Send-tap capture and the actual
     * submit must withhold the header — even when project B's live token
     * happens to carry the SAME `sub` (plausible: `sub` is the host's own
     * user id, typically unchanged across a tenant or dev/prod switch).
     * Reaches a REAL (local) `MockWebServer` request via
     * `ReporterDialog.__submitterFactoryForTesting` — the entry-level tests
     * above cannot observe this: `identityToken` is deliberately never
     * persisted onto `OutboxEntry` (only `identitySubject` is), so a
     * mutation that resolves the token and then drops it before `submit(...)`
     * is invisible at the entry level. Mutation-verified: reverting
     * `ReporterDialog.kt`'s call back to
     * `Everframe.__resolveIdentityToken(capturedSession.user.identitySubject)`
     * (single arg, dropping the epoch) makes this fail.
     */
    /** Forces `Everframe.currentReplayConfig()` to report `identity.enabled:
     *  true` via `__replayConfigOverrideForTesting` — WITHOUT this,
     *  `resolveIdentityHeader`'s own `isIdentityEnabled` guard returns
     *  `null` unconditionally (config defaults `.OFF` pre-`ReplaySession`,
     *  and a real `ReplaySession` cannot be constructed from this module —
     *  its `internal` state lives in `:everframe-core`), which would make a
     *  "header withheld" assertion pass for the WRONG reason regardless of
     *  whether the epoch check exists at all. */
    private fun forceIdentityEnabled() {
        Everframe.__replayConfigOverrideForTesting = dev.everframe.config.ReplayConfig(
            replayEnabled = false,
            replayDurationSec = 30,
            samplingRate = 1.0,
            identity = dev.everframe.config.IdentityConfigWire(enabled = true),
        )
    }

    @Test
    fun `submit withholds the identity token when another project starts after the Send tap`() {
        val server = MockWebServer()
        server.start()
        try {
            val controller = Robolectric.buildActivity(android.app.Activity::class.java).create()
            val activity = controller.get()
            val context = activity.applicationContext

            // Project A — the report is captured here.
            Everframe.start(
                context,
                EverframeConfig(appId = "test-app-id", sdkKey = "txx_live_projectA123456789", environment = Environment.production),
            )
            forceIdentityEnabled()
            assertTrue(
                "fixture sanity: currentReplayConfig() must report identity-enabled",
                dev.everframe.config.isIdentityEnabled(Everframe.currentReplayConfig()),
            )
            val aliceTokenA = jwt(sub = "alice", expMs = System.currentTimeMillis() + 300_000)
            Everframe.setIdentityToken(IdentityTokenSource.Token(aliceTokenA))
            val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
            val capture = ScreenshotCapture.CaptureResult(
                bitmap = bitmap, widthPx = bitmap.width, heightPx = bitmap.height,
                pngBytes = ByteArrayOutputStream().use { bos -> bitmap.compress(Bitmap.CompressFormat.PNG, 100, bos); bos.toByteArray() },
            )
            val shots = listOf(SubmittedShot(bitmap = bitmap, annotations = emptyList()))
            // THE SEND TAP — user + session epoch + identity subject, atomically.
            val capturedSession = Everframe.captureSessionSnapshot()
            assertEquals("fixture sanity: the subject must be captured", "alice", capturedSession.user.identitySubject)

            // The switch — lands AFTER the Send tap, before submitBaked runs.
            // The host immediately re-authenticates against project B, and
            // alice happens to be signed in there too.
            Everframe.start(
                context,
                EverframeConfig(appId = "other-app-id", sdkKey = "txx_live_projectB098765432", environment = Environment.production),
            )
            val aliceTokenB = jwt(sub = "alice", expMs = System.currentTimeMillis() + 300_000)
            Everframe.setIdentityToken(IdentityTokenSource.Token(aliceTokenB))
            assertTrue(
                "fixture sanity: currentReplayConfig() must still report identity-enabled after the switch",
                dev.everframe.config.isIdentityEnabled(Everframe.currentReplayConfig()),
            )
            // Not vacuous: project B's live token really would resolve for
            // ITS OWN captures (identity enabled + subject present) — the
            // epoch check, not identity being disabled or the subject
            // mismatching, is what must withhold it here.
            assertEquals(
                "fixture sanity: project B's live token must actually be presentable",
                "alice",
                Everframe.captureSessionSnapshot().user.identitySubject,
            )

            val client = OkHttpClient.Builder()
                .connectTimeout(2, TimeUnit.SECONDS).readTimeout(2, TimeUnit.SECONDS).writeTimeout(2, TimeUnit.SECONDS)
                .build()
            ReporterDialog.__submitterFactoryForTesting = { cfg, outbox ->
                dev.everframe.transport.ReportSubmitter(
                    config = cfg, outbox = outbox,
                    uploader = dev.everframe.transport.MultipartUploader(client),
                    endpointOverride = server.url("/").toString(),
                )
            }
        val resultRef = AtomicReference<ReportResult?>(null)
            try {
                server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
                CoroutineScope(Dispatchers.IO).launch {
                    resultRef.set(
                        ReporterDialog.submitBaked(
                    reportCapture = Everframe.__replayFreeze(),
                            activity = activity,
                            capture = capture,
                            shots = shots,
                            title = "Submit-boundary identity-epoch test",
                            description = "d",
                            // THE ORIGINAL capture — project A's epoch, from
                            // before the switch above.
                            capturedSession = capturedSession,
                            hostExtra = null,
                            includes = ReporterIncludes(),
                        ),
                    )
                }
                val deadline = System.currentTimeMillis() + 30_000
                while (resultRef.get() == null && System.currentTimeMillis() < deadline) {
                    shadowOf(android.os.Looper.getMainLooper()).idle()
                    Thread.sleep(5)
                }
            } finally {
                ReporterDialog.__submitterFactoryForTesting = null
            }
            val result = resultRef.get() ?: error("submitBaked did not complete within 30s")
            assertTrue("expected Submitted, got $result", result is ReportResult.Submitted)

            val request = server.takeRequest(10, TimeUnit.SECONDS)
            assertNotNull("MockWebServer never received the submit request", request)
            assertNull(
                "project B's live token must never drain onto a report captured under project A's session, even though the subject matches",
                request!!.getHeader("X-TX-Identity-Token"),
            )
        } finally {
            Everframe.setIdentityToken(null)
            Everframe.__replayConfigOverrideForTesting = null
            server.shutdown()
        }
    }

    /**
     * Independent review, P1 — the live path's epoch check already
     * withholds `identityToken` on a mismatch (Serious 1), but used to
     * still persist the RAW captured `identitySubject` onto the queued
     * `OutboxEntry` unconditionally — inconsistent with
     * `capturedSession.user.resolve()`, which already drops the
     * self-declared user on the identical mismatch (see
     * `a user captured at Send is dropped when another project starts
     * mid-prep` above). A later drain could then attach a header on the
     * strength of a subject the SDK had already concluded it should not
     * rely on.
     *
     * Full pipeline, both halves required by the finding: (1) a live
     * submit whose epoch changes mid-flight enqueues an entry with a NULL
     * subject, and (2) that exact entry then drains WITHOUT a header even
     * when a live token's `sub` would have matched. Mutation-verified:
     * reverting the `identity.epochStillCurrent` gate on `identitySubject`
     * in `ReporterDialog.kt` makes part (1) fail (subject un-nulled).
     */
    // Merge note (native-identity x captured-session, follow-ups item 9):
    // this originally asserted the entry shipped under project B's key —
    // true before `submitBaked()` routed by the CAPTURED config. Now that
    // `capturedSession.config` (not a live re-read) decides `cfg`, the
    // switch to project B changes the EPOCH (nulling the subject, still
    // this test's point) but no longer the DESTINATION — the entry ships
    // under the project it was captured in, exactly like `a report is
    // enqueued under the project it was captured in` above. Updated to
    // assert that, and Part 2 now drains against the CAPTURED project's
    // config to match what the entry actually carries.
    @Test
    fun `a queued entry carries no identity subject when another project starts mid-prep, and drains without a header even though a live token would match`() {
        val entry = submitAndCaptureOutboxEntry(
            userAtSendTap = null,
            identityTokenAtSendTap = jwt(sub = "alice", expMs = System.currentTimeMillis() + 300_000),
            identityEnabledAtSendTap = true,
            afterCapture = { ctx ->
                Everframe.start(
                    ctx,
                    EverframeConfig(
                        appId = "other-customer-app-id",
                        sdkKey = "txx_live_projectB098765432",
                        environment = Environment.production,
                    ),
                )
                Everframe.setIdentityToken(
                    IdentityTokenSource.Token(jwt(sub = "alice", expMs = System.currentTimeMillis() + 300_000)),
                )
            },
        )

        // Not vacuous: the entry really was enqueued under the CAPTURED
        // project's key ("test-app-id" — see submitAndCaptureOutboxEntry) —
        // routing by the captured config means the live switch to project B
        // changes neither this nor the drain destination, only the epoch
        // the subject is judged against.
        assertEquals("txx_live_test1234567890", entry.sdkKey)
        assertNull(
            "an epoch mismatch must null the PERSISTED subject too, not just the live identityToken",
            entry.identitySubject,
        )

        // Part 2: drain this EXACT entry (endpoint redirected to a server
        // this test controls — drainOutbox always uses the entry's OWN
        // endpoint/sdkKey, never a submitter's endpointOverride) for real,
        // against a live holder whose token's sub is ALSO "alice" and
        // identity-enabled for the CAPTURED project (entry.sdkKey).
        val server = MockWebServer()
        server.start()
        try {
            server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
            val redirectedEntry = entry.copy(endpoint = server.url("/api/ingest").toString())
            val drainOutboxFile = java.io.File.createTempFile("p1-dialog-drain-test", ".jsonl")
            try {
                val drainOutbox = testOutbox(drainOutboxFile)
                runBlocking { drainOutbox.enqueue(redirectedEntry) }

                val holder = dev.everframe.identity.IdentityTokenHolder()
                holder.set(IdentityTokenSource.Token(jwt(sub = "alice", expMs = System.currentTimeMillis() + 300_000)))
                val drainSubmitter = dev.everframe.transport.ReportSubmitter(
                    config = EverframeConfig(appId = "test-app-id", sdkKey = "txx_live_test1234567890"),
                    outbox = drainOutbox,
                )
                runBlocking {
                    drainSubmitter.drainOutbox(
                        identityHolder = holder,
                        currentReplayConfig = {
                            dev.everframe.config.ReplayConfig(
                                replayEnabled = false, replayDurationSec = 30, samplingRate = 1.0,
                                identity = dev.everframe.config.IdentityConfigWire(enabled = true),
                            )
                        },
                        epochAtInitiation = 0,
                        currentEpoch = { 0 },
                    )
                }
                val recorded = server.takeRequest(10, TimeUnit.SECONDS)
                assertNotNull("MockWebServer never received the drain request", recorded)
                assertNull(
                    "the entry's null subject must withhold the header even though a live token's sub matches",
                    recorded!!.getHeader("X-TX-Identity-Token"),
                )
            } finally {
                drainOutboxFile.delete()
            }
        } finally {
            server.shutdown()
        }
    }

    /**
     * Runs one real `ReporterDialog.submitBaked(...)` and returns the envelope
     * bytes it queued. `submitBaked` posts to the main looper (replay read),
     * which under Robolectric's PAUSED looper only advances when this thread
     * idles it — so the call runs on another dispatcher while this thread
     * drains, mirroring `CompanionSubmissionComposerTest`.
     */
    private fun submitAndCaptureEnvelopeBytes(
        userAtSendTap: TXUser?,
        afterCapture: (android.content.Context) -> Unit,
    ): ByteArray = submitAndCaptureOutboxEntry(userAtSendTap, afterCapture).envelopeBytes

    private fun submitAndCaptureOutboxEntry(
        /** Installed via `setUser` after `start()` and snapshotted below with
         *  `captureSessionSnapshot()` — captured exactly the way `show()`'s
         *  `onSubmit` lambda captures it on the real Send tap, epoch and all. */
        userAtSendTap: TXUser?,
        /** Runs AFTER the Send-tap snapshot and BEFORE `submitBaked` is
         *  launched. Handed the app context so it can call
         *  `Everframe.start(...)`. */
        afterCapture: (android.content.Context) -> Unit,
        /** Native identity Task 8b: installed via `setIdentityToken` after
         *  `start()`, BEFORE the Send-tap `captureSessionSnapshot()` below, so
         *  the captured `TXCapturedSession.user.identitySubject` reflects it
         *  exactly like a real signed-in host. `null` (default) leaves
         *  identity untouched — the ordinary anonymous case the other tests
         *  exercise. */
        identityTokenAtSendTap: String? = null,
        /** Independent review, round 4 (Serious 3) — `captureUserSnapshot()`/
         *  `captureSessionSnapshot()` also gate the stamp on
         *  `isIdentityEnabled(currentReplayConfig())`. `false` (default,
         *  matches production before any config fetch) — callers that want a
         *  subject actually captured must opt in. */
        identityEnabledAtSendTap: Boolean = false,
    ): OutboxEntry {
        val controller = Robolectric.buildActivity(android.app.Activity::class.java).create()
        val activity = controller.get()
        val context = activity.applicationContext

        Everframe.start(
            context,
            EverframeConfig(
                appId = "test-app-id",
                sdkKey = "txx_live_test1234567890",
                environment = Environment.production,
            ),
        )
        if (identityEnabledAtSendTap) {
            Everframe.__replayConfigOverrideForTesting = dev.everframe.config.ReplayConfig(
                replayEnabled = false,
                replayDurationSec = 30,
                samplingRate = 1.0,
                identity = dev.everframe.config.IdentityConfigWire(enabled = true),
            )
        }

        val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
        val pngBytes = ByteArrayOutputStream().use { bos ->
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, bos)
            bos.toByteArray()
        }
        val capture = ScreenshotCapture.CaptureResult(
            bitmap = bitmap,
            widthPx = bitmap.width,
            heightPx = bitmap.height,
            pngBytes = pngBytes,
        )
        val shots = listOf(
            SubmittedShot(bitmap = bitmap, annotations = emptyList()),
        )

        // setUser is a no-op while the capture gate is closed, so this has to
        // follow start() — the same ordering every host has to use.
        Everframe.setUser(userAtSendTap)
        identityTokenAtSendTap?.let { Everframe.setIdentityToken(IdentityTokenSource.Token(it)) }
        // THE SEND TAP — user + session epoch + identity subject, atomically
        // (external review, findings 3 then 1; native identity Task 3).
        // Exactly what `show()`'s onSubmit lambda does.
        val capturedSession = Everframe.captureSessionSnapshot()

        // The switch lands here — after the boundary snapshot, before any of
        // submitBaked's work.
        afterCapture(context)

            val testOutbox = testOutbox()
        ReporterDialog.__submitterFactoryForTesting = { cfg, _ ->
            dev.everframe.transport.ReportSubmitter(cfg, testOutbox, uploader = dev.everframe.transport.MultipartUploader(OkHttpClient.Builder()
                .addInterceptor { throw java.io.IOException("offline test") }.build()))
        }
        val resultRef = AtomicReference<ReportResult?>(null)
        CoroutineScope(Dispatchers.IO).launch {
            resultRef.set(
                ReporterDialog.submitBaked(
                    reportCapture = Everframe.__replayFreeze(),
                    activity = activity,
                    capture = capture,
                    shots = shots,
                    title = "Submit-boundary test",
                    description = "d",
                    capturedSession = capturedSession,
                    hostExtra = null,
                    includes = ReporterIncludes(),
                ),
            )
        }

        val deadline = System.currentTimeMillis() + 30_000
        while (resultRef.get() == null && System.currentTimeMillis() < deadline) {
            shadowOf(android.os.Looper.getMainLooper()).idle()
            Thread.sleep(5)
        }
        val result = resultRef.get()
            ?: error("submitBaked did not complete within 30s")
        assertTrue(
            "expected Queued (no ingest server in unit tests), got $result",
            result is ReportResult.Queued,
        )

        val entries = runBlocking { testOutbox.hydrate() }
        assertEquals("expected exactly one queued entry", 1, entries.size)
        return entries.single()
    }
}
