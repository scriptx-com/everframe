// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.health

import android.os.Handler
import android.os.Looper
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import dev.everframe.envelope.txGuardVoid
import java.util.concurrent.atomic.AtomicBoolean

/** Main-thread lifecycle events perform memory publication only; the owner schedules IO. */
internal class ReleaseHealthLifecycleObserver(
    private val changed: (Boolean) -> Unit,
    private val owner: () -> LifecycleOwner = { ProcessLifecycleOwner.get() },
) : DefaultLifecycleObserver {
    private val closed = AtomicBoolean(false)
    private var installed = false
    private var foreground: Boolean? = null
    fun install() = post {
        if (!closed.get() && !installed) {
            installed = true
            val lifecycle = owner().lifecycle
            lifecycle.addObserver(this)
            update(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED))
        }
    }
    fun uninstall() {
        closed.set(true) // Fence both queued install and late callbacks immediately.
        post { if (installed) { owner().lifecycle.removeObserver(this); installed = false } }
    }
    override fun onStart(owner: LifecycleOwner) = update(true)
    override fun onStop(owner: LifecycleOwner) = update(false)
    private fun update(value: Boolean) {
        if (closed.get() || foreground == value) return
        foreground = value
        txGuardVoid("releaseHealth.lifecycle") { changed(value) }
    }
    private fun post(block: () -> Unit) { Handler(Looper.getMainLooper()).post { txGuardVoid("releaseHealth.observer", block) } }
}
