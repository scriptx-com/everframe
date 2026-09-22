// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Byte-budgeted ring buffer for captured network request/response bodies
// (spec network-body-capture). Unlike NetworkRingBuffer (count-capped at
// 250/100), this buffer is budgeted by TOTAL UTF-8 byte cost of the stored
// bodies — reqBody + resBody summed across all entries — since bodies can
// vary from empty to hundreds of KB each. Entries are appended in `t`
// order, so eviction is head-first (oldest first), same shape as the
// metadata ring buffers.
//
// Freeze/discardAndResume/takeFrozen/clear lifecycle + ReentrantLock
// discipline mirror BreadcrumbRingBuffer.kt:267-282 exactly. Mirrors
// packages/sdk-ios/Sources/TraceItX/Capture/NetworkBodyRingBuffer.swift.
//
// Producer (spec 2026-08-12-android-network-body-tee-design.md) —
// `capture/NetworkBodyTee.kt`, via `NetworkBodyFinalizer`, is the producer
// that calls [append] in production for the RESPONSE direction. The REQUEST
// direction remains unimplemented (spec §14), so no request-side entry is
// ever appended. [freeze]/[discardAndResume]/[clear] stay wired into the
// real reporter/kill/logout lifecycle in `TraceItX.kt` and
// `CompanionSubmissionComposer.kt`, and [EnvelopeBuilder] emits whatever this
// buffer holds.
package com.traceitx.capture

import androidx.annotation.VisibleForTesting
import com.traceitx.TraceItX
import com.traceitx.protocol.generated.NetworkBody
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

class NetworkBodyRingBuffer internal constructor(
    /**
     * Round-2 review Finding F11 — mirrors [NetworkRingBuffer.honorsKillGate]
     * exactly (same rationale: a still-in-flight request's completion can
     * race `kill()` and try to append after the kill switch has flipped; the
     * buffer itself must refuse, not just the interceptor caller). `true`
     * (default, via the public constructor below) in production; `false`
     * ONLY for unit tests that exercise budget/eviction independently of
     * global kill-switch state.
     */
    internal val honorsKillGate: Boolean,
) {
    /** Public production constructor — always honors the kill gate. */
    constructor() : this(honorsKillGate = true)

    companion object {
        /** Default total byte budget across all buffered reqBody + resBody strings (spec default). */
        const val defaultTotalBudget: Int = 262_144

        /**
         * Final-review Finding 2 (unbounded zero-cost entries): a fixed
         * per-entry overhead so an entry with NO bodies (204s, content-type
         * skips) still costs something and remains subject to eviction —
         * without this, zero-body entries' refs/skip-metadata/header maps
         * could grow the buffer without bound while `totalBytes` never
         * crossed the budget. Mirrors
         * packages/sdk-ios/Sources/TraceItX/Capture/NetworkBodyRingBuffer.swift's
         * `entryOverhead`.
         */
        private const val entryOverhead = 256

        /**
         * Byte cost of a single entry: UTF-8 byte count of `reqBody` +
         * `resBody` (nil bodies cost 0) + UTF-8 byte count of every header
         * key and value in `reqHeaders`/`resHeaders` + a fixed
         * `entryOverhead` so body-less entries are still bounded (Finding 2).
         */
        private fun cost(entry: NetworkBody): Int =
            (entry.reqBody?.toByteArray(Charsets.UTF_8)?.size ?: 0) +
                (entry.resBody?.toByteArray(Charsets.UTF_8)?.size ?: 0) +
                headerBytes(entry.reqHeaders) + headerBytes(entry.resHeaders) +
                entryOverhead

        private fun headerBytes(headers: Map<String, String>?): Int {
            if (headers == null) return 0
            var total = 0
            for ((k, v) in headers) {
                total += k.toByteArray(Charsets.UTF_8).size + v.toByteArray(Charsets.UTF_8).size
            }
            return total
        }
    }

    private val lock = ReentrantLock()
    private val entries = ArrayDeque<NetworkBody>()
    private var frozen: List<NetworkBody>? = null
    private var totalBytes: Int = 0
    private var budget: Int = defaultTotalBudget

    /**
     * Test-only seam (PR review round 4 Finding F15): invoked, when set, at
     * the exact point between the cheap pre-lock gate read in [append] and
     * the lock acquisition — i.e. the window a paused thread could otherwise
     * occupy while `kill()` flips [TraceItX.captureGate] and `clear()`
     * zeroizes the buffer out from under it. Always null in production.
     */
    @VisibleForTesting
    internal var preLockHook: (() -> Unit)? = null

    /**
     * Re-budget the buffer. Non-positive values are ignored (config/host
     * input — never let a bad value zeroize the chain). Shrinking evicts
     * oldest entries immediately to bring `totalBytes` back under budget.
     *
     * Round-6 review Finding F26: [guard], when non-null, is evaluated
     * INSIDE [lock] — atomically with the mutation — for the same reason
     * documented on [NetworkBodyCaptureState.applyConfig]'s `guard`
     * parameter: a caller that checks generation validity BEFORE calling
     * this function leaves a window, while this call is blocked acquiring
     * [lock], in which a concurrent teardown can invalidate that generation
     * without this call ever seeing it. `null` (the default) skips the
     * check, so existing callers are unaffected.
     */
    fun setTotalBudget(bytes: Int, guard: (() -> Boolean)? = null) = lock.withLock {
        if (guard != null && !guard()) return@withLock
        if (bytes < 1) return@withLock
        budget = bytes
        evictToFitLocked()
    }

    /**
     * Add an entry, then evict oldest (by append order / `t`) while the
     * running total exceeds the budget. Round-2 review Finding F11: honors
     * the kill switch by default (see [honorsKillGate]'s doc comment) — a
     * kill()-then-resumed request must not repopulate this buffer.
     *
     * PR review round 4 Finding F15: the check above is only a cheap fast
     * path — it runs BEFORE the lock is acquired, so a thread that reads
     * `captureGate == true` here can still be preempted before entering
     * `lock.withLock`, let `kill()` run to completion on another thread
     * (which flips `captureGate` false and THEN calls `clear()` — see
     * `TraceItX.kill()`), and only then resume and insert into a buffer
     * `clear()` just zeroized. The re-check below, taken while HOLDING the
     * lock immediately before the insert, is the authoritative one and is
     * what makes this race-free: because `kill()` flips the gate strictly
     * before calling `clear()`, observing the gate still open here means
     * `clear()` hasn't run yet and will subsequently take this same lock and
     * wipe the entry we're about to add; observing it closed means we simply
     * never insert. Either way the post-kill buffer ends up empty.
     *
     * Round-7 review Finding F34: [guard], when non-null, is evaluated
     * INSIDE [lock] — the very last thing checked before the insert —
     * exactly like the kill-gate re-check above, and for the same reason.
     * The production call site ([com.traceitx.okhttp.TraceItXInterceptor])
     * passes a closure capturing the [NetworkBodyCaptureState] generation
     * observed at DECISION time (before the possibly-slow
     * [com.traceitx.okhttp.NetworkBodyCapture.makeEntry] work), so a remote
     * `captureBodies: false` config refresh that lands between that decision
     * and this append — bumping the state's generation — is caught here
     * even though nothing upstream of `append` re-checks the gate. `null`
     * (the default) skips the check entirely, so every existing call site
     * that doesn't care about gate-generation validity (budget/eviction/
     * freeze/kill-gate unit tests) is unaffected.
     */
    fun append(entry: NetworkBody, guard: (() -> Boolean)? = null) {
        if (honorsKillGate && !TraceItX.captureGate) return
        preLockHook?.invoke()
        lock.withLock {
            if (honorsKillGate && !TraceItX.captureGate) return@withLock
            if (guard != null && !guard()) return@withLock
            entries.addLast(entry)
            totalBytes += cost(entry)
            evictToFitLocked()
        }
    }

    private fun evictToFitLocked() {
        while (totalBytes > budget && entries.isNotEmpty()) {
            val removed = entries.removeFirst()
            totalBytes -= cost(removed)
        }
    }

    /** Owner-bound immutable selection; source epoch is checked inside the ring lock. */
    fun snapshotForReport(): List<NetworkBody> = lock.withLock { entries.toList() }
    internal fun snapshotForReport(guard: () -> Boolean): List<NetworkBody>? = lock.withLock {
        if (guard()) entries.toList() else null
    }

    /** Snapshot the chain at reporter-open. Idempotent — never a second snapshot while one is already held. */
    fun freeze() = lock.withLock {
        if (frozen == null) frozen = entries.toList()
    }

    /** Drop the frozen snapshot (reporter cancelled). Live capture continues. */
    fun discardAndResume() = lock.withLock { frozen = null }

    /** Return + clear the frozen snapshot, or null if freeze() was never called. */
    fun takeFrozen(): List<NetworkBody>? = lock.withLock {
        val out = frozen
        frozen = null
        out
    }

    /** Non-destructive copy of the LIVE chain. Independent of the freeze lifecycle. */
    fun snapshot(): List<NetworkBody> = lock.withLock { entries.toList() }

    /** Zeroize everything (logout / identity change / kill switch). */
    fun clear() = lock.withLock {
        entries.clear()
        totalBytes = 0
        frozen = null
    }
}

/**
 * Process-wide network body ring buffer. Budgeted at 262144 bytes total
 * (spec default) — matches iOS `NetworkBodyRingBuffer.shared`.
 */
val sharedNetworkBodyBuffer = NetworkBodyRingBuffer()
