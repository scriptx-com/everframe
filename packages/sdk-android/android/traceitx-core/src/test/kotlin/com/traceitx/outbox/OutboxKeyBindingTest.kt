// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package com.traceitx.outbox

import com.traceitx.TraceItX
import com.traceitx.config.ReplayConfig
import com.traceitx.config.TraceItXConfig
import com.traceitx.identity.IdentityTokenHolder
import com.traceitx.testing.takeRequestOrFail
import com.traceitx.transport.MultipartUploader
import com.traceitx.transport.ReportSubmitter
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.async
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.concurrent.TimeUnit

/** Outbox key binding (spec 2026-08-12). */
@org.junit.runner.RunWith(org.robolectric.RobolectricTestRunner::class)
@org.robolectric.annotation.Config(sdk = [34])
class OutboxKeyBindingTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var serverA: MockWebServer
    private lateinit var serverB: MockWebServer
    private lateinit var client: OkHttpClient

    @Before
    fun setUpServers() {
        serverA = MockWebServer().also { server ->
            server.dispatcher = object : okhttp3.mockwebserver.QueueDispatcher() {
                override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): MockResponse =
                    if (request.path == "/api/config") MockResponse().setResponseCode(503) else super.dispatch(request)
            }; server.start()
        }
        serverB = MockWebServer().also { server ->
            server.dispatcher = object : okhttp3.mockwebserver.QueueDispatcher() {
                override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): MockResponse =
                    if (request.path == "/api/config") MockResponse().setResponseCode(503) else super.dispatch(request)
            }; server.start()
        }
        client = OkHttpClient.Builder()
            .connectTimeout(2, TimeUnit.SECONDS)
            .readTimeout(2, TimeUnit.SECONDS)
            .writeTimeout(2, TimeUnit.SECONDS)
            .build()
        TraceItX.captureGate = true   // drainOutbox early-returns without it
    }

    @After
    fun tearDownServers() {
        serverA.shutdown()
        serverB.shutdown()
        TraceItX.captureGate = false
    }

    private fun entry(
        sdkKey: String = "key-A",
        endpoint: String = "https://a.example.com",
        reportId: String = "r-1",
    ) = OutboxEntry(
        reportId = reportId,
        createdAt = 1L,
        envelopeBytes = byteArrayOf(120),
        idempotencyKey = "idem-$reportId",
        attachmentRefs = emptyList(),
        sdkKey = sdkKey,
        endpoint = endpoint,
    )

    @Test
    fun `delayed drain uses captured kill authority after gate reopens`() = kotlinx.coroutines.runBlocking {
        val box = JSONLOutbox(File(tmp.newFolder(), "outbox.jsonl"), keys = JceTestOutboxKeyProvider(), ops = JvmOutboxFileOps())
        box.enqueue(entry(endpoint = serverA.url("/api/ingest").toString()))
        val captured = TraceItX.captureSessionSnapshot()
        val endpoint = serverA.url("/api/ingest").toString()
        val submitter = ReportSubmitter(TraceItXConfig("app-A", "key-A"), box, MultipartUploader(client), serverB.url("/").toString())
        // The deferred coroutine receives the old snapshot, even though its body starts
        // only after real kill has advanced the monotonic generation and local capture reopens.
        val deferred = async(start = kotlinx.coroutines.CoroutineStart.LAZY) {
            submitter.drainOutbox(IdentityTokenHolder(), { ReplayConfig.OFF }, captured.user.startEpoch,
                { TraceItX.currentStartEpoch() }, captured, endpoint)
        }
        TraceItX.kill()
        TraceItX.captureGate = true
        deferred.await()
        assertEquals(0, serverA.requestCount)
        assertEquals(0, serverB.requestCount)
        assertEquals(1, box.count())
    }

    @Test
    fun `8 MiB video and screenshot reopen on original route enabled by A while B is current`() = kotlinx.coroutines.runBlocking {
        replayRoundtrip("""{"replayEnabled":true,"replayDurationSec":30,"samplingRate":0.0,"nativeVideo":{"framesPerSecond":5}}""", 200, true)
    }

    @Test
    fun `disabled original route omits video even while B allows it`() = kotlinx.coroutines.runBlocking {
        replayRoundtrip("""{"replayEnabled":false}""", 200, false)
    }

    @Test
    fun `unconfirmed original route omits video even while B allows it`() = kotlinx.coroutines.runBlocking {
        replayRoundtrip("unconfirmed", 503, false)
    }

    private suspend fun replayRoundtrip(configBody: String, configStatus: Int, expectVideo: Boolean) {
        var uploads = 0
        serverA.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): MockResponse = when(request.path) {
                "/api/config" -> MockResponse().setResponseCode(configStatus).setBody(configBody)
                "/api/ingest" -> MockResponse().setResponseCode(if (++uploads <= 2) 503 else 200)
                else -> MockResponse().setResponseCode(404)
            }
        }
        serverB.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest) = MockResponse().setBody(
                """{"replayEnabled":true,"replayDurationSec":30,"nativeVideo":{"framesPerSecond":5}}""")
        }
        val file = File(tmp.newFolder(), "outbox.jsonl")
        val keys = JceTestOutboxKeyProvider()
        val first = JSONLOutbox(file, keys = keys, ops = JvmOutboxFileOps())
        val video = ByteArray(8 * 1024 * 1024) { (it % 251).toByte() }
        val shot = byteArrayOf(1,2,3,4)
        val envelope = """{"reportId":"captured-original","user":{"id":"alice"},"attachments":[{"partName":"replay","format":"traceitx-video-v1","contentType":"video/mp4"},{"partName":"shot","contentType":"image/png"}]}""".toByteArray()
        fun part(name: String, type: String, bytes: ByteArray) = ReportSubmitter.Attachment(name, "$name.bin", type, bytes,
            java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) })
        val permit = object : com.traceitx.transport.ReportAuthorization {
            override fun evaluate() = com.traceitx.transport.ReportAuthorizationDecision(true, true)
            override fun tryStart(expected: com.traceitx.transport.ReportAuthorizationDecision, start: () -> Unit): Boolean { start(); return true }
        }
        val result = ReportSubmitter(TraceItXConfig("app-A", "key-A"), first, MultipartUploader(client), serverA.url("/api/ingest").toString())
            .submit(envelope, "original-idem", listOf(part("replay", "video/mp4", video), part("shot", "image/png", shot)),
                identitySubject = "alice", authorization = permit)
        org.junit.Assert.assertTrue(result is com.traceitx.config.ReportResult.Queued)
        serverA.takeRequestOrFail()
        val reopened = JSONLOutbox(file, keys = keys, ops = JvmOutboxFileOps())
        val before = reopened.hydrate().single()
        org.junit.Assert.assertArrayEquals(video, before.attachmentRefs.first().data)
        org.junit.Assert.assertArrayEquals(shot, before.attachmentRefs.last().data)
        org.junit.Assert.assertArrayEquals(envelope, before.envelopeBytes)
        val holder = IdentityTokenHolder()
        val jwt = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString("{}".toByteArray()) + "." +
            java.util.Base64.getUrlEncoder().withoutPadding().encodeToString("""{"sub":"alice","exp":9999999999}""".toByteArray()) + ".signature"
        holder.set(com.traceitx.identity.IdentityTokenSource.Token(jwt))
        val current = ReportSubmitter(TraceItXConfig("app-B", "key-B"), reopened, MultipartUploader(client), serverB.url("/").toString())
        repeat(2) { attempt ->
            current.drainOutbox(holder, { ReplayConfig.OFF }, 0, { 0 })
            val configRequest = serverA.takeRequestOrFail()
            assertEquals("/api/config", configRequest.path)
            assertEquals("Bearer key-A", configRequest.getHeader("Authorization"))
            val request = serverA.takeRequestOrFail()
            assertEquals("/api/ingest", request.path)
            assertEquals("Bearer key-A", request.getHeader("Authorization"))
            assertEquals("original-idem", request.getHeader("X-TraceItX-Idempotency-Key"))
            org.junit.Assert.assertNull(request.getHeader("X-TX-Identity-Token"))
            val body = request.body.readByteArray()
            val text = body.toString(Charsets.ISO_8859_1)
            assertEquals(expectVideo, text.contains("video/mp4"))
            assertEquals(expectVideo, text.contains("traceitx-video-v1"))
            org.junit.Assert.assertTrue(text.contains("captured-original") && text.contains("alice") && text.contains("shot"))
            if (expectVideo) org.junit.Assert.assertTrue(okio.Buffer().write(body).indexOf(okio.ByteString.of(*video)) >= 0)
            org.junit.Assert.assertTrue(okio.Buffer().write(body).indexOf(okio.ByteString.of(*shot)) >= 0)
            if (attempt == 0) assertEquals("alice", reopened.hydrate().single().identitySubject)
        }
        assertEquals(0, reopened.count())
        assertEquals(0, serverB.requestCount)
        assertEquals(0, File(file.parentFile, file.name + ".encrypted").walkTopDown().count { it.extension == "txq" })
    }

    @Test
    fun `entry roundtrips sdkKey and endpoint`() = runTest {
        val box = JSONLOutbox(File(tmp.newFolder(), "outbox.jsonl"), keys = JceTestOutboxKeyProvider(), ops = JvmOutboxFileOps())
        box.enqueue(entry())

        val out = box.hydrate()
        assertEquals(1, out.size)
        assertEquals("key-A", out[0].sdkKey)
        assertEquals("https://a.example.com", out[0].endpoint)
    }

    /** Missing captured routes must block migration without deleting the legacy evidence. */
    @Test
    fun `legacy line missing only sdkKey is blocked and preserved`() = runTest {
        val json = Json.encodeToString(OutboxEntry.serializer(), entry())
        val legacy = json.replace(Regex(""","sdkKey":"[^"]*""""), "")
        assertEquals("sdkKey must be stripped", false, legacy.contains("sdkKey"))
        assertEquals("endpoint must survive untouched", true, legacy.contains("\"endpoint\":\"https://a.example.com\""))

        val f = File(tmp.newFolder(), "outbox.jsonl")
        f.parentFile?.mkdirs()
        f.writeText(legacy + "\n")

        assertEquals(
            "an entry missing only sdkKey cannot be routed and must not hydrate",
            0,
            JSONLOutbox(f, keys = JceTestOutboxKeyProvider(), ops = JvmOutboxFileOps()).hydrate().size,
        )
        org.junit.Assert.assertEquals(legacy + "\n", f.readText())
    }

    @Test
    fun `legacy line missing only endpoint is blocked and preserved`() = runTest {
        val json = Json.encodeToString(OutboxEntry.serializer(), entry())
        val legacy = json.replace(Regex(""","endpoint":"[^"]*""""), "")
        assertEquals("endpoint must be stripped", false, legacy.contains("endpoint"))
        assertEquals("sdkKey must survive untouched", true, legacy.contains("\"sdkKey\":\"key-A\""))

        val f = File(tmp.newFolder(), "outbox.jsonl")
        f.parentFile?.mkdirs()
        f.writeText(legacy + "\n")

        assertEquals(
            "an entry missing only endpoint cannot be routed and must not hydrate",
            0,
            JSONLOutbox(f, keys = JceTestOutboxKeyProvider(), ops = JvmOutboxFileOps()).hydrate().size,
        )
        org.junit.Assert.assertEquals(legacy + "\n", f.readText())
    }

    /**
     * Crash reports leak by exactly the same route as reporter submissions:
     * `CrashSidecar` writes the same `OutboxEntry` type and `hydrateInto`
     * feeds those entries into the main outbox on next launch. So the key has
     * to survive that hop, not just the direct enqueue path.
     */
    @Test
    fun `sidecar entries carry the key through hydrateInto`() = runTest {
        val dir = tmp.newFolder()
        val sidecar = CrashSidecar(File(dir, "crash-outbox.jsonl"))
        File(dir, "crash-outbox.jsonl").writeText(Json.encodeToString(OutboxEntry.serializer(),
            entry(sdkKey = "key-crash", reportId = "r-crash")) + "\n")

        val box = JSONLOutbox(File(dir, "outbox.jsonl"), keys = JceTestOutboxKeyProvider(), ops = JvmOutboxFileOps())
        assertEquals(1, sidecar.hydrateInto(box))

        val out = box.hydrate()
        assertEquals(1, out.size)
        assertEquals("key-crash", out[0].sdkKey)
        assertEquals("https://a.example.com", out[0].endpoint)
    }

    /**
     * The leak, directly: an outbox holding entries for two projects, drained
     * by a submitter configured for only one. Each report must reach the
     * project that captured it.
     *
     * `endpointOverride` is deliberately set to server A. Pre-fix, drain reads
     * that override for EVERY entry, so both reports land on server A under
     * `key-B` and server B sees nothing — a clean red without any request
     * escaping to a real host. Post-fix, drain ignores the override entirely
     * and routes by `entry.endpoint`.
     */
    @Test
    fun `drain submits each entry with its own key and endpoint`() = runTest {
        serverA.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        serverB.enqueue(MockResponse().setResponseCode(200).setBody("{}"))

        val box = JSONLOutbox(File(tmp.newFolder(), "outbox.jsonl"), keys = JceTestOutboxKeyProvider(), ops = JvmOutboxFileOps())
        box.enqueue(entry(
            sdkKey = "key-A", endpoint = serverA.url("/").toString(), reportId = "r-A"))
        box.enqueue(entry(
            sdkKey = "key-B", endpoint = serverB.url("/").toString(), reportId = "r-B"))

        ReportSubmitter(
            config = TraceItXConfig(appId = "app-B", sdkKey = "key-B"),
            outbox = box,
            uploader = MultipartUploader(client),
            endpointOverride = serverA.url("/").toString(),
        ).drainOutbox(identityHolder = IdentityTokenHolder(), currentReplayConfig = { ReplayConfig.OFF }, epochAtInitiation = 0, currentEpoch = { 0 })

        assertEquals("project A's report must reach project A", 2, serverA.requestCount)
        assertEquals("project B's report must reach project B", 2, serverB.requestCount)
        assertEquals("/api/config", serverA.takeRequestOrFail().path)
        assertEquals("/api/config", serverB.takeRequestOrFail().path)
        assertEquals("Bearer key-A", serverA.takeRequestOrFail().getHeader("Authorization"))
        assertEquals("Bearer key-B", serverB.takeRequestOrFail().getHeader("Authorization"))
    }
}
