// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Lock-protected FIFO ring buffer for captured network metadata. Capacity 250
// (mirrors iOS NetworkRingBuffer.swift). Shared SDK-wide via
// `sharedNetworkBuffer`.
//
// PRIV-03R (revised) hard invariant — this metadata Entry intentionally
// carries NO payload field, and never will. The interceptor
// (TraceItXInterceptor) records only:
//   • method, URL (post-redaction), status code, duration in milliseconds,
//   • request + response headers — already filtered through
//     RedactionEngine.filterHeaders (default-deny allowlist).
//
// Body bytes are captured ONLY in the designated body-capture unit (the body
// path of `TXNetworkCaptureProtocol` on iOS; `capture/NetworkBodyTee.kt` on
// Android), ONLY behind the server-authoritative fail-closed gate, ALWAYS
// redacted before entering the body buffer. The metadata `Entry` structurally
// carries no body field.
//
// Threat-model T-05-04-I mitigation: the absence of any payload-bearing
// field here is the structural enforcement; the source-grep gate in
// TraceItXInterceptor.kt's sibling directory is the second belt.
package com.traceitx.capture

import androidx.annotation.VisibleForTesting
import com.traceitx.TraceItX
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

// Plan 05-06 cross-module read — :reporter-ui's DetailsDisclosure renders the
// last 10 entries in the reporter "What's included" panel.
class NetworkRingBuffer internal constructor(
    private val capacity: Int,
    internal val honorsKillGate: Boolean,
) {
    /** Public production constructor — always honors the kill gate. */
    constructor(capacity: Int = 100) : this(capacity, honorsKillGate = true)

    /**
     * One captured network exchange's metadata. `status` is null when the
     * underlying call threw before a response was produced (IOException,
     * cancellation); `errorMessage` carries the throwable's message in that
     * case. Both fields are null when the call succeeded normally.
     */
    data class Entry(
        val timestamp: Long,
        val method: String,
        val url: String,
        val status: Int?,
        val durationMs: Long,
        val requestHeaders: Map<String, String>,
        val responseHeaders: Map<String, String>,
        val errorMessage: String?,
    )

    private val lock = ReentrantLock()
    private val buffer = ArrayDeque<Entry>(capacity)
    private var generation = 0
    internal fun rotate(startEpoch: Int) = lock.withLock { generation = startEpoch; buffer.clear() }

    /**
     * Test-only seam (PR review round 4 Finding F15): invoked, when set, at
     * the exact point between the cheap pre-lock gate read in [push] and the
     * lock acquisition — i.e. the window a paused thread could otherwise
     * occupy while `kill()` flips [TraceItX.captureGate] and `clear()`
     * zeroizes the buffer out from under it. Always null in production.
     */
    @VisibleForTesting
    internal var preLockHook: (() -> Unit)? = null

    /**
     * Round-2 review Finding F11 — a still-in-flight request's
     * `TraceItXInterceptor.intercept` can resume from `chain.proceed()` after
     * `kill()` has already flipped `TraceItX.captureGate` and zeroized this
     * buffer; without a gate check HERE, that resumed call would silently
     * repopulate a buffer the kill switch just emptied. The interceptor
     * itself now also re-checks the gate post-`proceed()` (defense in
     * depth) — this is the authoritative backstop, mirroring iOS
     * `NetworkRingBuffer.honorsKillGate`.
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
     */
    fun push(entry: Entry) = pushChecked(entry, null)
    internal fun push(entry: Entry, owner: Int) = pushChecked(entry, owner)

    private fun pushChecked(entry: Entry, owner: Int?) {
        if (honorsKillGate && !TraceItX.captureGate) return
        preLockHook?.invoke()
        lock.withLock {
            if (owner != null && owner != generation) return@withLock
            if (honorsKillGate && !TraceItX.captureGate) return@withLock
            if (buffer.size >= capacity) buffer.removeFirst()
            buffer.addLast(entry)
        }
    }

    fun snapshot(): List<Entry> = lock.withLock { buffer.toList() }

    @androidx.annotation.RestrictTo(androidx.annotation.RestrictTo.Scope.LIBRARY_GROUP)
    fun snapshotForSession(startEpoch: Int): List<Entry> = lock.withLock {
        if (generation == startEpoch) buffer.toList() else emptyList()
    }

    fun size(): Int = lock.withLock { buffer.size }

    fun clear() = lock.withLock { buffer.clear() }
}

/**
 * Process-wide network ring buffer. Plan 05-06 will wire EnvelopeBuilder to
 * read `sharedNetworkBuffer.snapshot()` when emitting a report envelope.
 *
 * Capacity 100 — matches iOS `NetworkRingBuffer.shared` (capacity 100). Oldest
 * entries are evicted from memory on overflow so the buffer never accumulates
 * beyond the last 100 exchanges.
 */
val sharedNetworkBuffer = NetworkRingBuffer(capacity = 100)
