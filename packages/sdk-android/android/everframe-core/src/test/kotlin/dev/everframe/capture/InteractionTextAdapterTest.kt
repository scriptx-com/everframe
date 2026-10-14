// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import android.app.Activity
import android.text.Spannable
import android.text.InputType
import android.view.inputmethod.EditorInfo
import android.widget.*
import androidx.test.core.app.ApplicationProvider
import dev.everframe.shared.SharedData
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

internal class InteractionAdapterFixture {
    val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    val root = LinearLayout(activity).also { activity.setContentView(it) }
    val buffer = BreadcrumbRingBuffer(100, false)
    var now = 0L
    val recorder = InteractionEventRecorder(buffer, clock = { now }, schedule = { _, _ -> })
    init { SharedData.init(ApplicationProvider.getApplicationContext()) }
    fun field() = EditText(activity).also { root.addView(it) }
    fun events() = buffer.snapshotForReport().map { it.data!!.getValue("interaction").jsonObject }
}

@RunWith(RobolectricTestRunner::class) @Config(manifest = Config.NONE)
class InteractionTextAdapterTest {
    @Test fun editsCoalesceAt750AndCompositionMustSettle() {
        val f = InteractionAdapterFixture(); val adapter = InteractionTextAdapter(f.recorder)
        val view = f.field(); view.setText("hello\nworld")
        // Programmatic values alone never enter the adapter.
        assertEquals(0, f.buffer.size)
        adapter.changed(view)
        f.now = 749; f.recorder.flushDue(); assertEquals(0, f.buffer.size)
        f.now = 750; f.recorder.flushDue(); assertEquals(11, f.events().single()["length"]!!.jsonPrimitive.int)
        f.now = 2000
        val composing = Any(); view.text.setSpan(composing, 0, 3, Spannable.SPAN_COMPOSING)
        adapter.changed(view); f.now += 750; f.recorder.flushDue(); assertEquals(1, f.buffer.size)
        view.text.removeSpan(composing); adapter.changed(view); adapter.ended(view, submit = true)
        assertEquals("submit", f.events().last()["reason"]!!.jsonPrimitive.content)
    }
    @Test fun compositionFinishesWithoutAnotherTextChangeAfterIdle() {
        val f = InteractionAdapterFixture(); val adapter = InteractionTextAdapter(f.recorder)
        val view = f.field(); view.requestFocus()
        val input = view.onCreateInputConnection(EditorInfo())!!
        input.setComposingText("draft", 1); adapter.changed(view)
        f.now = 750; f.recorder.flushDue(); assertEquals(0, f.buffer.size)
        input.finishComposingText() // IMEs can remove only spans, without another text change.
        adapter.ended(view, submit = true)
        val event = f.events().single()
        assertEquals(5, event["length"]!!.jsonPrimitive.int)
        assertEquals("submit", event["reason"]!!.jsonPrimitive.content)
        assertFalse(event.containsKey("value"))
    }
    @Test fun compositionCompletionNeverRenewsRevokedOrProgrammaticOwnership() {
        val f = InteractionAdapterFixture(); val adapter = InteractionTextAdapter(f.recorder)
        val view = f.field(); view.requestFocus()
        view.setText("programmatic"); adapter.ended(view); assertEquals(0, f.buffer.size)
        val input = view.onCreateInputConnection(EditorInfo())!!
        input.setComposingText("draft", 1); adapter.changed(view)
        f.now = 750; f.recorder.flushDue(); f.buffer.clear()
        input.finishComposingText(); adapter.ended(view); assertEquals(0, f.buffer.size)
    }
    @Test fun secureMaskAndHelperOwnershipSuppressOnlySemanticText() {
        val f = InteractionAdapterFixture(); val adapter = InteractionTextAdapter(f.recorder); val view = f.field()
        view.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        view.setText("SECRET"); adapter.changed(view); adapter.ended(view); assertEquals(0, f.buffer.size)
        view.inputType = InputType.TYPE_CLASS_TEXT
        assertTrue(f.recorder.register(view, "ref", 1, f.recorder.lease()!!, setOf("text_edit")))
        adapter.changed(view); adapter.ended(view); assertEquals(0, f.buffer.size)
    }
    @Test fun dormantCompositionIsBoundedAndDoesNotPoll() {
        val f = InteractionAdapterFixture(); val timers = mutableListOf<() -> Unit>()
        val recorder = InteractionEventRecorder(f.buffer, clock = { f.now }, schedule = { _, action -> timers.add(action) })
        val adapter = InteractionTextAdapter(recorder)
        val fields = (1..33).map {
            f.field().also { view ->
                view.setText("draft"); view.text.setSpan(Any(), 0, 5, Spannable.SPAN_COMPOSING)
                adapter.changed(view)
            }
        }
        assertEquals(1, timers.size)
        f.now = 750; timers.single().invoke()
        assertEquals(1, timers.size); assertEquals(0, f.buffer.size)
        assertEquals(32, recorder.pendingCount)
        fields.forEach { android.view.inputmethod.BaseInputConnection.removeComposingSpans(it.text) }
        adapter.ended(fields.first()); assertEquals(0, f.buffer.size)
        adapter.ended(fields.last()); assertEquals(5, f.events().single()["length"]!!.jsonPrimitive.int)
    }
    @Test fun compositionCompletionRechecksPrivacyAndKeepsOnlyObservedLength() {
        for (mode in listOf("secure", "detached", "replacement")) {
            val f = InteractionAdapterFixture(); val adapter = InteractionTextAdapter(f.recorder)
            val view = f.field(); view.setText("draft")
            val span = Any(); view.text.setSpan(span, 0, 5, Spannable.SPAN_COMPOSING)
            adapter.changed(view); f.now = 750; f.recorder.flushDue(); view.text.removeSpan(span)
            when (mode) {
                "secure" -> view.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
                "detached" -> f.root.removeView(view)
                "replacement" -> view.setText("programmatic replacement")
            }
            adapter.ended(view)
            if (mode == "replacement") {
                assertEquals(5, f.events().single()["length"]!!.jsonPrimitive.int)
                assertFalse(f.events().single().containsKey("value"))
            } else assertEquals(0, f.buffer.size)
        }
    }
}
