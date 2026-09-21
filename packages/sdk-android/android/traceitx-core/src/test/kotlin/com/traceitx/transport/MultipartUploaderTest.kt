// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Plan 05-05 Task 2 — MultipartUploader unit tests via OkHttp MockWebServer.
package com.traceitx.transport

import com.traceitx.testing.takeRequestOrFail
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.IOException
import java.util.concurrent.TimeUnit

class MultipartUploaderTest {

    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = OkHttpClient.Builder()
            .connectTimeout(2, TimeUnit.SECONDS)
            .readTimeout(2, TimeUnit.SECONDS)
            .writeTimeout(2, TimeUnit.SECONDS)
            .build()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun replayDisallowed() = object : ReportAuthorization {
        override fun evaluate() = ReportAuthorizationDecision(true, false)
        override fun tryStart(expected: ReportAuthorizationDecision, start: () -> Unit): Boolean {
            start(); return true
        }
    }

    @Test
    fun `oversized routing and multibyte metadata start no request`() = runBlocking {
        val uploader = MultipartUploader(client)
        for (value in listOf("x".repeat(16_385), "界".repeat(6_000))) {
            val failure = runCatching { uploader.upload(server.url("/").toString(), value, "i", "{}".toByteArray(), emptyList()) }.exceptionOrNull()
            assertTrue(failure is IllegalArgumentException)
        }
        val failure = runCatching { uploader.upload(server.url("/").toString(), "k", "i", "{}".toByteArray(),
            listOf(MultipartUploader.Part("shot", "界".repeat(400), byteArrayOf(1), "image/png"))) }.exceptionOrNull()
        assertTrue(failure is IllegalArgumentException)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `oversized malformed envelope is bounded before direct uploader parsing`() = runBlocking {
        val oversized = ByteArray(1_000_001) { ' '.code.toByte() }.apply { this[0] = '{'.code.toByte() }
        val failure = runCatching {
            MultipartUploader(client).upload(server.url("/").toString(), "k", "oversized", oversized,
                emptyList(), authorization = replayDisallowed())
        }.exceptionOrNull()
        assertTrue("expected size rejection, got $failure", failure is IllegalArgumentException)
        assertEquals("Envelope exceeds limit", failure?.message)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `attachment count is bounded before direct uploader filtering`() = runBlocking {
        val attachments = object : AbstractList<MultipartUploader.Part>() {
            override val size = 7
            override fun get(index: Int): MultipartUploader.Part = error("Caller collection traversed")
        }
        val failure = runCatching {
            MultipartUploader(client).upload(server.url("/").toString(), "k", "too-many", "{}".toByteArray(),
                attachments, authorization = replayDisallowed())
        }.exceptionOrNull()
        assertTrue("expected count rejection, got $failure", failure is IllegalArgumentException)
        assertEquals("Too many attachments", failure?.message)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `actual multipart exact cap includes long permitted metadata`() {
        val metadata = "x".repeat(1024)
        val empty = MultipartUploader.Part(metadata, metadata, byteArrayOf(), "application/octet-stream")
        val overhead = MultipartUploader.multipartBody("{}".toByteArray(), listOf(empty)).contentLength()
        val exact = empty.copy(data = ByteArray((25_000_000 - overhead - 7).toInt()))
        val body = MultipartUploader.multipartBody("{}".toByteArray(), listOf(exact))
        assertEquals(25_000_000, body.contentLength())
        MultipartUploader.requireBodyLength(body.contentLength())
        org.junit.Assert.assertThrows(IllegalArgumentException::class.java) {
            MultipartUploader.requireBodyLength(MultipartUploader.multipartBody("{}".toByteArray(), listOf(exact.copy(data = exact.data + 0))).contentLength())
        }
        org.junit.Assert.assertThrows(IllegalArgumentException::class.java) { MultipartUploader.requireBodyLength(-1) }
        // The independent 24 MB payload cap is intentionally stricter for bounded metadata.
        org.junit.Assert.assertThrows(IllegalArgumentException::class.java) { MultipartUploader.validatePayload("{}".toByteArray(), listOf(exact)) }
    }

    @Test
    fun `cancelling suspended upload cancels underlying call`() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.NO_RESPONSE))
        val job = launch {
            MultipartUploader(client).upload(server.url("/").toString(), "k", "i", "{}".toByteArray(), emptyList())
        }
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { server.takeRequestOrFail() }
        job.cancel()
        job.join()
        assertTrue(job.isCancelled)
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
        while (client.dispatcher.runningCallsCount() != 0 && System.nanoTime() < deadline) kotlinx.coroutines.delay(10)
        assertEquals(0, client.dispatcher.runningCallsCount())
    }

    @Test
    fun `revocation at final enqueue rebuilds metadata and part together`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200))
        var attempts = 0
        var decision = ReportAuthorizationDecision(true, true)
        val authority = object : ReportAuthorization {
            override fun evaluate() = decision
            override fun tryStart(expected: ReportAuthorizationDecision, start: () -> Unit): Boolean {
                attempts++
                if (attempts == 1) { decision = ReportAuthorizationDecision(true, false); return false }
                assertEquals(decision, expected)
                start(); return true
            }
        }
        MultipartUploader(client).upload(server.url("/").toString(), "k", "original-id",
            """{"reportId":"original","attachments":[{"partName":"replay","format":"traceitx-video-v1"},{"partName":"shot"}]}""".toByteArray(),
            listOf(MultipartUploader.Part("replay", "replay.mp4", byteArrayOf(1), "video/mp4"),
                MultipartUploader.Part("shot", "shot.png", byteArrayOf(2), "image/png")), authorization = authority)
        val request = server.takeRequestOrFail()
        val body = request.body.readUtf8()
        assertEquals(2, attempts)
        assertTrue(body.contains("original")); assertTrue(body.contains("shot"))
        assertTrue(!body.contains("replay")); assertTrue(!body.contains("video/mp4"))
        assertEquals("original-id", request.getHeader("X-TraceItX-Idempotency-Key"))
    }

    @Test
    fun `whole report revoke at final enqueue starts no HTTP`() = runBlocking {
        val authority = object : ReportAuthorization {
            override fun evaluate() = ReportAuthorizationDecision(true, true)
            override fun tryStart(expected: ReportAuthorizationDecision, start: () -> Unit) = false
        }
        val failure = runCatching { MultipartUploader(client).upload(server.url("/").toString(), "k", "i",
            "{}".toByteArray(), emptyList(), authorization = authority) }.exceptionOrNull()
        assertTrue(failure is ReportAuthorizationCancelled)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `rejects excessive metadata before HTTP`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200))
        val failure = runCatching { MultipartUploader(client).upload(server.url("/").toString(), "k", "i",
            "{}".toByteArray(), listOf(MultipartUploader.Part("x".repeat(1025), "x", byteArrayOf(1), "image/png"))) }.exceptionOrNull()
        assertTrue("must reject metadata before upload: $failure", failure is IllegalArgumentException)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `upload sends multipart with envelope + attachment + Bearer + Idempotency-Key`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        val uploader = MultipartUploader(client)
        val attachment = MultipartUploader.Part(
            name = "screenshot",
            filename = "screen.png",
            data = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47),  // PNG magic
            contentType = "image/png",
        )
        val result = uploader.upload(
            endpoint = server.url("/api/ingest").toString(),
            sdkKey = "test-key",
            idempotencyKey = "abc-123-uuid",
            envelopeBytes = """{"reportId":"r-1"}""".toByteArray(),
            attachments = listOf(attachment),
        )
        assertEquals(200, result.statusCode)

        val recorded = server.takeRequestOrFail()
        assertEquals("POST", recorded.method)
        assertEquals("/api/ingest", recorded.path)
        assertEquals("Bearer test-key", recorded.getHeader("Authorization"))
        assertEquals("abc-123-uuid", recorded.getHeader("X-TraceItX-Idempotency-Key"))
        val ct = recorded.getHeader("Content-Type") ?: ""
        assertTrue("expected multipart/form-data, got $ct", ct.startsWith("multipart/form-data"))
        assertTrue("expected boundary= in $ct", ct.contains("boundary="))

        val bodyStr = recorded.body.readUtf8()
        assertTrue("body should mention envelope part: $bodyStr",
            bodyStr.contains("name=\"envelope\""))
        assertTrue("body should mention envelope.json: $bodyStr",
            bodyStr.contains("filename=\"envelope.json\""))
        assertTrue("body should mention application/json", bodyStr.contains("application/json"))
        assertTrue("body should mention screenshot part",
            bodyStr.contains("name=\"screenshot\""))
        assertTrue("body should mention screen.png", bodyStr.contains("filename=\"screen.png\""))
    }

    @Test
    fun `upload with 5xx returns non-2xx UploadResult (no exception)`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(503).setBody("service unavailable"))
        val uploader = MultipartUploader(client)
        val result = uploader.upload(
            endpoint = server.url("/api/ingest").toString(),
            sdkKey = "k",
            idempotencyKey = "i",
            envelopeBytes = "{}".toByteArray(),
            attachments = emptyList(),
        )
        assertEquals(503, result.statusCode)
        // Submitter (not uploader) decides what to do with the status.
    }

    @Test
    fun `upload propagates IOException on connection refused`() {
        // Shut server down BEFORE upload to force connection failure.
        server.shutdown()
        val uploader = MultipartUploader(client)
        var caught: Throwable? = null
        runBlocking {
            try {
                uploader.upload(
                    endpoint = "http://127.0.0.1:1/api/ingest",
                    sdkKey = "k",
                    idempotencyKey = "i",
                    envelopeBytes = "{}".toByteArray(),
                    attachments = emptyList(),
                )
            } catch (e: Throwable) { caught = e }
        }
        assertNotNull("expected IOException, got null", caught)
        assertTrue(
            "expected IOException, got ${caught!!::class.qualifiedName}",
            caught is IOException
        )
    }

    @Test
    fun `upload returns response body preview when 5xx`() = runBlocking {
        // Note: BuildConfig.DEBUG is true for debug build variant used by unit tests.
        server.enqueue(MockResponse().setResponseCode(500).setBody("oops"))
        val uploader = MultipartUploader(client)
        val result = uploader.upload(
            endpoint = server.url("/api/ingest").toString(),
            sdkKey = "k",
            idempotencyKey = "i",
            envelopeBytes = "{}".toByteArray(),
            attachments = emptyList(),
        )
        assertEquals(500, result.statusCode)
        // In debug builds, the preview is populated. In release builds it would be null.
        // The test runs against debug, so we expect a non-null preview.
        assertNotNull(result.responseBodyPreview)
        assertTrue(result.responseBodyPreview!!.contains("oops"))
    }
}
