// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/** Constant-space process fence. Tokens own counts, never Views or tag registries. */
internal object VideoPrivacyRevocation {
    private class Observer(val callback: (Long) -> Unit, val onSettled: () -> Unit)
    private val observer = java.util.concurrent.atomic.AtomicReference<Observer?>(null)
    /** One recorder-owned slot; replacement cannot be removed by an old subscription. */
    fun subscribe(callback: (Long) -> Unit): AutoCloseable = subscribe(callback, {})
    fun subscribe(callback: (Long) -> Unit, onSettled: () -> Unit): AutoCloseable {
        val owner = Observer(callback, onSettled)
        observer.set(owner)
        return AutoCloseable { observer.compareAndSet(owner, null) }
    }
    private val generation = AtomicLong()
    private val pending = AtomicLong()
    val current: Long get() = generation.get()
    val blocked: Boolean get() = pending.get() != 0L

    fun begin(): AutoCloseable {
        pending.incrementAndGet()
        revoke()
        val closed = AtomicBoolean()
        return AutoCloseable {
            if (closed.compareAndSet(false, true) && pending.decrementAndGet() == 0L) {
                // A hint only: another begin may already have advanced the fence again.
                // No privacy lock is held while the owner reconciles live permission.
                try { observer.get()?.onSettled?.invoke() } catch (_: Throwable) { /* fence remains authoritative */ }
            }
        }
    }
    fun revoke() {
        val next = generation.incrementAndGet()
        try { observer.get()?.callback?.invoke(next) } catch (_: Throwable) { /* generation still revokes */ }
    }
    fun permits(snapshot: Long): Boolean = !blocked && current == snapshot
}
