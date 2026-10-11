// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import androidx.test.core.app.ApplicationProvider
import dev.everframe.Everframe
import dev.everframe.capture.replay.ReplaySession
import dev.everframe.config.ConfigFetcher
import dev.everframe.config.ReplayConfigProvider
import dev.everframe.protocol.generated.AttachmentKind
import dev.everframe.protocol.generated.Format
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.ConcurrentLinkedDeque
import java.util.concurrent.atomic.AtomicLong

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ErrorReplaySessionTest {
    private val h = VideoExporterTest.Harness()
    private val mainTasks = ConcurrentLinkedDeque<() -> Unit>()
    private val pts = AtomicLong()
    private val scheduler = object : VideoCaptureScheduler {
        override fun main(block: () -> Unit) { mainTasks.add(block) }
        override fun worker(block: () -> Unit) = block()
        override fun later(delayMs: Long, block: () -> Unit): () -> Unit = {}
        override fun isWorkerThread() = false
        override fun nowNanos() = 0L
    }
    private lateinit var session: ReplaySession

    @Before fun setUp() {
        dev.everframe.shared.SharedData.init(ApplicationProvider.getApplicationContext())
        Everframe.captureGate = true
        session = ReplaySession(sdkKey = "k", context = ApplicationProvider.getApplicationContext(),
            provider = ReplayConfigProvider.make("https://a.test", "k", ConfigFetcher { request ->
                Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("test")
                    .body("""{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,"nativeVideo":{"framesPerSecond":2}}"""
                        .toResponseBody("application/json".toMediaType())).build()
            }))
        session.videoStartupAdmission = VideoStartupAdmission(scheduler) { _, _ -> true }
        session.videoDeviceConditions = object : VideoDeviceConditions {
            override fun pauseRecording() = false
            override val lowRamDevice = false
        }
        session.errorReplayAttachment = { clip -> NativeVideoAttachment(h.scheduler).build(clip) }
        session.recorderFactory = { _, owner, _ ->
            NativeVideoRecorder(owner, scheduler, { block -> block(); true }, { VideoSize(4, 4) }, { null }, { _, _, _ ->
                object : RecordingVideoEncoder {
                    override fun prepare(size: VideoSize, fps: Int) = size
                    override fun offer(frame: SafeVideoFrame) = false
                    override fun finish(deadline: Long) = listOf(h.segment(pts.addAndGet(2_000_000), who = owner))
                    override val isTerminal = false
                    override fun close() = Unit
                }
            }, { segments, allowed -> h.exporter.export(owner, segments, allowed) },
                snapshotExporter = { segments, allowed -> h.exporter.exportBorrowed(owner, segments, allowed) })
        }
        runBlocking { session.refreshConfigNow() }
        drainMain()
    }

    @After fun tearDown() { session.teardown(); drainMain(); Everframe.captureGate = false; h.root.deleteRecursively() }

    private fun drainMain() { while (true) { (mainTasks.pollFirst() ?: break).invoke() } }
    private suspend fun attach(): VideoAttachmentPair? {
        val snapshot = session.beginErrorReplay() ?: return null
        val pair = snapshot.await()
        snapshot.settle(pair != null); drainMain()
        return pair
    }

    @Test fun snapshotAttachesTheRecordingAndRecordingContinues() = runBlocking {
        val snapshot = checkNotNull(session.beginErrorReplay())
        val pair = checkNotNull(snapshot.await())
        assertEquals(AttachmentKind.SessionReplay, pair.envelope.kind)
        assertEquals(Format.EverframeVideoV1, pair.envelope.format)
        assertTrue(snapshot.replayAllowed())
        snapshot.settle(true); drainMain()
        assertEquals(dev.everframe.capture.video.NativeVideoRecorder.State.BUFFERING, session.__lifecycleStateForTesting())
        val report = session.freezeOwnedCapture()
        try { assertNotNull("a later bug report still has the history", report.exportVideo()?.also { it.close() }) }
        finally { report.cancel() }
    }

    @Test fun atMostTwoErrorReplaysPerSessionAndAMissDoesNotCount() = runBlocking {
        val missed = checkNotNull(session.beginErrorReplay()); missed.await(); missed.settle(false); drainMain()
        assertNotNull(attach()); assertNotNull(attach())
        assertNull("the third error in this session ships without a replay", session.beginErrorReplay())
    }

    @Test fun inFlightClaimsCountAgainstTheCapBeforeAnythingAttaches() = runBlocking {
        val release = kotlinx.coroutines.CompletableDeferred<Unit>()
        session.errorReplayAttachment = { clip -> release.await(); NativeVideoAttachment(h.scheduler).build(clip) }
        val claims = (1..100).mapNotNull { session.beginErrorReplay() }
        try {
            assertEquals("an error burst reserves no more than two exports", 2, claims.size)
            assertNull(session.beginErrorReplay())
        } finally {
            release.complete(Unit)
            claims.forEach { it.await(); it.settle(false) }
        }
    }

    @Test fun aReplayClaimFromAnotherStartCannotAcquireThisSessionsHistory() = runBlocking {
        assertNull(session.beginErrorReplay(Everframe.currentStartEpochVolatile() - 1))
        assertTrue("a foreign start cannot export this recorder", h.inputs.isEmpty())
        assertNotNull(attach())
    }

    @Test fun anOpenBugReportBlocksErrorReplays() = runBlocking {
        val report = session.freezeOwnedCapture()
        try { assertNull(session.beginErrorReplay()) } finally { report.cancel() }
        drainMain()
        val after = checkNotNull(session.beginErrorReplay()) { "a released report gives the buffer back" }
        after.await(); after.settle(false)
    }

    @Test fun pauseAfterExportInvalidatesPublicationEvenAfterResume() = runBlocking {
        val snapshot = checkNotNull(session.beginErrorReplay())
        assertNotNull(snapshot.await())
        session.pause(); session.resume()
        assertFalse("a pre-pause attachment must not publish from a resumed buffer", snapshot.replayAllowed())
        snapshot.settle(false)
    }

    @Test fun consumingAConcurrentReportDoesNotRevokeAnErrorsIndependentCopy() = runBlocking {
        val snapshot = checkNotNull(session.beginErrorReplay())
        assertNotNull(snapshot.await())
        val report = session.freezeOwnedCapture()
        try {
            assertNotNull(report.exportVideo()?.also { it.close() })
            report.finishConsumption()
            assertTrue("report cleanup must not revoke the error's own copy", snapshot.replayAllowed())
        } finally { report.cancel(); snapshot.settle(false) }
    }

    @Test fun aPausedSessionDoesNotSnapshot() = runBlocking {
        session.pause()
        assertNull(session.beginErrorReplay())
        session.resume(); drainMain()
        val resumed = checkNotNull(session.beginErrorReplay()); resumed.await(); resumed.settle(false)
    }

    @Test fun privacyRevocationAfterTheExportDeniesTheAttachment() = runBlocking {
        val snapshot = checkNotNull(session.beginErrorReplay())
        assertNotNull(snapshot.await())
        VideoPrivacyRevocation.revoke()
        assertFalse(snapshot.replayAllowed()); snapshot.settle(false)
    }
}
