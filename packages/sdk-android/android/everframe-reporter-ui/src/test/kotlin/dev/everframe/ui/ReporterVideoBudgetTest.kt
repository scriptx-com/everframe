// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
@file:Suppress("INVISIBLE_MEMBER", "INVISIBLE_REFERENCE")
package dev.everframe.ui

import android.app.Activity
import android.graphics.Bitmap
import dev.everframe.Everframe
import dev.everframe.capture.ScreenshotCapture
import dev.everframe.capture.video.*
import dev.everframe.config.*
import dev.everframe.transport.*
import dev.everframe.ui.details.ReporterIncludes
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class ReporterVideoBudgetTest {
    @Test fun fiveShotsOmitOwnedVideoButFourShotsKeepIt() = runBlocking {
        for (shotCount in listOf(5, 4)) {
            val activity = Robolectric.buildActivity(Activity::class.java).create().get()
            Everframe.start(activity, EverframeConfig("a", "txx_live_test1234567890", capture = CaptureConfig(logs = false)))
            val session = Everframe.captureSessionSnapshot()
            val root = kotlin.io.path.createTempDirectory("reporter-video-budget").toFile()
            val owner = VideoOwner("session", "capture")
            val file = File(root, "replay.mp4").apply { writeBytes(byteArrayOf(1, 2, 3)) }
            val budget = VideoDiskBudget()
            val clip = OwnedVideoClip(owner, file, VideoMetadata(VideoSize(4, 4), 400, 12_000, 3, sha256(file.readBytes())),
                VideoOwnedFile(file, budget.reserve(3)!!, budget) { it.delete() }, AndroidVideoCaptureScheduler, AutoCloseable {})
            var exported = false
            val origin = object : ReplayCaptureOrigin {
                override val sessionId = owner.sessionId
                override fun replayAllowed(owner: VideoOwner, generation: Long) = true
                override suspend fun export(owner: VideoOwner, generation: Long): OwnedVideoClip { exported = true; return clip }
                override fun cancel(owner: VideoOwner) = Unit
                override fun release(owner: VideoOwner) = Unit
            }
            val owned = FrozenReportCapture(owner, session.user.startEpoch, 1, origin, FrozenAncillarySnapshot(null, null))
            val server = MockWebServer().apply { start(); enqueue(MockResponse().setResponseCode(200)) }
            ReporterDialog.__submitterFactoryForTesting = { cfg, _ -> ReportSubmitter(cfg, testOutbox(), MultipartUploader(OkHttpClient()), server.url("/").toString()) }
            try {
                val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
                val pending = async(Dispatchers.Default) {
                    ReporterDialog.submitBaked(activity, ScreenshotCapture.CaptureResult(bitmap, 2, 2, byteArrayOf()), owned,
                        List(shotCount) { SubmittedShot(bitmap, emptyList()) }, "original title", "original description", session,
                        null, ReporterIncludes())
                }
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
                while (!pending.isCompleted && System.nanoTime() < deadline) {
                    shadowOf(AndroidVideoCaptureScheduler.workerHandler.looper).idle()
                    shadowOf(android.os.Looper.getMainLooper()).idle()
                    delay(5)
                }
                assertTrue("reporter completed", pending.isCompleted)
                assertTrue("${pending.await()}", pending.await() is ReportResult.Submitted)
                assertTrue("real NativeVideoAttachment consumed the owned clip", exported && !file.exists())
                val request = server.takeRequest(3, TimeUnit.SECONDS)!!
                val body = request.body.readUtf8()
                assertEquals(6, Regex("Content-Disposition: form-data;").findAll(body).count())
                assertTrue(body.contains("original title")); assertTrue(body.contains("original description"))
                assertEquals(shotCount == 4, body.contains("Content-Type: video/mp4"))
                val env = Json.parseToJsonElement(body.substringAfter("\r\n\r\n").substringBefore("\r\n--")).jsonObject
                assertEquals(5, env["attachments"]!!.jsonArray.size)
                assertEquals(shotCount == 4, env.toString().contains("everframe-video-v1"))
                if (shotCount == 5) assertEquals("replay_part_limit", env["captureControl"]!!.jsonObject["degradedReason"]!!.jsonPrimitive.content)
            } finally {
                ReporterDialog.__submitterFactoryForTesting = null; owned.cancel(); clip.close()
                Everframe.kill(); server.shutdown(); root.deleteRecursively()
            }
        }
    }
}
