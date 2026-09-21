// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package com.traceitx.transport

import com.traceitx.TraceItX
import com.traceitx.config.*
import com.traceitx.identity.IdentityTokenHolder
import com.traceitx.outbox.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class OptionalVideoBudgetTest {
    private val permit = object : ReportAuthorization {
        override fun evaluate() = ReportAuthorizationDecision(true, true)
        override fun tryStart(expected: ReportAuthorizationDecision, start: () -> Unit): Boolean { start(); return true }
    }
    private fun shots(count: Int) = (1..count).map {
        MultipartUploader.Part("shot-$it", "shot-$it.png", "pixels-$it".toByteArray(), "image/png")
    }
    private fun video(size: Int = 3) = MultipartUploader.Part("replay", "replay.mp4", ByteArray(size) { 42 }, "video/mp4")
    private fun envelope(parts: List<MultipartUploader.Part>) = buildJsonObject {
        put("reportId", "original-report"); put("title", "original title")
        putJsonObject("captureControl") {
            putJsonArray("included") { add("logs") }; putJsonArray("excluded") { add("network") }
        }
        putJsonArray("attachments") { parts.forEach { part -> add(buildJsonObject {
            put("partName", part.name); put("contentType", part.contentType)
            if (part.name == "replay") put("format", "traceitx-video-v1")
        }) } }
    }.toString().toByteArray()

    @Test fun fiveScreenshotsAndVideoShipSixFilesWithOriginalEvidence() = runBlocking {
        withServer { server ->
            val parts = shots(5) + video()
            MultipartUploader(OkHttpClient()).upload(server.url("/").toString(), "original-key", "original-idem",
                envelope(parts), parts, authorization = permit)
            assertDegraded(server.takeRequest(3, TimeUnit.SECONDS)!!, 5, "replay_part_limit")
        }
    }

    @Test fun videoCrossingPayloadBudgetIsOmittedBeforeValidation() = runBlocking {
        withServer { server ->
            val parts = shots(1) + video(24_000_000)
            MultipartUploader(OkHttpClient()).upload(server.url("/").toString(), "original-key", "original-idem",
                envelope(parts), parts, authorization = permit)
            assertDegraded(server.takeRequest(3, TimeUnit.SECONDS)!!, 1, "replay_report_budget")
        }
    }

    @Test fun fittingVideoAtExactPayloadBudgetAndFiveAttachmentBoundaryIsPreserved() {
        val parts = shots(4) + video()
        val env = envelope(parts)
        val exact = parts.dropLast(1) + video(24_000_000 - env.size - parts.dropLast(1).sumOf { it.data.size })
        val prepared = MultipartUploader.preparePayload(env, exact, true)
        assertArrayEquals(env, prepared.first)
        assertEquals(exact, prepared.second)
        MultipartUploader.validatePayload(prepared.first, prepared.second)
    }

    @Test fun sixNonVideoPartsStillRejectWithoutSending() = runBlocking {
        withServer { server ->
            val parts = shots(6)
            val failure = runCatching { MultipartUploader(OkHttpClient()).upload(server.url("/").toString(), "key", "i",
                envelope(parts), parts, authorization = permit) }.exceptionOrNull()
            assertTrue("$failure", failure is IllegalArgumentException)
            assertEquals(0, server.requestCount)
        }
    }

    @Test fun newOfflineReportPersistsOnlyFittingEvidenceAndDrainsOnce() = runBlocking {
        queueRoundtrip(existingSixAttachmentEntry = false)
    }

    @Test fun existingSixAttachmentEncryptedEntryReopensAndDrainsWithoutPoisoningQueue() = runBlocking {
        queueRoundtrip(existingSixAttachmentEntry = true)
    }

    @Test fun newOfflineByteOverflowPersistsOnlyFittingEvidenceAndDrainsOnce() = runBlocking {
        queueRoundtrip(existingSixAttachmentEntry = false, byteOverflow = true)
    }

    @Test fun oneByteOverExactBudgetDropsVideoAndPreservesEarlierDegradation() {
        val parts = shots(1) + video()
        val root = Json.parseToJsonElement(envelope(parts).decodeToString()).jsonObject
        val env = JsonObject(root.toMutableMap().apply {
            put("captureControl", JsonObject(root["captureControl"]!!.jsonObject.toMutableMap().apply {
                put("degradedReason", JsonPrimitive("prior-degradation"))
            }))
        }).toString().toByteArray()
        val over = parts.take(1) + video(24_000_001 - env.size - parts.first().data.size)
        val prepared = MultipartUploader.preparePayload(env, over, true)
        MultipartUploader.validatePayload(prepared.first, prepared.second)
        assertEquals(parts.take(1), prepared.second)
        assertEquals("prior-degradation;replay_report_budget", Json.parseToJsonElement(prepared.first.decodeToString())
            .jsonObject["captureControl"]!!.jsonObject["degradedReason"]!!.jsonPrimitive.content)
    }

    @Test fun nullableExistingReasonRecordsOnlyActualBudgetDegradation() {
        val parts = shots(5) + video()
        val root = Json.parseToJsonElement(envelope(parts).decodeToString()).jsonObject
        val env = JsonObject(root.toMutableMap().apply {
            put("captureControl", JsonObject(root["captureControl"]!!.jsonObject.toMutableMap().apply {
                put("degradedReason", JsonNull)
            }))
        }).toString().toByteArray()
        val prepared = MultipartUploader.preparePayload(env, parts, true)
        assertEquals("replay_part_limit", Json.parseToJsonElement(prepared.first.decodeToString())
            .jsonObject["captureControl"]!!.jsonObject["degradedReason"]!!.jsonPrimitive.content)
    }

    @Test fun rewrittenEnvelopeCannotBypassBudgetWhenRequiredEvidenceIsTooLarge() = runBlocking {
        withServer { server ->
            // Existing reason absorbs more bytes on omission than the minimal video metadata frees.
            val env = """{"captureControl":{"included":[],"excluded":[],"degradedReason":"prior"}}""".toByteArray()
            val parts = listOf(MultipartUploader.Part("shot", "shot.png", ByteArray(24_000_000 - env.size), "image/png"), video(1))
            val failure = runCatching { MultipartUploader(OkHttpClient()).upload(server.url("/").toString(), "key", "i",
                env, parts, authorization = permit) }.exceptionOrNull()
            assertTrue("rewritten envelope still exceeds the payload cap: $failure", failure is IllegalArgumentException)
            assertEquals(0, server.requestCount)
        }
    }

    private suspend fun queueRoundtrip(existingSixAttachmentEntry: Boolean, byteOverflow: Boolean = false) {
        TraceItX.captureGate = true
        val root = kotlin.io.path.createTempDirectory("video-budget-outbox").toFile()
        try { withServer { server ->
            var offline = !existingSixAttachmentEntry
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest) = if (request.path == "/api/config")
                    MockResponse().setBody("""{"replayEnabled":true,"replayDurationSec":30,"samplingRate":0.0,"nativeVideo":{"framesPerSecond":5}}""")
                else MockResponse().setResponseCode(if (offline) 503 else 200)
            }
            val file = File(root, "outbox.jsonl"); val keys = JceTestOutboxKeyProvider()
            val box = JSONLOutbox(file, keys = keys, ops = JvmOutboxFileOps())
            val count = if (byteOverflow) 1 else 5
            val reason = if (byteOverflow) "replay_report_budget" else "replay_part_limit"
            val parts = shots(count) + video(if (byteOverflow) 24_000_000 else 3); val env = envelope(parts)
            val refs = parts.map { OutboxEntry.AttachmentRef(it.name, it.filename!!, it.contentType, it.data, com.traceitx.capture.video.sha256(it.data)) }
            val config = TraceItXConfig("app", "original-key")
            val submitter = ReportSubmitter(config, box, MultipartUploader(OkHttpClient()), server.url("/").toString())
            if (existingSixAttachmentEntry) {
                box.enqueue(OutboxEntry("original-report", 1L, env, "original-idem", refs,
                    sdkKey = "original-key", endpoint = server.url("/").toString()))
            } else {
                val result = submitter.submit(env, "original-idem", parts.map {
                    ReportSubmitter.Attachment(it.name, it.filename!!, it.contentType, it.data, com.traceitx.capture.video.sha256(it.data))
                }, reportId = UUID.randomUUID(), authorization = permit)
                assertTrue("$result", result is ReportResult.Queued)
                assertDegraded(server.takeRequest(3, TimeUnit.SECONDS)!!, count, reason)
            }
            val reopened = JSONLOutbox(file, keys = keys, ops = JvmOutboxFileOps())
            val stored = reopened.hydrate().single()
            assertEquals(if (existingSixAttachmentEntry) 6 else count, stored.attachmentRefs.size)
            offline = false
            ReportSubmitter(config, reopened, MultipartUploader(OkHttpClient()), server.url("/").toString())
                .drainOutbox(IdentityTokenHolder(), { ReplayConfig.OFF }, 0, { 0 })
            assertEquals("/api/config", server.takeRequest(3, TimeUnit.SECONDS)!!.path)
            assertDegraded(server.takeRequest(3, TimeUnit.SECONDS)!!, count, reason)
            assertEquals(0, reopened.count())
        } } finally { TraceItX.captureGate = false; root.deleteRecursively() }
    }

    private fun assertDegraded(request: RecordedRequest, count: Int, reason: String) {
        assertEquals("/api/ingest", request.path)
        assertEquals("Bearer original-key", request.getHeader("Authorization"))
        assertEquals("original-idem", request.getHeader("X-TraceItX-Idempotency-Key"))
        val body = request.body.readUtf8()
        assertEquals(count + 1, Regex("Content-Disposition: form-data;").findAll(body).count())
        assertFalse(body.contains("video/mp4")); assertFalse(body.contains("traceitx-video-v1"))
        val env = Json.parseToJsonElement(body.substringAfter("\r\n\r\n").substringBefore("\r\n--")).jsonObject
        assertEquals("original title", env["title"]!!.jsonPrimitive.content)
        assertEquals("original-report", env["reportId"]!!.jsonPrimitive.content)
        assertEquals(count, env["attachments"]!!.jsonArray.size)
        val control = env["captureControl"]!!.jsonObject
        assertEquals(reason, control["degradedReason"]!!.jsonPrimitive.content)
        assertEquals("logs", control["included"]!!.jsonArray.single().jsonPrimitive.content)
        assertEquals("network", control["excluded"]!!.jsonArray.single().jsonPrimitive.content)
        (1..count).forEach { assertTrue(body.contains("pixels-$it")) }
    }

    private suspend fun withServer(block: suspend (MockWebServer) -> Unit) {
        val server = MockWebServer().apply { start(); enqueue(MockResponse().setResponseCode(200)) }
        try { block(server) } finally { server.shutdown() }
    }
}
