// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.health

import android.os.Handler
import android.os.Looper
import android.util.Log
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
            // App Startup attaches ProcessLifecycleOwner eagerly, in the default process only; it
            // refuses lazy initialization. An unattached owner never starts: say so once per start.
            if (lifecycle.currentState == Lifecycle.State.INITIALIZED) Log.w("Everframe",
                "Release health not ready: $LIFECYCLE_UNAVAILABLE. Keep androidx.lifecycle.ProcessLifecycleInitializer " +
                    "in androidx.startup.InitializationProvider and start release health in the default process.")
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

    companion object {
        /** Documented not-ready reason, logged as an `Everframe` warning. */
        const val LIFECYCLE_UNAVAILABLE = "process-lifecycle-unavailable"
    }
}
