// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// DEBUG-ONLY unit test source set. This test assigns `EndpointOverride.current`,
// which is a `val` in the release variant, so it cannot compile there — the
// type system enforcing the variant split rather than fighting it.
//
// Split out of CrashReporterTest when the endpoint seam was added: every other
// case in that class is variant-agnostic and stays in src/test.
package com.traceitx.crash

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.traceitx.TraceItX
import com.traceitx.capture.replay.ReplaySession
import com.traceitx.config.ConfigFetcher
import com.traceitx.config.EndpointOverride
import com.traceitx.config.IdentityConfigWire
import com.traceitx.config.ReplayConfig
import com.traceitx.config.ReplayConfigProvider
import com.traceitx.config.TraceItXConfig
import com.traceitx.config.isIdentityEnabled
import com.traceitx.identity.IdentityTokenHolder
import com.traceitx.identity.IdentityTokenSource
import com.traceitx.outbox.CrashSidecar
import com.traceitx.outbox.JSONLOutbox
import com.traceitx.shared.SharedData
import com.traceitx.testing.takeRequestOrFail
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.Job
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class CrashDeliveryTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val config = TraceItXConfig(appId = "app", sdkKey = "sk")
    private lateinit var server: MockWebServer
    private lateinit var crashOutbox: JSONLOutbox
    private lateinit var crashDir: File
    private lateinit var crashKeys: com.traceitx.outbox.JceTestOutboxKeyProvider
    private val crashOps = com.traceitx.outbox.JvmOutboxFileOps()

    @Before
    fun setUp() {
        server = MockWebServer().apply { dispatcher = object : okhttp3.mockwebserver.QueueDispatcher() {
            override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): MockResponse =
                if (request.path?.startsWith("/api/config") == true) MockResponse().setResponseCode(200).setBody(
                    """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,"identity":{"enabled":true}}""")
                else super.dispatch(request)
        } }
        server.start()
        // Stamp-time redirect. drainOutbox() routes by the entry's OWN endpoint
        // (ReportSubmitter.kt:201) and deliberately ignores endpointOverride —
        // OutboxKeyBindingTest guards that — so the only way to reach this mock
        // is for CrashReporter to stamp it at capture time.
        EndpointOverride.current = server.url("/api/ingest").toString()
        SharedData.init(context)
        TraceItX.captureGate = true
        CrashReporter.__resetForTesting()
        crashDir = kotlin.io.path.createTempDirectory("crash-delivery").toFile()
        crashKeys = com.traceitx.outbox.JceTestOutboxKeyProvider()
        crashOutbox = JSONLOutbox(File(crashDir, "outbox.jsonl"), crashKeys, crashOps)
        CrashReporter.sidecarFactory = { CrashSidecar(File(crashDir, "crash-outbox.jsonl"), crashKeys, crashOps) }
        sidecarFile().delete()
        CrashReporter.configure(context)
        // The crash path takes its config from the crash-entry snapshot now, so
        // it must be installed on TraceItX; `__setConfigForTesting` does that
        // under `stateLock` without start()'s heavy-init tail.
        TraceItX.__setConfigForTesting(config)
    }

    @After
    fun tearDown() {
        CrashReporter.__resetForTesting()
        TraceItX.__setConfigForTesting(null)   // process-global; leaks across suites
        EndpointOverride.current = null   // process-global; leaks across suites
        TraceItX.captureGate = false
        TraceItX::class.java.getDeclaredField("sharedOutbox").apply { isAccessible = true }.set(null, null)
        server.shutdown()
    }

    private fun reportRequest(): okhttp3.mockwebserver.RecordedRequest {
        val first = server.takeRequestOrFail()
        return if (first.path?.startsWith("/api/config") == true) server.takeRequestOrFail() else first
    }

    private fun sidecarFile() = File(File(context.cacheDir, "com.traceitx"), "crash-outbox.jsonl")

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

    @Test
    fun `crash then relaunch delivers the report (definition of done)`() = runBlocking {
        // 1. "Crash": handler persists synchronously.
        CrashReporter.captureThrowable(Thread.currentThread(), RuntimeException("fatal boom"))
        assertEquals(1, kotlinx.coroutines.runBlocking { crashOutbox.count() })

        // 2. "Relaunch": hydrate into the real outbox path, then drain. No
        // identity token was ever set on this run, so a fresh holder + OFF is
        // the honest fixture here — see the identity-attributed case below
        // for the header assertion.
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        val outbox = JSONLOutbox(File(crashDir, "outbox.jsonl"), crashKeys, crashOps)
        CrashSidecar(context).hydrateInto(outbox)
        com.traceitx.transport.ReportSubmitter(config, outbox).drainOutbox(
            identityHolder = IdentityTokenHolder(),
            currentReplayConfig = { ReplayConfig.OFF },
            epochAtInitiation = 0,
            currentEpoch = { 0 },
        )

        val request = reportRequest()
        assertTrue(String(request.body.readByteArray()).contains("\"source\":\"crash\""))
        assertEquals(0, outbox.count())
    }

    /**
     * Native identity Task 8b — the crash-path half of the wiring gap: a
     * crash captures a `TXCapturedUser` (which carries `identitySubject`,
     * snapshotted atomically with the crash) but used to build its
     * `OutboxEntry` directly WITHOUT threading that subject through, so a
     * crash could never be attributed however identity was configured.
     * `CrashReporter.kt`'s entry-building now passes
     * `captured.user.identitySubject` into the entry; this proves it actually
     * reaches the wire end-to-end: crash while a matching identity token is
     * installed, relaunch, drain with the SAME token live, and see the real
     * MockWebServer request carry `X-TX-Identity-Token`.
     */
    @Test
    fun `a crash captured while alice is signed in is attributed to alice on relaunch drain`() = runBlocking {
        val now = System.currentTimeMillis()
        val token = jwt(sub = "alice", expMs = now + 300_000)
        TraceItX.setIdentityToken(IdentityTokenSource.Token(token))
        // Independent review, round 4 (Serious 3) — captureUserSnapshot()
        // now also gates the stamp on isIdentityEnabled(currentReplayConfig()).
        // This test's own point is that the subject reaches the wire once
        // captured; arm identity as enabled at capture time the same way a
        // live project with a signing secret would resolve it.
        TraceItX.__replayConfigOverrideForTesting = ReplayConfig(
            replayEnabled = false,
            replayDurationSec = 30,
            samplingRate = 1.0,
            identity = IdentityConfigWire(enabled = true),
        )
        try {
            // 1. "Crash": handler persists synchronously, snapshotting the
            // identity subject atomically with the crash (captureUserSnapshot).
            CrashReporter.captureThrowable(Thread.currentThread(), RuntimeException("fatal boom"))
            assertEquals(1, kotlinx.coroutines.runBlocking { crashOutbox.count() })

            // 2. "Relaunch": hydrate + drain with a HAND-BUILT holder/config
            // fixture that matches what a live drain call sees once identity
            // is live and enabled for the project. This is deliberately NOT
            // `TraceItX.requestOutboxDrain()` or `TraceItX._identityHolder` /
            // `TraceItX.currentReplayConfig()` — it is `ReportSubmitter
            // .drainOutbox` exercised directly with fixture values that
            // MIRROR what those real accessors would resolve to on the
            // ONE drain call site that can actually observe them live: see
            // `a non-fatal crash relaunch-drains through requestOutboxDrain
            // once identity and config have genuinely settled` below, which
            // drives the REAL production call (`TraceItX.requestOutboxDrain()`
            // reading the REAL `_identityHolder`/`currentReplayConfig()`).
            // The OTHER production drain call site — `TraceItX.start()`'s
            // launch drain — can NEVER attach a header, by construction: see
            // that test's header comment for why.
            server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
            val outbox = JSONLOutbox(File(crashDir, "outbox.jsonl"), crashKeys, crashOps)
            CrashSidecar(context).hydrateInto(outbox)
            val holder = IdentityTokenHolder()
            holder.set(IdentityTokenSource.Token(token))
            com.traceitx.transport.ReportSubmitter(config, outbox).drainOutbox(
                identityHolder = holder,
                currentReplayConfig = {
                    ReplayConfig(
                        replayEnabled = true,
                        replayDurationSec = 30,
                        samplingRate = 1.0,
                        identity = IdentityConfigWire(enabled = true),
                    )
                },
                epochAtInitiation = 0,
                currentEpoch = { 0 },
            )

            val request = reportRequest()
            assertEquals(
                "the crash report must carry alice's identity token on the wire",
                token,
                request.getHeader("X-TX-Identity-Token"),
            )
            assertEquals(0, outbox.count())
        } finally {
            TraceItX.setIdentityToken(null)
            TraceItX.__replayConfigOverrideForTesting = null
        }
    }

    /**
     * Fix round 1 finding (Important 1) — of the platform's TWO production
     * drain call sites, `TraceItX.start()`'s launch drain runs too early to
     * EVER attach a header: `start()` clears `_identityHolder` synchronously
     * moments before the launch drain reads it, and `currentReplayConfig()`
     * resolves `ReplayConfig.OFF` because the `ReplaySession` that would fetch
     * a real one is installed LATER in that same async tail
     * (`start.replay` runs after `start.drainOutbox`). That is fail-closed and
     * safe, not a leak — but it means the launch drain can never be the retry
     * path that recovers "Alice queues offline, Bob signs in, the retry
     * fires": that report ships unattributed forever and is then deleted on
     * 200.
     *
     * `TraceItX.requestOutboxDrain()` — the RN non-fatal path's explicit,
     * caller-invoked drain — is the OTHER call site, and it does NOT share
     * either limitation: it can run arbitrarily long after `start()`
     * (whenever the host's JS bridge catches a non-fatal error and asks for a
     * flush), by which point `_replaySession` has had a real chance to fetch,
     * and the host has had a real chance to call `setIdentityToken` after
     * `start()` returned. This test proves that concretely rather than
     * asserting it: it installs a `ReplaySession` built from a STUB fetcher
     * that resolves identity-enabled immediately (standing in for "the real
     * fetch already completed"; `start()`'s OWN replay install is blocked via
     * `__startTailDelayHookForTesting` so it can never race/overwrite this
     * one), sets an identity token the way a host would post-`start()`,
     * captures a non-fatal crash, and calls the REAL
     * `TraceItX.requestOutboxDrain()` — reading the REAL
     * `TraceItX._identityHolder` / `TraceItX.currentReplayConfig()`, not a
     * hand-built fixture — then asserts the actual `X-TX-Identity-Token`
     * header on the actual MockWebServer request.
     */
    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun `a non-fatal crash relaunch-drains through requestOutboxDrain once identity and config have genuinely settled`() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        // Block start()'s OWN replay-session install indefinitely (bounded,
        // so the orphaned background thread doesn't linger past the test
        // process) so it can never overwrite the session this test installs
        // directly below. See the field's own doc comment: a BLOCKING
        // closure is required — `refreshConfigNow`'s coroutine has no
        // suspension point between epoch capture and install, so cancellation
        // alone cannot stop it.
        TraceItX.__startTailDelayHookForTesting = { Thread.sleep(5_000) }
        try {
            TraceItX.start(context, config)

            // Stand in for "the ReplaySession's initial config fetch already
            // completed" — a stub fetcher resolving identity-enabled
            // immediately, refreshed synchronously before installation so
            // there is no fetch-in-flight window in this test.
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
            val provider = ReplayConfigProvider(configUrl = "https://x/api/config", apiKey = config.sdkKey, fetcher = fetcher)
            val session = ReplaySession(apiKey = config.sdkKey, locallyDisabled = false, provider = provider)
            runBlocking { session.refreshConfigNow() }
            TraceItX._replaySession = session

            // Not vacuous: prove the seam `requestOutboxDrain()` itself reads
            // really does reflect the fetch above, before relying on it.
            assertTrue(
                "fixture sanity: currentReplayConfig() must reflect the settled fetch",
                isIdentityEnabled(TraceItX.currentReplayConfig()),
            )

            // The host calling setIdentityToken some time after start() —
            // exactly the ordering this drain site (unlike the launch drain)
            // can actually observe.
            val now = System.currentTimeMillis()
            val token = jwt(sub = "alice", expMs = now + 300_000)
            TraceItX.setIdentityToken(IdentityTokenSource.Token(token))

            // The RN bridge's non-fatal path: persist synchronously (no
            // internal auto-drain on Android — CrashReporter.kt never calls
            // drainOutbox itself), then the bridge explicitly requests a
            // flush.
            CrashReporter.captureFacts(
                exceptionType = "RangeError",
                message = "non-fatal boom",
                framesRaw = emptyList(),
                mechanism = "errorutils",
                fatal = false,
                occurredAt = "2026-08-13T00:00:00Z",
            )
            assertEquals(1, kotlinx.coroutines.runBlocking { crashOutbox.count() })

            server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
            TraceItX::class.java.getDeclaredField("sharedOutbox").apply { isAccessible = true }.set(null, crashOutbox)
            TraceItX.requestOutboxDrain()

            val request = reportRequest()
            assertEquals(
                "the real requestOutboxDrain() path must attach alice's token once identity and config are live",
                token,
                request.getHeader("X-TX-Identity-Token"),
            )
        } finally {
            TraceItX.__resetStartTailDelayHookForTesting()
            TraceItX.setIdentityToken(null)
            TraceItX.kill()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `public handled capture immediately delivers and retries the exact durable envelope without restart`() = runBlocking {
        val started = java.util.concurrent.CountDownLatch(1)
        val releaseStart = java.util.concurrent.CountDownLatch(1)
        val contextField = TraceItX::class.java.getDeclaredField("appContext").apply { isAccessible = true }
        val oldContext = contextField.get(null)
        // Run the real synchronous start, parking only the automatic launch drain.
        // The public capture below must itself initiate the sole active drain.
        TraceItX.__beforeDrainLaunchForTesting = {
            started.countDown()
            check(releaseStart.await(30, java.util.concurrent.TimeUnit.SECONDS))
        }
        val startThread = Thread { TraceItX.start(context, config) }
        startThread.start()
        try {
            assertTrue(started.await(5, java.util.concurrent.TimeUnit.SECONDS))
            TraceItX.__beforeDrainLaunchForTesting = null
            TraceItX::class.java.getDeclaredField("sharedOutbox").apply { isAccessible = true }.set(null, crashOutbox)
            server.enqueue(MockResponse().setResponseCode(503).setBody("{}"))
            val epoch = TraceItX.currentStartEpoch()
            TraceItX.captureException(IllegalStateException("public handled HTTP"))
            val first = reportRequest()
            withTimeout(5_000) { TraceItX.sdkScope.coroutineContext[Job]!!.children.toList().joinAll() }
            val entry = crashOutbox.hydrate().single()
            fun envelope(request: okhttp3.mockwebserver.RecordedRequest) =
                request.body.readUtf8().substringAfter("\r\n\r\n").substringBefore("\r\n--")
            val firstEnvelope = envelope(first)
            assertEquals(String(entry.envelopeBytes), firstEnvelope)
            val json = Json.parseToJsonElement(firstEnvelope).jsonObject
            val crash = json["payload"]!!.jsonObject["crash"]!!.jsonObject
            assertEquals("error", json["source"]!!.jsonPrimitive.content)
            assertTrue(crash["handled"]!!.jsonPrimitive.boolean)
            assertEquals(false, crash["fatal"]!!.jsonPrimitive.boolean)
            assertEquals("captureException", crash["mechanism"]!!.jsonPrimitive.content)
            assertEquals("public handled HTTP", crash["message"]!!.jsonPrimitive.content)
            assertEquals(entry.idempotencyKey, first.getHeader("X-TraceItX-Idempotency-Key"))
            assertEquals(entry.reportId, json["reportId"]!!.jsonPrimitive.content)

            server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
            TraceItX.requestOutboxDrain()
            val retry = reportRequest()
            withTimeout(5_000) { TraceItX.sdkScope.coroutineContext[Job]!!.children.toList().joinAll() }
            assertEquals(firstEnvelope, envelope(retry))
            assertEquals(entry.idempotencyKey, retry.getHeader("X-TraceItX-Idempotency-Key"))
            assertEquals(0, crashOutbox.count())
            assertEquals(epoch, TraceItX.currentStartEpoch())
        } finally {
            TraceItX.__beforeDrainLaunchForTesting = null
            TraceItX.kill()
            releaseStart.countDown()
            startThread.join(5_000)
            assertTrue(!startThread.isAlive)
            contextField.set(null, oldContext)
        }
    }
}
