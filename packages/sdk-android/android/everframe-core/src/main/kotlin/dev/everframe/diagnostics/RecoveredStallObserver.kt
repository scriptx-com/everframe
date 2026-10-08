// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.diagnostics

import kotlin.math.abs

internal data class StallClockSample(val uptimeMs: Long, val elapsedMs: Long, val wallMs: Long)
internal data class RecoveredStallObservation(val queuedAtMs: Long, val recoveredAtMs: Long, val probeDelayMs: Long)

/** One process budget, shared across replacement controllers and opt-in epochs. */
internal class RecoveredStallBudget {
    private var admitted = 0
    private var lastRecovery: Long? = null
    private var admitting = false
    @Synchronized fun canObserve(now: Long): Boolean = !admitting && admitted < 4 &&
        (lastRecovery?.let { now - it >= 60_000 } ?: true)

    fun admit(now: Long, action: () -> Boolean): Boolean {
        synchronized(this) {
            if (!canObserve(now)) return false
            admitting = true
        }
        var accepted = false
        try { accepted = action(); return accepted }
        finally { synchronized(this) {
            if (accepted) { admitted++; lastRecovery = now }
            admitting = false
        } }
    }
}

/**
 * Measures a probe's queue latency, never an OS ANR or fatal outcome. Acknowledgement
 * only records clocks; the worker's next eligible tick performs any admission work.
 */
internal class RecoveredStallObserver(
    private val budget: RecoveredStallBudget,
    private val postProbe: (Long) -> Boolean,
    private val removeProbe: (Long) -> Unit,
    private val onRecovered: (RecoveredStallObservation) -> Boolean,
) {
    private data class Pending(val id: Long, val queued: StallClockSample, var ack: StallClockSample? = null)
    private val lock = Any()
    private var nextId = 0L
    private var generation = 0L
    private var pending: Pending? = null
    private var lastTick: StallClockSample? = null

    fun acknowledge(probeId: Long, sample: StallClockSample) = synchronized(lock) {
        pending?.takeIf { it.id == probeId && it.ack == null }?.ack = sample
    }

    fun invalidate() {
        val old = synchronized(lock) {
            generation++
            pending?.id.also { pending = null; lastTick = null }
        }
        if (old != null) removeProbe(old)
    }

    fun tick(sample: StallClockSample, eligible: Boolean) {
        var remove: Long? = null
        var post: Long? = null
        var recovered: RecoveredStallObservation? = null
        var recoveryUptime = 0L
        var recoveryGeneration = 0L
        synchronized(lock) {
            val previousTick = lastTick
            lastTick = sample
            val current = pending
            val late = previousTick != null &&
                (sample.uptimeMs - previousTick.uptimeMs > 2500 || !consistent(previousTick, sample))
            if (!eligible || (current != null && late)) {
                remove = current?.id; pending = null
                return@synchronized
            }
            if (current != null) {
                val ack = current.ack
                if (ack == null) {
                    if (!consistent(current.queued, sample) || sample.uptimeMs - current.queued.uptimeMs > 60_000) {
                        remove = current.id; pending = null
                    }
                    return@synchronized
                }
                remove = current.id; pending = null
                val delay = ack.uptimeMs - current.queued.uptimeMs
                if (consistent(current.queued, ack) && previousTick != null &&
                    ack.uptimeMs - previousTick.uptimeMs in 0..2500 &&
                    sample.uptimeMs >= ack.uptimeMs && delay in 5000..60_000) {
                    recovered = RecoveredStallObservation(current.queued.wallMs, ack.wallMs, delay)
                    recoveryUptime = ack.uptimeMs; recoveryGeneration = generation
                    return@synchronized
                }
            }
            if (budget.canObserve(sample.uptimeMs)) {
                val id = ++nextId
                pending = Pending(id, sample); post = id
            }
        }
        remove?.let(removeProbe)
        post?.let { id ->
            val posted = try { postProbe(id) } catch (_: Exception) { false }
            val keep = synchronized(lock) {
                if (!posted && pending?.id == id) pending = null
                posted && pending?.id == id
            }
            // Invalidation may race the external Handler.post call itself.
            if (!keep) removeProbe(id)
        }
        recovered?.let { observation ->
            budget.admit(recoveryUptime) {
                if (synchronized(lock) { generation != recoveryGeneration }) false
                else try { onRecovered(observation) } catch (_: Exception) { false }
            }
        }
    }

    private fun consistent(from: StallClockSample, to: StallClockSample): Boolean {
        val uptime = to.uptimeMs - from.uptimeMs
        return uptime >= 0 && abs((to.elapsedMs - from.elapsedMs) - uptime) <= 1000 &&
            abs((to.wallMs - from.wallMs) - uptime) <= 1000
    }
}
