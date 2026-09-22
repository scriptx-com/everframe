// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx

import androidx.test.core.app.ApplicationProvider
import com.traceitx.config.TraceItXConfig
import com.traceitx.outbox.*
import kotlinx.coroutines.*
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class PublicDrainCaptureBoundaryTest {
    @Test fun startCapturesKillAuthorityBeforeLaunch() = drive(true, true)
    @Test fun requestedDrainCapturesKillAuthorityBeforeLaunch() = drive(false, true)
    @Test fun startRetainsOriginalStoredRouteAfterPublicRestart() = drive(true, false)
    @Test fun requestedDrainRetainsOriginalStoredRouteAfterPublicRestart() = drive(false, false)

    private fun drive(startCaller: Boolean, kill: Boolean) = runBlocking {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val server = MockWebServer().apply {
            dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest) = MockResponse().setResponseCode(200).setBody(
                    if (request.path!!.startsWith("/api/config")) """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0}""" else "{}")
            }
            start()
        }
        val field = TraceItX::class.java.getDeclaredField("sharedOutbox").apply { isAccessible = true }
        fun store() = JSONLOutbox(File(kotlin.io.path.createTempDirectory("public-drain").toFile(), "outbox.jsonl"),
            keys = JceTestOutboxKeyProvider(), ops = JvmOutboxFileOps())
        val originalStore = store()
        val originalEntry = entry("00000000-0000-0000-0000-000000000001").copy(endpoint = server.url("/").toString(), sdkKey = "original-key")
        originalStore.enqueue(originalEntry)
        fun settleStart() {
            val replay = TraceItX::class.java.getDeclaredField("_replaySession").apply { isAccessible = true }
            val deadline = System.nanoTime() + 5_000_000_000L
            while (replay.get(null) == null && System.nanoTime() < deadline) {
                org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
                Thread.sleep(5)
            }
            val installed = replay.get(null)
            assertNotNull(installed)
            // start publishes the session before enabling it. Complete that
            // idempotent phase before snapshotting SDK jobs, or the permanent
            // refresh loop can be mistaken for a later drain job and joined.
            (installed as com.traceitx.capture.replay.ReplaySession).enableIfConfigured()
        }
        var beforeOldLaunch = emptySet<Job>()
        val config = TraceItXConfig(appId = "a", sdkKey = "txx_live_test1234567890", capture = com.traceitx.config.CaptureConfig(logs = false))
        if (!startCaller) { TraceItX.start(context, config); settleStart() }
        var original: TXCapturedSession? = null
        var hookRan = false
        TraceItX.__beforeDrainLaunchForTesting = {
            TraceItX.__beforeDrainLaunchForTesting = null
            hookRan = true
            original = TraceItX.captureSessionSnapshot()
            if (kill) TraceItX.kill()
            field.set(null, store())
            TraceItX.start(context, config.copy(appId = "replacement"))
            settleStart()
            // The old durable entry remains available, so no-HTTP cannot pass merely because kill erased it.
            field.set(null, originalStore)
            beforeOldLaunch = TraceItX.sdkScope.coroutineContext[Job]!!.children.toSet()
        }
        try {
            if (startCaller) TraceItX.start(context, config) else TraceItX.requestOutboxDrain()
            withTimeout(5_000) { TraceItX.sdkScope.coroutineContext[Job]!!.children.filterNot { it in beforeOldLaunch }.toList().joinAll() }
            assertTrue(hookRan)
            assertTrue(TraceItX.captureGate)
            assertEquals(kill, original!!.isRevoked)
            if (kill) {
                assertEquals(0, server.requestCount)
                assertEquals(1, originalStore.hydrate().size)
            } else {
                val configRequest = server.takeRequest(3, TimeUnit.SECONDS)!!
                val report = server.takeRequest(3, TimeUnit.SECONDS)!!
                assertEquals("Bearer original-key", configRequest.getHeader("Authorization"))
                assertEquals("/api/ingest", report.path)
                assertEquals("Bearer original-key", report.getHeader("Authorization"))
                assertEquals(originalEntry.idempotencyKey, report.getHeader("X-TraceItX-Idempotency-Key"))
                assertNull(report.getHeader("X-TX-Identity-Token"))
                assertTrue(originalStore.hydrate().isEmpty())
            }
        } finally {
            TraceItX.__resetStartTailDelayHookForTesting(); field.set(null, null); TraceItX.kill(); server.shutdown()
        }
    }
}
