// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Emulator quick capture's `captureHotkey.replay` flag. Replay records when the app's `replayEnabled` is
// true, or when quick capture is armed and the flag is true. The flag never turns replay off, and a disarm
// hands the decision back to `replayEnabled` at the next config apply. Drives the real
// `ReplaySession.refreshConfigNow()` against `QuickCapture`, the object that refresh publishes to.
// Android twin of iOS `QuickCaptureReplayTests`.

package dev.everframe.capture.replay

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import dev.everframe.Everframe
import dev.everframe.capture.NetworkBodyCaptureState
import dev.everframe.capture.video.NativeVideoRecorder
import dev.everframe.capture.video.RecordingVideoEncoder
import dev.everframe.capture.video.SafeVideoFrame
import dev.everframe.capture.video.VideoCaptureScheduler
import dev.everframe.capture.video.VideoDeviceConditions
import dev.everframe.capture.video.VideoExporterTest
import dev.everframe.capture.video.VideoSize
import dev.everframe.capture.video.VideoStartupAdmission
import dev.everframe.config.CaptureConfig
import dev.everframe.config.ConfigFetcher
import dev.everframe.config.EverframeConfig
import dev.everframe.config.ReplayConfigProvider
import dev.everframe.quickcapture.QuickCapture
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.ConcurrentLinkedDeque
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class QuickCaptureReplaySessionTest {
    private val app: Application = ApplicationProvider.getApplicationContext()
    private val h = VideoExporterTest.Harness()
    private val mainTasks = ConcurrentLinkedDeque<() -> Unit>()
    private val pts = AtomicLong()
    private val recorders = AtomicInteger()
    private val scheduler = object : VideoCaptureScheduler {
        override fun main(block: () -> Unit) { mainTasks.add(block) }
        override fun worker(block: () -> Unit) = block()
        override fun later(delayMs: Long, block: () -> Unit): () -> Unit = {}
        override fun isWorkerThread() = false
        override fun nowNanos() = 0L
    }
    private val sessions = mutableListOf<ReplaySession>()

    /** The `/api/config` body the fake server sends next. */
    @Volatile private var body = config(replayEnabled = false)

    /** `samplingRate` 0 keeps a session sampled out, so only forcing can make it record. */
    private fun config(replayEnabled: Boolean, samplingRate: Double = 1.0, hotkey: String? = null) =
        """{"replayEnabled":$replayEnabled,"replayDurationSec":30,"samplingRate":$samplingRate,""" +
            """"nativeVideo":{"framesPerSecond":2}""" + (hotkey?.let { ""","captureHotkey":$it""" } ?: "") + "}"

    private val forcing = """{"enabled":true,"replay":true}"""

    @Before fun setUp() {
        dev.everframe.shared.SharedData.init(app)
        NetworkBodyCaptureState.resetForTesting()
        Everframe.captureGate = true
        Everframe.__setConfigForTesting(EverframeConfig(appId = "a", sdkKey = "k",
            capture = CaptureConfig(logs = false, network = false)))
        QuickCapture.isEmulator = { true }
    }

    @After fun tearDown() {
        sessions.forEach { it.teardown() }; drainMain()
        QuickCapture.teardown()
        QuickCapture.__resetForTesting()
        Everframe.kill()
        NetworkBodyCaptureState.resetForTesting()
        h.root.deleteRecursively()
    }

    /** Quick capture as `start()` leaves it on a debug emulator; its block arrives with each served config. */
    private fun installQuickCapture(localEnabled: Boolean = true, debug: Boolean = true) =
        QuickCapture.install(app, localEnabled = localEnabled, debug = debug)

    private fun session(locallyDisabled: Boolean = false): ReplaySession {
        val session = ReplaySession(sdkKey = "k", context = app, locallyDisabled = locallyDisabled,
            provider = ReplayConfigProvider.make("https://a.test", "k", ConfigFetcher { request ->
                Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200)
                    .message("test").body(body.toResponseBody("application/json".toMediaType())).build()
            }))
        session.videoStartupAdmission = VideoStartupAdmission(scheduler) { _, _ -> true }
        session.videoDeviceConditions = object : VideoDeviceConditions {
            override fun pauseRecording() = false
            override val lowRamDevice = false
        }
        session.recorderFactory = { _, owner, _ ->
            recorders.incrementAndGet()
            NativeVideoRecorder(owner, scheduler, { block -> block(); true }, { VideoSize(4, 4) }, { null }, { _, _, _ ->
                object : RecordingVideoEncoder {
                    override fun prepare(size: VideoSize, fps: Int) = size
                    override fun offer(frame: SafeVideoFrame) = false
                    override fun finish(deadline: Long) = listOf(h.segment(pts.addAndGet(2_000_000), who = owner))
                    override val isTerminal = false
                    override fun close() = Unit
                }
            }, { segments, allowed -> h.exporter.export(owner, segments, allowed) },
                snapshotExporter = { segments, allowed -> h.exporter.export(owner, segments, allowed) })
        }
        sessions += session
        return session
    }

    private fun drainMain() { while (true) { (mainTasks.pollFirst() ?: break).invoke() } }
    private fun ReplaySession.refresh() { runBlocking { refreshConfigNow() }; drainMain() }
    private fun ReplaySession.recording() =
        Everframe.withReportAuthorizationLock { __lifecycleStateForTesting() } == NativeVideoRecorder.State.BUFFERING

    @Test fun armedWithTheReplayFlagRecordsWhileReplayIsOff() {
        installQuickCapture()
        body = config(replayEnabled = false, hotkey = forcing)
        val session = session()
        session.refresh()
        assertTrue(QuickCapture.forcesReplay)
        assertFalse(session.currentConfig.replayEnabled)
        assertTrue(session.recording())
        assertEquals(1, recorders.get())
    }

    /** A developer debug session: forced replay records even when the configured sampling rate drops it. */
    @Test fun forcedReplayIgnoresSampling() {
        installQuickCapture()
        for (replayEnabled in listOf(false, true)) {
            body = config(replayEnabled = replayEnabled, samplingRate = 0.0, hotkey = forcing)
            val session = session()
            session.refresh()
            assertTrue("replayEnabled=$replayEnabled", session.recording())
        }
    }

    @Test fun replayFollowsReplayEnabledWhenNotArmedOrNotFlagged() {
        val cases = listOf<Pair<String, () -> String?>>(
            "no block" to { installQuickCapture(); null },
            "block disabled" to { installQuickCapture(); """{"enabled":false,"replay":true}""" },
            "flag false" to { installQuickCapture(); """{"enabled":true,"replay":false}""" },
            "flag absent" to { installQuickCapture(); """{"enabled":true}""" },
            "flag malformed" to { installQuickCapture(); """{"enabled":true,"replay":"yes"}""" },
            "local opt-out" to { installQuickCapture(localEnabled = false); forcing },
            "release build" to { installQuickCapture(debug = false); forcing },
            "real device" to { QuickCapture.isEmulator = { false }; installQuickCapture(); forcing },
        )
        for ((name, arrange) in cases) {
            for (replayEnabled in listOf(false, true)) {
                QuickCapture.teardown(); QuickCapture.isEmulator = { true }
                body = config(replayEnabled = replayEnabled, hotkey = arrange())
                val session = session()
                session.refresh()
                assertFalse("$name: never forced", QuickCapture.forcesReplay)
                assertEquals("$name, replayEnabled=$replayEnabled", replayEnabled, session.recording())
            }
        }
    }

    /** A closed kill switch never records at all; quick capture never forces it open. */
    @Test fun aClosedKillSwitchNeverForces() {
        installQuickCapture()
        body = config(replayEnabled = false, hotkey = forcing)
        val session = session()
        Everframe.captureGate = false
        session.refresh()
        assertFalse(QuickCapture.forcesReplay)
        assertFalse(session.recording())
        assertEquals(0, recorders.get())
    }

    @Test fun theLocalVetoBeatsForcing() {
        installQuickCapture()
        body = config(replayEnabled = false, hotkey = forcing)
        val session = session(locallyDisabled = true)
        session.refresh()
        assertTrue(QuickCapture.forcesReplay)
        assertFalse(session.recording())
    }

    @Test fun aDisarmingRefreshStopsTheForcedRecording() {
        for (disarming in listOf(null, """{"enabled":false,"replay":true}""", """{"enabled":true,"replay":false}""")) {
            installQuickCapture()
            body = config(replayEnabled = false, hotkey = forcing)
            val session = session()
            session.refresh()
            assertTrue(session.recording())
            body = config(replayEnabled = false, hotkey = disarming)
            session.refresh()
            assertFalse("disarmed by $disarming", session.recording())
        }
    }

    @Test fun teardownStopsTheForcedRecordingAtTheNextApply() {
        installQuickCapture()
        body = config(replayEnabled = false, hotkey = forcing)
        val session = session()
        session.refresh()
        assertTrue(session.recording())
        QuickCapture.teardown()
        session.refresh()
        assertFalse(session.recording())
    }

    @Test fun aSampledOutSessionStopsWhenForcingEnds() {
        installQuickCapture()
        body = config(replayEnabled = true, samplingRate = 0.0, hotkey = forcing)
        val session = session()
        session.refresh()
        assertTrue(session.recording())
        body = config(replayEnabled = true, samplingRate = 0.0)
        session.refresh()
        assertFalse("the session's own draw decides again", session.recording())
    }

    @Test fun disarmingNeverStopsReplayTheAppEnabled() {
        installQuickCapture()
        body = config(replayEnabled = true, hotkey = forcing)
        val session = session()
        session.refresh()
        assertTrue(session.recording())
        body = config(replayEnabled = true)
        session.refresh()
        assertTrue(session.recording())
        assertEquals("forced to unforced with replayEnabled true is a no-op, not a restart", 1, recorders.get())
        QuickCapture.teardown()
        session.refresh()
        assertTrue(session.recording())
        assertEquals(1, recorders.get())
    }
}
