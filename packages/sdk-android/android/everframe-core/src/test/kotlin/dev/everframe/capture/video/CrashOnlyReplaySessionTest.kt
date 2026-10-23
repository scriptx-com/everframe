// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Crash-only sessions (spec 2026-10-12): a session started with reporterEnabled = false samples replay at
// the server's crashOnlySamplingRate and keeps network bodies off for the whole session. Error replays follow recording: with no recorder,
// beginErrorReplay() returns null, so an error carries no replay and no replay_omitted flag
// (ErrorReplayCaptureTest's "without a recording the error is stored exactly as before").

package dev.everframe.capture.video

import androidx.test.core.app.ApplicationProvider
import dev.everframe.Everframe
import dev.everframe.capture.NetworkBodyCaptureState
import dev.everframe.capture.replay.ReplayCoverage
import dev.everframe.capture.replay.ReplaySession
import dev.everframe.config.CaptureConfig
import dev.everframe.config.ConfigFetcher
import dev.everframe.config.EverframeConfig
import dev.everframe.config.ReplayConfigProvider
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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
class CrashOnlyReplaySessionTest {
    private val h = VideoExporterTest.Harness()
    private val mainTasks = ConcurrentLinkedDeque<() -> Unit>()
    private val pts = AtomicLong()
    private val recorders = AtomicInteger()
    @Volatile private var captureNow = 0L
    private val scheduler = object : VideoCaptureScheduler {
        override fun main(block: () -> Unit) { mainTasks.add(block) }
        override fun worker(block: () -> Unit) = block()
        override fun later(delayMs: Long, block: () -> Unit): () -> Unit = {}
        override fun isWorkerThread() = false
        override fun nowNanos() = captureNow
    }
    /** The `crashOnlySamplingRate` JSON value the fake server sends; null leaves the field out. */
    @Volatile private var crashOnlyRate: String? = null
    /** The `samplingRate` JSON value the fake server sends. */
    @Volatile private var reportRate = "1.0"
    /** When set, `/api/config` answers 503. */
    @Volatile private var serverDown = false
    private val fetches = AtomicInteger()
    private lateinit var session: ReplaySession

    private fun config(reporterEnabled: Boolean) = EverframeConfig(appId = "a", sdkKey = "k",
        capture = CaptureConfig(logs = false, network = true), reporterEnabled = reporterEnabled)

    private fun body() = """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":$reportRate,""" +
        """"nativeVideo":{"framesPerSecond":2},"networkBodies":{"captureBodies":true}""" +
        (crashOnlyRate?.let { ""","crashOnlySamplingRate":$it""" } ?: "") + "}"

    @Before fun setUp() {
        dev.everframe.shared.SharedData.init(ApplicationProvider.getApplicationContext())
        NetworkBodyCaptureState.resetForTesting()
        Everframe.captureGate = true
        Everframe.__setConfigForTesting(config(reporterEnabled = false))
        session = buildSession()
    }

    private fun buildSession(): ReplaySession {
        val session = ReplaySession(sdkKey = "k", context = ApplicationProvider.getApplicationContext(),
            provider = ReplayConfigProvider.make("https://a.test", "k", ConfigFetcher { request ->
                fetches.incrementAndGet()
                Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(if (serverDown) 503 else 200)
                    .message("test").body(body().toResponseBody("application/json".toMediaType())).build()
            }))
        session.videoStartupAdmission = VideoStartupAdmission(scheduler) { _, _ -> true }
        session.videoDeviceConditions = object : VideoDeviceConditions {
            override fun pauseRecording() = false
            override val lowRamDevice = false
        }
        session.errorReplayAttachment = { clip -> NativeVideoAttachment(h.scheduler).build(clip) }
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
        return session
    }

    @After fun tearDown() {
        session.teardown(); drainMain()
        // kill() is the production reset: it ends the config and the gate together.
        Everframe.kill()
        NetworkBodyCaptureState.resetForTesting()
        h.root.deleteRecursively()
    }

    private fun drainMain() { while (true) { (mainTasks.pollFirst() ?: break).invoke() } }
    private fun refresh() { runBlocking { session.refreshConfigNow() }; drainMain() }
    private fun lifecycle() = Everframe.withReportAuthorizationLock { session.__lifecycleStateForTesting() }

    /** Claims, exports and releases one error replay; true when the session had a recording to give. */
    private fun errorReplayAttaches(): Boolean = runBlocking {
        captureNow = 20_000_000_000L // The recording started at 0: an error 20 s in has history to take.
        val snapshot = session.beginErrorReplay() ?: return@runBlocking false
        val pair = snapshot.await()
        snapshot.settle(false); drainMain()
        pair != null
    }

    @Test fun aCrashOnlySessionAtTheDefaultRateNeverRecords() {
        for (rate in listOf(null, "0", "0.0")) {
            crashOnlyRate = rate
            refresh()
            assertTrue(Everframe.crashOnlyCoverage())
            assertEquals("crash-only rate $rate: no recorder is ever created", 0, recorders.get())
            assertNull("so an error has no replay to claim, and no replay_omitted flag", session.beginErrorReplay())
            assertFalse("network bodies stay off in a crash-only session", NetworkBodyCaptureState.isActive)
        }
    }

    @Test fun aCrashOnlySessionRecordsAtTheCrashOnlyRateWithBodiesStillOff() {
        crashOnlyRate = "1.0"
        refresh()
        assertEquals(1, recorders.get())
        assertEquals(NativeVideoRecorder.State.BUFFERING, lifecycle())
        assertTrue("a sampled crash-only session gives its errors replays", errorReplayAttaches())
        assertFalse(NetworkBodyCaptureState.isActive)
    }

    @Test fun aReportSessionSamplesAtTheReportRateAndIgnoresTheCrashOnlyRate() {
        Everframe.__setConfigForTesting(config(reporterEnabled = true))
        crashOnlyRate = "0"
        refresh()
        assertFalse(Everframe.crashOnlyCoverage())
        assertEquals(1, recorders.get())
        assertTrue(NetworkBodyCaptureState.isActive)
    }

    @Test fun anAdmittedCrashOnlySessionKeepsRecordingWhenTheRateDrops() {
        crashOnlyRate = "1.0"
        refresh()
        assertEquals(1, recorders.get())
        crashOnlyRate = "0.0"
        refresh(); refresh()
        assertEquals("an admission is kept for the session", 1, recorders.get())
        assertEquals(NativeVideoRecorder.State.BUFFERING, lifecycle())
    }

    @Test fun aReportSessionKeepsItsAdmissionWhenTheRateDrops() {
        Everframe.__setConfigForTesting(config(reporterEnabled = true))
        refresh()
        reportRate = "0.0"
        refresh()
        assertEquals(1, recorders.get())
        assertEquals(NativeVideoRecorder.State.BUFFERING, lifecycle())
    }

    @Test fun aRefusalIsComparedAgainstTheLiveRateAgain() {
        crashOnlyRate = "0.0"
        refresh()
        assertEquals(0, recorders.get())
        crashOnlyRate = "1.0"
        refresh()
        assertEquals("a no is not sticky: a raised rate admits the session", 1, recorders.get())
    }

    @Test fun eachCoverageSamplesAtItsOwnRate() {
        assertEquals(0.4, ReplayCoverage.Report.samplingRate(0.4, 0.9), 0.0)
        assertEquals(0.9, ReplayCoverage.CrashOnly.samplingRate(0.4, 0.9), 0.0)
        assertEquals(0.0, ReplayCoverage.CrashOnly.samplingRate(0.4, null), 0.0)
    }
}
