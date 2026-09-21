// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Process-wide ring buffer for txGuard{} failures. EnvelopeBuilder drains this
// into `captureControl.degradedReason` so the receiver knows the SDK degraded
// and can flag the report.
//
// Mirrors `packages/sdk-ios/Sources/TraceItX/Envelope/InternalLogger.swift`.
//
// Note: We use `android.util.Log` instead of Timber to avoid forcing Timber
// onto :traceitx-core's classpath (Timber is reflection-detected for log capture
// in Plan 05-04, NOT a hard dependency).
package com.traceitx.envelope

import java.time.Instant
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

@PublishedApi
internal object InternalLogger {
    private val lock = ReentrantLock()
    private val failures = ArrayDeque<Failure>()
    private const val MAX_BUFFERED = 50

    internal data class Failure(
        val label: String,
        val message: String,
        val at: Instant,
    )

    @PublishedApi
    internal fun recordSafeWrapFailure(label: String, error: Throwable) {
        lock.withLock {
            val entry = Failure(label, error.toString(), Instant.now())
            failures.addLast(entry)
            while (failures.size > MAX_BUFFERED) {
                failures.removeFirst()
            }
        }
        // Best-effort warn line; android.util.Log throws on JVM unit tests if not stubbed,
        // so route through System.err which Robolectric/JVM both tolerate.
        try {
            android.util.Log.w("TraceItX/safeWrap", "label=$label", error)
        } catch (_: Throwable) {
            System.err.println("TraceItX/safeWrap label=$label error=$error")
        }
    }

    /**
     * Drained by EnvelopeBuilder into `captureControl.degradedReason`. Buffer is
     * cleared after drain so each report only carries new failures.
     */
    fun drainFailures(): List<Failure> = lock.withLock {
        val out = failures.toList()
        failures.clear()
        out
    }
}
