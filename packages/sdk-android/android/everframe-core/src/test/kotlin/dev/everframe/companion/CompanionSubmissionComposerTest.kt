// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Plan 06.2-13 Task 2 — JVM unit tests for `CompanionSubmissionComposer`.
//
// Contract under test:
//   1. `Inputs` carries hostExtra + the include-flag booleans + a baked
//      Bitmap — same field shape as iOS `ReporterSubmission.Inputs`.
//   2. `submit(...)` short-circuits to `ReportResult.Cancelled("no_config")`
//      when `Everframe.start(...)` has never been called (mirrors the iOS
//      `ReporterSubmissionError.notStarted` branch).
//
// What this test deliberately does NOT cover:
//   • Real Bitmap drawing (PixelCopy needs a real Activity surface).
//     Robolectric's default `Bitmap.createBitmap(...)` returns a logical
//     bitmap whose `.compress(PNG, 100, ...)` produces deterministic bytes,
//     which is enough to exercise the SHA-256 + attachment-shape path.
//
// Fix round 1 correction (native identity Task 8b): `ReportSubmitter`
// constructs its OkHttp uploader internally with no injection seam BY
// DEFAULT, but `__submitterFactoryForTesting` (below) exists precisely to
// inject one, and the identity-header tests below use it to reach a real
// MockWebServer request.

package dev.everframe.companion

import dev.everframe.outbox.JceTestOutboxKeyProvider
import dev.everframe.outbox.JvmOutboxFileOps

import android.graphics.Bitmap
import androidx.test.core.app.ApplicationProvider
import dev.everframe.Everframe
import dev.everframe.capture.ResourceRingBuffer
import dev.everframe.capture.replay.ReplaySession
import dev.everframe.capture.sharedResourceBuffer
import dev.everframe.config.ConfigFetcher
import dev.everframe.config.Environment
import dev.everframe.config.TXUser
import dev.everframe.config.ReplayConfigProvider
import dev.everframe.config.ReportResult
import dev.everframe.config.EverframeConfig
import dev.everframe.config.isIdentityEnabled
import dev.everframe.envelope.EnvelopeBuilder
import dev.everframe.identity.IdentityTokenSource
import dev.everframe.outbox.JSONLOutbox
import dev.everframe.outbox.OutboxEntry
import dev.everframe.protocol.generated.VFrame
import dev.everframe.protocol.generated.VNode
import dev.everframe.protocol.generated.VOpAdd
import dev.everframe.protocol.generated.VRect
import dev.everframe.transport.MultipartUploader
import dev.everframe.transport.ReportSubmitter
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
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
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class CompanionSubmissionComposerTest {
    private lateinit var capturedOutbox: JSONLOutbox

    // Defense in depth: even though the two replay tests below reset the
    // override seam in a try/finally, an exception before the finally block
    // (or a future test that forgets the pattern) must not leak Everframe
    // global state (currentConfig / captureGate / the override seam) into
    // later tests in this class — mirrors EverframeTest's kill()-in-tearDown
    // pattern.
    @After
    fun tearDown() {
        CompanionSubmissionComposer.__submitterFactoryForTesting = null
        Everframe.kill()
        sharedResourceBuffer.clear()
    }

    /**
     * Contract 1: Inputs carries all the host-attachment + include-toggle
     * fields the bridge needs to thread.
     */
    @Test
    fun inputs_carryHostAttachmentsAndIncludeToggles() {
        val controller: ActivityController<android.app.Activity> =
            Robolectric.buildActivity(android.app.Activity::class.java).create()
        val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)

        val inputs = CompanionSubmissionComposer.Inputs(
            capture = Everframe.__replayFreeze(),
            activity = controller.get(),
            captureBitmap = bitmap,
            title = "Phone-submitted title",
            description = "Phone-typed description",
            includeLogs = true,
            includeNetwork = false,
            includeMetadata = true,
            extraOverrides = emptyMap(),
            hostExtra = "host-companion-extra",
            companionAttribution = null,
            capturedSession = Everframe.captureSessionSnapshot(),
            excluded = listOf("network"),
        )

        // Smoke — every field round-trips. The bridge constructs Inputs from
        // wire frames; verifying the data class shape keeps the bridge code
        // path compile-checked against future field renames.
        assertEquals("Phone-submitted title", inputs.title)
        assertEquals("host-companion-extra", inputs.hostExtra)
        assertTrue(inputs.includeLogs)
        assertTrue(!inputs.includeNetwork)
        assertEquals(listOf("network"), inputs.excluded)
    }

    /**
     * Contract 2: submit() without a configured Everframe returns
     * `Cancelled("no_config")` — never throws, never NPEs. Mirrors iOS
     * `ReporterSubmissionError.notStarted` recovery.
     */
    @Test
    fun submit_withoutEverframeStart_returnsCancelledNoConfig() = runTest {
        val controller = Robolectric.buildActivity(android.app.Activity::class.java).create()
        val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)

        val inputs = CompanionSubmissionComposer.Inputs(
            capture = Everframe.__replayFreeze(),
            activity = controller.get(),
            captureBitmap = bitmap,
            title = "t",
            description = "d",
            includeLogs = true,
            includeNetwork = true,
            includeMetadata = true,
            hostExtra = null,
            companionAttribution = null,
            capturedSession = Everframe.captureSessionSnapshot(),
        )

        val result = CompanionSubmissionComposer.submit(inputs)
        // Everframe.currentConfig is null in this test (no Everframe.start
        // call) — composer must short-circuit. If a prior test mutated
        // currentConfig the composer would still return a deterministic
        // ReportResult (Queued / Cancelled), never throw — we assert the
        // "no_config" path explicitly since this test owns its activity
        // lifecycle.
        assertTrue(
            "expected Cancelled(no_config), got $result",
            result is ReportResult.Cancelled && (result as ReportResult.Cancelled).reason == "no_config",
        )
    }

    // --- Report Resource Window (spec 2026-09-05) — gap class 3: this is the
    // PRIMARY "user-submitted bug report" build site, not just the crash
    // path. ---

    @Test
    fun `composer stamps payload_resources on a companion-submitted report`() {
        // Pushed from the `afterCapture` seam, i.e. AFTER `start()` — the
        // ring's push is gated on `Everframe.captureGate`, which is closed
        // until then, so a push before the drive is silently a no-op.
        // Timestamped at "now" because snapshot() evicts against the real
        // clock: a fixed historical timestamp would be gone before the
        // composer ever reads it.
        val entry = composeAndCaptureOutboxEntry(afterCapture = {
            sharedResourceBuffer.push(ResourceRingBuffer.Entry(t = System.currentTimeMillis(), cpu = 0.2, mem = 4096L))
        })
        val env = Json.parseToJsonElement(String(entry.envelopeBytes)).jsonObject
        val resources = env["payload"]!!.jsonObject["resources"]!!.jsonArray
        assertEquals(1, resources.size)
        assertEquals(4096.0, resources[0].jsonObject["mem"]!!.jsonPrimitive.double, 0.0)
    }

    /**
     * Contract 4 (smoke): the composer's envelope-build call shape matches
     * `ReporterDialog.kt:325-349`'s inline call shape — assertable by
     * running EnvelopeBuilder directly with the same arguments the composer
     * would feed it and checking the encoded envelope decodes cleanly.
     *
     * This is a parity-floor check, NOT byte-equality (a byte-equality
     * gate would need EnvelopeBuilder to be deterministic on `submittedAt`,
     * which is `Instant.now()` — non-trivial to mock).
     */
    @Test
    fun envelopeBuilder_acceptsComposerCallShape() {
        val builder = EnvelopeBuilder(EnvelopeBuilder.DefaultRedactor)
        val encoded = builder.buildEncoded(
            sdkVersion = "0.0.0-test",
            title = "t",
            description = "d",
            formFactor = "phone",
            logs = emptyList(),
            networkRows = emptyList(),
            appName = "com.example",
            appVersion = "1.0.0",
            appBuild = "1",
            deviceOs = "Android",
            deviceOsVersion = "13",
            deviceModel = "Pixel 7",
            deviceLocale = "en-US",
            deviceTimezone = "UTC",
            deviceScreenWidth = 1080.0,
            deviceScreenHeight = 1920.0,
            devicePixelRatio = 2.0,
            attachments = emptyList(),
            userExtra = "host-companion-extra",
            excluded = listOf("network"),
        )

        assertTrue("envelope must be non-empty", encoded.bytes.isNotEmpty())
        assertTrue("idempotencyKey must be a hex sha256", encoded.idempotencyKey.length == 64)
    }

    @Test
    fun disabledVideoShipsWithoutReplayAttachment() {
        val entry = composeAndCaptureOutboxEntry()
        val names = entry.attachmentRefs.map { it.name }.toSet()
        assertEquals(setOf("screenshot"), names)
    }

    /**
     * External review, finding 3 (Serious) — companion path. `submit()` used
     * to read `Everframe.currentUser` inline, AFTER PNG encoding, device
     * metadata collection, ring-buffer snapshotting and replay serialization.
     * Those stages run for hundreds of milliseconds to seconds after the phone
     * tapped Send, so a `setUser` landing in that window (sign-out/sign-in,
     * account switch) permanently regrouped A's report under B. The fix pins
     * the user to `Inputs.capturedSession`, snapshotted by the caller when the
     * paired submit frames arrived.
     *
     * The switch here happens after `Inputs` is built and before `submit()` is
     * even launched, which is strictly stronger than a mid-composition swap:
     * ANY live read anywhere inside `submit()` would return bob.
     */
    @Test
    fun `envelope carries the user captured at the submit boundary, not a later account switch`() {
        val entry = composeAndCaptureOutboxEntry(
            userAtSubmitBoundary = TXUser(id = "alice", email = "alice@x.com", displayName = "Alice"),
            afterCapture = { Everframe.setUser(TXUser(id = "bob", email = "bob@x.com")) },
        )

        // Not vacuous: the live singleton really did switch to bob.
        assertEquals("bob", Everframe.currentUser?.id)

        val reporter = Json.parseToJsonElement(String(entry.envelopeBytes))
            .jsonObject["reporter"]!!.jsonObject
        val user = reporter["user"]!!.jsonObject
        assertEquals("alice", user["id"]!!.jsonPrimitive.content)
        assertEquals("alice@x.com", user["email"]!!.jsonPrimitive.content)
        assertEquals("Alice", user["displayName"]!!.jsonPrimitive.content)
    }

    /**
     * External review, finding 1 (Serious) — companion path. The submit-boundary
     * snapshot above fixed WHO, but not WHERE: `submit()` reads
     * `Everframe.currentConfig` — which carries the SDK key, i.e. the project the
     * envelope is uploaded to — long after the capture. A `start(projectB)` in
     * that window left the snapshot perfectly intact (`start()` clears the LIVE
     * user, not one already captured), so alice was uploaded under project B's
     * key: a falsely attributed person in a DIFFERENT customer's project.
     *
     * The snapshot now carries the session epoch it was taken in and
     * `resolve()` discards it once a superseding `start()`/`kill()` has run —
     * the report still ships, anonymously. Losing attribution always beats
     * attributing to the wrong project.
     */
    @Test
    fun `a captured user is dropped when another project is configured before composition`() {
        val entry = composeAndCaptureOutboxEntry(
            userAtSubmitBoundary = TXUser(id = "alice", email = "alice@x.com", displayName = "Alice"),
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

        // Not vacuous: the envelope really was composed under project B's
        // configuration — this is the upload that would have carried alice.
        assertEquals("txx_live_projectB098765432", Everframe.currentConfig?.sdkKey)

        val reporter = Json.parseToJsonElement(String(entry.envelopeBytes)).jsonObject["reporter"]!!.jsonObject
        assertNull(
            "project A's user must never be uploaded under project B's SDK key",
            reporter["user"],
        )
    }

    /**
     * FOLLOW-UPS ITEM 9, FIFTH ROUND (external review 2026-08-13, codex).
     *
     * A `kill()` landing DURING assembly must stop the upload. The check at
     * the top of `submit()` cannot do that — PNG encoding, device metadata,
     * ring-buffer snapshotting and replay serialization all run after it — so
     * the authoritative one sits immediately before `submitter.submit(...)`.
     * Earlier rounds had only the early check while the comment claimed "the
     * submit boundary"; that comment described iOS's placement, not this one.
     *
     * Driven through `__submitterFactoryForTesting`, which the composer
     * invokes AT that boundary: killing inside the factory lambda puts the
     * revocation exactly in the window the early check has already passed.
     * Nothing else in this suite can reach that window.
     *
     * `ReportSubmitter`'s own `captureGate` read cannot cover this either —
     * it is a boolean and `start()` re-opens it, which is why the restart is
     * part of the scenario rather than a bare `kill()`.
     */
    @Test
    fun `a kill during assembly stops the upload even after a restart`() {
        var factoryRan = false
        // Grabbed on the test thread: the factory lambda below runs on
        // Dispatchers.IO, and building a Robolectric Activity off the main
        // thread does not work.
        val appContext = ApplicationProvider.getApplicationContext<android.content.Context>()
        CompanionSubmissionComposer.__submitterFactoryForTesting = { cfg, outbox ->
            factoryRan = true
            // The revocation lands HERE — past the early fast-path check,
            // immediately before the upload. The restart re-opens captureGate,
            // so only the monotonic counter behind isRevoked can still see it.
            Everframe.kill()
            Everframe.start(appContext, project("app_b", "sk_b"))
            // A REAL submitter: if the late check were missing, this would run,
            // fail to reach any ingest server, classify as retryable and return
            // Queued. `Cancelled("revoked")` is therefore the discriminator —
            // no spy or subclass needed (ReportSubmitter is final).
            ReportSubmitter(cfg, outbox)
        }

        val result = composeAndReturnResult(userAtSubmitBoundary = TXUser(id = "alice"))

        assertTrue("the factory must have run — otherwise this asserts nothing", factoryRan)
        assertTrue("precondition: start() re-opened the gate", Everframe.captureGate)
        assertEquals(ReportResult.Cancelled("revoked"), result)
    }

    /**
     * Follow-ups item 9 — the half the case above could not reach.
     *
     * Dropping the user was never the whole exposure. `submit()` read
     * `Everframe.currentConfig` long after the capture, so the same
     * `start(projectB)` that made `resolve()` correctly return null ALSO
     * repointed the upload: the envelope went to project B carrying project
     * A's screenshot, UI tree, breadcrumbs and network rows. Anonymously,
     * which is not a mitigation — the payload is the disclosure.
     *
     * Asserted on the enqueued entry's `sdkKey`, the field the drain actually
     * submits under (register item 1's key binding).
     */
    @Test
    fun `a companion report is enqueued under the project it was captured in`() {
        val entry = composeAndCaptureOutboxEntry(
            userAtSubmitBoundary = TXUser(id = "alice", email = "alice@x.com", displayName = "Alice"),
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

        // Not vacuous: project B really is the live session.
        assertEquals(
            "precondition: project B must be live",
            "txx_live_projectB098765432",
            Everframe.currentConfig?.sdkKey,
        )
        assertEquals(
            "the companion report must ship under the key of the project it was captured in",
            "txx_live_test1234567890",
            entry.sdkKey,
        )
    }

    // ---- Identity subject at the submit boundary (native identity Task 8b) ----

    /**
     * Native identity Task 8b — the companion path's half of the live-submit
     * wiring. `Inputs.capturedSession.user.identitySubject` must reach the
     * queued `OutboxEntry` exactly like the self-declared user does above, so
     * a later drain can attribute the report — the entry-level evidence for
     * this call site, mirroring `ReporterDialogSubmitBoundaryTest`'s
     * identical case for the in-process reporter's own live path.
     */
    @Test
    fun `a queued entry carries the identity subject captured at the submit boundary`() {
        val entry = composeAndCaptureOutboxEntry(
            identityTokenAtSubmitBoundary = jwt(sub = "alice", expMs = System.currentTimeMillis() + 300_000),
            identityEnabledAtSubmitBoundary = true,
        )
        assertEquals(
            "the subject captured at the submit boundary must reach the queued entry",
            "alice",
            entry.identitySubject,
        )
    }

    /**
     * Independent review, P1 — the live path's epoch check already
     * withholds `identityToken` on a mismatch (Serious 1), but used to
     * still persist the RAW captured `identitySubject` onto the queued
     * `OutboxEntry` unconditionally — inconsistent with
     * `capturedSession.user.resolve()`, which already drops the
     * self-declared user on the identical mismatch (see
     * `a captured user is dropped when another project is configured
     * before composition` above). A later drain could then attach a header
     * on the strength of a subject the SDK had already concluded it should
     * not rely on.
     *
     * Full pipeline, both halves required by the finding: (1) a live
     * submit whose epoch changes mid-flight enqueues an entry with a NULL
     * subject, and (2) that exact entry then drains WITHOUT a header even
     * when a live token's `sub` would have matched. Mutation-verified:
     * reverting the `epochStillCurrent` gate on `identitySubject` in
     * `CompanionSubmissionComposer.kt` makes part (1) fail (subject
     * un-nulled); reverting `resolveIdentityHeader`'s own `capturedSubject
     * == null` guard would make part (2) fail (not touched by this fix —
     * that guard already exists and is covered by
     * `IdentitySubjectGateTest.withholds for a report captured
     * anonymously`; this test proves the PIPELINE actually reaches it).
     *
     * Merge note (native-identity x captured-session, follow-ups item 9):
     * this originally asserted the entry shipped under project B's key —
     * true before `submit()` routed by the CAPTURED config. Now that
     * `inputs.capturedSession.config` (not a live re-read) decides `cfg`,
     * the switch to project B changes the EPOCH (nulling the subject, still
     * this test's point) but no longer the DESTINATION — the entry ships
     * under the project it was captured in, exactly like `a companion
     * report is enqueued under the project it was captured in` above.
     * Updated to assert that, and Part 2 now drains against the CAPTURED
     * project's config to match what the entry actually carries.
     */
    @Test
    fun `a queued entry carries no identity subject when another project starts before composition, and drains without a header even though a live token would match`() {
        // Part 1: the race — capture under project A, switch to project B
        // (also identity-enabled, ALSO alice) before submit() reads cfg.
        val entry = composeAndCaptureOutboxEntry(
            identityTokenAtSubmitBoundary = jwt(sub = "alice", expMs = System.currentTimeMillis() + 300_000),
            identityEnabledAtSubmitBoundary = true,
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
        // project's key (project A, "test-app-id" — see
        // composeAndCaptureResultInternal) — routing by the captured
        // config means the live switch to project B changes neither this
        // nor the drain destination, only the epoch the subject is judged
        // against.
        assertEquals("txx_live_test1234567890", entry.sdkKey)
        assertNull(
            "an epoch mismatch must null the PERSISTED subject too, not just the live identityToken",
            entry.identitySubject,
        )

        // Part 2: drain this EXACT entry (same envelope bytes, same null
        // identitySubject — only the endpoint is redirected to a server
        // this test controls; drainOutbox deliberately ignores
        // ReportSubmitter's own endpointOverride and always uses the
        // entry's OWN endpoint/sdkKey — see OutboxKeyBindingTest) for real,
        // against a live holder whose token's sub is ALSO "alice" and
        // identity-enabled for the CAPTURED project (entry.sdkKey) — if
        // anything besides the persisted null subject were doing the work,
        // this is the setup that would reveal it.
        val server = MockWebServer()
        server.start()
        try {
            server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
            val redirectedEntry = entry.copy(endpoint = server.url("/api/ingest").toString())
            val drainOutboxFile = java.io.File.createTempFile("p1-drain-test", ".jsonl")
            try {
                val drainOutbox = JSONLOutbox(drainOutboxFile, keys = JceTestOutboxKeyProvider(), ops = JvmOutboxFileOps())
                runBlocking { drainOutbox.enqueue(redirectedEntry) }

                val holder = dev.everframe.identity.IdentityTokenHolder()
                holder.set(IdentityTokenSource.Token(jwt(sub = "alice", expMs = System.currentTimeMillis() + 300_000)))
                val drainSubmitter = ReportSubmitter(
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
     * Fix round 1 finding (Important 2). The `identitySubject`-on-the-entry
     * test above cannot catch `identityToken` being dropped at the
     * `submitter.submit(...)` call site (`CompanionSubmissionComposer.kt:519`):
     * `identityToken` is deliberately NEVER persisted onto `OutboxEntry` (only
     * `identitySubject` is — the token is short-lived and must not be
     * written to durable storage), so a mutation that resolves the token
     * correctly and then throws it away before `submit(...)` is invisible at
     * the entry level. Verified by mutating `identityToken = null` at that
     * call site and confirming this test fails, then reverting.
     *
     * Reaches a REAL `MockWebServer` request — `__submitterFactoryForTesting`
     * (below) injects a `ReportSubmitter` pointed at it, bypassing
     * `IngestEndpoint`'s real (unreachable-in-tests) URL entirely. Getting
     * `resolveIdentityHeader` to actually resolve a non-null token needs
     * `Everframe.currentReplayConfig()` to be identity-enabled, which needs a
     * real (stubbed) config fetch — `Everframe.start()`'s own replay-session
     * install is blocked via `__startTailDelayHookForTesting` so it cannot
     * race the one this test installs directly.
     */
    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun `submit attaches the resolved identity token to the real HTTP request`() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        val server = MockWebServer()
        server.start()
        Everframe.__startTailDelayHookForTesting = { Thread.sleep(5_000) }
        try {
            val controller: ActivityController<android.app.Activity> =
                Robolectric.buildActivity(android.app.Activity::class.java).create()
            val activity = controller.get()
            val context = activity.applicationContext

            Everframe.start(
                context,
                EverframeConfig(appId = "test-app-id", sdkKey = "txx_live_test1234567890", environment = Environment.production),
            )

            // Stand in for "the ReplaySession's initial config fetch already
            // completed" — identity-enabled immediately, refreshed
            // synchronously before installation.
            val fetcher = ConfigFetcher {
                val req = Request.Builder().url("https://x/api/config").build()
                Response.Builder()
                    .request(req)
                    .protocol(Protocol.HTTP_1_1)
                    .code(200)
                    .message("OK")
                    .body(
                        """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
                        "identity":{"enabled":true}}"""
                            .toResponseBody("application/json".toMediaType()),
                    )
                    .build()
            }
            val provider = ReplayConfigProvider(configUrl = "https://x/api/config", apiKey = "k", fetcher = fetcher)
            val session = ReplaySession(apiKey = "k", locallyDisabled = false, provider = provider)
            runBlocking { session.refreshConfigNow() }
            Everframe._replaySession = session
            assertTrue(
                "fixture sanity: currentReplayConfig() must reflect the settled fetch",
                isIdentityEnabled(Everframe.currentReplayConfig()),
            )

            val token = jwt(sub = "alice", expMs = System.currentTimeMillis() + 300_000)
            Everframe.setIdentityToken(IdentityTokenSource.Token(token))
            val capturedSession = Everframe.captureSessionSnapshot()
            assertEquals("fixture sanity: the subject must be captured", "alice", capturedSession.user.identitySubject)

            val client = OkHttpClient.Builder()
                .connectTimeout(2, TimeUnit.SECONDS).readTimeout(2, TimeUnit.SECONDS).writeTimeout(2, TimeUnit.SECONDS)
                .build()
            CompanionSubmissionComposer.__submitterFactoryForTesting = { cfg, outbox ->
                ReportSubmitter(
                    config = cfg, outbox = outbox,
                    uploader = MultipartUploader(client),
                    endpointOverride = server.url("/").toString(),
                )
            }
            try {
                server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
                val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
                val inputs = CompanionSubmissionComposer.Inputs(
            capture = Everframe.__replayFreeze(),
                    activity = activity,
                    captureBitmap = bitmap,
                    title = "t",
                    description = "d",
                    includeLogs = false,
                    includeNetwork = false,
                    includeMetadata = false,
                    hostExtra = null,
                    companionAttribution = null,
                    capturedSession = capturedSession,
                )
                val result = runBlocking { CompanionSubmissionComposer.submit(inputs) }
                assertTrue("expected Submitted, got $result", result is ReportResult.Submitted)
            } finally {
                CompanionSubmissionComposer.__submitterFactoryForTesting = null
            }

            val request = server.takeRequest(10, TimeUnit.SECONDS)
            assertNotNull("MockWebServer never received the submit request", request)
            assertEquals(
                "the real HTTP request must carry alice's identity token",
                token,
                request!!.getHeader("X-TX-Identity-Token"),
            )
        } finally {
            Everframe.__resetStartTailDelayHookForTesting()
            Everframe.setIdentityToken(null)
            server.shutdown()
            Dispatchers.resetMain()
        }
    }

    /**
     * Final whole-branch review, Important 2 (companion path). The test
     * above proves the ordinary same-session case attaches the header; this
     * proves the header is withheld when a `start(projectB)` lands between
     * the submit-boundary capture and the actual submit — even though
     * project B's live token happens to carry the SAME `sub` as the entry
     * was captured under (plausible: `sub` is the host's own user id,
     * typically unchanged across a tenant or dev/prod switch). Without the
     * `capturedEpoch` check this composer now threads through
     * `Everframe.__resolveIdentityToken`, a subject match alone would let
     * project B's live bearer credential ship on a report that otherwise
     * still belongs to project A. Mutation-verified: reverting
     * `CompanionSubmissionComposer.kt`'s call back to a direct
     * `resolveIdentityHeader(...)` (dropping the epoch argument) makes this
     * test fail.
     */
    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun `submit withholds the identity token when another project starts after the capture boundary`() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        val server = MockWebServer()
        server.start()
        Everframe.__startTailDelayHookForTesting = { Thread.sleep(5_000) }
        try {
            val controller: ActivityController<android.app.Activity> =
                Robolectric.buildActivity(android.app.Activity::class.java).create()
            val activity = controller.get()
            val context = activity.applicationContext

            fun identityEnabledFetcher() = ConfigFetcher {
                val req = Request.Builder().url("https://x/api/config").build()
                Response.Builder()
                    .request(req)
                    .protocol(Protocol.HTTP_1_1)
                    .code(200)
                    .message("OK")
                    .body(
                        """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
                        "identity":{"enabled":true}}"""
                            .toResponseBody("application/json".toMediaType()),
                    )
                    .build()
            }
            fun installIdentityEnabledSession(apiKey: String) {
                val provider = ReplayConfigProvider(
                    configUrl = "https://x/api/config", apiKey = apiKey, fetcher = identityEnabledFetcher(),
                )
                val session = ReplaySession(apiKey = apiKey, locallyDisabled = false, provider = provider)
                runBlocking { session.refreshConfigNow() }
                Everframe._replaySession = session
            }

            // Project A — the report is captured here.
            Everframe.start(
                context,
                EverframeConfig(appId = "test-app-id", sdkKey = "txx_live_projectA123456789", environment = Environment.production),
            )
            installIdentityEnabledSession("project-a-key")
            assertTrue(
                "fixture sanity: currentReplayConfig() must reflect project A's settled fetch",
                isIdentityEnabled(Everframe.currentReplayConfig()),
            )
            val aliceTokenA = jwt(sub = "alice", expMs = System.currentTimeMillis() + 300_000)
            Everframe.setIdentityToken(IdentityTokenSource.Token(aliceTokenA))
            val capturedSession = Everframe.captureSessionSnapshot()
            assertEquals("fixture sanity: the subject must be captured", "alice", capturedSession.user.identitySubject)

            // The switch — lands AFTER the submit-boundary capture, before
            // submit() runs. The host immediately re-authenticates against
            // project B, and alice happens to be signed in there too (same
            // person, different tenant).
            Everframe.start(
                context,
                EverframeConfig(appId = "other-app-id", sdkKey = "txx_live_projectB098765432", environment = Environment.production),
            )
            installIdentityEnabledSession("project-b-key")
            val aliceTokenB = jwt(sub = "alice", expMs = System.currentTimeMillis() + 300_000)
            Everframe.setIdentityToken(IdentityTokenSource.Token(aliceTokenB))
            assertTrue(
                "fixture sanity: currentReplayConfig() must reflect project B's settled fetch",
                isIdentityEnabled(Everframe.currentReplayConfig()),
            )
            // Not vacuous: project B's live token really would resolve for
            // ITS OWN captures — the epoch check, not identity being
            // disabled or the subject mismatching, is what must withhold it
            // here.
            assertEquals(
                "fixture sanity: project B's live token must actually be presentable",
                "alice",
                Everframe.captureSessionSnapshot().user.identitySubject,
            )

            val client = OkHttpClient.Builder()
                .connectTimeout(2, TimeUnit.SECONDS).readTimeout(2, TimeUnit.SECONDS).writeTimeout(2, TimeUnit.SECONDS)
                .build()
            CompanionSubmissionComposer.__submitterFactoryForTesting = { cfg, outbox ->
                ReportSubmitter(
                    config = cfg, outbox = outbox,
                    uploader = MultipartUploader(client),
                    endpointOverride = server.url("/").toString(),
                )
            }
            try {
                server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
                val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
                val inputs = CompanionSubmissionComposer.Inputs(
            capture = Everframe.__replayFreeze(),
                    activity = activity,
                    captureBitmap = bitmap,
                    title = "t",
                    description = "d",
                    includeLogs = false,
                    includeNetwork = false,
                    includeMetadata = false,
                    hostExtra = null,
                    companionAttribution = null,
                    // THE ORIGINAL capture — project A's epoch, from before
                    // the switch above.
                    capturedSession = capturedSession,
                )
                val result = runBlocking { CompanionSubmissionComposer.submit(inputs) }
                assertTrue("expected Submitted, got $result", result is ReportResult.Submitted)
            } finally {
                CompanionSubmissionComposer.__submitterFactoryForTesting = null
            }

            val request = server.takeRequest(10, TimeUnit.SECONDS)
            assertNotNull("MockWebServer never received the submit request", request)
            assertNull(
                "project B's live token must never drain onto a report captured under project A's session, even though the subject matches",
                request!!.getHeader("X-TX-Identity-Token"),
            )
        } finally {
            Everframe.__resetStartTailDelayHookForTesting()
            Everframe.setIdentityToken(null)
            server.shutdown()
            Dispatchers.resetMain()
        }
    }

    /**
     * Drives one full `CompanionSubmissionComposer.submit(...)` call and
     * returns the single `OutboxEntry` it queues. `submit()` marshals the
     * replay read onto `Dispatchers.Main` (Task 6 step 4); under Robolectric's
     * PAUSED LooperMode a posted Handler runnable never runs on its own
     * (same reasoning as `CompanionFreezeLifecycleTest`'s `idle()` calls), so
     * `submit()` must run on a dispatcher OTHER than this test's thread while
     * this thread repeatedly drains the main looper — running it inline via
     * `runBlocking` on this thread would deadlock (this thread would be
     * parked awaiting the very post it needs to drain).
     */
    /**
     * Same drive as [composeAndCaptureOutboxEntry] but returns the
     * [ReportResult] instead of an outbox entry — for cases where the point is
     * that NOTHING was enqueued.
     */
    private fun composeAndReturnResult(
        userAtSubmitBoundary: TXUser? = null,
        afterCapture: (android.content.Context) -> Unit = {},
    ): ReportResult = composeAndCaptureResultInternal(userAtSubmitBoundary, afterCapture)

    private fun composeAndCaptureOutboxEntry(
        userAtSubmitBoundary: TXUser? = null,
        afterCapture: (android.content.Context) -> Unit = {},
        /** Native identity Task 8b: installed via `setIdentityToken` after
         *  `start()`, BEFORE the submit-boundary `captureSessionSnapshot()`
         *  below. `null` (default) leaves identity untouched. */
        identityTokenAtSubmitBoundary: String? = null,
        /** Independent review, round 4 (Serious 3) — `captureUserSnapshot()`/
         *  `captureSessionSnapshot()` also gate the stamp on
         *  `isIdentityEnabled(currentReplayConfig())`. `false` (default,
         *  matches production before any config fetch) — callers that want a
         *  subject actually captured must opt in. */
        identityEnabledAtSubmitBoundary: Boolean = false,
    ): OutboxEntry {
        val result = composeAndCaptureResultInternal(
            userAtSubmitBoundary,
            afterCapture,
            identityTokenAtSubmitBoundary,
            identityEnabledAtSubmitBoundary,
        )
        assertTrue(
            "expected Queued (no ingest server in unit tests), got $result",
            result is ReportResult.Queued,
        )
        val entries = runBlocking { capturedOutbox.hydrate() }
        assertEquals("expected exactly one queued entry", 1, entries.size)
        return entries.single()
    }

    /** App context for helpers that need one outside a drive. */
    private fun context(): android.content.Context =
        Robolectric.buildActivity(android.app.Activity::class.java).create().get().applicationContext

    private fun project(appId: String, sdkKey: String) = EverframeConfig(
        appId = appId, sdkKey = sdkKey, environment = Environment.production,
    )

    private fun composeAndCaptureResultInternal(
        /** Installed via `setUser` after `start()` and snapshotted below with
         *  `captureSessionSnapshot()` — i.e. captured exactly the way the RN
         *  bridge's `__submitProvider` captures it at the real submit
         *  boundary, epoch and all. */
        userAtSubmitBoundary: TXUser? = null,
        /** Runs AFTER the boundary snapshot and BEFORE `submit()` is launched —
         *  the seam the submit-boundary tests use to switch accounts, or to
         *  reconfigure onto a different project, mid-flight. Handed the app
         *  context so it can call `Everframe.start(...)`. */
        afterCapture: (android.content.Context) -> Unit = {},
        /** Native identity Task 8b: installed via `setIdentityToken` after
         *  `start()`, BEFORE the submit-boundary `captureSessionSnapshot()`
         *  below. `null` (default) leaves identity untouched. */
        identityTokenAtSubmitBoundary: String? = null,
        /** Independent review, round 4 (Serious 3) — `captureUserSnapshot()`/
         *  `captureSessionSnapshot()` also gate the stamp on
         *  `isIdentityEnabled(currentReplayConfig())`. `false` (default,
         *  matches production before any config fetch) — callers that want a
         *  subject actually captured must opt in. */
        identityEnabledAtSubmitBoundary: Boolean = false,
    ): ReportResult {
        val controller: ActivityController<android.app.Activity> =
            Robolectric.buildActivity(android.app.Activity::class.java).create()
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
        if (identityEnabledAtSubmitBoundary) {
            Everframe.__replayConfigOverrideForTesting = dev.everframe.config.ReplayConfig(
                replayEnabled = false,
                replayDurationSec = 30,
                samplingRate = 1.0,
                identity = dev.everframe.config.IdentityConfigWire(enabled = true),
            )
        }

        // setUser is a no-op while the capture gate is closed, so this has to
        // follow start() — the same ordering every host has to use.
        Everframe.setUser(userAtSubmitBoundary)
        identityTokenAtSubmitBoundary?.let {
            Everframe.setIdentityToken(dev.everframe.identity.IdentityTokenSource.Token(it))
        }

        val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
        val inputs = CompanionSubmissionComposer.Inputs(
            capture = Everframe.__replayFreeze(),
            activity = activity,
            captureBitmap = bitmap,
            title = "Replay-attachment test",
            description = "d",
            includeLogs = false,
            includeNetwork = false,
            includeMetadata = false,
            hostExtra = null,
            companionAttribution = null,
            // THE SUBMIT BOUNDARY — user + session epoch + identity subject,
            // atomically.
            capturedSession = Everframe.captureSessionSnapshot(),
        )
        afterCapture(context)

        capturedOutbox = JSONLOutbox(java.io.File(java.nio.file.Files.createTempDirectory("composer-outbox").toFile(), "outbox.jsonl"),
            keys = JceTestOutboxKeyProvider(), ops = JvmOutboxFileOps())
        if (CompanionSubmissionComposer.__submitterFactoryForTesting == null) CompanionSubmissionComposer.__submitterFactoryForTesting = { cfg, _ ->
            ReportSubmitter(cfg, capturedOutbox, uploader = dev.everframe.transport.MultipartUploader(OkHttpClient.Builder()
                .addInterceptor { throw java.io.IOException("offline test") }.build()))
        }
        val resultRef = AtomicReference<ReportResult?>(null)
        CoroutineScope(Dispatchers.IO).launch {
            resultRef.set(CompanionSubmissionComposer.submit(inputs))
        }
        // The unit-test environment has no ingest server: the isolated
        // OkHttpClient's connect to the debug-variant INGEST_URL
        // (http://10.0.2.2:8787) doesn't fail instantly — it runs the full
        // 10s connectTimeout (ReportSubmitter.buildIsolatedClient) before
        // OkHttp surfaces a SocketTimeoutException, which RetryPolicy then
        // classifies as retryable and enqueues to the outbox. Budget past
        // that, not just past a fast-refusal assumption.
        val deadline = System.currentTimeMillis() + 20_000
        while (resultRef.get() == null && System.currentTimeMillis() < deadline) {
            shadowOf(android.os.Looper.getMainLooper()).idle()
            Thread.sleep(5)
        }
        return resultRef.get()
            ?: error("composeAndCaptureResultInternal: submit() did not complete within 20s")
    }

}
