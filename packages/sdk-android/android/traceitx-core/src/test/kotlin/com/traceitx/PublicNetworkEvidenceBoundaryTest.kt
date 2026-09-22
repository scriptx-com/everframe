// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx

import androidx.test.core.app.ApplicationProvider
import com.traceitx.capture.*
import com.traceitx.capture.replay.ReplaySession
import com.traceitx.config.*
import com.traceitx.okhttp.addTraceItXInterceptor
import com.traceitx.shared.SharedData
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class PublicNetworkEvidenceBoundaryTest {
    @Test fun delayedSuccessAcrossRestartKeepsOnlyNewEvidence() = drive(kill = false, fail = false)
    @Test fun delayedSuccessAcrossKillAndStartKeepsOnlyNewEvidence() = drive(kill = true, fail = false)
    @Test fun delayedIOExceptionAcrossRestartKeepsOnlyNewEvidence() = drive(kill = false, fail = true)
    @Test fun delayedIOExceptionAcrossKillAndStartKeepsOnlyNewEvidence() = drive(kill = true, fail = true)
    @Test fun admittedMetadataInsertionAcrossKillAndStartCannotDualwriteOldEvidence() = drive(kill = true, fail = false, atInsertion = true)

    private fun drive(kill: Boolean, fail: Boolean, atInsertion: Boolean = false) {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        SharedData.init(context)
        NetworkBodyFinalizer.__directForTesting = true
        TraceItX.__replaySessionFactoryForTesting = { _, cfg, epoch, consent, _ ->
            val provider = ReplayConfigProvider.make("https://fixture.test", cfg.sdkKey, ConfigFetcher { request ->
                Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("ok")
                    .body("""{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1,"networkBodies":{"captureBodies":true}}""".toResponseBody()).build()
            })
            ReplaySession(apiKey = cfg.sdkKey, provider = provider, originatingStartEpoch = epoch, captureConsent = consent)
        }
        val config = TraceItXConfig(appId = "A", sdkKey = "txx_live_fixture1234567890", capture = CaptureConfig(logs = false, network = true, networkBodies = true))
        fun start(project: String) {
            TraceItX.start(context, config.copy(appId = project))
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (TraceItX._replaySession == null && System.nanoTime() < deadline) Thread.yield()
            assertNotNull(TraceItX._replaySession)
            runBlocking { TraceItX._replaySession!!.refreshConfigNow() }
            assertTrue("positive body authority must be configured", NetworkBodyCaptureState.isActive)
        }
        val server = MockWebServer().apply { start() }
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val first = AtomicBoolean(true)
        fun pauseOnce() {
            if (first.compareAndSet(true, false)) {
                entered.countDown(); check(release.await(5, TimeUnit.SECONDS))
            }
        }
        val client = OkHttpClient.Builder().addTraceItXInterceptor().addInterceptor { chain ->
            if (chain.request().url.encodedPath == "/project-A-request") {
                if (!atInsertion) pauseOnce()
                if (fail) throw IOException("project A transport failure")
            }
            chain.proceed(chain.request())
        }.build()
        val responseA = AtomicReference<String>()
        val errorA = AtomicReference<Throwable>()
        val worker = Thread {
            try {
                responseA.set(client.newCall(Request.Builder().url(server.url("/project-A-request")).build()).execute().use { it.body!!.string() })
            } catch (t: Throwable) { errorA.set(t) }
        }
        try {
            start("A")
            if (atInsertion) sharedNetworkBuffer.preLockHook = { pauseOnce() }
            if (!fail) server.enqueue(MockResponse().setBody("{\"owner\":\"project-A-response\"}").setHeader("Content-Type", "application/json"))
            worker.start(); assertTrue("old request must reach controlled boundary", entered.await(5, TimeUnit.SECONDS))
            if (kill) TraceItX.kill()
            start("B")
            release.countDown(); worker.join(5_000)
            assertFalse(worker.isAlive)
            if (fail) assertTrue(errorA.get() is IOException)
            else { errorA.get()?.let { throw it }; assertEquals("{\"owner\":\"project-A-response\"}", responseA.get()) }
            assertTrue("old request cannot borrow B's body generation", sharedNetworkBodyBuffer.snapshot().isEmpty())
            assertFalse("old request metadata cannot enter B", sharedNetworkBuffer.snapshot().any { it.url.contains("project-A-request") })
            assertFalse("old request crumb cannot enter B", sharedBreadcrumbBuffer.snapshotForReport().any { it.message.contains("project-A-request") })
            server.enqueue(MockResponse().setBody("{\"owner\":\"project-B-response\"}").setHeader("Content-Type", "application/json"))
            val fresh = client.newCall(Request.Builder().url(server.url("/project-B-request")).build()).execute().use { it.body!!.string() }
            assertEquals("{\"owner\":\"project-B-response\"}", fresh)
            assertTrue(sharedNetworkBuffer.snapshot().any { it.url.contains("project-B-request") })
            assertTrue(sharedBreadcrumbBuffer.snapshotForReport().any { it.message.contains("project-B-request") })
            assertTrue("same-session body capture must stay live", sharedNetworkBodyBuffer.snapshot().any { it.resBody == fresh })
        } finally {
            release.countDown(); worker.join(5_000); sharedNetworkBuffer.preLockHook = null
            TraceItX.__resetStartTailDelayHookForTesting(); TraceItX.kill()
            NetworkBodyFinalizer.__directForTesting = false
            server.shutdown()
        }
    }
}
