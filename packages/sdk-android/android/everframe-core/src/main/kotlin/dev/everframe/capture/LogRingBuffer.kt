// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Lock-protected FIFO ring buffer for captured log lines. Capacity 100 (memory-
// bounded to the last 100; mirrors iOS LogRingBuffer.swift + web). The buffer is
// shared SDK-wide via `sharedLogBuffer`.
//
// Pattern carry-forward (PATTERNS lines 39-40):
//   • Producer side: Timber Tree + System.out/System.err PrintStream wrap
//     (LogCapture). Both push entries through the same lock.
//   • Consumer side: snapshot() — invoked from EnvelopeBuilder when a report is
//     emitted (Plan 05-06).
//
// Concurrency contract:
//   • All mutating ops are guarded by ReentrantLock — no torn writes under
//     concurrent producers (LogCaptureTest exercises 8 threads × 1000 ops).
//   • snapshot() returns a defensive copy; the caller may iterate without
//     holding any lock.
//
// PRIV-03 invariant: this buffer stores only log MESSAGES already shaped by the
// producer. Body bytes from network responses NEVER reach this buffer (they go
// through NetworkRingBuffer instead, and even there only metadata is recorded).
package dev.everframe.capture

import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

// Plan 05-06 cross-module read — :reporter-ui's DetailsDisclosure renders the
// last 20 entries in the reporter "What's included" panel.
class LogRingBuffer(private val capacity: Int = 100) {

    /**
     * One captured log line. `tag` is null for System.out/System.err lines (the
     * PrintStream tap has no tag affordance); Timber-sourced entries carry the
     * Timber tag verbatim.
     */
    data class Entry(
        val timestamp: Long,
        val level: String,
        val tag: String?,
        val message: String,
    )

    private val lock = ReentrantLock()
    private val buffer = ArrayDeque<Entry>(capacity)

    private var generation = 0L
    internal fun generation(): Long = lock.withLock { generation }
    internal fun rotate(owner: Long) = lock.withLock { generation = owner; buffer.clear() }
    internal fun push(entry: Entry, owner: Long) = lock.withLock {
        if (owner == generation) push(entry)
    }

    fun push(entry: Entry) = lock.withLock {
        if (buffer.size >= capacity) buffer.removeFirst()
        buffer.addLast(entry)
    }

    fun snapshot(): List<Entry> = lock.withLock { buffer.toList() }

    /** Report selection is atomic with generation rotation; never acquire the facade lock from here. */
    @androidx.annotation.RestrictTo(androidx.annotation.RestrictTo.Scope.LIBRARY_GROUP)
    fun snapshotForSession(startEpoch: Int): List<Entry> = lock.withLock {
        if (generation == startEpoch.toLong()) buffer.toList() else emptyList()
    }

    fun size(): Int = lock.withLock { buffer.size }

    fun clear() = lock.withLock { buffer.clear() }
}

/**
 * Process-wide log ring buffer. Plan 05-06 will wire EnvelopeBuilder to read
 * `sharedLogBuffer.snapshot()` when emitting a report envelope.
 *
 * Capacity 100 — matches iOS `LogRingBuffer.shared` + web; oldest evicted on
 * overflow so it never accumulates beyond the last 100 lines.
 */
val sharedLogBuffer = LogRingBuffer(capacity = 100)
