// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import android.content.Context
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleInitializer
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.startup.Initializer

/** No capture/config/SDK initialization: only distinguish early install from late background install. */
internal class InteractionProcessHistory : DefaultLifecycleObserver {
    companion object { val shared = InteractionProcessHistory() }
    private var installed = false
    private var seenForeground = false
    fun install(lifecycle: Lifecycle) {
        if (installed) return
        installed = true
        seenForeground = lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
        lifecycle.addObserver(this)
    }
    fun beforeFirstForeground(): Boolean = installed && !seenForeground
    override fun onStart(owner: LifecycleOwner) { seenForeground = true }
}

/** AndroidX Startup invokes this in the default app process, before any Activity starts. */
class InteractionProcessInitializer : Initializer<Unit> {
    override fun create(context: Context) { InteractionProcessHistory.shared.install(ProcessLifecycleOwner.get().lifecycle) }
    override fun dependencies(): List<Class<out Initializer<*>>> = listOf(ProcessLifecycleInitializer::class.java)
}
