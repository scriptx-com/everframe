// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The last hop of companion attribution (spec 2026-08-07): a token captured
// off the relay socket must land on the ingest POST as
// `X-TX-Companion-Attribution`, and must be entirely absent for every ordinary
// (QR / in-process reporter) submit.
//
// These drive the real `ReportSubmitter` → `MultipartUploader` pair against
// MockWebServer and assert on the header the server actually received. Setup
// mirrors `ReportSubmitterTest` (file-backed outbox, no Robolectric).

package com.traceitx.transport

import com.traceitx.outbox.JceTestOutboxKeyProvider
import com.traceitx.outbox.JvmOutboxFileOps

import com.traceitx.TraceItX
import com.traceitx.config.TraceItXConfig
import com.traceitx.outbox.JSONLOutbox
import com.traceitx.testing.takeRequestOrFail
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.concurrent.TimeUnit

class CompanionAttributionHeaderTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var server: MockWebServer
    private lateinit var submitter: ReportSubmitter

    @Before
    fun setUp() {
        TraceItX.captureGate = true
        server = MockWebServer()
        server.start()
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        val http = OkHttpClient.Builder()
            .connectTimeout(2, TimeUnit.SECONDS)
            .readTimeout(2, TimeUnit.SECONDS)
            .writeTimeout(2, TimeUnit.SECONDS)
            .build()
        submitter = ReportSubmitter(
            config = TraceItXConfig(appId = "app-id", sdkKey = "test-sdk-key"),
            outbox = JSONLOutbox(File(tmp.newFolder("com.traceitx"), "outbox.jsonl"), keys = JceTestOutboxKeyProvider(), ops = JvmOutboxFileOps()),
            uploader = MultipartUploader(http),
            endpointOverride = server.url("/api/ingest").toString(),
        )
    }

    @After
    fun tearDown() {
        server.shutdown()
        TraceItX.captureGate = false
    }

    @Test
    fun submit_withACompanionToken_setsTheAttributionHeader() = runBlocking {
        submitter.submit(
            envelopeBytes = "{}".toByteArray(),
            idempotencyKey = "idem-1",
            attachments = emptyList(),
            companionAttribution = "attr_tok_1",
        )

        val recorded = server.takeRequestOrFail()
        assertEquals("attr_tok_1", recorded.getHeader("X-TX-Companion-Attribution"))
        // The rest of the locked wire format is untouched.
        assertEquals("Bearer test-sdk-key", recorded.getHeader("Authorization"))
        assertEquals("idem-1", recorded.getHeader("X-TraceItX-Idempotency-Key"))
    }

    @Test
    fun submit_withoutACompanionToken_sendsNoAttributionHeaderAtAll() = runBlocking {
        // An ordinary QR / in-process report must not carry an empty attribution
        // header — ingest treats the header's presence as the signal, so ""
        // would be a claim rather than an absence.
        submitter.submit(
            envelopeBytes = "{}".toByteArray(),
            idempotencyKey = "idem-2",
            attachments = emptyList(),
        )

        assertNull(server.takeRequestOrFail().getHeader("X-TX-Companion-Attribution"))
    }
}
