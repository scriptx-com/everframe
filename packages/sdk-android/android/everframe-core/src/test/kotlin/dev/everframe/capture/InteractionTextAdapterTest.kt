// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import android.app.Activity
import android.text.Spannable
import android.text.InputType
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
    @Test fun secureMaskAndHelperOwnershipSuppressOnlySemanticText() {
        val f = InteractionAdapterFixture(); val adapter = InteractionTextAdapter(f.recorder); val view = f.field()
        view.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        view.setText("SECRET"); adapter.changed(view); adapter.ended(view); assertEquals(0, f.buffer.size)
        view.inputType = InputType.TYPE_CLASS_TEXT
        assertTrue(f.recorder.register(view, "ref", 1, f.recorder.lease()!!, setOf("text_edit")))
        adapter.changed(view); adapter.ended(view); assertEquals(0, f.buffer.size)
    }
}
