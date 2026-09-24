// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.everframe.CaptureExceptionOptions
import dev.everframe.ErrorSeverity
import dev.everframe.Everframe
import dev.everframe.config.EndpointOverride
import dev.everframe.config.EverframeConfig
import dev.everframe.outbox.CrashSidecar
import dev.everframe.outbox.JSONLOutbox
import dev.everframe.outbox.JceTestOutboxKeyProvider
import dev.everframe.outbox.JvmOutboxFileOps
import dev.everframe.shared.SharedData
import java.io.File
import java.nio.charset.StandardCharsets
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Job
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class HandledDetailsDeliveryTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun `public capture retries owned encrypted details with exact report identity and bytes`() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val appContextField = Everframe::class.java.getDeclaredField("appContext").apply { isAccessible = true }
        val sharedOutboxField = Everframe::class.java.getDeclaredField("sharedOutbox").apply { isAccessible = true }
        val previousContext = appContextField.get(null)
        val previousOutbox = sharedOutboxField.get(null)
        val previousEndpoint = EndpointOverride.current
        val storageDir = tmp.newFolder()
        val outboxFile = File(storageDir, "outbox.jsonl")
        val keys = JceTestOutboxKeyProvider()
        val captureOutbox = JSONLOutbox(outboxFile, keys, JvmOutboxFileOps())
        val firstEntered = CountDownLatch(1)
        val firstRelease = CountDownLatch(1)
        val secondEntered = CountDownLatch(1)
        val secondRelease = CountDownLatch(1)
        val server = MockWebServer()
        var attempts = 0
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path == "/api/config") return MockResponse().setResponseCode(200).setBody(
                    """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0}""",
                )
                if (request.path != "/api/ingest") return MockResponse().setResponseCode(404)
                attempts += 1
                val entered = if (attempts == 1) firstEntered else secondEntered
                val release = if (attempts == 1) firstRelease else secondRelease
                entered.countDown()
                check(release.await(5, TimeUnit.SECONDS))
                return MockResponse().setResponseCode(if (attempts == 1) 503 else 200)
            }
        }
        server.start()
        val metadata = linkedMapOf<String, Any?>("attempt" to 1, "token" to "plain-secret")

        try {
            EndpointOverride.current = server.url("/").toString()
            SharedData.init(context)
            CrashReporter.__resetForTesting()
            CrashReporter.configure(context)
            CrashReporter.sidecarFactory = {
                CrashSidecar(File(storageDir, "crash-outbox.jsonl"), keys, JvmOutboxFileOps())
            }
            appContextField.set(null, context.applicationContext)
            sharedOutboxField.set(null, captureOutbox)
            Everframe.__setConfigForTesting(EverframeConfig(appId = "delivery-app", sdkKey = "delivery-key"))
            Everframe.captureGate = true

            val jobsBeforeFirstDrain = Everframe.sdkScope.coroutineContext[Job]!!.children.toSet()
            Everframe.captureException(
                IllegalStateException("delivery probe"),
                CaptureExceptionOptions(ErrorSeverity.WARNING, "checkout", metadata),
            )
            metadata["attempt"] = 2
            metadata["later"] = "mutated"

            assertTrue("first public drain must reach ingest", firstEntered.await(5, TimeUnit.SECONDS))
            val firstJobs = Everframe.sdkScope.coroutineContext[Job]!!.children
                .filterNot { it in jobsBeforeFirstDrain }.toList()
            val reopenedAfterCapture = JSONLOutbox(outboxFile, keys, JvmOutboxFileOps())
            val accepted = reopenedAfterCapture.hydrate().single()
            val crash = Json.parseToJsonElement(accepted.envelopeBytes.decodeToString())
                .jsonObject["payload"]!!.jsonObject["crash"]!!.jsonObject
            val details = crash["details"]!!.jsonObject
            assertEquals("warning", details["severity"]!!.jsonPrimitive.content)
            assertEquals("checkout", details["context"]!!.jsonPrimitive.content)
            assertEquals(1, details["metadata"]!!.jsonObject["attempt"]!!.jsonPrimitive.int)
            assertEquals("[REDACTED]", details["metadata"]!!.jsonObject["token"]!!.jsonPrimitive.content)
            assertNull(details["metadata"]!!.jsonObject["later"])
            assertFalse(File(storageDir, "outbox.jsonl.encrypted").walkTopDown().filter { it.isFile }
                .any { String(it.readBytes()).contains("delivery probe") })

            firstRelease.countDown()
            withTimeout(5_000) { firstJobs.joinAll() }
            val firstConfigRequest = server.takeRequest(5, TimeUnit.SECONDS)
            assertEquals("/api/config", firstConfigRequest?.path)
            val firstRequest = server.takeRequest(5, TimeUnit.SECONDS)
            assertNotNull(firstRequest)
            assertEquals("/api/ingest", firstRequest!!.path)
            assertEquals("delivery-key", firstRequest.getHeader("Authorization")!!.removePrefix("Bearer "))
            assertEquals(accepted.idempotencyKey, firstRequest.getHeader("X-Everframe-Idempotency-Key"))
            assertArrayEquals(accepted.envelopeBytes, envelopePart(firstRequest))

            val reopenedAfterFailure = JSONLOutbox(outboxFile, keys, JvmOutboxFileOps())
            val retained = reopenedAfterFailure.hydrate().single()
            assertEquals(accepted.reportId, retained.reportId)
            assertEquals(accepted.idempotencyKey, retained.idempotencyKey)
            assertArrayEquals(accepted.envelopeBytes, retained.envelopeBytes)
            assertEquals("a queued 503 waits for a later requested drain", 1, attempts)
            sharedOutboxField.set(null, reopenedAfterFailure)

            val jobsBeforeSecondDrain = Everframe.sdkScope.coroutineContext[Job]!!.children.toSet()
            Everframe.requestOutboxDrain()
            assertTrue("explicit second drain must reach ingest", secondEntered.await(5, TimeUnit.SECONDS))
            val secondJobs = Everframe.sdkScope.coroutineContext[Job]!!.children
                .filterNot { it in jobsBeforeSecondDrain }.toList()
            secondRelease.countDown()
            withTimeout(5_000) { secondJobs.joinAll() }
            val secondConfigRequest = server.takeRequest(5, TimeUnit.SECONDS)
            assertEquals("/api/config", secondConfigRequest?.path)
            val secondRequest = server.takeRequest(5, TimeUnit.SECONDS)
            assertNotNull(secondRequest)
            assertEquals(accepted.idempotencyKey, secondRequest!!.getHeader("X-Everframe-Idempotency-Key"))
            val secondEnvelope = envelopePart(secondRequest)
            assertArrayEquals(accepted.envelopeBytes, secondEnvelope)
            assertEquals(accepted.reportId,
                Json.parseToJsonElement(secondEnvelope.decodeToString()).jsonObject["reportId"]!!.jsonPrimitive.content)
            assertTrue(JSONLOutbox(outboxFile, keys, JvmOutboxFileOps()).hydrate().isEmpty())
            assertEquals(2, attempts)
        } finally {
            firstRelease.countDown()
            secondRelease.countDown()
            EndpointOverride.current = previousEndpoint
            Everframe.__setConfigForTesting(null)
            Everframe.captureGate = false
            CrashReporter.__resetForTesting()
            sharedOutboxField.set(null, previousOutbox)
            appContextField.set(null, previousContext)
            server.shutdown()
        }
    }

    private fun envelopePart(request: RecordedRequest): ByteArray {
        val contentType = requireNotNull(request.getHeader("Content-Type"))
        val boundary = requireNotNull(contentType.substringAfter("boundary=", "").trim('"').takeIf { it.isNotEmpty() })
        val body = request.body.readByteArray().toString(StandardCharsets.ISO_8859_1)
        val envelopeHeader = body.indexOf("name=\"envelope\"")
        require(envelopeHeader >= 0)
        val start = body.indexOf("\r\n\r\n", envelopeHeader) + 4
        require(start >= 4)
        val end = body.indexOf("\r\n--$boundary", start)
        require(end >= start)
        return body.substring(start, end).toByteArray(StandardCharsets.ISO_8859_1)
    }
}
