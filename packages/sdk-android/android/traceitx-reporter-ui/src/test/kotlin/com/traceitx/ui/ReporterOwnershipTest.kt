// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.ui

import android.app.Activity
import android.graphics.Bitmap
import com.traceitx.TraceItX
import com.traceitx.capture.ScreenshotCapture
import com.traceitx.capture.sharedBreadcrumbBuffer
import com.traceitx.config.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class ReporterOwnershipTest {
    @After fun close() { TraceItX.kill() }

    @Test fun reporterFreezesBeforeScreenshotAndMountAndCancelsOnlyItsHandle() = runBlocking {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val config = TraceItXConfig(appId = "a", sdkKey = "txx_live_test1234567890", capture = com.traceitx.config.CaptureConfig(logs = false))
        TraceItX.start(activity, config)
        awaitSession()
        sharedBreadcrumbBuffer.clear()
        TraceItX.addBreadcrumb("before-open")
        val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
        var messagesAtMount: List<String>? = null
        var old: com.traceitx.capture.video.FrozenReportCapture? = null
        var replacement: com.traceitx.capture.video.FrozenReportCapture? = null
        val presenter = TXReporterPresenter(
            captureScreenshot = { _, _ ->
                TraceItX.addBreadcrumb("after-screenshot-start")
                ScreenshotCapture.CaptureResult(bitmap, 2, 2, byteArrayOf(1))
            },
            showDialog = { _, _, capture, _ ->
                old = capture
                messagesAtMount = capture.takeBreadcrumbs()?.map { it.message }
                TraceItX.start(activity, config.copy(appId = "b"))
                awaitSession()
                sharedBreadcrumbBuffer.clear()
                TraceItX.addBreadcrumb("replacement")
                replacement = TraceItX.__replayFreeze()
                ReportResult.Cancelled("test")
            },
        )
        assertTrue(presenter.openReporter(activity) is ReportResult.Cancelled)
        assertEquals(listOf("before-open"), messagesAtMount)
        assertNull(old!!.takeNetworkBodies())
        assertEquals(listOf("replacement"), replacement!!.takeBreadcrumbs()!!.map { it.message })
        replacement!!.cancel()
    }
    @Test @Config(sdk = [28])
    fun api28ReporterSubmitsOriginalScreenshotWithoutReplay() = submitOwned(false)

    @Test
    fun submitConsumesOnlyItsOriginalHandleAfterSessionReplacement() = submitOwned(true)

    private fun submitOwned(replace: Boolean) = runBlocking {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val config = TraceItXConfig(appId = "a", sdkKey = "txx_live_test1234567890", capture = com.traceitx.config.CaptureConfig(logs = false))
        TraceItX.start(activity, config)
        awaitSession()
        val owner = TraceItX.__replayFreeze()
        val session = TraceItX.captureSessionSnapshot()
        var newer: com.traceitx.capture.video.FrozenReportCapture? = null
        if (replace) {
            TraceItX.start(activity, config.copy(appId = "b")); awaitSession()
            sharedBreadcrumbBuffer.clear(); TraceItX.addBreadcrumb("newer-owner")
            newer = TraceItX.__replayFreeze()
        }
        val server = okhttp3.mockwebserver.MockWebServer().apply { start(); enqueue(okhttp3.mockwebserver.MockResponse().setResponseCode(200)) }
        ReporterDialog.__submitterFactoryForTesting = { cfg, outbox ->
            com.traceitx.transport.ReportSubmitter(cfg, outbox, com.traceitx.transport.MultipartUploader(okhttp3.OkHttpClient()), server.url("/").toString())
        }
        val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
        try {
            val result = ReporterDialog.submitBaked(activity, ScreenshotCapture.CaptureResult(bitmap, 2, 2, byteArrayOf(1)),
                owner, listOf(SubmittedShot(bitmap, emptyList())), "original title", "description", session, null,
                com.traceitx.ui.details.ReporterIncludes())
            assertTrue("$result", result is ReportResult.Submitted)
            val request = server.takeRequest(3, java.util.concurrent.TimeUnit.SECONDS)!!
            val body = request.body.readUtf8()
            assertTrue(body.contains("original title")); assertTrue(body.contains("name=\"screenshot\""))
            assertFalse(body.contains("video/mp4")); assertFalse(body.contains("traceitx-vtree-v1"))
            assertEquals("Bearer txx_live_test1234567890", request.getHeader("Authorization"))
            assertNull(owner.takeBreadcrumbs())
            if (replace) assertEquals(listOf("newer-owner"), newer!!.takeBreadcrumbs()!!.map { it.message })
        } finally { owner.cancel(); newer?.cancel(); ReporterDialog.__submitterFactoryForTesting = null; server.shutdown() }
    }

    @Test fun replacementReportWireContainsNewLogsAndNoPreviousProjectLogs() = runBlocking {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val config = TraceItXConfig(appId = "A", sdkKey = "txx_live_projectA1234567890", capture = CaptureConfig(logs = true))
        TraceItX.start(activity, config); awaitSession()
        val old = "project-A-private-log"
        println(old)
        assertTrue(com.traceitx.capture.sharedLogBuffer.snapshot().any { it.message == old })
        TraceItX.start(activity, config.copy(appId = "B", sdkKey = "txx_live_projectB1234567890")); awaitSession()
        val fresh = "project-B-current-log"
        println(fresh)
        val owner = TraceItX.__replayFreeze()
        val session = TraceItX.captureSessionSnapshot()
        val server = okhttp3.mockwebserver.MockWebServer().apply { start(); enqueue(okhttp3.mockwebserver.MockResponse().setResponseCode(200)) }
        ReporterDialog.__submitterFactoryForTesting = { cfg, outbox ->
            com.traceitx.transport.ReportSubmitter(cfg, outbox, com.traceitx.transport.MultipartUploader(okhttp3.OkHttpClient()), server.url("/").toString())
        }
        val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
        try {
            val result = ReporterDialog.submitBaked(activity, ScreenshotCapture.CaptureResult(bitmap, 2, 2, byteArrayOf(1)),
                owner, listOf(SubmittedShot(bitmap, emptyList())), "B report", "description", session, null,
                com.traceitx.ui.details.ReporterIncludes())
            assertTrue("$result", result is ReportResult.Submitted)
            val request = server.takeRequest(3, java.util.concurrent.TimeUnit.SECONDS)!!
            val body = request.body.readUtf8()
            assertEquals("Bearer txx_live_projectB1234567890", request.getHeader("Authorization"))
            assertTrue("new logs must remain enabled on actual B report", body.contains(fresh))
            assertFalse("A log must never ship under B's key", body.contains(old))
        } finally { owner.cancel(); ReporterDialog.__submitterFactoryForTesting = null; server.shutdown() }
    }

    @Test fun reportPausedAtLogSnapshotCannotSendReplacementProjectsLogs() = pausedEvidenceSnapshot(false)
    @Test fun reportPausedAtNetworkSnapshotCannotSendReplacementProjectsMetadata() = pausedEvidenceSnapshot(true)

    private fun pausedEvidenceSnapshot(network: Boolean) {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val config = TraceItXConfig(appId = "B", sdkKey = "txx_live_projectB1234567890", capture = CaptureConfig(logs = true))
        TraceItX.start(activity, config); awaitSession()
        val owner = TraceItX.__replayFreeze()
        val session = TraceItX.captureSessionSnapshot()
        val server = okhttp3.mockwebserver.MockWebServer().apply { start(); enqueue(okhttp3.mockwebserver.MockResponse().setResponseCode(200)) }
        ReporterDialog.__submitterFactoryForTesting = { cfg, outbox ->
            com.traceitx.transport.ReportSubmitter(cfg, outbox, com.traceitx.transport.MultipartUploader(okhttp3.OkHttpClient()), server.url("/").toString())
        }
        val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
        val result = java.util.concurrent.atomic.AtomicReference<ReportResult>()
        val failure = java.util.concurrent.atomic.AtomicReference<Throwable>()
        val sender = Thread {
            try {
                result.set(runBlocking {
                    ReporterDialog.submitBaked(activity, ScreenshotCapture.CaptureResult(bitmap, 2, 2, byteArrayOf(1)),
                        owner, listOf(SubmittedShot(bitmap, emptyList())), "B report", "description", session, null,
                        com.traceitx.ui.details.ReporterIncludes())
                })
            } catch (t: Throwable) { failure.set(t) }
        }
        val ring: Any = if (network) com.traceitx.capture.sharedNetworkBuffer else com.traceitx.capture.sharedLogBuffer
        val lock = ring.javaClass.getDeclaredField("lock").apply { isAccessible = true }.get(ring) as java.util.concurrent.locks.ReentrantLock
        val marker = "project-C-private-after-B-check"
        try {
            lock.lock()
            try {
                sender.start()
                val deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(5)
                while (!lock.hasQueuedThread(sender) && System.nanoTime() < deadline) Thread.yield()
                assertTrue("B submit passed its session check and reached the actual log snapshot", lock.hasQueuedThread(sender))
                TraceItX.start(activity, config.copy(appId = "C", sdkKey = "txx_live_projectC1234567890")); awaitSession()
                if (network) com.traceitx.capture.sharedNetworkBuffer.push(com.traceitx.capture.NetworkRingBuffer.Entry(
                    timestamp = 1L, method = "GET", url = "https://fixture.test/$marker", status = 200, durationMs = 1L,
                    requestHeaders = emptyMap(), responseHeaders = emptyMap(), errorMessage = null,
                )) else println(marker)
                assertTrue("C evidence must actually be present at the paused snapshot boundary", if (network)
                    com.traceitx.capture.sharedNetworkBuffer.snapshot().any { it.url.contains(marker) }
                    else com.traceitx.capture.sharedLogBuffer.snapshot().any { it.message == marker })
            } finally { lock.unlock(); sender.join(5_000) }
            failure.get()?.let { throw it }
            assertFalse(sender.isAlive)
            assertTrue("${result.get()}", result.get() is ReportResult.Submitted)
            val request = server.takeRequest(3, java.util.concurrent.TimeUnit.SECONDS)!!
            assertEquals("Bearer txx_live_projectB1234567890", request.getHeader("Authorization"))
            assertFalse("C evidence must never ship in B's normal report", request.body.readUtf8().contains(marker))
        } finally { owner.cancel(); ReporterDialog.__submitterFactoryForTesting = null; server.shutdown() }
    }

    private fun awaitSession() {
        val field = TraceItX::class.java.getDeclaredField("_replaySession").apply { isAccessible = true }
        val deadline = System.nanoTime() + 5_000_000_000L
        while (field.get(null) == null && System.nanoTime() < deadline) {
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
            Thread.sleep(5)
        }
        assertNotNull("public start must install its coordinator", field.get(null))
    }

}
