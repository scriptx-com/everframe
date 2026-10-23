// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Simulator quick capture: the capture token rides the live ingest POST as
// `X-Everframe-Capture-Token` and nothing else. It must be absent when not
// supplied, and never reach outbox storage, so a queued capture is retried
// without it (ingest then files it in the shared inbox).
//
// Drives the real `ReportSubmitter` -> `MultipartUploader` pair against
// MockWebServer.

package dev.everframe.transport

import dev.everframe.Everframe
import dev.everframe.config.EverframeConfig
import dev.everframe.config.ReplayConfig
import dev.everframe.config.ReportResult
import dev.everframe.identity.IdentityTokenHolder
import dev.everframe.outbox.JSONLOutbox
import dev.everframe.outbox.JceTestOutboxKeyProvider
import dev.everframe.outbox.JvmOutboxFileOps
import dev.everframe.testing.takeRequestOrFail
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.concurrent.TimeUnit

class CaptureTokenHeaderTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var server: MockWebServer
    private lateinit var submitter: ReportSubmitter
    private lateinit var outbox: JSONLOutbox
    private lateinit var outboxFile: File

    @Before
    fun setUp() {
        Everframe.captureGate = true
        server = MockWebServer()
        server.start()
        val http = OkHttpClient.Builder()
            .connectTimeout(2, TimeUnit.SECONDS)
            .readTimeout(1, TimeUnit.SECONDS)
            .writeTimeout(2, TimeUnit.SECONDS)
            .retryOnConnectionFailure(false)
            .build()
        outboxFile = File(tmp.newFolder("dev.everframe"), "outbox.jsonl")
        outbox = JSONLOutbox(outboxFile, keys = JceTestOutboxKeyProvider(), ops = JvmOutboxFileOps())
        submitter = ReportSubmitter(
            config = EverframeConfig(appId = "app-id", sdkKey = "test-sdk-key"),
            outbox = outbox,
            uploader = MultipartUploader(http),
            endpointOverride = server.url("/api/ingest").toString(),
        )
    }

    @After
    fun tearDown() {
        server.shutdown()
        Everframe.captureGate = false
    }

    @Test
    fun submit_withACaptureToken_setsTheCaptureTokenHeader() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        submitter.submit(
            envelopeBytes = "{}".toByteArray(),
            idempotencyKey = "idem-1",
            attachments = emptyList(),
            captureToken = "cap_tok_1",
        )

        val recorded = server.takeRequestOrFail()
        assertEquals("cap_tok_1", recorded.getHeader("X-Everframe-Capture-Token"))
        assertEquals("Bearer test-sdk-key", recorded.getHeader("Authorization"))
        assertEquals("idem-1", recorded.getHeader("X-Everframe-Idempotency-Key"))
    }

    @Test
    fun submit_withoutACaptureToken_sendsNoCaptureTokenHeader() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        submitter.submit(
            envelopeBytes = "{}".toByteArray(),
            idempotencyKey = "idem-2",
            attachments = emptyList(),
        )

        assertNull(server.takeRequestOrFail().getHeader("X-Everframe-Capture-Token"))
    }

    @Test
    fun aRetryableHttpFailure_neverPersistsTheToken_andTheDrainSendsNoHeader() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(503))
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        assertQueuedWithoutTokenThenDrainedWithoutHeader()
    }

    @Test
    fun aNetworkFailure_neverPersistsTheToken_andTheDrainSendsNoHeader() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        assertQueuedWithoutTokenThenDrainedWithoutHeader()
    }

    private suspend fun assertQueuedWithoutTokenThenDrainedWithoutHeader() {
        val token = "cap_tok_secret_9f3a"
        val result = submitter.submit(
            envelopeBytes = "{}".toByteArray(),
            idempotencyKey = "idem-3",
            attachments = emptyList(),
            captureToken = token,
        )
        assertTrue("expected Queued, got $result", result is ReportResult.Queued)
        // The live attempt did carry it.
        assertEquals(token, server.takeRequestOrFail().getHeader("X-Everframe-Capture-Token"))

        // Nothing in storage mentions it: not the raw file, not any hydrated field.
        val stored = outboxFile.parentFile!!.walkTopDown().filter { it.isFile }.toList()
        assertTrue("outbox wrote no files", stored.isNotEmpty())
        stored.forEach { assertFalse(String(it.readBytes(), Charsets.ISO_8859_1).contains(token)) }
        val entries = outbox.hydrate()
        assertEquals(1, entries.size)
        assertFalse(entries.single().toString().contains(token))
        assertFalse(String(entries.single().envelopeBytes).contains(token))

        submitter.drainOutbox(IdentityTokenHolder(), { ReplayConfig.OFF }, 0, { 0 })
        val retried = server.takeRequestOrFail()
        assertNull(retried.getHeader("X-Everframe-Capture-Token"))
        assertEquals("Bearer test-sdk-key", retried.getHeader("Authorization"))
    }
}
