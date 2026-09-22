// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Report Resource Window (spec 2026-09-05) — lock-protected FIFO ring buffer
// for CPU/memory samples. Attached to report and crash envelopes as
// `payload.resources`. Mirrors packages/protocol/src/resources.ts's
// `ResourceSample` shape (t/cpu/mem) and `MAX_RESOURCE_SAMPLES` cap, and
// iOS's ResourceRingBuffer.swift.
//
// Template: LogRingBuffer.kt — `ReentrantLock` + `withLock`, `ArrayDeque`,
// `snapshot()` returning a defensive copy, plus a top-level
// `sharedResourceBuffer` mirroring `sharedLogBuffer` — cloned exactly.
// Deliberately NOT lock-free/atomic: Android crash capture runs on an
// ordinary JVM thread (Thread.setDefaultUncaughtExceptionHandler), not an
// async-signal context, so this buffer follows the same discipline as its
// siblings rather than a lock-free design.
//
// `windowSec` is a mutable, lock-guarded property (not captured once at
// construction) so a live `/api/config` refresh can widen or narrow the
// eviction horizon without an SDK restart — see ReplayConfigProvider.kt's
// `ResourcesConfigWire` and ReplaySession.kt's `refreshConfigNow`, which
// writes `sharedResourceBuffer.windowSec` on every resolved config, the same
// way it reads other live-reapplied blocks.
package com.traceitx.capture

import com.traceitx.TraceItX
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

// Round-review Finding 3 (2026-09-05 whole-branch review) — `honorsKillGate`
// mirrors NetworkRingBuffer.kt's identical field/gate exactly (itself Round-2
// review Finding F11 + PR round 4 Finding F15), NOT iOS's simpler
// `ResourceRingBuffer.append` (which only checks the gate once, before taking
// the lock). Without this, `TraceItX.kill()` calling
// `clearCapturedEvidenceBuffers()` (which clears this ring) BEFORE
// `_replaySession?.teardown()` (which stops the sampler that feeds it) left a
// window where a tick already queued on the main looper could fire between
// the clear and the teardown and push one post-kill sample into the ring —
// see `push`'s doc comment for the two-phase check that closes it
// structurally, independent of that ordering.
class ResourceRingBuffer internal constructor(
    windowSec: Int,
    internal val honorsKillGate: Boolean,
) {
    /** Public production constructor — always honors the kill gate. */
    constructor(windowSec: Int = defaultWindowSec) : this(windowSec, honorsKillGate = true)

    /**
     * One captured resource sample.
     *
     * `cpu` is null when a `/proc/self/stat` read failed, was malformed, or
     * produced a negative delta for this tick (ResourceSampler ships `null`
     * rather than a fabricated value in every such case) — this is a
     * RING-LEVEL concern only insofar as the buffer must never coerce a null
     * `cpu` into anything else. The OMIT-not-null wire behavior is enforced
     * by EnvelopeBuilder at serialization time, not here.
     */
    data class Entry(val t: Long, val cpu: Double?, val mem: Long)

    private val lock = ReentrantLock()
    private val entries = ArrayDeque<Entry>()

    private var _windowSec: Int = windowSec

    /**
     * Read/write live — a config refresh applies to every subsequent
     * push/snapshot with no SDK restart (see ReplaySession.refreshConfigNow).
     */
    var windowSec: Int
        get() = lock.withLock { _windowSec }
        set(value) = lock.withLock { _windowSec = value }

    /**
     * The real, testable seam — entries are stamped in epoch ms (t=0..70_000
     * in tests), so a bare real-clock read would evict everything and every
     * eviction assertion would be vacuous. Production call sites use the
     * `push(entry)` convenience below.
     *
     * Round-review Finding 3 (2026-09-05) — gated on [TraceItX.captureGate],
     * exactly like `NetworkRingBuffer.push`: a cheap pre-lock check (the fast
     * path — avoids taking the lock at all while the gate is closed) AND an
     * authoritative re-check taken WHILE HOLDING the lock, immediately before
     * the insert. The re-check is what makes this race-free against
     * `TraceItX.kill()`, which flips `captureGate` false strictly before
     * calling `clearCapturedEvidenceBuffers()` (which clears this ring): a
     * `ResourceSampler.tick()` already past the pre-lock check when `kill()`
     * runs can still only observe the gate open here if `clear()` hasn't
     * taken the lock yet either — and it will, right after, wiping whatever
     * this call is about to add. Observing the gate closed here means this
     * call simply never inserts. Either way the post-kill ring ends up
     * empty, independent of whether `kill()` happens to clear this buffer
     * before or after tearing down the sampler that feeds it.
     */
    fun push(entry: Entry, now: Long) {
        if (honorsKillGate && !TraceItX.captureGate) return
        lock.withLock {
            if (honorsKillGate && !TraceItX.captureGate) return@withLock
            entries.addLast(entry)
            evictLocked(now)
        }
    }

    /** Convenience defaulting `now` to the current epoch ms — the real
     *  production call site (the sampler's periodic tick). */
    fun push(entry: Entry) = push(entry, now = System.currentTimeMillis())

    /** The real, testable seam — see `push`'s doc comment; the same
     *  rationale applies here. */
    fun snapshot(now: Long): List<Entry> = lock.withLock {
        evictLocked(now)
        entries.toList()
    }

    /** Convenience defaulting `now` to the current epoch ms — the real
     *  production call site (report/crash envelope stamping). */
    fun snapshot(): List<Entry> = snapshot(now = System.currentTimeMillis())

    fun clear() = lock.withLock { entries.clear() }

    /**
     * Evict by age FIRST (against the live `_windowSec`, read fresh on every
     * call — never cached), THEN apply the hard cap, keeping the newest
     * entries. Must be called with `lock` already held.
     */
    private fun evictLocked(now: Long) {
        val windowMs = _windowSec.toLong() * 1000
        val cutoff = now - windowMs
        while (entries.isNotEmpty() && entries.first().t < cutoff) entries.removeFirst()
        while (entries.size > MAX_SAMPLES) entries.removeFirst()
    }

    companion object {
        /**
         * Mirrors protocol's `MAX_RESOURCE_SAMPLES` — a stamp exceeding this
         * makes the server reject the WHOLE report (400, non-retryable), not
         * merely drop the resources block.
         */
        const val MAX_SAMPLES = 256

        /** Mirrors protocol's `DEFAULT_RESOURCE_WINDOW_SEC`. */
        const val defaultWindowSec = 60
    }
}

/**
 * Process-wide resource ring buffer, mirroring `sharedLogBuffer`. Fed by
 * `ResourceSampler`'s periodic tick; consumed by EnvelopeBuilder's report and
 * crash build sites via `snapshot()`.
 */
val sharedResourceBuffer = ResourceRingBuffer()
