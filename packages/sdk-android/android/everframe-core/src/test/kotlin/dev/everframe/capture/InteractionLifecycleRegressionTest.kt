// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import android.view.View
import android.view.KeyEvent
import android.widget.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class) @Config(manifest = Config.NONE)
class InteractionLifecycleRegressionTest {
    @Test fun detachedAutomaticTextShouldNotReviveWhenTheSameHostReattaches() {
        val f = InteractionAdapterFixture()
        val adapter = InteractionTextAdapter(f.recorder)
        val field = f.field().apply { id = android.R.id.input; setText("old user") }
        f.recorder.configure(InteractionEventPolicy.parse("""{"valueTestIds":["input"]}"""))
        assertTrue(adapter.changed(field))
        f.root.removeView(field)
        assertFalse(field.isAttachedToWindow)
        field.setText("replacement")
        f.root.addView(field)
        assertTrue(field.isAttachedToWindow)
        f.now = 750
        f.recorder.flushDue()
        assertEquals("Detached automatic host must invalidate old text summary; actual=${f.events()}", 0, f.buffer.size)
        field.setText("new user")
        assertTrue(adapter.changed(field))
        f.now = 1500
        f.recorder.flushDue()
        assertEquals("new user", f.events().single().string("value"))
    }
    @Test @Config(qualifiers="television") fun verticalRemoteKeyShouldObserveVerticalAncestorInsideHorizontalRail() {
        val f = InteractionAdapterFixture()
        val vertical = ScrollView(f.activity)
        val content = LinearLayout(f.activity).apply { orientation = LinearLayout.VERTICAL }
        val horizontal = HorizontalScrollView(f.activity)
        val button = Button(f.activity).apply { text = "item"; isFocusableInTouchMode = true }
        horizontal.addView(button, android.widget.FrameLayout.LayoutParams(2000, 100))
        content.addView(horizontal, LinearLayout.LayoutParams(200, 100))
        content.addView(View(f.activity), LinearLayout.LayoutParams(200, 2000))
        vertical.addView(content)
        f.activity.setContentView(vertical)
        vertical.measure(View.MeasureSpec.makeMeasureSpec(200, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(200, View.MeasureSpec.EXACTLY))
        vertical.layout(0, 0, 200, 200)
        button.requestFocus()
        dev.everframe.Everframe.captureGate = true
        sharedBreadcrumbBuffer.applyConfig(null); sharedBreadcrumbBuffer.clear()
        assertSame(button, f.activity.window.currentFocus)
        val delegate = object : android.view.Window.Callback by f.activity.window.callback {
            override fun dispatchKeyEvent(event: KeyEvent): Boolean {
                vertical.scrollTo(0,100)
                assertEquals(100,vertical.scrollY)
                return true
            }
        }
        try {
            TXWindowCallbackWrapper(delegate,f.activity).dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_DPAD_DOWN))
            sharedBreadcrumbBuffer.freeze()
            val events = sharedBreadcrumbBuffer.takeFrozen()!!
            assertEquals("Remote-driven vertical movement should create a summary: $events",1,events.size)
        } finally { InteractionScrollAdapter.shared.dispose(); sharedBreadcrumbBuffer.clear(); dev.everframe.Everframe.captureGate = false }
    }
}

@RunWith(RobolectricTestRunner::class) @Config(manifest = Config.NONE)
class InteractionSensitiveTransitionTest {
    @Test fun offMainTextCannotAcquirePrivacyProofByUnmaskingBeforeAdmission() {
        for (mode in listOf("secure", "masked", "ordinary")) {
            val f = InteractionAdapterFixture()
            val view = f.field()
            val lease = f.recorder.lease()!!
            assertTrue(f.recorder.register(view, "helper", 1, lease, setOf("text_edit")))
            if (mode == "secure") view.transformationMethod = android.text.method.PasswordTransformationMethod.getInstance()
            if (mode == "masked") view.setTag(dev.everframe.R.id.tx_sensitive, true)
            var queued: PreparedInteraction? = null
            Thread {
                queued = f.recorder.prepare(lease, "helper", 1, """{"type":"text_edit","source":"app","observedAt":1,"length":31,"phase":"end"}""")
            }.apply { start(); join() }
            view.transformationMethod = null
            view.setTag(dev.everframe.R.id.tx_sensitive, null)
            queued?.let { f.recorder.recordPrepared(it) }
            assertEquals("Off-main $mode observation must not become admissible: ${f.events()}", 0, f.buffer.size)
            assertNull("Unknown observation-time privacy must fail closed", queued)
        }
    }

    @Test fun secureHostObservationMustNotBeResurrectedByUnmaskingBeforeQueueDrain() {
        val f = InteractionAdapterFixture()
        val view = f.field()
        val lease = f.recorder.lease()!!
        assertTrue(f.recorder.register(view,"helper",1,lease,setOf("text_edit")))
        for (mode in listOf("secure", "masked")) {
            if (mode == "secure") view.transformationMethod = android.text.method.PasswordTransformationMethod.getInstance()
            else view.setTag(dev.everframe.R.id.tx_sensitive, true)
            val prepared = f.recorder.prepare(lease,"helper",1,"""{"type":"text_edit","source":"app","observedAt":1,"length":31,"phase":"end"}""")
            view.transformationMethod = null
            view.setTag(dev.everframe.R.id.tx_sensitive, null)
            if (prepared != null) f.recorder.recordPrepared(prepared)
            assertEquals("Text observed while $mode must emit neither value nor length; actual=${f.events()}",0,f.buffer.size)
        }
    }
}

@RunWith(RobolectricTestRunner::class) @Config(manifest = Config.NONE)
class InteractionDeadlineTest {
    @Test fun earlierScrollDeadlineMustRunBeforeAnExistingTextTimer() {
        val f = InteractionAdapterFixture()
        val scheduled = mutableListOf<Pair<Long,()->Unit>>()
        val recorder = InteractionEventRecorder(f.buffer,clock={f.now},schedule={delay,action -> scheduled.add((f.now+delay) to action)})
        val text = f.field().apply { setText("typed") }
        InteractionTextAdapter(recorder).changed(text)
        val scroll = View(f.activity).also { f.root.addView(it) }
        val adapter = InteractionScrollAdapter(recorder,clock={f.now})
        f.now=50
        adapter.began(scroll,"y")
        scroll.scrollTo(0,100); adapter.moved(scroll)
        f.now=250
        while (scheduled.any { it.first <= f.now }) {
            val next = scheduled.filter { it.first <= f.now }.minBy { it.first }
            scheduled.remove(next); next.second()
        }
        val events = f.events()
        assertEquals("Scroll with 200 ms inactivity must complete before unrelated text's 750 ms timer; actual=$events",1,events.size)
        assertEquals("scroll",events.single().string("type"))
    }

    @Test fun launchDeadlinePreemptsTextAndSupersededTimersDoNotRepeatEvents() {
        val f = InteractionAdapterFixture()
        val scheduled = mutableListOf<Pair<Long, () -> Unit>>()
        val recorder = InteractionEventRecorder(f.buffer, clock = { f.now }, schedule = { delay, action -> scheduled.add((f.now + delay) to action) })
        val text = f.field().apply { setText("typed") }
        assertTrue(InteractionTextAdapter(recorder).changed(text))
        f.now = 50
        assertTrue(recorder.observe(InteractionObservation(recorder.owner()!!,
            nativeInteractionEvent("launch", JsonObject(mapOf("start" to JsonPrimitive("cold")))), deferLaunch = true)))
        fun runDue(at: Long) {
            f.now = at
            while (scheduled.any { it.first <= f.now }) {
                val next = scheduled.filter { it.first <= f.now }.minBy { it.first }
                scheduled.remove(next)
                next.second()
            }
        }
        runDue(300)
        assertEquals(listOf("launch"), f.events().map { it.string("type") })
        runDue(749)
        assertEquals(1, f.buffer.size)
        // Both the superseded timer and its replacement are due here.
        runDue(750)
        assertEquals(listOf("launch", "text_edit"), f.events().map { it.string("type") })
        runDue(2000)
        assertEquals(2, f.buffer.size)
    }
}
