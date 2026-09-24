// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import java.lang.ref.WeakReference

/**
 * Bounded identity admission for one SDK start. Reserve before invoking host getters;
 * settle in finally with true only after durable acceptance. A refusal releases the
 * reservation without spending allowance or retaining the Throwable.
 *
 * The monitor protects only these small lists/fields, never host code or storage.
 * [currentEpoch] must be a lock-free SDK epoch read. An obsolete caller cannot reset
 * a newer epoch's allowance, and an obsolete settlement cannot clear its reservation.
 * Accepted identities are weak: reporting never pins host exception/cause/custom-field
 * graphs after settlement. The separate accepted count is never refunded by GC.
 * At most ten weak identity slots and one strong in-progress reference are retained.
 */
internal class HandledThrowableAdmission(private val currentEpoch: () -> Int) {
    internal class Reservation internal constructor(val epoch: Int, val throwable: Throwable)

    private var epoch: Int? = null
    private val accepted = ArrayList<WeakReference<Throwable>>(10)
    private var acceptedCount = 0
    private var pending: Reservation? = null

    @Synchronized
    fun reserve(throwable: Throwable, capturedEpoch: Int): Reservation? {
        if (capturedEpoch != currentEpoch()) return null
        if (epoch != capturedEpoch) {
            epoch = capturedEpoch
            accepted.clear()
            acceptedCount = 0
            pending = null
        }
        accepted.removeAll { it.get() == null }
        if (pending != null || acceptedCount == 10 || accepted.any { it.get() === throwable }) return null
        return Reservation(capturedEpoch, throwable).also { pending = it }
    }

    @Synchronized
    fun settle(reservation: Reservation, durablyAccepted: Boolean) {
        if (pending !== reservation) return
        pending = null
        if (durablyAccepted && epoch == reservation.epoch && currentEpoch() == reservation.epoch) {
            accepted.add(WeakReference(reservation.throwable))
            acceptedCount += 1
        }
    }
}
