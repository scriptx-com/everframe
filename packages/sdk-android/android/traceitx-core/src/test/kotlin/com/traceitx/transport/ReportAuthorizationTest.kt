// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.transport

import com.traceitx.TraceItX
import com.traceitx.capture.video.*
import org.junit.Assert.*
import org.junit.Test
import kotlinx.coroutines.async
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ReportAuthorizationTest {
    @Test fun staleBodyDecisionMustRebuildAndCancellationKeepsReport() {
        TraceItX.captureGate = true
        val session = TraceItX.captureSessionSnapshot()
        val origin = object : ReplayCaptureOrigin {
            override val sessionId = "a"
            override fun replayAllowed(owner: VideoOwner, generation: Long) = true
            override suspend fun export(owner: VideoOwner, generation: Long): OwnedVideoClip? = null
            override fun cancel(owner: VideoOwner) = Unit
            override fun release(owner: VideoOwner) = Unit
        }
        val capture = FrozenReportCapture(VideoOwner("a", "c"), session.user.startEpoch, 0, origin, FrozenAncillarySnapshot(null, null))
        val authority = ReportAuthorizationFactory.forCapture(session, capture)
        val prepared = authority.evaluate()
        assertTrue(prepared.replayAllowed)
        capture.cancel()
        var enqueues = 0
        assertFalse(authority.tryStart(prepared) { enqueues++ })
        val rebuilt = authority.evaluate()
        assertTrue(rebuilt.reportAllowed); assertFalse(rebuilt.replayAllowed)
        assertTrue(authority.tryStart(rebuilt) { enqueues++ })
        assertEquals(1, enqueues)
    }
    @Test fun killNeverRevivesCapturedAuthority() {
        val authority = ReportAuthorizationFactory.forCapture(TraceItX.captureSessionSnapshot(), null)
        val prepared = authority.evaluate()
        TraceItX.kill()
        var enqueues = 0
        assertFalse(authority.tryStart(prepared) { enqueues++ })
        assertFalse(authority.evaluate().reportAllowed)
        assertEquals(0, enqueues)
    }
    @Test fun enqueueWinsWithoutWaitingForHttpAndKillFirstRefuses() {
        val session = TraceItX.captureSessionSnapshot()
        val authority = ReportAuthorizationFactory.forCapture(session, null)
        val queued = java.util.concurrent.CountDownLatch(1)
        val leaveEnqueue = java.util.concurrent.CountDownLatch(1)
        val killStarted = java.util.concurrent.CountDownLatch(1)
        val killReturned = java.util.concurrent.CountDownLatch(1)
        val starts = java.util.concurrent.atomic.AtomicInteger()
        val thread = Thread {
            authority.tryStart(authority.evaluate()) {
                starts.incrementAndGet(); queued.countDown()
                check(leaveEnqueue.await(2, java.util.concurrent.TimeUnit.SECONDS))
            }
        }.apply { start() }
        assertTrue(queued.await(2, java.util.concurrent.TimeUnit.SECONDS))
        val killer = Thread { killStarted.countDown(); TraceItX.kill(); killReturned.countDown() }.apply { start() }
        assertTrue(killStarted.await(2, java.util.concurrent.TimeUnit.SECONDS))
        assertFalse(killReturned.await(50, java.util.concurrent.TimeUnit.MILLISECONDS))
        leaveEnqueue.countDown(); thread.join(2_000); killer.join(2_000)
        assertFalse(thread.isAlive); assertFalse(killer.isAlive); assertEquals(1, starts.get())
        assertFalse(authority.tryStart(authority.evaluate()) { starts.incrementAndGet() })
        // Reopening local capture is the restart behavior relevant to this monotonic permit.
        TraceItX.captureGate = true
        assertFalse(authority.evaluate().reportAllowed)
        TraceItX.captureGate = false
    }

    private val enabledConfig = """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":0.0,"nativeVideo":{"framesPerSecond":5}}"""

    @Test fun pendingUsesStoredRouteAndExpiryRebuildsBeforeSingleRealEnqueue() = kotlinx.coroutines.runBlocking {
        val a = okhttp3.mockwebserver.MockWebServer(); val b = okhttp3.mockwebserver.MockWebServer()
        a.start(); b.start()
        try {
            TraceItX.captureGate = true
            val captured = TraceItX.captureSessionSnapshot()
            a.enqueue(okhttp3.mockwebserver.MockResponse().setBody(enabledConfig))
            a.enqueue(okhttp3.mockwebserver.MockResponse().setBody("ok"))
            b.enqueue(okhttp3.mockwebserver.MockResponse().setBody(enabledConfig))
            val authority = ReportAuthorizationFactory.forPending(captured, b.url("/").toString(), a.url("/").toString(), "A-key")
            val configRequest = a.takeRequest(2, java.util.concurrent.TimeUnit.SECONDS)!!
            assertEquals("/api/config", configRequest.path); assertEquals("Bearer A-key", configRequest.getHeader("Authorization"))
            val prepared = authority.evaluate(); assertTrue(prepared.replayAllowed)
            org.robolectric.shadows.ShadowSystemClock.advanceBy(java.time.Duration.ofSeconds(31))
            var enqueues = 0
            assertFalse(authority.tryStart(prepared) { enqueues++ })
            val replayFree = authority.evaluate(); assertTrue(replayFree.reportAllowed); assertFalse(replayFree.replayAllowed)
            val response = java.util.concurrent.CountDownLatch(1)
            val call = okhttp3.OkHttpClient().newCall(okhttp3.Request.Builder().url(a.url("/api/ingest")).build())
            assertTrue(authority.tryStart(replayFree) {
                enqueues++
                call.enqueue(object : okhttp3.Callback {
                    override fun onFailure(call: okhttp3.Call, e: java.io.IOException) { response.countDown() }
                    override fun onResponse(call: okhttp3.Call, result: okhttp3.Response) { result.close(); response.countDown() }
                })
            })
            assertTrue(response.await(2, java.util.concurrent.TimeUnit.SECONDS))
            assertEquals("/api/ingest", a.takeRequest(2, java.util.concurrent.TimeUnit.SECONDS)!!.path)
            assertEquals(1, enqueues); assertEquals(0, b.requestCount)
        } finally { TraceItX.captureGate = false; a.shutdown(); b.shutdown() }
    }

    @Test fun failedStoredRouteRefreshCannotBorrowInstalledProjectsConfig() = kotlinx.coroutines.runBlocking {
        val a = okhttp3.mockwebserver.MockWebServer(); a.start()
        try {
            TraceItX.captureGate = true
            a.enqueue(okhttp3.mockwebserver.MockResponse().setResponseCode(503))
            val authority = ReportAuthorizationFactory.forPending(TraceItX.captureSessionSnapshot(), "https://project-b.test", a.url("/").toString(), "A")
            assertEquals(ReportAuthorizationDecision(true, false), authority.evaluate())
            var starts = 0
            assertTrue(authority.tryStart(authority.evaluate()) { starts++ }); assertEquals(1, starts)
        } finally { TraceItX.captureGate = false; a.shutdown() }
    }

    @Test fun killDuringPendingFetchNeverStartsReport() = kotlinx.coroutines.runBlocking {
        val a = okhttp3.mockwebserver.MockWebServer(); a.start()
        val arrived = java.util.concurrent.CountDownLatch(1); val release = java.util.concurrent.CountDownLatch(1)
        a.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): okhttp3.mockwebserver.MockResponse {
                arrived.countDown(); check(release.await(3, java.util.concurrent.TimeUnit.SECONDS))
                return okhttp3.mockwebserver.MockResponse().setBody(enabledConfig)
            }
        }
        try {
            TraceItX.captureGate = true
            val session = TraceItX.captureSessionSnapshot()
            val pending = async(kotlinx.coroutines.Dispatchers.IO) {
                ReportAuthorizationFactory.forPending(session, a.url("/").toString(), a.url("/").toString(), "A")
            }
            assertTrue(arrived.await(2, java.util.concurrent.TimeUnit.SECONDS)); TraceItX.kill(); release.countDown()
            val authority = pending.await()
            assertEquals(ReportAuthorizationDecision(false, false), authority.evaluate())
            assertFalse(authority.tryStart(authority.evaluate()) { fail("kill-first enqueued") })
            assertEquals(1, a.requestCount)
        } finally { release.countDown(); a.shutdown() }
    }

    @Test fun pendingRefreshCannotFollowRedirectToAnotherProjectsConfig() = kotlinx.coroutines.runBlocking {
        val a = okhttp3.mockwebserver.MockWebServer(); val b = okhttp3.mockwebserver.MockWebServer(); a.start(); b.start()
        try {
            TraceItX.captureGate = true
            a.enqueue(okhttp3.mockwebserver.MockResponse().setResponseCode(302).setHeader("Location", b.url("/api/config")))
            b.enqueue(okhttp3.mockwebserver.MockResponse().setBody(enabledConfig))
            val authority = ReportAuthorizationFactory.forPending(TraceItX.captureSessionSnapshot(), b.url("/").toString(), a.url("/").toString(), "A")
            assertEquals(ReportAuthorizationDecision(true, false), authority.evaluate())
            assertEquals(0, b.requestCount)
        } finally { TraceItX.captureGate = false; a.shutdown(); b.shutdown() }
    }

    @Test fun sendTimeMismatchOmitsOptionalCaptureWithoutRevokingReport() {
        TraceItX.captureGate = true
        val session = TraceItX.captureSessionSnapshot()
        val capture = FrozenReportCapture.empty(session.user.startEpoch)
        assertTrue(capture.matchesSession(session))
        val later = session.copy(user = session.user.copy(startEpoch = session.user.startEpoch + 1))
        assertFalse(capture.matchesSession(later))
        assertEquals(ReportAuthorizationDecision(true, false), ReportAuthorizationFactory.forCapture(later, capture).evaluate())
        TraceItX.kill(); assertFalse(capture.matchesSession(session)); capture.cancel()
    }

}
