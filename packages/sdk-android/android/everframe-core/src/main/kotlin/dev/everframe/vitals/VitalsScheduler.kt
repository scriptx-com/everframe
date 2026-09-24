// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.vitals

import android.os.Handler
import java.util.concurrent.atomic.AtomicBoolean

/** Repeating-timer seam so the collector engine stays Android-free and testable. */
fun interface VitalsScheduler {
    fun repeat(intervalMs: Long, tick: () -> Unit): AutoCloseable
}

internal class HandlerVitalsScheduler(private val handler: Handler) : VitalsScheduler {
    override fun repeat(intervalMs: Long, tick: () -> Unit): AutoCloseable {
        // AutoCloseable.close() can be called from a thread other than the
        // Handler's own looper thread, so this flag is read cross-thread —
        // AtomicBoolean instead of a plain var for a visible, safe read/write.
        val cancelled = AtomicBoolean(false)
        lateinit var r: Runnable
        r = Runnable {
            if (cancelled.get()) return@Runnable
            tick()
            if (!cancelled.get()) handler.postDelayed(r, intervalMs)
        }
        handler.postDelayed(r, intervalMs)
        return AutoCloseable {
            cancelled.set(true)
            handler.removeCallbacks(r)
        }
    }
}
