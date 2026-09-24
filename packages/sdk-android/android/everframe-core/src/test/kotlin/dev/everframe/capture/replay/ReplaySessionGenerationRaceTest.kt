// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Round-5 review Finding F24: `refreshConfigNow()`'s generation check was not
// atomic with the process-global applies that follow it. `teardown()` could
// bump `epoch` immediately after the check passed, and a stale refresh would
// still apply. The reviewer reproduced this deterministically: hold the
// breadcrumb buffer's lock (from another thread), start an ON refresh so it
// passes the generation check and blocks INSIDE
// `sharedBreadcrumbBuffer.applyConfig(...)` waiting for that externally-held
// lock, call `teardown()` (which bumps `epoch`), then release the lock — the
// now-unblocked call sailed on to `NetworkBodyCaptureState.applyConfig(...)`
// with an already-invalidated generation and re-armed the gate anyway. Job
// cancellation does not help here: the refresh is blocked acquiring a plain
// `ReentrantLock`, not suspended at a coroutine suspension point.
//
// Fixed by re-validating the generation, under a session-owned `sessionLock`,
// immediately before EVERY individual process-global apply — not just once
// at entry — with `teardown()` acquiring the SAME lock before bumping
// `epoch`. `sessionLock` is a short-lived leaf lock: never held while calling
// into a buffer's own lock (and `teardown()` never touches a buffer lock at
// all), so `teardown()` can always acquire it immediately, even while a
// refresh is blocked waiting on a buffer elsewhere — see
// `ReplaySession.sessionLock`'s doc comment for the full lock-ordering
// argument.
package dev.everframe.capture.replay

import dev.everframe.Everframe
import dev.everframe.capture.NetworkBodyCaptureState
import dev.everframe.capture.sharedBreadcrumbBuffer
import dev.everframe.config.CaptureConfig
import dev.everframe.config.ConfigFetcher
import dev.everframe.config.ReplayConfigProvider
import dev.everframe.config.EverframeConfig
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
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
class ReplaySessionGenerationRaceTest {

    private val url = "https://everframe.dev/api/config"

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        NetworkBodyCaptureState.resetForTesting()
        sharedBreadcrumbBuffer.applyConfig(null)
        // NetworkBodyCaptureState.applyConfig's `locallyDisabled` argument is
        // computed from `Everframe.currentConfig` — without a started config,
        // `locallyDisabled(null)` is unconditionally true (fail-closed) and
        // `isActive` could never become true regardless of whether this
        // finding's race is closed, silently making the assertion below
        // vacuous. `__setConfigForTesting` mirrors
        // ReplaySessionRefreshLoopTest's identical need (round-5 review
        // Finding F22) without paying for start()'s full async heavy-init
        // tail.
        Everframe.__setConfigForTesting(
            EverframeConfig(appId = "app", sdkKey = "k", capture = CaptureConfig(network = true, networkBodies = true)),
        )
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        NetworkBodyCaptureState.resetForTesting()
        sharedBreadcrumbBuffer.applyConfig(null)
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

    private companion object {
        /**
         * Budget for the thread-coordination waits in these tests (latch
         * awaits, the queued-threads poll, the holder join).
         *
         * 30s, raised from 5s on 2026-08-10. None of these waits is the claim
         * under test — the claims are the `isActive` assertions at the end.
         * They exist only to get two real OS threads into the interleaving the
         * race needs, and each returns the instant its condition holds, so a
         * larger ceiling costs a fast machine nothing.
         *
         * At 5s, `teardown racing a refresh blocked on NetworkBodyCaptureState's
         * own lock…` failed inside CI's `build-and-verify` job — while passing
         * in the android workflow's own `build` job on the SAME commit, which
         * is what a load-sensitive threshold looks like rather than a defect.
         * The setup guards are deliberately worded "test setup is wrong, not
         * exercising the race"; a timeout there reports a broken test, so
         * making the budget generous keeps that message honest.
         */
        const val COORDINATION_TIMEOUT_MS = 30_000L
    }

    @Test
    fun `teardown racing a refresh blocked on the breadcrumb lock still prevents it from arming the body gate`() =
        runTest(UnconfinedTestDispatcher()) {
            // Reviewer's exact repro: hold the breadcrumb buffer's lock from
            // another (real) thread first.
            val lockAcquired = CountDownLatch(1)
            val releaseLock = CountDownLatch(1)
            val holderThread = Thread {
                sharedBreadcrumbBuffer.__holdLockForTesting {
                    lockAcquired.countDown()
                    // The held lock defines the interleaving under test. A
                    // timed wait can silently release it on a loaded runner
                    // and turn the setup into a different race. The finally
                    // block below always releases this latch.
                    releaseLock.await()
                }
            }
            holderThread.start()
            try {
                assertTrue(
                    "lock-holder thread never acquired the breadcrumb lock",
                    lockAcquired.await(COORDINATION_TIMEOUT_MS, TimeUnit.MILLISECONDS),
                )

                val onBody = """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
                    "networkBodies":{"captureBodies":true}}"""
                val fetcher = ConfigFetcher { response(200, onBody) }
                val provider = ReplayConfigProvider(configUrl = url, apiKey = "k", fetcher = fetcher)
                val session = ReplaySession(apiKey = "k", locallyDisabled = false, provider = provider)

                // Mirrors enableIfConfigured()'s initial fetch. ReplayConfigProvider
                // .refresh() hops to the REAL Dispatchers.IO, so this genuinely runs
                // on a separate OS thread and genuinely blocks on the
                // externally-held breadcrumb lock below (not merely simulated) —
                // mirrors ReplaySessionSupersessionTest's identical rationale.
                val refreshJob = launch { session.refreshConfigNow() }

                // Wait until the refresh coroutine is ACTUALLY blocked trying to
                // acquire the breadcrumb buffer's lock — polling
                // hasQueuedThreads() rather than a fixed sleep, so this is
                // deterministic regardless of scheduling.
                val deadline = System.currentTimeMillis() + COORDINATION_TIMEOUT_MS
                while (!sharedBreadcrumbBuffer.__hasQueuedThreadsForTesting() && System.currentTimeMillis() < deadline) {
                    Thread.sleep(5)
                }
                assertTrue(
                    "refresh never blocked on the breadcrumb buffer's lock — test setup is wrong, not exercising the race",
                    sharedBreadcrumbBuffer.__hasQueuedThreadsForTesting(),
                )

                // teardown() must be able to proceed RIGHT NOW, even though the
                // refresh coroutine is still blocked above — this is exactly what
                // `sessionLock` never being held across a buffer call makes
                // possible.
                session.teardown()

                // NOW release the breadcrumb lock — the blocked applyConfig call
                // unblocks and completes, then refreshConfigNow()'s SECOND
                // generation check (immediately before the network-body apply)
                // must see the bumped epoch and bail out.
                releaseLock.countDown()
                refreshJob.join()

                assertFalse(
                    "teardown() racing a refresh blocked on the breadcrumb lock must still prevent " +
                        "NetworkBodyCaptureState.isActive from becoming true",
                    NetworkBodyCaptureState.isActive,
                )
            } finally {
                releaseLock.countDown()
                holderThread.join()
            }
        }

    // Round-6 review Finding F26: the fix above (re-validating the
    // generation immediately before EACH apply) was itself not atomic with
    // the apply it guards — `currentGenerationValid()` releases
    // `sessionLock` BEFORE `NetworkBodyCaptureState.applyConfig()` acquires
    // ITS OWN lock, so `teardown()` can still land in the gap between "check
    // passed" and "the guarded call actually starts mutating", specifically
    // while that call is itself blocked trying to acquire
    // `NetworkBodyCaptureState`'s lock (not the breadcrumb buffer's — that
    // race is what the test above already closes). Reviewer's exact repro:
    // hold `NetworkBodyCaptureState`'s own lock from another thread, let an
    // ON refresh pass the check immediately before the
    // NetworkBodyCaptureState.applyConfig call and block trying to acquire
    // that externally-held lock, call teardown(), release — the
    // now-unblocked call must still not arm the gate.
    @Test
    fun `teardown racing a refresh blocked on NetworkBodyCaptureState's own lock still prevents isActive from becoming true`() =
        runTest(UnconfinedTestDispatcher()) {
            val lockAcquired = CountDownLatch(1)
            val releaseLock = CountDownLatch(1)
            val holderThread = Thread {
                NetworkBodyCaptureState.__holdLockForTesting {
                    lockAcquired.countDown()
                    // The held lock defines the interleaving under test. A
                    // timed wait can silently release it on a loaded runner
                    // and turn the setup into a different race. The finally
                    // block below always releases this latch.
                    releaseLock.await()
                }
            }
            holderThread.start()
            try {
                assertTrue(
                    "lock-holder thread never acquired NetworkBodyCaptureState's lock",
                    lockAcquired.await(COORDINATION_TIMEOUT_MS, TimeUnit.MILLISECONDS),
                )

                val onBody = """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
                    "networkBodies":{"captureBodies":true}}"""
                val fetcher = ConfigFetcher { response(200, onBody) }
                val provider = ReplayConfigProvider(configUrl = url, apiKey = "k", fetcher = fetcher)
                val session = ReplaySession(apiKey = "k", locallyDisabled = false, provider = provider)

                // Mirrors enableIfConfigured()'s initial fetch — hops to the
                // REAL Dispatchers.IO inside provider.refresh(), so this
                // genuinely blocks on the externally-held NetworkBodyCaptureState
                // lock below on a separate OS thread, same rationale as the test
                // above.
                val refreshJob = launch { session.refreshConfigNow() }

                val deadline = System.currentTimeMillis() + COORDINATION_TIMEOUT_MS
                while (!NetworkBodyCaptureState.__hasQueuedThreadsForTesting() && System.currentTimeMillis() < deadline) {
                    Thread.sleep(5)
                }
                assertTrue(
                    "refresh never blocked on NetworkBodyCaptureState's own lock — test setup is wrong, not exercising the race",
                    NetworkBodyCaptureState.__hasQueuedThreadsForTesting(),
                )

                // teardown() must be able to proceed RIGHT NOW even though the
                // refresh is blocked above — sessionLock is never held across a
                // buffer's own lock.
                session.teardown()

                releaseLock.countDown()
                refreshJob.join()

                assertFalse(
                    "teardown() racing a refresh blocked on NetworkBodyCaptureState's OWN lock must still " +
                        "prevent isActive from becoming true",
                    NetworkBodyCaptureState.isActive,
                )
            } finally {
                releaseLock.countDown()
                holderThread.join()
            }
        }

    // Round-1 review, Critical 1 (Report Resource Window, spec 2026-09-05):
    // the SAME F24/F26 race, applied to the resource sampler. Worse here
    // than the NetworkBodyCaptureState case above: that one is a
    // process-global `kill()` separately `reset()`s, but `ResourceSampler`
    // is SESSION-OWNED, and `kill()` nulls `Everframe._replaySession` —
    // once orphaned, nothing can ever call `stop()` on it again. Reviewer's
    // exact repro (identical shape to the breadcrumb-lock test above): hold
    // `sharedBreadcrumbBuffer`'s lock, let an ON refresh (with
    // `resources.enabled: true`) pass the generation check and block inside
    // `sharedBreadcrumbBuffer.applyConfig(...)`, call `teardown()`, release
    // — the now-unblocked call must still not arm the sampler.
    @Test
    fun `teardown racing a refresh blocked on the breadcrumb lock must not leave the resource sampler running`() =
        runTest(UnconfinedTestDispatcher()) {
            val lockAcquired = CountDownLatch(1)
            val releaseLock = CountDownLatch(1)
            val holderThread = Thread {
                sharedBreadcrumbBuffer.__holdLockForTesting {
                    lockAcquired.countDown()
                    // Keep the intended interleaving until the test explicitly
                    // releases it; a timed wait can silently unlock under load.
                    releaseLock.await()
                }
            }
            holderThread.start()
            try {
                assertTrue(
                    "lock-holder thread never acquired the breadcrumb lock",
                    lockAcquired.await(COORDINATION_TIMEOUT_MS, TimeUnit.MILLISECONDS),
                )

                val onBody = """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
                    "resources":{"enabled":true}}"""
                val fetcher = ConfigFetcher { response(200, onBody) }
                val provider = ReplayConfigProvider(configUrl = url, apiKey = "k", fetcher = fetcher)
                val session = ReplaySession(apiKey = "k", locallyDisabled = false, provider = provider)

                val refreshJob = launch { session.refreshConfigNow() }

                val deadline = System.currentTimeMillis() + COORDINATION_TIMEOUT_MS
                while (!sharedBreadcrumbBuffer.__hasQueuedThreadsForTesting() && System.currentTimeMillis() < deadline) {
                    Thread.sleep(5)
                }
                assertTrue(
                    "refresh never blocked on the breadcrumb buffer's lock — test setup is wrong, not exercising the race",
                    sharedBreadcrumbBuffer.__hasQueuedThreadsForTesting(),
                )

                // teardown() must be able to proceed RIGHT NOW, even though the
                // refresh coroutine is still blocked above.
                session.teardown()

                // NOW release the breadcrumb lock — the blocked applyConfig call
                // unblocks and completes, then refreshConfigNow()'s generation
                // check immediately before touching the resource sampler must
                // see the bumped epoch and bail out BEFORE `resourceSampler
                // .start()` ever runs.
                releaseLock.countDown()
                refreshJob.join()

                assertFalse(
                    "teardown() racing a refresh blocked on the breadcrumb lock must not leave the " +
                        "resource sampler running — an orphaned, unstoppable sampler would keep sampling " +
                        "after the kill switch fired",
                    session.__resourceSamplerIsRunningForTesting,
                )
            } finally {
                releaseLock.countDown()
                holderThread.join()
            }
        }
}
