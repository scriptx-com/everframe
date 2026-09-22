// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Report Resource Window (spec 2026-09-05) — Round-2 review fix: `start()`
// used to arm (`handler = h`, evaluated atomically with `guard()` under
// `lock`) and then call `h.postDelayed(runnable, SAMPLE_INTERVAL_MS)` AFTER
// releasing that same lock. A `stop()` landing in that gap would null
// `handler`, capture the (not-yet-posted) runnable, and call
// `removeCallbacks` against it — a no-op, because nothing had been posted
// yet. `start()`'s thread would then go on to post it anyway, leaving an
// unstoppable one-shot callback that fires ~2s later and pushes one sample
// into the process-global ring AFTER teardown, exactly the residual DEFE-03
// hole `packages/sdk-android/.../ResourceSampler.kt`'s revised doc comment
// describes.
//
// Fixed by moving `h.postDelayed(...)` INSIDE the same `lock.withLock` block
// that performs the arm, so a concurrent `stop()` can only ever observe
// "not armed, nothing posted" or "armed AND posted" — never the gap between.
//
// This test reproduces the interleaving deterministically, without any
// sleep-based timing: `start(guard = ...)` is called with a `guard` that
// blocks on a latch — since `guard()` runs INSIDE `lock.withLock`, this holds
// the sampler's own lock for as long as the latch is held, exactly like
// `NetworkBodyCaptureState.__holdLockForTesting` / `BreadcrumbRingBuffer
// .__holdLockForTesting` do for their own locks. A second thread's `stop()`
// call is then genuinely forced to queue behind it (confirmed via
// `__hasQueuedThreadsForTesting()`, not a fixed sleep) before the guard is
// released. Because posting now happens before the lock is released, by the
// time the queued `stop()` finally acquires the lock, the runnable it
// captures is GUARANTEED to already be posted — so `removeCallbacks` always
// finds and cancels a real pending message, and idling Robolectric's paused
// main Looper past the sample interval afterward must show zero ticks.
package com.traceitx.capture

import android.os.Looper
import java.time.Duration
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ResourceSamplerConcurrencyTest {

    private companion object {
        // Same rationale/value as ReplaySessionGenerationRaceTest's own
        // COORDINATION_TIMEOUT_MS: generous so a loaded CI box never turns a
        // load-sensitivity issue into a false failure — none of these waits
        // is the claim under test, they only get two real OS threads into
        // the needed interleaving, and each returns the instant its
        // condition holds.
        const val COORDINATION_TIMEOUT_MS = 30_000L
    }

    @Test
    fun `stop queued behind an in-flight start always cancels the callback start posts`() {
        // honorsKillGate = false: this test is about the start/stop scheduling
        // race (Round-2 review fix), not about `TraceItX.captureGate` — bypass the
        // Finding-3 gate entirely so this ring's own default `captureGate` state
        // (false, unless some other test in this JVM already flipped it) can't turn
        // the assertion below into a false pass for the wrong reason.
        val ring = ResourceRingBuffer(windowSec = 60, honorsKillGate = false)
        val sampler = ResourceSampler(windowProvider = { 60 }, ringBuffer = ring)

        val guardEntered = CountDownLatch(1)
        val releaseGuard = CountDownLatch(1)

        // Holds `sampler`'s own lock for the duration, exactly like
        // `__holdLockForTesting` does for the buffer locks elsewhere in this
        // file's sibling race tests — `guard()` is evaluated INSIDE
        // `lock.withLock`, so blocking here blocks with the lock held.
        val starterThread = Thread {
            sampler.start(guard = {
                guardEntered.countDown()
                releaseGuard.await(COORDINATION_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                true
            })
        }
        starterThread.start()
        assertTrue(
            "starter thread never entered guard() — test setup is wrong, not exercising the race",
            guardEntered.await(COORDINATION_TIMEOUT_MS, TimeUnit.MILLISECONDS),
        )

        val stopperThread = Thread { sampler.stop() }
        stopperThread.start()

        // Wait until stop() is ACTUALLY blocked trying to acquire the
        // sampler's lock (held by the starter thread inside guard()) —
        // polling, not a fixed sleep, so this is deterministic regardless of
        // scheduling.
        val deadline = System.currentTimeMillis() + COORDINATION_TIMEOUT_MS
        while (!sampler.__hasQueuedThreadsForTesting() && System.currentTimeMillis() < deadline) {
            Thread.sleep(5)
        }
        assertTrue(
            "stop() never blocked on the sampler's own lock — test setup is wrong, not exercising the race",
            sampler.__hasQueuedThreadsForTesting(),
        )

        // Release the guard: start()'s thread arms `handler` AND posts the
        // runnable, all still under the same lock section, THEN releases it
        // — only at that point can the queued stop() proceed.
        releaseGuard.countDown()
        starterThread.join(COORDINATION_TIMEOUT_MS)
        stopperThread.join(COORDINATION_TIMEOUT_MS)

        assertFalse(
            "stop() queued behind an in-flight start() must leave the sampler not running",
            sampler.isRunning,
        )

        // The real assertion: advance Robolectric's paused main Looper past
        // the sample interval. Under the pre-fix code, this exact
        // interleaving could leave the posted runnable un-cancelled (posted
        // AFTER stop()'s no-op removeCallbacks), and it would fire here,
        // pushing one post-teardown sample into the ring. Under the fix,
        // stop() can never observe "armed but not yet posted", so the
        // callback is always cancelled before it can ever fire.
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(ResourceSampler.SAMPLE_INTERVAL_MS + 500))

        assertEquals(
            "a callback fired after stop() returned — the post-teardown sample the Round-2 fix exists to prevent",
            0,
            ring.snapshot(now = System.currentTimeMillis()).size,
        )
    }
}
