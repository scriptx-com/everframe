// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import android.view.View

/** Framework metadata seam; the core has no React Native dependency. */
data class InteractionTargetViewHints(
    val testId: String? = null,
    val role: String? = null,
    val name: String? = null,
    val actionable: Boolean = false,
)
fun interface InteractionTargetViewAdapter {
    fun describe(view: View): InteractionTargetViewHints?
}
object InteractionTargetViewAdapters {
    @Volatile private var adapter: InteractionTargetViewAdapter? = null
    @Synchronized fun register(value: InteractionTargetViewAdapter): AutoCloseable {
        adapter = value
        return AutoCloseable { synchronized(this) { if (adapter === value) adapter = null } }
    }
    internal fun describe(view: View): InteractionTargetViewHints? = try { adapter?.describe(view) } catch (_: Throwable) { null }
}
