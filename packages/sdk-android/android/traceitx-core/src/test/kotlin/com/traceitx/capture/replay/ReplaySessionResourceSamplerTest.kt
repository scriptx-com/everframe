// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Report Resource Window (spec 2026-09-05) — gap class 2: the sampler was
// built and unit-tested in isolation (Task 12) but never wired into the SDK
// lifecycle, which would have shipped a dead feature exactly like it did on
// iOS before that gap was closed there. ReplaySession is the Android
// equivalent of iOS's config-applying session object — the one seam every
// other server-negotiated, live-reapplied block (breadcrumbs, network-body
// capture, replay images) already goes through — so the resource sampler is
// gated here too, on the LIVE `resources.enabled` flag, the same way
// `windowSec` is read live.
//
// Harness mirrors ReplaySessionRefreshLoopTest.kt exactly: an injectable-
// fetcher/injectable-clock ReplayConfigProvider drives `refreshConfigNow()`
// directly. No real network, no 300s delay.
package com.traceitx.capture.replay

import com.traceitx.TraceItX
import com.traceitx.capture.sharedResourceBuffer
import com.traceitx.config.ConfigFetcher
import com.traceitx.config.ReplayConfigProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Request
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

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ReplaySessionResourceSamplerTest {

    private val url = "https://traceitx.com/api/config"

    @Before
    fun setUp() {
        // Same rationale as ReplaySessionRefreshLoopTest: `refreshConfigNow()`
        // ends with `withContext(Dispatchers.Main) { startBufferingIfEligible() }`;
        // UnconfinedTestDispatcher runs that hop inline under Robolectric's
        // default PAUSED LooperMode.
        Dispatchers.setMain(UnconfinedTestDispatcher())
        sharedResourceBuffer.clear()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        sharedResourceBuffer.clear()
    }

    private fun response(code: Int, body: String): Response {
        val req = Request.Builder().url(url).build()
        return Response.Builder()
            .request(req)
            .protocol(Protocol.HTTP_1_1)
            .code(code)
            .message(if (code == 200) "OK" else "ERR")
            .body(body.toResponseBody("application/json".toMediaType()))
            .build()
    }

    private fun session(clock: () -> Long, fetcher: ConfigFetcher): ReplaySession {
        val provider = ReplayConfigProvider(configUrl = url, apiKey = "k", fetcher = fetcher, now = clock)
        return ReplaySession(apiKey = "k", locallyDisabled = false, provider = provider)
    }

    @Test
    fun `sampler does not run when the server block is absent`() = runTest {
        val session = session(clock = { 0L }, fetcher = {
            response(200, """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0}""")
        })
        session.refreshConfigNow()
        assertFalse(session.__resourceSamplerIsRunningForTesting)
    }

    @Test
    fun `sampler does not run when the server explicitly disables it`() = runTest {
        val session = session(clock = { 0L }, fetcher = {
            response(
                200,
                """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
                "resources":{"enabled":false}}""",
            )
        })
        session.refreshConfigNow()
        assertFalse(session.__resourceSamplerIsRunningForTesting)
    }

    @Test
    fun `sampler runs when the server enables it`() = runTest {
        val session = session(clock = { 0L }, fetcher = {
            response(
                200,
                """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
                "resources":{"enabled":true,"windowSec":30}}""",
            )
        })
        session.refreshConfigNow()
        assertTrue(session.__resourceSamplerIsRunningForTesting)
        // The live windowSec must be applied to the shared ring, same seam
        // the sampler itself reads back on every tick.
        assertEquals(30, sharedResourceBuffer.windowSec)
    }

    @Test
    fun `sampler stops on teardown`() = runTest {
        val session = session(clock = { 0L }, fetcher = {
            response(
                200,
                """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
                "resources":{"enabled":true}}""",
            )
        })
        session.refreshConfigNow()
        assertTrue(session.__resourceSamplerIsRunningForTesting)
        session.teardown()
        assertFalse(session.__resourceSamplerIsRunningForTesting)
    }

    @Test
    fun `sampler starts on a live false to true config flip, no restart needed`() = runTest {
        var callCount = 0
        val fetcher = ConfigFetcher {
            callCount += 1
            if (callCount == 1) {
                response(
                    200,
                    """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
                    "resources":{"enabled":false}}""",
                )
            } else {
                response(
                    200,
                    """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
                    "resources":{"enabled":true}}""",
                )
            }
        }
        var clockValue = 0L
        val session = session(clock = { clockValue }, fetcher = fetcher)

        session.refreshConfigNow()
        assertFalse(session.__resourceSamplerIsRunningForTesting)

        // Simulate the periodic loop's next tick (past the provider's TTL) by
        // invoking the same seam again directly — no delay, no real network.
        clockValue = 400_000L
        session.refreshConfigNow()
        assertTrue(session.__resourceSamplerIsRunningForTesting)
        assertEquals(2, callCount)

        session.teardown()
    }
}
