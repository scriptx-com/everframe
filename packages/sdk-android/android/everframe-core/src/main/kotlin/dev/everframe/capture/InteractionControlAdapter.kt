// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import android.view.View
import android.widget.*
import kotlinx.serialization.json.*

class InteractionControlChange internal constructor(internal val owner: InteractionOwner, internal val before: JsonObject)

/** Additive observation. App listeners remain installed and run normally. */
class InteractionControlAdapter internal constructor(private val recorder: InteractionEventRecorder) {
    companion object { val shared by lazy { InteractionControlAdapter(sharedInteractionRecorder) } }
    fun begin(view: View): InteractionControlChange? = runCatching {
        if (recorder.suppresses(view, "control_change")) return null
        val owner = recorder.owner(view) ?: return null
        InteractionControlChange(owner, state(view) ?: return null)
    }.getOrNull()
    fun complete(change: InteractionControlChange): Boolean = runCatching {
        val view = change.owner.host?.get() ?: return false
        val state = state(view) ?: return false
        if (state == change.before || recorder.suppresses(view, "control_change")) return false
        recorder.observe(InteractionObservation(change.owner, nativeInteractionEvent("control_change", state)))
    }.getOrDefault(false)
    /** RN dispatches its user-change event after native state changes and before JS callbacks. */
    fun changed(view: View): Boolean = runCatching {
        if (recorder.suppresses(view, "control_change")) return false
        val owner = recorder.owner(view) ?: return false
        recorder.observe(InteractionObservation(owner, nativeInteractionEvent("control_change", state(view) ?: return false)))
    }.getOrDefault(false)
    private fun state(view: View): JsonObject? = when (view) {
        is CheckBox -> JsonObject(mapOf("control" to JsonPrimitive("checkbox"), "checked" to JsonPrimitive(view.isChecked)))
        is RadioButton -> null
        is CompoundButton -> JsonObject(mapOf("control" to JsonPrimitive("switch"), "checked" to JsonPrimitive(view.isChecked)))
        is SeekBar -> JsonObject(mapOf("control" to JsonPrimitive("slider"), "position" to JsonPrimitive(view.progress)))
        else -> null // Opaque pickers require explicit safe option IDs through the helper.
    }
}
