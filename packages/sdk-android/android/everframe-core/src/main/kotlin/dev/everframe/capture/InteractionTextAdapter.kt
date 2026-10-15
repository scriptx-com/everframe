// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import android.view.inputmethod.BaseInputConnection
import android.view.View
import android.widget.EditText
import java.util.WeakHashMap
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Called only from a framework event that establishes a user edit, never a TextWatcher on all updates. */
class InteractionTextAdapter internal constructor(private val recorder: InteractionEventRecorder) {
    companion object { val shared by lazy { InteractionTextAdapter(sharedInteractionRecorder) } }
    // One token per attached native host. The listener retains no view or text.
    internal class Attachment : View.OnAttachStateChangeListener {
        var attached = true
            private set
        override fun onViewAttachedToWindow(view: View) = Unit
        override fun onViewDetachedFromWindow(view: View) {
            attached = false
            view.removeOnAttachStateChangeListener(this)
        }
    }
    private val attachments = WeakHashMap<EditText, Attachment>()
    fun changed(view: EditText): Boolean = runCatching {
        if (recorder.suppresses(view, "text_edit")) return false
        val owner = recorder.owner(view) ?: return false
        val attachment = attachments[view]?.takeIf { it.attached } ?: Attachment().also {
            attachments[view] = it
            view.addOnAttachStateChangeListener(it)
        }
        val text = view.text ?: return false
        val composing = BaseInputConnection.getComposingSpanStart(text) >= 0 ||
            text.getSpans(0, text.length, Any::class.java).any { text.getSpanFlags(it) and android.text.Spanned.SPAN_COMPOSING != 0 }
        val fields = linkedMapOf("length" to JsonPrimitive(text.length))
        if (!composing && recorder.allowsValue(owner, "text_edit")) fields["value"] = JsonPrimitive(text.toString())
        recorder.observe(InteractionObservation(owner, nativeInteractionEvent("text_edit", JsonObject(fields)), composing = composing, nativeTextAttachment = attachment))
    }.getOrDefault(false)
    fun ended(view: EditText, submit: Boolean = false) {
        if (!recorder.suppresses(view, "text_edit")) recorder.complete(view, "text_edit", if (submit) "submit" else "end")
    }
}

internal fun nativeInteractionEvent(type: String, fields: JsonObject): JsonObject = JsonObject(fields + mapOf(
    "type" to JsonPrimitive(type), "source" to JsonPrimitive("native"), "observedAt" to JsonPrimitive(System.currentTimeMillis()),
))
