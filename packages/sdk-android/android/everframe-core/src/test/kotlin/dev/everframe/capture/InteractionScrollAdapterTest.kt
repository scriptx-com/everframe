// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import android.view.View
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class) @Config(manifest = Config.NONE)
class InteractionScrollAdapterTest {
    @Test fun revocationBetweenCaptureAndRetentionDoesNotRestoreGesture() {
        val f = InteractionAdapterFixture()
        val adapter = InteractionScrollAdapter(f.recorder, clock = { f.recorder.revoke(); 0 })
        val view = View(f.activity).also { f.root.addView(it) }
        adapter.began(view, "y")
        assertEquals(0, adapter.retainedHosts)
    }
    @Test fun dragAndMomentumProduceOneSummaryAndProgrammaticOffsetsProduceNone() {
        val f = InteractionAdapterFixture(); val adapter = InteractionScrollAdapter(f.recorder, clock = { f.now })
        val view = View(f.activity).also { f.root.addView(it) }
        view.scrollTo(0, 5); adapter.moved(view); assertEquals(0, f.buffer.size)
        adapter.began(view, "y")
        view.scrollTo(0, 50); adapter.moved(view); adapter.endDrag(view)
        f.now = 100; view.scrollTo(0, 100); adapter.moved(view)
        f.now = 299; f.recorder.flushDue(); assertEquals(0, f.buffer.size)
        adapter.finished(view); f.now = 1000; f.recorder.flushDue(); assertEquals(1, f.buffer.size)
        assertEquals("forward", f.events().single()["direction"]!!.jsonPrimitive.content)
        view.scrollTo(0, 200); adapter.moved(view); f.recorder.flushDue(); assertEquals(1, f.buffer.size)
    }
    @Test fun endedDragWithoutMovementCannotClaimLaterProgrammaticScroll() {
        val f = InteractionAdapterFixture(); val adapter = InteractionScrollAdapter(f.recorder, clock = { f.now })
        val view = View(f.activity).also { f.root.addView(it) }
        adapter.began(view, "y"); adapter.endDrag(view)
        f.now = 5000
        view.scrollTo(0, 100); adapter.moved(view)
        f.now = 6000; f.recorder.flushDue()
        assertEquals(0, f.buffer.size)
        assertEquals(0, adapter.retainedHosts)
    }
    @Test fun remoteFocusAloneDoesNotProveScrollingAndNewGesturesHaveNewOwnership() {
        val f = InteractionAdapterFixture(); val adapter = InteractionScrollAdapter(f.recorder, clock = { f.now })
        val view = View(f.activity).also { f.root.addView(it) }
        adapter.began(view, "x"); adapter.moved(view); adapter.finished(view); assertEquals(0, f.buffer.size)
        adapter.began(view, "x"); view.scrollTo(10, 0); adapter.moved(view); adapter.finished(view)
        f.now = 1000; adapter.began(view, "x"); view.scrollTo(0, 0); adapter.moved(view); adapter.finished(view)
        assertEquals(2, f.buffer.size); assertEquals("backward", f.events().last()["direction"]!!.jsonPrimitive.content)
        f.now = 2000; adapter.began(view, "x"); assertEquals(1, adapter.retainedHosts)
        f.buffer.clear(); assertEquals(0, adapter.retainedHosts)
        view.scrollTo(30, 0); adapter.moved(view); adapter.finished(view)
        assertEquals(0, f.buffer.size)
        assertEquals(0, adapter.retainedHosts)
    }
    @Test @Config(qualifiers = "television") fun windowRemoteObservationCallsThroughAndCapturesActualContainerMovement() {
        val f = InteractionAdapterFixture()
        val scroll = android.widget.ScrollView(f.activity)
        val child = android.widget.Button(f.activity).apply { text = "item"; isFocusableInTouchMode = true }
        scroll.addView(child, android.widget.FrameLayout.LayoutParams(200, 2000))
        f.activity.setContentView(scroll)
        scroll.measure(View.MeasureSpec.makeMeasureSpec(200, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(200, View.MeasureSpec.EXACTLY))
        scroll.layout(0, 0, 200, 200); child.layout(0, 0, 200, 2000); child.requestFocus()
        dev.everframe.Everframe.captureGate = true
        sharedBreadcrumbBuffer.applyConfig(null); sharedBreadcrumbBuffer.clear()
        assertSame(child, f.activity.window.currentFocus)
        assertTrue(scroll.isAttachedToWindow)
        assertNotNull(sharedInteractionRecorder.owner(scroll))
        var calls = 0
        val delegate = object : android.view.Window.Callback by f.activity.window.callback {
            override fun dispatchKeyEvent(event: android.view.KeyEvent): Boolean { calls++; scroll.scrollTo(0, 100); assertEquals(100, scroll.scrollY); return true }
        }
        try {
            val callback = TXWindowCallbackWrapper(delegate, f.activity)
            assertTrue(callback.dispatchKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_DPAD_DOWN)))
            sharedBreadcrumbBuffer.freeze()
            assertEquals(1, calls)
            assertEquals("scroll", sharedBreadcrumbBuffer.takeFrozen()!!.single().data!!["interaction"]!!.jsonObject["type"]!!.jsonPrimitive.content)
        } finally { InteractionScrollAdapter.shared.dispose(); sharedBreadcrumbBuffer.clear(); dev.everframe.Everframe.captureGate = false }
    }
}
