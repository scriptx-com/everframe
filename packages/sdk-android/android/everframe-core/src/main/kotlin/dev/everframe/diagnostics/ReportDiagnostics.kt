// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.diagnostics

import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** Leaf lock: no external work, storage/lifecycle lock, provider or callback is invoked here. */
internal class ReportDiagnostics(private val lock: ReentrantLock = ReentrantLock()) {
    private var state = ReportDeliveryStatus()
    private var current: Handle? = null

    fun beginGeneration(epoch: Int, enabled: Boolean): Handle = lock.withLock {
        val handle = Handle(this, epoch)
        current = handle
        state = ReportDeliveryStatus(status = "active", reason = "none", capture = CaptureStatus(enabled = enabled))
        handle
    }

    fun retireGeneration(epoch: Int) = lock.withLock {
        if (current != null && current!!.epoch > epoch) return@withLock
        current = null
        state = ReportDeliveryStatus(status = "disabled", reason = "capture-disabled")
    }

    fun handle(epoch: Int): Handle? {
        if (!lock.tryLock()) return null
        return try { current?.takeIf { it.epoch == epoch } } finally { lock.unlock() }
    }

    fun snapshot(): ReportDeliveryStatus {
        if (!lock.tryLock()) return ReportDeliveryStatus(status = "unavailable", reason = "snapshot-busy")
        return try {
            state.copy(
                capture = state.capture.copy(paths = state.capture.paths.mapValues { (_, v) -> v.copy(outcomes = v.outcomes.toMap()) }),
                queue = state.queue.copy(operations = state.queue.operations.toMap()),
                transport = state.transport.mapValues { (_, v) -> v.copy(outcomes = v.outcomes.toMap()) },
            )
        } finally { lock.unlock() }
    }

    private inline fun observe(owner: Handle, update: (ReportDeliveryStatus) -> ReportDeliveryStatus) {
        if (!lock.tryLock()) return
        try { if (current === owner) state = update(state).copy(revision = add(state.revision, 1)) }
        finally { lock.unlock() }
    }

    internal class Handle internal constructor(private val ledger: ReportDiagnostics, internal val epoch: Int) {
        fun capture(path: CapturePath, outcome: CaptureOutcome) = ledger.observe(this) { state ->
            val before = state.capture.paths.getValue(path.code)
            val next = before.copy(settledAttempts = add(before.settledAttempts, 1),
                outcomes = increment(before.outcomes, outcome.code, 1), lastOutcome = outcome.code)
            state.copy(capture = state.capture.copy(paths = state.capture.paths + (path.code to next)))
        }

        fun queueObserved(count: Int?, quality: QueueQuality, migration: String? = null) = ledger.observe(this) { state ->
            state.copy(queue = state.queue.copy(observation = "observed", quality = quality.code,
                pendingCount = count?.takeIf { it >= 0 }, lastFailure = null,
                migration = when (migration) { "not-observed", "clear", "blocked", "unknown" -> migration; else -> state.queue.migration }))
        }

        fun queueOperation(operation: QueueOperation, amount: Int = 1, failure: StorageFailure? = null) {
            if (amount <= 0) return
            ledger.observe(this) { state ->
                val failed = operation == QueueOperation.ENQUEUE_FAILED || operation == QueueOperation.REMOVAL_FAILED || operation == QueueOperation.READ_FAILED
                state.copy(queue = state.queue.copy(
                    operations = increment(state.queue.operations, operation.code, amount),
                    observation = if (failed) "failed" else state.queue.observation,
                    quality = if (failed) "unknown" else state.queue.quality,
                    pendingCount = if (failed) null else state.queue.pendingCount,
                    lastFailure = if (failed) (failure ?: StorageFailure.UNKNOWN).code else state.queue.lastFailure,
                ))
            }
        }

        fun transport(origin: TransportOrigin, outcome: TransportOutcome, httpStatus: Int? = null) = ledger.observe(this) { state ->
            val before = state.transport.getValue(origin.code)
            val next = before.copy(settledAttempts = add(before.settledAttempts, 1),
                outcomes = increment(before.outcomes, outcome.code, 1), lastOutcome = outcome.code,
                lastHttpStatus = httpStatus?.takeIf { it in 100..599 })
            state.copy(transport = state.transport + (origin.code to next))
        }
    }

    companion object {
        val shared = ReportDiagnostics()
        private fun add(value: Int, amount: Int): Int = (value.toLong() + amount).coerceIn(0, Int.MAX_VALUE.toLong()).toInt()
        private fun increment(values: Map<String, Int>, key: String, amount: Int) = values + (key to add(values.getValue(key), amount))
    }
}
