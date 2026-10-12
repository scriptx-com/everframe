// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Crash-only sessions (spec 2026-10-12): a session started with reporterEnabled = false samples replay at
// the server's crashOnlySamplingRate and keeps network bodies off, until a companion bond upgrades it to
// report coverage for the rest of the session. Error replays follow recording: with no recorder,
// beginErrorReplay() returns null, so an error carries no replay and no replay_omitted flag
// (ErrorReplayCaptureTest's "without a recording the error is stored exactly as before").

package dev.everframe.capture.video

import androidx.test.core.app.ApplicationProvider
import dev.everframe.Everframe
import dev.everframe.capture.NetworkBodyCaptureState
import dev.everframe.capture.replay.ReplayCoverage
import dev.everframe.capture.replay.ReplaySession
import dev.everframe.companion.Companion
import dev.everframe.companion.CompanionState
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
        Companion.__setState(CompanionState.Unpaired)
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
        // kill() is the production reset: it ends the upgrade, the config and the gate together.
        Everframe.kill()
        Companion.__setState(CompanionState.Unpaired)
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

    @Test fun aCompanionBondUpgradesTheRunningSessionToReportCoverage() {
        refresh()
        assertEquals(0, recorders.get())
        Everframe._replaySession = session
        try {
            Everframe.__onCompanionMemberAttached()
            assertFalse("the upgrade is visible at once", Everframe.crashOnlyCoverage())
            // The bond forces a refresh of the installed session on the SDK scope.
            val deadline = System.currentTimeMillis() + 5_000
            while (lifecycle() != NativeVideoRecorder.State.BUFFERING) {
                assertTrue("the bond's refresh never started recording", System.currentTimeMillis() < deadline)
                Thread.sleep(10)
            }
            drainMain()
        } finally { Everframe._replaySession = null }
        assertEquals(1, recorders.get())
        assertTrue("server body rules apply from the bond on", NetworkBodyCaptureState.isActive)
        assertTrue("errors after the bond carry replays", errorReplayAttaches())
    }

    @Test fun theUpgradeOutlivesLaterRefreshesAndADetach() {
        refresh()
        Everframe.__onCompanionMemberAttached() // No installed session: the next refresh reads the upgrade.
        refresh()
        assertEquals(1, recorders.get())
        Companion.__setAttachedUserName(null)
        Companion.__setState(CompanionState.Unpaired)
        refresh(); refresh()
        assertFalse(Everframe.crashOnlyCoverage())
        assertEquals("the recording is kept, never revoked and restarted", 1, recorders.get())
        assertEquals(NativeVideoRecorder.State.BUFFERING, lifecycle())
        assertTrue(NetworkBodyCaptureState.isActive)
    }

    @Test fun anUpgradeKeepsAnAlreadySampledCrashOnlyRecording() {
        crashOnlyRate = "1.0"
        refresh()
        assertEquals(1, recorders.get())
        Everframe.__onCompanionMemberAttached()
        refresh()
        assertEquals("one draw for both kinds: the upgrade never restarts or stops it", 1, recorders.get())
        assertEquals(NativeVideoRecorder.State.BUFFERING, lifecycle())
    }

    @Test fun anUpgradeKeepsRecordingWhenTheCrashOnlyRateIsAboveTheReportRate() {
        // Every draw passes a crash-only rate of 1 and none passes a report rate of 0. Sampling an
        // upgraded session at samplingRate alone would revoke this recording on the next refresh.
        reportRate = "0.0"
        crashOnlyRate = "1.0"
        refresh()
        assertEquals(1, recorders.get())
        Everframe.__onCompanionMemberAttached()
        refresh(); refresh()
        assertEquals(ReplayCoverage.Upgraded, Everframe.replayCoverage())
        assertEquals("the upgrade keeps the recording", 1, recorders.get())
        assertEquals(NativeVideoRecorder.State.BUFFERING, lifecycle())
        assertTrue(errorReplayAttaches())
    }

    private fun upgrade() { Everframe.__onCompanionMemberAttached(); runBlocking { session.applyCompanionUpgrade() }; drainMain() }

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

    @Test fun anUpgradeInheritsTheCrashOnlyAdmissionAfterBothRatesDrop() {
        crashOnlyRate = "1.0"
        refresh()
        assertEquals(1, recorders.get())
        crashOnlyRate = "0.0"; reportRate = "0.0"
        upgrade()
        refresh()
        assertEquals(ReplayCoverage.Upgraded, Everframe.replayCoverage())
        assertEquals("neither live rate admits the draw, the admission carries over", 1, recorders.get())
        assertEquals(NativeVideoRecorder.State.BUFFERING, lifecycle())
    }

    @Test fun theBondReappliesTheConfirmedConfigWithoutFetching() {
        refresh()
        assertEquals(0, recorders.get())
        val before = fetches.get()
        serverDown = true
        Everframe._replaySession = session
        try {
            Everframe.__onCompanionMemberAttached()
            val deadline = System.currentTimeMillis() + 5_000
            while (lifecycle() != NativeVideoRecorder.State.BUFFERING) {
                assertTrue("the bond never started recording", System.currentTimeMillis() < deadline)
                Thread.sleep(10)
            }
            drainMain()
        } finally { Everframe._replaySession = null }
        assertEquals("the upgrade uses the confirmed config, no fetch", before, fetches.get())
        assertEquals(1, recorders.get())
        assertTrue(NetworkBodyCaptureState.isActive)
    }

    @Test fun anUnreachableServerAtTheBondNeverRevokesTheCrashOnlyRecording() {
        crashOnlyRate = "1.0"
        refresh()
        assertEquals(1, recorders.get())
        serverDown = true
        val before = fetches.get()
        upgrade()
        assertEquals(before, fetches.get())
        assertEquals("the recording survives the upgrade", 1, recorders.get())
        assertEquals(NativeVideoRecorder.State.BUFFERING, lifecycle())
        assertTrue(errorReplayAttaches())
    }

    @Test fun aBondWithNoConfirmedConfigFetches() {
        serverDown = true
        refresh()
        assertEquals(0, recorders.get())
        serverDown = false
        val before = fetches.get()
        upgrade()
        assertEquals("a failed last refresh leaves nothing to re-apply", before + 1, fetches.get())
        assertEquals(1, recorders.get())
    }

    @Test fun upgradedCoverageSamplesAtTheHigherOfBothRates() {
        assertEquals(0.4, ReplayCoverage.Report.samplingRate(0.4, 0.9), 0.0)
        assertEquals(0.9, ReplayCoverage.CrashOnly.samplingRate(0.4, 0.9), 0.0)
        assertEquals(0.0, ReplayCoverage.CrashOnly.samplingRate(0.4, null), 0.0)
        assertEquals(0.9, ReplayCoverage.Upgraded.samplingRate(0.4, 0.9), 0.0)
        assertEquals(0.4, ReplayCoverage.Upgraded.samplingRate(0.4, 0.1), 0.0)
        assertEquals(0.4, ReplayCoverage.Upgraded.samplingRate(0.4, null), 0.0)
    }

    @Test fun aCrashOnlySessionThatStartsWhileCompanionIsBondedStartsUpgraded() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        Companion.__setState(CompanionState.Paired)
        Everframe.start(context, config(reporterEnabled = false))
        assertEquals("no new pair.bonded comes for a bond that already exists",
            ReplayCoverage.Upgraded, Everframe.replayCoverage())

        Companion.__beginReport("c1")
        Everframe.start(context, config(reporterEnabled = false))
        assertEquals("a companion report in progress is a bond", ReplayCoverage.Upgraded, Everframe.replayCoverage())

        Companion.__setState(CompanionState.PhoneDisconnected)
        Everframe.start(context, config(reporterEnabled = false))
        assertEquals("a phone away inside the grace window is still bonded",
            ReplayCoverage.Upgraded, Everframe.replayCoverage())
    }

    @Test fun theStartUpgradeNeedsABondAndACrashOnlySession() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        Everframe.start(context, config(reporterEnabled = false))
        assertEquals("unpaired: crash-only", ReplayCoverage.CrashOnly, Everframe.replayCoverage())

        // Backgrounding enters PhoneDisconnected without any bond (RelayWSClient.onStop).
        Companion.__setState(CompanionState.PhoneDisconnected)
        Everframe.start(context, config(reporterEnabled = false))
        assertEquals("a backgrounded, never-bonded companion is no bond",
            ReplayCoverage.CrashOnly, Everframe.replayCoverage())

        Companion.__setState(CompanionState.Paired)
        Everframe.start(context, config(reporterEnabled = true))
        assertEquals("a report session is never upgraded", ReplayCoverage.Report, Everframe.replayCoverage())

        // A detach ends the bond: the next start is crash-only again.
        Companion.__setState(CompanionState.Unpaired)
        Everframe.start(context, config(reporterEnabled = false))
        assertEquals(ReplayCoverage.CrashOnly, Everframe.replayCoverage())
    }

    @Test fun aStartWhileBondedRecordsFromItsFirstRefresh() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        Companion.__setState(CompanionState.Paired)
        Everframe.start(context, config(reporterEnabled = false))
        // A session belongs to the start that built it: build one for this start.
        session.teardown(); drainMain()
        session = buildSession()
        refresh()
        assertEquals("the upgraded session records at samplingRate", 1, recorders.get())
        assertTrue(NetworkBodyCaptureState.isActive)
    }

    @Test fun killEndsTheUpgrade() {
        Everframe.__onCompanionMemberAttached()
        assertFalse(Everframe.crashOnlyCoverage())
        Everframe.kill()
        Everframe.captureGate = true
        Everframe.__setConfigForTesting(config(reporterEnabled = false))
        assertTrue("the next crash-only session starts without coverage", Everframe.crashOnlyCoverage())
    }

    @Test fun aBondOutsideARunningCrashOnlySessionUpgradesNothing() {
        Everframe.captureGate = false
        Everframe.__onCompanionMemberAttached()
        Everframe.captureGate = true
        assertTrue("a bond while capture is off is not this session's upgrade", Everframe.crashOnlyCoverage())

        Everframe.__setConfigForTesting(config(reporterEnabled = true))
        Everframe.__onCompanionMemberAttached()
        Everframe.__setConfigForTesting(config(reporterEnabled = false))
        assertTrue("a report session has nothing to upgrade", Everframe.crashOnlyCoverage())
        refresh()
        assertEquals(0, recorders.get())
    }

    @Test fun aNewStartEndsTheUpgrade() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        Everframe.start(context, config(reporterEnabled = false))
        Everframe.__onCompanionMemberAttached()
        assertFalse(Everframe.crashOnlyCoverage())
        Everframe.start(context, config(reporterEnabled = false))
        assertTrue("a bond upgrades one session only", Everframe.crashOnlyCoverage())
    }
}
