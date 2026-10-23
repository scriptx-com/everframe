// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// A quick capture queued offline keeps the replay that `captureHotkey.replay` forced when the outbox
// drains it later, while quick capture still forces replay for the same project. Without forcing, the
// drain still strips replay unless the project's `replayEnabled` is true.
package dev.everframe.transport

import androidx.test.core.app.ApplicationProvider
import dev.everframe.Everframe
import dev.everframe.config.CaptureHotkeyConfigWire
import dev.everframe.config.EverframeConfig
import dev.everframe.config.ReplayConfig
import dev.everframe.identity.IdentityTokenHolder
import dev.everframe.outbox.JSONLOutbox
import dev.everframe.outbox.JceTestOutboxKeyProvider
import dev.everframe.outbox.JvmOutboxFileOps
import dev.everframe.outbox.OutboxEntry
import dev.everframe.quickcapture.QuickCapture
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class QuickCaptureReplayDrainTest {
    private val app = ApplicationProvider.getApplicationContext<android.app.Application>()
    private val server = MockWebServer()
    private val root = kotlin.io.path.createTempDirectory("quick-capture-drain").toFile()

    @Before fun setUp() {
        Everframe.captureGate = true
        QuickCapture.isEmulator = { true }
        // The project's own config: replay off, video settings present.
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = if (request.path == "/api/config")
                MockResponse().setBody("""{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,"nativeVideo":{"framesPerSecond":5}}""")
            else MockResponse().setResponseCode(200)
        }
        server.start()
    }

    @After fun tearDown() {
        QuickCapture.teardown()
        QuickCapture.__resetForTesting()
        Everframe.captureGate = false
        server.shutdown()
        root.deleteRecursively()
    }

    private fun armForcing() {
        QuickCapture.install(app, localEnabled = true, debug = true)
        QuickCapture.publishRemote(CaptureHotkeyConfigWire(enabled = true, replay = true))
        assertTrue(QuickCapture.forcesReplay)
    }

    /** Queues one quick capture with a screenshot and a video replay, drains it, and returns the upload body. */
    private fun drainQueuedReplay(entrySdkKey: String = "k"): String = runBlocking {
        val shot = MultipartUploader.Part("shot", "shot.png", "pixels".toByteArray(), "image/png")
        val video = MultipartUploader.Part("replay", "replay.mp4", ByteArray(3) { 42 }, "video/mp4")
        val envelope = buildJsonObject {
            put("reportId", "quick-capture"); put("quickCapture", true)
            putJsonObject("captureControl") { putJsonArray("included") {}; putJsonArray("excluded") {} }
            putJsonArray("attachments") {
                add(buildJsonObject { put("partName", "shot"); put("contentType", "image/png") })
                add(buildJsonObject { put("partName", "replay"); put("contentType", "video/mp4"); put("format", "everframe-video-v1") })
            }
        }.toString().toByteArray()
        val box = JSONLOutbox(File(root, "outbox-$entrySdkKey.jsonl"), keys = JceTestOutboxKeyProvider(), ops = JvmOutboxFileOps())
        box.enqueue(OutboxEntry("quick-capture", 1L, envelope, "idem", listOf(shot, video).map {
            OutboxEntry.AttachmentRef(it.name, it.filename!!, it.contentType, it.data, dev.everframe.capture.video.sha256(it.data))
        }, sdkKey = entrySdkKey, endpoint = server.url("/").toString()))
        ReportSubmitter(EverframeConfig("app", "k"), box, MultipartUploader(OkHttpClient()), server.url("/").toString())
            .drainOutbox(IdentityTokenHolder(), { ReplayConfig.OFF }, 0, { 0 })
        assertEquals("/api/config", server.takeRequest(3, TimeUnit.SECONDS)!!.path)
        val ingest = server.takeRequest(3, TimeUnit.SECONDS)!!
        assertEquals("/api/ingest", ingest.path)
        assertEquals(0, box.count())
        ingest.body.readUtf8().also { assertTrue("the report itself always ships", it.contains("pixels")) }
    }

    @Test fun aQueuedForcedQuickCaptureKeepsItsReplay() {
        armForcing()
        val body = drainQueuedReplay()
        assertTrue("the replay multipart part ships", body.contains("name=\"replay\"; filename=\"replay.mp4\""))
        assertTrue("with its bytes", body.contains("***"))
        assertFalse(body.contains("degradedReason"))
    }

    @Test fun withoutForcingTheDrainStillStripsReplayWhenReplayIsOff() {
        QuickCapture.install(app, localEnabled = true, debug = true)
        QuickCapture.publishRemote(CaptureHotkeyConfigWire(enabled = true))
        val body = drainQueuedReplay()
        assertFalse(body.contains("name=\"replay\""))
    }

    @Test fun forcingNeverKeepsReplayForAnotherProjectsEntry() {
        armForcing()
        val body = drainQueuedReplay(entrySdkKey = "other-project")
        assertFalse(body.contains("name=\"replay\""))
    }
}
