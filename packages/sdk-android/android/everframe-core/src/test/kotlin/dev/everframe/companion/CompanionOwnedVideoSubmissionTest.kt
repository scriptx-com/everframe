// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.companion

import android.app.Activity
import android.graphics.Bitmap
import dev.everframe.Everframe
import dev.everframe.capture.video.*
import dev.everframe.config.*
import dev.everframe.transport.*
import kotlinx.coroutines.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class CompanionOwnedVideoSubmissionTest {
    @Test fun liveOwnerShipsMeasuredVideoWithScreenshot() = drive("live")
    @Test fun cancelAfterVideoAssemblyPreservesTitleAndScreenshotOnly() = drive("cancel")
    @Test fun killAndPublicRestartAfterVideoAssemblyStartsNoRequest() = drive("kill")

    @Test fun optionalVideoCannotRejectCompanionWhenExtraShotsReachPayloadBudget() = drive("budget")

    private fun drive(action: String) = runBlocking {
        val activity = Robolectric.buildActivity(Activity::class.java).create().get()
        val config = EverframeConfig(appId = "a", sdkKey = "txx_live_test1234567890", capture = dev.everframe.config.CaptureConfig(logs = false))
        Everframe.start(activity, config)
        val session = Everframe.captureSessionSnapshot()
        val h = VideoExporterTest.Harness()
        val origin = object : ReplayCaptureOrigin {
            override val sessionId = h.owner.sessionId
            var allowed = true
            override fun replayAllowed(owner: VideoOwner, generation: Long) = allowed
            override suspend fun export(owner: VideoOwner, generation: Long): OwnedVideoClip? {
                if (action != "budget") return h.exporter.export(owner, listOf(h.segment())) { allowed }
                val file = java.io.File(h.root, "budget.mp4").apply { writeBytes(ByteArray(1_000_000)) }
                return OwnedVideoClip(owner, file, VideoMetadata(VideoSize(4, 4), 400, 12_000,
                    file.length(), sha256(file.readBytes())), VideoOwnedFile(file, h.budget.reserve(file.length())!!, h.budget) { it.delete() },
                    h.scheduler, AutoCloseable {})
            }
            override fun cancel(owner: VideoOwner) { allowed = false }
            override fun release(owner: VideoOwner) = Unit
        }
        val capture = FrozenReportCapture(h.owner, session.user.startEpoch, 1, origin, FrozenAncillarySnapshot(null, null))
        val server = MockWebServer().apply { start(); enqueue(MockResponse().setResponseCode(200)) }
        val assembled = CountDownLatch(1)
        val release = CountDownLatch(1)
        CompanionSubmissionComposer.__submitterFactoryForTesting = { cfg, outbox ->
            assembled.countDown()
            check(release.await(5, TimeUnit.SECONDS))
            ReportSubmitter(cfg, outbox, MultipartUploader(OkHttpClient()), server.url("/").toString())
        }
        val pending = async(Dispatchers.Default) { CompanionSubmissionComposer.submit(CompanionSubmissionComposer.Inputs(
            activity = activity, captureBitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888), capture = capture,
            title = "original title", description = "original description", includeLogs = false, includeNetwork = false,
            includeMetadata = false, hostExtra = null, companionAttribution = null, capturedSession = session,
            extraShotPngs = if (action == "budget") listOf(ByteArray(23_000_000)) else emptyList())) }
        try {
            val deadline = System.nanoTime() + 5_000_000_000L
            while (assembled.count > 0 && System.nanoTime() < deadline) {
                shadowOf(AndroidVideoCaptureScheduler.workerHandler.looper).idle()
                delay(5)
            }
            assertEquals("real composer must finish expensive attachment assembly", 0, assembled.count)
            when (action) {
                "cancel" -> capture.cancel()
                "kill" -> { Everframe.kill(); Everframe.start(activity, config.copy(appId = "b")) }
            }
            release.countDown()
            val result = pending.await()
            if (action == "kill") {
                assertTrue(result is ReportResult.Cancelled)
                assertEquals(0, server.requestCount)
                assertTrue(session.isRevoked)
            } else {
                assertTrue("$result", result is ReportResult.Submitted)
                val request = server.takeRequest(3, TimeUnit.SECONDS)!!
                val body = request.body.readUtf8()
                assertTrue(body.contains("original title"))
                assertTrue(body.contains("name=\"screenshot\""))
                val envelope = body.substringAfter("\r\n\r\n").substringBefore("\r\n--")
                val parsed = kotlinx.serialization.json.Json.parseToJsonElement(envelope).toString()
                assertEquals(action == "live", parsed.contains("everframe-video-v1"))
                assertEquals(action == "live", body.contains("Content-Type: video/mp4"))
                if (action == "budget") assertTrue(parsed.contains("replay_report_budget"))
                if (action == "live") { assertTrue(parsed.contains("replayStartEpochMs")); assertTrue(parsed.contains("400")) }
            }
        } finally {
            release.countDown(); pending.cancel(); capture.cancel(); CompanionSubmissionComposer.__submitterFactoryForTesting = null
            Everframe.kill(); server.shutdown(); h.root.deleteRecursively()
        }
    }
}
