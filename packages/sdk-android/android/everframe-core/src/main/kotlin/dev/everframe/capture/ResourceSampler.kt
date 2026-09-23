// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Report Resource Window (spec 2026-09-05) — periodic CPU/memory sampler
// feeding `sharedResourceBuffer`. CPU comes from `/proc/self/stat`'s
// utime/stime (fields 14/15, in clock ticks) — cumulative PER-PROCESS
// counters that only ever increase (unlike iOS's TASK_THREAD_TIMES_INFO,
// which is a LIVE-THREADS-ONLY aggregate that can decrease when a thread
// with accrued time exits — see `safeFractionSinceBaseline`'s guard for why
// that one needs a negative-delta escape hatch iOS's own comment describes
// as NOT theoretical there). Memory comes from `Debug.MemoryInfo.totalPss`
// (see the risk note in task-12-brief.md §Step 4 — the read-cost measurement
// is deferred to on-device verification; PSS is implemented as specified).
//
// Every read is wrapped in try/catch — a failed `/proc` read or a failed
// `Debug.getMemoryInfo` call skips the affected value (or the whole sample,
// for memory, which is mandatory on an Entry) rather than throwing. Pauses
// while backgrounded (`ProcessLifecycleOwner` ON_STOP) and resets the CPU
// baseline on resume (ON_START) so a CPU-time delta measured across a
// suspended app is never reported as usage — mirrors iOS's
// `pauseForBackground`/`resumeFromForeground`.
package dev.everframe.capture

import android.os.Debug
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.annotation.VisibleForTesting
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.math.min

/** utime/stime in clock ticks, parsed from `/proc/self/stat` fields 14/15. */
data class ProcCpuTicks(val utime: Long, val stime: Long)

/**
 * Periodic sampler. Idempotent `start()`/`stop()`; safe to call either
 * repeatedly. Not started/stopped by itself on construction — the owning
 * config-applying session (`ReplaySession`) gates this on the LIVE
 * `resources.enabled` server flag, the same seam `windowSec` already uses.
 *
 * @param windowProvider read live on every tick and written back to
 *   [sharedResourceBuffer]'s `windowSec` — the ring's own eviction horizon,
 *   never captured once at construction (mirrors iOS's
 *   `ResourceSampler(windowProvider:)`).
 * @param ringBuffer injectable for tests; defaults to the process-wide
 *   singleton.
 */
class ResourceSampler(
    private val windowProvider: () -> Int = { sharedResourceBuffer.windowSec },
    private val ringBuffer: ResourceRingBuffer = sharedResourceBuffer,
) : DefaultLifecycleObserver {

    private val lock = ReentrantLock()
    private var handler: Handler? = null
    private var tickRunnable: Runnable? = null
    private var isPaused = false
    private var hasBaseline = false
    private var baselineWallSec = 0.0
    private var baselineTicks = 0L

    /**
     * Round-1 review fix (Minor 4) — an `AtomicBoolean`, mirroring
     * `LifecycleBreadcrumbObserver.installed`, so `stop()` can symmetrically
     * remove the observer it added. Unlike `LifecycleBreadcrumbObserver`
     * (a process-wide singleton, install-once-forever by design), a
     * `ResourceSampler` is owned per `ReplaySession` and started/stopped
     * repeatedly across the session's life — leaving the observer installed
     * across a `stop()` would mean every foreground resume keeps doing a
     * real `/proc/self/stat` read (via `onStart` below) even while nothing
     * is sampling, and every start/kill cycle strands one more observer on
     * the process-wide `ProcessLifecycleOwner` forever.
     */
    private val lifecycleObserverInstalled = AtomicBoolean(false)

    /** Test-observability seam — whether the repeating tick is currently
     *  armed. Mirrors `NetworkBodyCaptureState.isActive` / iOS's
     *  `ResourceSampler.isRunning`. */
    @VisibleForTesting
    internal val isRunning: Boolean
        get() = lock.withLock { handler != null }

    /**
     * Test-only (Round-2 review, the postDelayed-outside-the-lock fix): true
     * once at least one other thread is blocked waiting to acquire [lock] —
     * lets a test poll for "a concurrent `stop()` call is genuinely queued
     * behind an in-flight `start()`" deterministically instead of a fixed
     * sleep. Mirrors `NetworkBodyCaptureState.__hasQueuedThreadsForTesting` /
     * `BreadcrumbRingBuffer.__hasQueuedThreadsForTesting`.
     */
    @VisibleForTesting
    internal fun __hasQueuedThreadsForTesting(): Boolean = lock.hasQueuedThreads()

    /**
     * Idempotent. Starts the 2s repeating tick and (on first start, or the
     * first start after a `stop()`) registers the app-lifecycle pause/resume
     * observer. No-op if already running.
     *
     * @param guard Round-1 review fix (Critical 1) — evaluated INSIDE
     *   [lock], atomically with the actual arm (`handler = h`), never just
     *   as a pre-check before it. `ReplaySession.refreshConfigNow`'s own
     *   `currentGenerationValid` check immediately before calling this is
     *   only a fast pre-filter — this file's own F24/F26 doctrine (see
     *   `ReplaySession.sessionLock`'s doc comment) is that `teardown()` can
     *   still land in the gap between that check and the mutation actually
     *   landing, especially while this call blocks trying to acquire
     *   [lock] against a concurrent `stop()` from `teardown()`. Defaults to
     *   always-armed for callers (tests, mainly) that don't need the
     *   guard — mirrors `NetworkBodyCaptureState.applyConfig`'s `guard`
     *   parameter shape.
     */
    fun start(guard: () -> Boolean = { true }) {
        lock.lock()
        if (handler != null) { lock.unlock(); return }
        lock.unlock()

        val h = Handler(Looper.getMainLooper())
        lateinit var runnable: Runnable
        runnable = Runnable {
            tick()
            // Minor 3 fix: identity, not nullness. A `stop()` landing while
            // this tick is executing (between `tick()` above and this
            // re-post) followed by a `start()` would otherwise have this
            // OLD runnable see the NEW `handler` as non-null and re-post
            // itself onto the OLD `h` — a second, unstoppable repeating
            // callback `stop()`'s `removeCallbacks(r)` (called against the
            // NEW pair) can never reach.
            lock.withLock { if (handler === h) h.postDelayed(runnable, SAMPLE_INTERVAL_MS) }
        }

        val armed = lock.withLock {
            if (handler == null && guard()) {
                handler = h
                tickRunnable = runnable
                isPaused = false
                hasBaseline = false
                // Round-2 fix: posting happens INSIDE the same lock section
                // that arms `handler`, not after releasing it. Previously a
                // `stop()` could land in the gap between releasing this lock
                // and the (formerly outside-the-lock) `postDelayed` call:
                // `stop()` would null `handler` and call `removeCallbacks`
                // against a runnable that was never actually posted yet, so
                // the callback still fires ~2s later — one post-teardown
                // `tick()` landing in the process-global ring after
                // `clearCapturedEvidenceBuffers()` has already run. Posting
                // atomically with arming closes that window: `stop()` can now
                // only ever observe either "not armed yet, nothing posted" or
                // "armed and posted", never the gap in between. Safe against
                // new lock-ordering issues: `Handler.postDelayed` only takes
                // the MessageQueue's own lock, and nothing here holds that
                // lock while acquiring `lock`.
                h.postDelayed(runnable, SAMPLE_INTERVAL_MS)
                true
            } else {
                false
            }
        }
        if (!armed) return

        if (lifecycleObserverInstalled.compareAndSet(false, true)) {
            runOnMain { ProcessLifecycleOwner.get().lifecycle.addObserver(this) }
        }
    }

    /** Idempotent. Stops the repeating tick AND removes the lifecycle
     *  observer (Minor 4 fix) — a later `start()` on this SAME instance
     *  re-installs it, so this is a clean pause/resume pair, not a one-shot
     *  install like `LifecycleBreadcrumbObserver`'s. */
    fun stop() {
        lock.lock()
        val h = handler
        val r = tickRunnable
        handler = null
        tickRunnable = null
        lock.unlock()
        if (h != null && r != null) h.removeCallbacks(r)

        if (lifecycleObserverInstalled.compareAndSet(true, false)) {
            runOnMain { ProcessLifecycleOwner.get().lifecycle.removeObserver(this) }
        }
    }

    override fun onStop(owner: LifecycleOwner) {
        lock.withLock { isPaused = true }
    }

    /** Resets the baseline HERE, synchronously, on resume — not lazily on the
     *  next tick — so the frozen background span is discarded immediately
     *  rather than folded into whatever tick happens to run next. */
    override fun onStart(owner: LifecycleOwner) {
        val ticks = try {
            readProcSelfCpuTicks()
        } catch (_: Throwable) {
            null
        }
        lock.withLock {
            if (ticks != null) {
                baselineWallSec = wallSec()
                baselineTicks = ticks.utime + ticks.stime
                hasBaseline = true
            } else {
                hasBaseline = false
            }
            isPaused = false
        }
    }

    private fun tick() {
        val paused = lock.withLock { isPaused }
        if (paused) return

        // Memory is mandatory on a ResourceSample — a failed read skips the
        // WHOLE sample rather than shipping a fabricated value.
        val mem = try {
            readMemoryFootprintBytes()
        } catch (_: Throwable) {
            null
        } ?: return

        var cpu: Double? = null
        val wallNow = wallSec()
        val ticks = try {
            readProcSelfCpuTicks()
        } catch (_: Throwable) {
            null
        }
        if (ticks != null) {
            val totalTicks = ticks.utime + ticks.stime
            val (hadBaseline, baseWall, baseTicks) = lock.withLock {
                Triple(hasBaseline, baselineWallSec, baselineTicks)
            }
            if (hadBaseline) {
                val ticksDelta = totalTicks - baseTicks
                val wallDelta = wallNow - baseWall
                cpu = safeCpuFraction(ticksDelta, wallDelta, CLOCK_TICKS_PER_SEC)
            }
            // Baseline ALWAYS advances forward, regardless of the branch
            // above (mirrors iOS's fractionSinceBaseline `defer`), so the
            // very next tick measures only its own interval — never
            // compounding a stale/negative reading forward.
            lock.withLock {
                baselineWallSec = wallNow
                baselineTicks = totalTicks
                hasBaseline = true
            }
        }
        // cpu read failure: never traps — `cpu` simply stays null for this
        // sample.

        ringBuffer.windowSec = windowProvider()
        ringBuffer.push(ResourceRingBuffer.Entry(t = System.currentTimeMillis(), cpu = cpu, mem = mem))
    }

    private fun wallSec(): Double = SystemClock.elapsedRealtime() / 1000.0

    private fun readMemoryFootprintBytes(): Long {
        val info = Debug.MemoryInfo()
        Debug.getMemoryInfo(info)
        // totalPss is reported in KB.
        return info.totalPss.toLong() * 1024L
    }

    private fun readProcSelfCpuTicks(): ProcCpuTicks? {
        val line = File("/proc/self/stat").readText()
        return parseProcSelfStat(line)
    }

    private fun runOnMain(block: () -> Unit) {
        val mainLooper = Looper.getMainLooper()
        if (Looper.myLooper() === mainLooper) {
            block()
        } else {
            Handler(mainLooper).post(block)
        }
    }

    companion object {
        /** Mirrors protocol's `RESOURCE_SAMPLE_INTERVAL_MS` (2_000ms). Fixed
         *  — not configurable; only the window length is a knob. */
        const val SAMPLE_INTERVAL_MS = 2_000L

        /**
         * Mirrors protocol's `MAX_CPU_CORES` (`packages/protocol/src/resources.ts`)
         * — the schema's hard ceiling on `cpu` (`z.number().min(0).max(1024)`).
         * A value past this (a clock anomaly, not a real multicore reading)
         * must be CLAMPED, not shipped verbatim: one over-ceiling sample
         * fails schema validation and rejects the whole report,
         * non-retryably.
         */
        const val MAX_CPU_CORES = 1024.0

        /**
         * USER_HZ — the clock-tick rate `/proc/[pid]/stat`'s utime/stime are
         * expressed in. Standard (and, in practice, universal) on Android/
         * Linux; there is no public Android API to read `sysconf(_SC_CLK_TCK)`
         * without NDK, so this is a named constant rather than a runtime
         * query, exactly like the fixed 2s sample interval above.
         */
        internal const val CLOCK_TICKS_PER_SEC = 100L

        /**
         * Locates the LAST `')'` and indexes forward from there. Field 2
         * (`comm`, the process name) is parenthesized and can itself contain
         * spaces and parentheses ("(my app)"), so a naive `split(' ')` from
         * the front picks the wrong fields for everything after it. Returns
         * null on any malformed input rather than throwing — a `/proc` read
         * that succeeds but yields garbage must skip the sample, not crash
         * the sampler.
         */
        fun parseProcSelfStat(line: String): ProcCpuTicks? {
            val closeIdx = line.lastIndexOf(')')
            if (closeIdx < 0 || closeIdx + 1 >= line.length) return null
            val rest = line.substring(closeIdx + 1).trim()
            if (rest.isEmpty()) return null
            val fields = rest.split(Regex("\\s+"))
            // Fields after `)` start at absolute field 3 (state) as index 0;
            // field 14 (utime) is index 11, field 15 (stime) is index 12.
            if (fields.size < 13) return null
            val utime = fields[11].toLongOrNull() ?: return null
            val stime = fields[12].toLongOrNull() ?: return null
            return ProcCpuTicks(utime, stime)
        }

        /**
         * Fraction of ONE core: a delta of one second of CPU time over one
         * second of wall time is 1.0; two cores fully busy is 2.0. Guards
         * against a zero/negative wall delta (clock oddities) by returning 0
         * rather than dividing by zero or reporting a negative fraction.
         *
         * Pure arithmetic — the decision of what to SHIP for a negative
         * ticks delta belongs one layer up, in `tick()`'s caller (see the
         * gap-4 comment there); this stays an honest division, nothing more.
         */
        fun cpuFraction(ticksDelta: Long, wallDeltaSec: Double, clockTicksPerSec: Long): Double {
            if (wallDeltaSec <= 0) return 0.0
            return (ticksDelta.toDouble() / clockTicksPerSec) / wallDeltaSec
        }

        /**
         * Gap class 4 — the production call site's actual seam, split out
         * from [cpuFraction] so it stays a testable pure function (mirrors
         * iOS's `safeFractionSinceBaseline`/`fractionSinceBaseline` split).
         *
         * Linux's `/proc/self/stat` utime/stime are cumulative PER-PROCESS
         * counters and monotonic, so a negative delta should not arise here
         * in practice (unlike iOS's live-threads-only TASK_THREAD_TIMES_INFO
         * aggregate, which the docstring on iOS's equivalent describes as a
         * real, non-theoretical case) — but never rely on that: a negative
         * delta ships `null` rather than a fabricated negative number, and
         * the upper end is independently clamped to [MAX_CPU_CORES]. Either
         * one, shipped verbatim, fails the schema's
         * `cpu: z.number().min(0).max(1024)` and drops the WHOLE report,
         * non-retryably.
         */
        internal fun safeCpuFraction(ticksDelta: Long, wallDeltaSec: Double, clockTicksPerSec: Long): Double? {
            if (ticksDelta < 0) return null
            return min(cpuFraction(ticksDelta, wallDeltaSec, clockTicksPerSec), MAX_CPU_CORES)
        }
    }
}
