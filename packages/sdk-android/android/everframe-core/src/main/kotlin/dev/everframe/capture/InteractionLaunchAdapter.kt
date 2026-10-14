// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import android.os.Handler
import android.os.Looper
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import kotlinx.serialization.json.*

/** ProcessLifecycleOwner coalesces Activities and configuration changes before these callbacks. */
internal class InteractionLaunchAdapter(private val recorder: InteractionEventRecorder) : DefaultLifecycleObserver {
    companion object { val shared by lazy { InteractionLaunchAdapter(sharedInteractionRecorder) } }
    private var seeded = false
    private var seenForeground = false
    private var foreground = false
    private var installed = false
    private var observedLaunch = false
    fun install() {
        val action = {
            if (!installed) {
                installed = true
                val lifecycle = ProcessLifecycleOwner.get().lifecycle
                seed(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED))
                if (InteractionProcessHistory.shared.beforeFirstForeground()) launched()
                lifecycle.addObserver(this)
            }
        }
        if (Looper.myLooper() == Looper.getMainLooper()) action() else Handler(Looper.getMainLooper()).post { action() }
    }
    fun seed(alreadyForeground: Boolean) {
        if (seeded) return
        seeded = true; foreground = alreadyForeground; seenForeground = alreadyForeground
    }
    fun launched() { observedLaunch = true }
    fun foreground() {
        if (foreground) return
        foreground = true
        val start = if (observedLaunch && !seenForeground) "cold" else "warm"
        seenForeground = true
        val owner = recorder.owner() ?: return
        recorder.observe(InteractionObservation(owner, nativeInteractionEvent("launch", JsonObject(mapOf("start" to JsonPrimitive(start)))), deferLaunch = true))
    }
    fun background() { recorder.finishLaunch(); foreground = false }
    override fun onStart(owner: LifecycleOwner) { foreground() }
    override fun onStop(owner: LifecycleOwner) { background() }
}
