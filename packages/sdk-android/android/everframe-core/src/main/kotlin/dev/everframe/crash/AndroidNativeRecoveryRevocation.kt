// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import java.util.concurrent.atomic.AtomicLong

/** Monotonic erasure intent survives a disable/kill tail displaced by a newer command.
 * invalidate is atomic-only and safe under SDK stateLock; finish does durable work outside it.
 */
internal class AndroidNativeRecoveryRevocation {
    private val requested = AtomicLong()
    private var completed = 0L
    fun invalidate() { requested.incrementAndGet() }
    @Synchronized fun finish(erase: () -> Boolean): Boolean {
        while (completed != requested.get()) {
            val generation = requested.get()
            if (!erase()) return false
            completed = generation
        }
        return true
    }
}
