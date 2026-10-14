// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import android.view.inputmethod.BaseInputConnection
import android.widget.EditText
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Called only from a framework event that establishes a user edit, never a TextWatcher on all updates. */
class InteractionTextAdapter internal constructor(private val recorder: InteractionEventRecorder) {
    companion object { val shared by lazy { InteractionTextAdapter(sharedInteractionRecorder) } }
    fun changed(view: EditText): Boolean = runCatching {
        if (recorder.suppresses(view, "text_edit")) return false
        val owner = recorder.owner(view) ?: return false
        val text = view.text ?: return false
        val composing = BaseInputConnection.getComposingSpanStart(text) >= 0 ||
            text.getSpans(0, text.length, Any::class.java).any { text.getSpanFlags(it) and android.text.Spanned.SPAN_COMPOSING != 0 }
        val fields = linkedMapOf("length" to JsonPrimitive(text.length))
        if (!composing && recorder.allowsValue(owner, "text_edit")) fields["value"] = JsonPrimitive(text.toString())
        recorder.observe(InteractionObservation(owner, nativeInteractionEvent("text_edit", JsonObject(fields)), composing = composing))
    }.getOrDefault(false)
    fun ended(view: EditText, submit: Boolean = false) {
        if (!recorder.suppresses(view, "text_edit")) recorder.complete(view, "text_edit", if (submit) "submit" else "end")
    }
}

internal fun nativeInteractionEvent(type: String, fields: JsonObject): JsonObject = JsonObject(fields + mapOf(
    "type" to JsonPrimitive(type), "source" to JsonPrimitive("native"), "observedAt" to JsonPrimitive(System.currentTimeMillis()),
))
