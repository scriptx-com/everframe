// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Round-4 review Finding F16 (2026-08-02-pr25-review-round-4): `start()` is
// explicitly supported multiple times (restart / re-init with a different
// app config). A superseding `start()` used to overwrite
// `Everframe._replaySession` with a fresh session WITHOUT tearing down the
// prior session first. The prior session's refresh coroutines were launched
// via the process-wide `Everframe.sdkScope` and were never individually
// cancelled — only `kill()`'s blanket
// `sdkScope.coroutineContext[Job]?.cancelChildren()` ever reached them — so a
// superseded session kept polling and could apply ITS stale `captureBodies`
// response to the process-global `NetworkBodyCaptureState` gate AFTER a NEW
// (superseding) session had already taken over.
//
// Fixed by giving `ReplaySession` its own generation `epoch` + idempotent
// `teardown()` (mirrors iOS `ReplaySession.epoch`/`teardown()`, round-3
// Finding F13, commit 7a047bdd): `teardown()` cancels this session's OWN
// refresh jobs directly and bumps `epoch`; `refreshConfigNow()` captures its
// epoch before the first suspension point and re-checks it (plus
// `isTornDown`) immediately before touching any process-global state.
// `Everframe.start()` now calls `_replaySession?.teardown()` on the prior
// session before installing its replacement.
//
// This spec drives `ReplaySession.refreshConfigNow()`/`teardown()` directly
// via the injectable-fetcher `ReplayConfigProvider` (mirrors
// `ReplaySessionRefreshLoopTest`'s fake-`ConfigFetcher` pattern), modeling
// the exact A→B restart sequence the reviewer described: session A's ON
// response is parked behind a real blocking `CountDownLatch` —
// `ConfigFetcher.fetch` is synchronous and `ReplayConfigProvider.refresh`
// hops to the REAL `Dispatchers.IO` to call it, so blocking there does not
// stall the test's virtual clock — released only AFTER session B (config
// OFF) has already applied its state.
package dev.everframe.capture.replay

import dev.everframe.Everframe
import dev.everframe.capture.NetworkBodyCaptureState
import dev.everframe.config.CaptureConfig
import dev.everframe.config.ConfigFetcher
import dev.everframe.config.ReplayConfigProvider
import dev.everframe.config.EverframeConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ReplaySessionSupersessionTest {

    private val url = "https://everframe.dev/api/config"

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        NetworkBodyCaptureState.resetForTesting()
        // Round-5 re-review gap: `refreshConfigNow()`'s network-body gate
        // fails closed on a null `Everframe.currentConfig` (F22). This spec
        // drives `ReplaySession` directly (not via `Everframe.start()`), so
        // `currentConfig` would otherwise stay null throughout and
        // `NetworkBodyCaptureState.isActive` could NEVER legitimately become
        // true — making the `assertFalse(isActive)` assertions below
        // vacuously true regardless of whether the F16 supersession-teardown
        // fix actually works. Set the client config via the test-only seam
        // (both client preconditions opted in), mirroring
        // `ReplaySessionRefreshLoopTest`'s setUp for the same finding.
        Everframe.__setConfigForTesting(
            EverframeConfig(appId = "app", sdkKey = "k", capture = CaptureConfig(network = true, networkBodies = true)),
        )
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        NetworkBodyCaptureState.resetForTesting()
        Everframe.__setConfigForTesting(null)
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

    private fun session(fetcher: ConfigFetcher): ReplaySession {
        val provider = ReplayConfigProvider(configUrl = url, apiKey = "k", fetcher = fetcher)
        return ReplaySession(apiKey = "k", locallyDisabled = false, provider = provider)
    }

    @Test
    fun `session A torn down by a superseding start cannot arm the gate with its stale ON response`() =
        runTest(UnconfinedTestDispatcher()) {
            val onBody = """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
                "networkBodies":{"captureBodies":true}}"""
            val offBody = """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
                "networkBodies":{"captureBodies":false}}"""

            val fetchStarted = CountDownLatch(1)
            val releaseFetch = CountDownLatch(1)
            var aCallCount = 0
            val fetcherA = ConfigFetcher {
                aCallCount += 1
                fetchStarted.countDown()
                // Real blocking wait — ReplayConfigProvider.refresh() hops to
                // the REAL Dispatchers.IO before calling this, so blocking
                // here does not stall the test's virtual clock.
                releaseFetch.await(5, TimeUnit.SECONDS)
                response(200, onBody)
            }
            val sessionA = session(fetcherA)

            var bCallCount = 0
            val fetcherB = ConfigFetcher {
                bCallCount += 1
                response(200, offBody)
            }
            val sessionB = session(fetcherB)

            // Mirrors enableIfConfigured()'s initial fetch: kick off A's
            // refresh in the background — it immediately parks on the latch.
            val aJob = launch { sessionA.refreshConfigNow() }
            assertTrue("session A's fetch never started", fetchStarted.await(5, TimeUnit.SECONDS))

            // The superseding start(): tear A down FIRST (the F16 fix in
            // Everframe.start()), THEN install + refresh B.
            sessionA.teardown()
            sessionB.refreshConfigNow()

            assertFalse("session B's OFF config must stand once installed", NetworkBodyCaptureState.isActive)
            assertEquals(1, bCallCount)

            // NOW release session A's parked, stale ON response — it
            // resolves LAST, well after B has already taken over.
            releaseFetch.countDown()
            aJob.join()

            assertFalse(
                "session A's stale captureBodies:true response, resolving AFTER it was torn down by a " +
                    "superseding start(), must not re-arm the process-global gate",
                NetworkBodyCaptureState.isActive,
            )
            assertEquals(1, aCallCount)
        }
}
