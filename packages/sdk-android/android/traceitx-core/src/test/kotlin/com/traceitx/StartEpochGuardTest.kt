// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Re-review gap (post round-4 F16, commit 4a2411cc): F16 gave ReplaySession
// its own per-session epoch so a SUPERSEDING start() tears down a prior
// session before installing its replacement. It did not, however, guard
// against a `kill()` racing an in-flight `start()`: `start()`'s heavy-init
// coroutine builds a fresh `ReplaySession` and installs it into
// `TraceItX._replaySession` synchronously (no suspension point in that
// block) — a `kill()` landing while that coroutine is still mid-tail used to
// have no effect on the about-to-be-installed session: it would land
// anyway, moments after `kill()` believed itself done, and its refresh loop
// could re-arm the process-global network-body gate off a killed app's
// config.
//
// Crucially, `kill()`'s `sdkScope.coroutineContext[Job]?.cancelChildren()`
// CANNOT be relied on to stop this: `start()`'s heavy-init coroutine is a
// child of `sdkScope`, but the `start.replay` block has no suspension point
// between building the candidate `ReplaySession` and installing it —
// cooperative cancellation only takes effect at a suspension point, so a
// `kill()` racing in has nothing to interrupt there. This is also why this
// test's delay hook (below) is a BLOCKING call, not a `suspend` one: a
// `suspend` hook parked on e.g. `CompletableDeferred.await()` IS a
// suspension point and WOULD get cancelled by `cancelChildren()` — which
// would make this test pass even without the epoch guard, for the wrong
// reason (accidentally exercising cancellation instead of the race the
// guard is meant to close).
//
// Fixed the same way as iOS (TraceItX.swift, commit 826e5f76): a
// monotonically increasing `_startEpoch`, bumped under `stateLock` by BOTH
// `start()` and `kill()`. `start()`'s heavy-init tail captures its epoch at
// entry and, in the `start.replay` block, re-checks under `stateLock`
// immediately before installing that the epoch is still current; if not, it
// tears down the just-built session instead of installing it.
//
// `TraceItX.__startTailDelayHookForTesting` parks the tail (via a real
// blocking `CountDownLatch.await()` on the `Dispatchers.IO` thread pool
// thread executing it — mirrors `ReplaySessionSupersessionTest`'s
// fetcher-latch pattern) right after the candidate `ReplaySession` is built
// and before the epoch recheck, so this test can interleave `kill()` before
// releasing it.
package com.traceitx

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.traceitx.capture.NetworkBodyCaptureState
import com.traceitx.capture.sharedBreadcrumbBuffer
import com.traceitx.capture.sharedNetworkBodyBuffer
import com.traceitx.capture.sharedNetworkBuffer
import com.traceitx.config.CaptureConfig
import com.traceitx.config.TXUser
import com.traceitx.config.TraceItXConfig
import com.traceitx.shared.SharedData
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class StartEpochGuardTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()

    private fun validConfig(): TraceItXConfig = TraceItXConfig(
        appId = "test-app-id",
        sdkKey = "txx_live_test1234567890",
        // Mirrors TraceItXTest.validConfig()'s rationale: keep the
        // detached heavy-init coroutine's OTHER side effects (log tee
        // install) out of this suite entirely.
        capture = CaptureConfig(logs = false),
    )

    @Before
    fun setUp() {
        SharedData.init(context)
        NetworkBodyCaptureState.resetForTesting()
    }

    @After
    fun tearDown() {
        TraceItX.__resetStartTailDelayHookForTesting()
        TraceItX.kill()
        sharedBreadcrumbBuffer.applyConfig(null)
        sharedBreadcrumbBuffer.clear()
        sharedNetworkBodyBuffer.clear()
        sharedNetworkBuffer.clear()
        NetworkBodyCaptureState.resetForTesting()
    }

    @Test
    fun `kill racing an in-flight start discards the stale ReplaySession install`() {
        val hookEntered = CountDownLatch(1)
        val releaseTail = CountDownLatch(1)
        TraceItX.__startTailDelayHookForTesting = {
            hookEntered.countDown()
            // Real blocking wait on the sdkScope (Dispatchers.IO) thread
            // executing this coroutine — NOT a suspend call, so kill()'s
            // cancelChildren() has no suspension point here to act on. This
            // is what makes the race deterministic AND faithful to
            // production (which also has no suspension point at this
            // spot) — see this file's header comment. Not asserted here:
            // this hook body runs inside `txGuardVoid`, which would
            // silently swallow a thrown AssertionError — a timeout is
            // instead surfaced by the outer `hookEntered`/state assertions
            // below failing on their own.
            releaseTail.await(5, TimeUnit.SECONDS)
        }

        // start() must return synchronously (its documented <5ms contract)
        // with the heavy-init coroutine now parked inside the hook — before
        // it has reached the stateLock-guarded epoch recheck + install.
        TraceItX.start(context, validConfig())
        assertTrue("session's heavy-init tail never reached the delay hook", hookEntered.await(5, TimeUnit.SECONDS))

        // kill() races it right here, mid-tail: bumps _startEpoch before the
        // parked tail's recheck can observe the epoch it captured at start().
        TraceItX.kill()

        // Release the parked tail so it can (attempt to) proceed to install.
        releaseTail.countDown()

        // Give the released tail time to actually run its (synchronous, no
        // suspension point) stateLock-guarded recheck + install-or-discard
        // decision — long enough that an unguarded install would have
        // landed.
        Thread.sleep(500)

        assertNull(
            "kill() racing start()'s in-flight heavy-init tail must discard the stale ReplaySession " +
                "install, not let it land after kill() — _replaySession must stay null",
            TraceItX._replaySession,
        )
        assertFalse(
            "the process-global network-body gate must not be armed by a session that was never " +
                "installed because kill() won the race",
            NetworkBodyCaptureState.isActive,
        )
        assertFalse("kill() must leave captureGate closed", TraceItX.captureGate)
    }

    @Test
    fun `start after the raced kill still installs its own session normally`() {
        val hookEntered = CountDownLatch(1)
        val releaseTail = CountDownLatch(1)
        TraceItX.__startTailDelayHookForTesting = {
            hookEntered.countDown()
            releaseTail.await(5, TimeUnit.SECONDS)
        }

        TraceItX.start(context, validConfig())
        assertTrue(hookEntered.await(5, TimeUnit.SECONDS))
        TraceItX.kill()
        releaseTail.countDown()
        Thread.sleep(500)
        assertNull(TraceItX._replaySession)

        // A later, LEGITIMATE start() (its own fresh epoch, no delay hook
        // this time) must still be able to install its own session — the
        // epoch guard must not permanently wedge the SDK shut.
        TraceItX.__resetStartTailDelayHookForTesting()
        TraceItX.start(context, validConfig())

        val deadline = System.currentTimeMillis() + 2_000
        while (TraceItX._replaySession == null && System.currentTimeMillis() < deadline) {
            Thread.sleep(10)
        }
        assertTrue(
            "a later legitimate start() must still be able to install its session",
            TraceItX._replaySession != null,
        )
    }

    /**
     * Codex round-6, #1. `start()` reserves its epoch and only then reaches
     * the block that removes and tears down the previous session's
     * `ReplaySession`. That block took `stateLock` but checked nothing, so a
     * `start(B)` descheduled long enough for `start(C)` to complete — install
     * included — tore down **C's** session on its way past: C lost replay,
     * and with it the coordinator that publishes every later vitals config
     * update. B's own publication re-check further down refuses too late to
     * undo that.
     *
     * Driven at the decision itself (`takeSupersededReplay`): the window sits
     * between two points inside `start()`'s synchronous body with no seam
     * between them, and a stale epoch is exactly what a descheduled B holds.
     */
    @Test
    fun `a start whose epoch has moved tears down nothing`() {
        TraceItX.start(context, validConfig())
        val staleEpoch = TraceItX.currentStartEpoch()
        awaitReplaySession("the first start never installed a session")

        // A second start supersedes it and installs its own — this is "C".
        TraceItX.start(context, validConfig())
        assertNotEquals(
            "precondition: the second start really reserved a newer epoch",
            staleEpoch,
            TraceItX.currentStartEpoch(),
        )
        awaitReplaySession("the superseding start never installed its own session")
        val live = TraceItX._replaySession

        assertNull(
            "a start whose epoch has moved must take no session to tear down",
            TraceItX.takeSupersededReplay(staleEpoch),
        )
        assertSame(
            "...and must leave the newer start's ReplaySession installed",
            live,
            TraceItX._replaySession,
        )

        // Not a blanket refusal: the start that IS newest still supersedes.
        assertSame(live, TraceItX.takeSupersededReplay(TraceItX.currentStartEpoch()))
        assertNull(TraceItX._replaySession)
    }

    private fun awaitReplaySession(why: String) {
        val deadline = System.currentTimeMillis() + 5_000
        while (TraceItX._replaySession == null && System.currentTimeMillis() < deadline) Thread.sleep(10)
        assertNotNull(why, TraceItX._replaySession)
    }

    @Test
    fun `start does not bump killGeneration`() {
        TraceItX.start(context, TraceItXConfig(appId = "app_a", sdkKey = "sk_a"))
        val before = TraceItX.captureSessionSnapshot().killGeneration
        TraceItX.start(context, TraceItXConfig(appId = "app_b", sdkKey = "sk_b"))
        assertFalse(
            "start() must not look like a revocation",
            TraceItX.killGenerationChanged(before),
        )
    }

    @Test
    fun `kill bumps killGeneration`() {
        TraceItX.start(context, TraceItXConfig(appId = "app_a", sdkKey = "sk_a"))
        val before = TraceItX.captureSessionSnapshot().killGeneration
        TraceItX.kill()
        assertTrue(TraceItX.killGenerationChanged(before))
    }

    /** The case a boolean gate cannot express — start() re-opens captureGate. */
    @Test
    fun `kill then start still reads as revoked`() {
        TraceItX.start(context, TraceItXConfig(appId = "app_a", sdkKey = "sk_a"))
        val before = TraceItX.captureSessionSnapshot().killGeneration
        TraceItX.kill()
        TraceItX.start(context, TraceItXConfig(appId = "app_b", sdkKey = "sk_b"))
        assertTrue("precondition: start() re-opened the gate", TraceItX.captureGate)
        assertTrue(
            "a later start() must not resurrect a revoked capture",
            TraceItX.killGenerationChanged(before),
        )
    }

    @Test
    fun `snapshot pairs the user with the config of the same session`() {
        TraceItX.start(context, TraceItXConfig(appId = "app_a", sdkKey = "sk_a"))
        TraceItX.setUser(TXUser(id = "u_1"))
        val snap = TraceItX.captureSessionSnapshot()
        assertEquals("u_1", snap.user.user?.id)
        assertEquals("sk_a", snap.config?.sdkKey)
    }
}
