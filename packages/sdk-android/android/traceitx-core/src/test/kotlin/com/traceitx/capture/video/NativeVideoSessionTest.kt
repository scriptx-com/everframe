// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.capture.video

import com.traceitx.TraceItX
import com.traceitx.capture.replay.ReplaySession
import com.traceitx.capture.sharedBreadcrumbBuffer
import com.traceitx.capture.sharedNetworkBodyBuffer
import com.traceitx.config.*
import com.traceitx.protocol.generated.BreadcrumbKind
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.async
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NativeVideoSessionTest {
    @org.junit.Before fun initializeRedaction() {
        com.traceitx.shared.SharedData.init(androidx.test.core.app.ApplicationProvider.getApplicationContext())
    }

    @Test fun staleCaptureCannotConsumeReplacementDataAndFailureRevokesOnlyVideo() = runBlocking {
        var okay = true
        val provider = ReplayConfigProvider.make("https://a.test", "key", ConfigFetcher { request ->
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(if (okay) 200 else 500).message("test")
                .body("""{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,"nativeVideo":{"framesPerSecond":5}}""".toResponseBody("application/json".toMediaType())).build()
        })
        TraceItX.captureGate = true
        val a = ReplaySession(apiKey = "key", provider = provider)
        a.refreshConfigNow()
        sharedBreadcrumbBuffer.clear(); sharedBreadcrumbBuffer.add(BreadcrumbKind.Custom, "A")
        sharedNetworkBodyBuffer.clear()
        sharedNetworkBodyBuffer.append(networkBody("A"))
        val old = a.freezeOwnedCapture()
        a.teardown()
        val b = ReplaySession(apiKey = "key", provider = provider)
        b.refreshConfigNow()
        sharedBreadcrumbBuffer.clear(); sharedBreadcrumbBuffer.add(BreadcrumbKind.Custom, "B")
        sharedNetworkBodyBuffer.clear()
        sharedNetworkBodyBuffer.append(networkBody("B"))
        val replacement = b.freezeOwnedCapture()
        old.cancel(); assertNull(old.takeBreadcrumbs())
        assertEquals(listOf("B"), replacement.takeBreadcrumbs()!!.map { it.message })
        assertEquals(listOf("B"), replacement.takeNetworkBodies()!!.map { it.resBody })
        assertNull(old.takeNetworkBodies())
        assertTrue(replacement.replayAllowed())
        okay = false; b.refreshConfigNow(); assertFalse(replacement.replayAllowed())
        okay = true; b.refreshConfigNow(); assertFalse(replacement.replayAllowed())
        replacement.finishConsumption(); b.teardown(); TraceItX.captureGate = false
    }
    private fun networkBody(value: String) = com.traceitx.protocol.generated.NetworkBody(
        ref = 1.0, t = 0.0, reqBody = null, reqBodyBytes = null, reqBodySkipped = null,
        reqBodyTruncated = null, reqHeaders = null, resBody = value, resBodyBytes = 1.0,
        resBodySkipped = null, resBodyTruncated = null, resHeaders = null)

    private fun configProvider(body: () -> String, attempts: java.util.concurrent.atomic.AtomicInteger = java.util.concurrent.atomic.AtomicInteger()) =
        ReplayConfigProvider.make("https://a.test", "key", ConfigFetcher { request ->
            attempts.incrementAndGet()
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("test")
                .body(body().toResponseBody("application/json".toMediaType())).build()
        })
    private val on = """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,"nativeVideo":{"framesPerSecond":5}}"""

    @Test fun backgroundAndIdentityChangesPreserveFrozenAuthorizationUntilConsumption() = runBlocking {
        TraceItX.captureGate = true
        val session = ReplaySession(apiKey = "k", provider = configProvider({ on }))
        session.refreshConfigNow()
        val capture = session.freezeOwnedCapture()
        session.pause(); session.resume(); TraceItX.setIdentityToken(null)
        assertTrue(capture.replayAllowed())
        capture.finishConsumption()
        assertTrue("Transferred clip claim must survive slot release", capture.replayAllowed())
        session.teardown(); assertFalse(capture.replayAllowed()); TraceItX.captureGate = false
    }

    @Test fun absentBlockConsentAndImmutableLocalVetoFailClosed() = runBlocking {
        for ((consent, disabled, body) in listOf(Triple(false, false, on), Triple(true, true, on),
            Triple(true, false, """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0}"""))) {
            TraceItX.captureGate = consent
            val session = ReplaySession(apiKey = "k", locallyDisabled = disabled, provider = configProvider({ body }))
            session.refreshConfigNow(); val capture = session.freezeOwnedCapture()
            assertFalse(capture.replayAllowed()); capture.cancel(); session.teardown()
        }
        TraceItX.captureGate = false
    }

    @Test fun failedRefreshNeverUsesTtlSkipToAuthorizeStaleVideo() = runBlocking {
        TraceItX.captureGate = true
        var body = on; val attempts = java.util.concurrent.atomic.AtomicInteger()
        val provider = configProvider({ body }, attempts)
        val session = ReplaySession(apiKey = "k", provider = provider)
        session.refreshConfigNow(); val capture = session.freezeOwnedCapture(); assertTrue(capture.replayAllowed())
        body = "malformed"; session.refreshConfigNow(); assertFalse(capture.replayAllowed())
        provider.refresh() // Provider may report a TTL skip as true; coordinator still forces actual refresh.
        session.refreshConfigNow()
        assertEquals(3, attempts.get()); assertFalse(capture.replayAllowed())
        capture.cancel(); session.teardown(); TraceItX.captureGate = false
    }

    @Test fun slotsRejectNewOptionalCapturesAndReleaseWithoutEviction() = runBlocking {
        TraceItX.captureGate = true
        val sessions = (1..3).map { ReplaySession(apiKey = "k", provider = configProvider({ on })) }
        sessions.forEach { it.refreshConfigNow() }
        val a = sessions[0].freezeOwnedCapture(); val b = sessions[1].freezeOwnedCapture()
        val exhausted = sessions[2].freezeOwnedCapture()
        assertNull(exhausted.takeBreadcrumbs()); assertFalse(exhausted.replayAllowed())
        val duplicate = sessions[0].freezeOwnedCapture(); assertNull(duplicate.takeNetworkBodies())
        a.cancel()
        val admitted = sessions[2].freezeOwnedCapture(); assertNotNull(admitted.takeBreadcrumbs())
        assertTrue(b.replayAllowed()); b.cancel(); admitted.cancel(); exhausted.cancel(); duplicate.cancel()
        sessions.forEach { it.teardown() }; TraceItX.captureGate = false
    }

    @Test fun sourceEpochIsCheckedInsideSnapshotLock() {
        val buffer = com.traceitx.capture.BreadcrumbRingBuffer()
        val valid = java.util.concurrent.atomic.AtomicBoolean(true)
        val held = java.util.concurrent.CountDownLatch(1); val release = java.util.concurrent.CountDownLatch(1)
        val locker = Thread { buffer.__holdLockForTesting { held.countDown(); check(release.await(2, java.util.concurrent.TimeUnit.SECONDS)) } }.apply { start() }
        assertTrue(held.await(2, java.util.concurrent.TimeUnit.SECONDS))
        val result = java.util.concurrent.atomic.AtomicReference<List<com.traceitx.protocol.generated.Breadcrumb>?>()
        val reader = Thread { result.set(buffer.snapshotForReport { valid.get() }) }.apply { start() }
        val deadline = System.nanoTime() + 1_000_000_000
        while (!buffer.__hasQueuedThreadsForTesting() && System.nanoTime() < deadline) Thread.yield()
        assertTrue(buffer.__hasQueuedThreadsForTesting()); valid.set(false); release.countDown()
        reader.join(2_000); locker.join(2_000); assertFalse(reader.isAlive); assertNull(result.get())
    }

    @Test fun consumedOwnersLateCancellationDeniesReplayWithoutTouchingNextCapture() = runBlocking {
        TraceItX.captureGate = true
        val session = ReplaySession(apiKey = "k", provider = configProvider({ on }))
        session.refreshConfigNow()
        val a = session.freezeOwnedCapture()
        val authority = com.traceitx.transport.ReportAuthorizationFactory.forCapture(TraceItX.captureSessionSnapshot(), a)
        a.finishConsumption(); assertTrue(authority.evaluate().replayAllowed)
        val b = session.freezeOwnedCapture()
        a.cancel(); a.cancel()
        assertEquals(com.traceitx.transport.ReportAuthorizationDecision(true, false), authority.evaluate())
        assertTrue(b.replayAllowed()); assertNotNull(b.takeBreadcrumbs()); b.cancel(); session.teardown()
        TraceItX.captureGate = false
    }

    @Test fun productionCoordinatorRevokesOnlyVideoWhileExporterIsInsideRemux() = coordinatorRevokesInsideRemux(false)
    @Test fun settledFreshAuthorizationNeverRevivesExportPausedInsideRemux() = coordinatorRevokesInsideRemux(true)

    private fun coordinatorRevokesInsideRemux(privacy: Boolean) = runBlocking {
        TraceItX.captureGate = true
        var body = on
        val h = VideoExporterTest.Harness()
        val entered = java.util.concurrent.CountDownLatch(1); val release = java.util.concurrent.CountDownLatch(1)
        h.afterRemux = { entered.countDown(); check(release.await(3, java.util.concurrent.TimeUnit.SECONDS)) }
        val mainTasks = java.util.ArrayDeque<() -> Unit>()
        val scheduler = object : VideoCaptureScheduler {
            override fun main(block: () -> Unit) { mainTasks.add(block) }
            override fun worker(block: () -> Unit) = block()
            override fun later(delayMs: Long, block: () -> Unit): () -> Unit = {}
            override fun isWorkerThread() = false
            override fun nowNanos() = 0L
        }
        val session = ReplaySession(apiKey = "k", context = androidx.test.core.app.ApplicationProvider.getApplicationContext(), provider = configProvider({ body }))
        session.videoStartupAdmission = VideoStartupAdmission(scheduler) { _, _ -> true }
        session.recorderFactory = { _, owner, _ ->
            NativeVideoRecorder(owner, scheduler, { block -> block(); true }, { VideoSize(4, 4) }, { null }, { _, _, _ ->
                object : RecordingVideoEncoder {
                    override fun prepare(size: VideoSize, fps: Int) = size
                    override fun offer(frame: SafeVideoFrame) = false
                    override fun finish(deadline: Long) = listOf(h.segment(who = owner))
                    override val isTerminal = false
                    override fun close() = Unit
                }
            }, { segments, allowed -> h.exporter.export(owner, segments, allowed) })
        }
        if (privacy) {
            session.enableIfConfigured()
            val job = ReplaySession::class.java.getDeclaredField("initialRefreshJob").apply { isAccessible = true }.get(session) as kotlinx.coroutines.Job
            kotlinx.coroutines.withTimeout(3_000) { job.join() }
        } else session.refreshConfigNow()
        mainTasks.removeFirst().invoke()
        val capture = session.freezeOwnedCapture()
        val export = async(kotlinx.coroutines.Dispatchers.Default) { capture.exportVideo() }
        try {
            assertTrue(entered.await(2, java.util.concurrent.TimeUnit.SECONDS))
            session.pause(); assertTrue(capture.replayAllowed()); session.resume()
            if (privacy) {
                VideoPrivacyRevocation.begin().close()
                assertEquals("1", session.nativeVideoDiagnostics()!!["authorized"].toString())
            } else { body = "malformed"; session.refreshConfigNow() }
            assertFalse(capture.replayAllowed()); assertNotNull(capture.takeBreadcrumbs())
            release.countDown(); assertNull(export.await()); assertEquals(0, h.budget.usedBytes)
        } finally { release.countDown(); capture.cancel(); session.teardown(); TraceItX.captureGate = false }
    }

}
