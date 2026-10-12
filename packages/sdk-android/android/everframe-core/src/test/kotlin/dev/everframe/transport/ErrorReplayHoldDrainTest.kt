// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.transport

import dev.everframe.Everframe
import dev.everframe.config.EverframeConfig
import dev.everframe.config.ReplayConfig
import dev.everframe.crash.ErrorReplayHolds
import dev.everframe.identity.IdentityTokenHolder
import dev.everframe.outbox.JSONLOutbox
import dev.everframe.outbox.JceTestOutboxKeyProvider
import dev.everframe.outbox.JvmOutboxFileOps
import dev.everframe.outbox.OutboxEntry
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class ErrorReplayHoldDrainTest {
    @Test fun heldErrorStaysQueuedUntilItsReplayResolves() = runBlocking {
        Everframe.captureGate = true
        val root = kotlin.io.path.createTempDirectory("held-error").toFile()
        val server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = if (request.path == "/api/config")
                MockResponse().setBody("""{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0}""")
            else MockResponse().setResponseCode(200)
        }
        server.start()
        try {
            val box = JSONLOutbox(File(root, "outbox.jsonl"), keys = JceTestOutboxKeyProvider(), ops = JvmOutboxFileOps())
            box.enqueue(OutboxEntry("held-error", 1L, "{}".toByteArray(), "idem", emptyList(),
                sdkKey = "key", endpoint = server.url("/").toString()))
            val submitter = ReportSubmitter(EverframeConfig("app", "key"), box, MultipartUploader(OkHttpClient()), server.url("/").toString())
            ErrorReplayHolds.hold("held-error")
            submitter.drainOutbox(IdentityTokenHolder(), { ReplayConfig.OFF }, 0, { 0 })
            assertEquals("a held error is not even authorized", 0, server.requestCount)
            assertEquals(1, box.count())
            ErrorReplayHolds.release("held-error")
            submitter.drainOutbox(IdentityTokenHolder(), { ReplayConfig.OFF }, 0, { 0 })
            assertEquals(0, box.count())
            assertEquals("/api/ingest", (1..server.requestCount).map { server.takeRequest().path }.last())
        } finally {
            ErrorReplayHolds.release("held-error"); server.shutdown(); Everframe.captureGate = false; root.deleteRecursively()
        }
    }

    @Test fun aLostReleaseLapsesAfterFiveSeconds() {
        assertEquals(5_000_000_000L, ErrorReplayHolds.HOLD_NANOS)
        ErrorReplayHolds.hold("lapsed", now = 0L)
        assertTrue(ErrorReplayHolds.isHeld("lapsed", now = 4_999_999_999L))
        assertFalse(ErrorReplayHolds.isHeld("lapsed", now = 5_000_000_000L))
        assertFalse("a lapsed hold is forgotten", ErrorReplayHolds.isHeld("lapsed", now = 0L))
    }
}
