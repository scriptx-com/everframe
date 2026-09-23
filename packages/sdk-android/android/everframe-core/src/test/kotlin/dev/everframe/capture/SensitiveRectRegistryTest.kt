// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// SensitiveRectRegistry tests — covers all five `isSensitive(view)` branches
// (TXSensitiveView, View.tag, EditText TYPE_CLASS_TEXT password, EditText
// TYPE_CLASS_NUMBER password, EditText non-password) plus the nested-walk
// early-return invariant (sensitive subtree does NOT descend).
//
// Robolectric drives Activity / View construction without an emulator. The
// Compose-side path is exercised by the instrumented test
// (TxSensitiveModifierInstrumentedTest) since ComposeView lifecycle on
// Robolectric is brittle.
package dev.everframe.capture

import android.app.Activity
import android.text.InputType
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.TextView
import androidx.test.core.app.ApplicationProvider
import dev.everframe.R
import dev.everframe.Everframe
import dev.everframe.sensitive.TXSensitiveView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class SensitiveRectRegistryTest {

    private val ctx get() = ApplicationProvider.getApplicationContext<android.content.Context>()

    @Test
    fun `TXSensitiveView is sensitive`() {
        val v = TXSensitiveView(ctx)
        assertTrue(SensitiveRectRegistry.isSensitive(v))
    }

    @Test
    fun `View tagged with R_id_tx_sensitive is sensitive`() {
        val v = View(ctx).apply { setTag(R.id.tx_sensitive, true) }
        assertTrue(SensitiveRectRegistry.isSensitive(v))
    }

    @Test
    fun `View with no tag is not sensitive`() {
        val v = View(ctx)
        assertFalse(SensitiveRectRegistry.isSensitive(v))
    }

    @Test
    fun `EditText TYPE_TEXT_VARIATION_PASSWORD is sensitive`() {
        val v = EditText(ctx).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        assertTrue(SensitiveRectRegistry.isSensitive(v))
    }

    @Test
    fun `EditText TYPE_TEXT_VARIATION_VISIBLE_PASSWORD is sensitive`() {
        val v = EditText(ctx).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
        }
        assertTrue(SensitiveRectRegistry.isSensitive(v))
    }

    @Test
    fun `EditText TYPE_TEXT_VARIATION_WEB_PASSWORD is sensitive`() {
        val v = EditText(ctx).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD
        }
        assertTrue(SensitiveRectRegistry.isSensitive(v))
    }

    @Test
    fun `EditText TYPE_NUMBER_VARIATION_PASSWORD is sensitive`() {
        val v = EditText(ctx).apply {
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
        }
        assertTrue(SensitiveRectRegistry.isSensitive(v))
    }

    @Test
    fun `EditText TYPE_CLASS_TEXT (no variation) is not sensitive`() {
        val v = EditText(ctx).apply { inputType = InputType.TYPE_CLASS_TEXT }
        assertFalse(SensitiveRectRegistry.isSensitive(v))
    }

    @Test
    fun `EditText TYPE_CLASS_TEXT TYPE_TEXT_VARIATION_URI is not sensitive (cross-class collision guard)`() {
        // TYPE_TEXT_VARIATION_URI = 0x10 — same bit as TYPE_NUMBER_VARIATION_PASSWORD.
        // A naive `inputType and pwdMask != 0` check would mis-flag this; the
        // class-aware mask in isPasswordEditText must reject it.
        val v = EditText(ctx).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        }
        assertFalse(SensitiveRectRegistry.isSensitive(v))
    }

    // Phase 05.2 D-11 UAT regression — Everframe.markSensitive(view) was a no-op
    // stub for the duration of v1.2 dev. The Payment sample screen's
    // markSensitive(cardEditText) call silently did nothing and the EditText
    // rendered unredacted in screenshots. Lock the happy-path.

    @Test
    fun `Everframe_markSensitive tags the view`() {
        Everframe.captureGate = true
        try {
            val v = View(ctx)
            Everframe.markSensitive(v)
            assertEquals(true, v.getTag(R.id.tx_sensitive))
            assertTrue(SensitiveRectRegistry.isSensitive(v))
        } finally {
            Everframe.captureGate = false
        }
    }

    @Test
    fun `Everframe_markSensitive preserves privacy while captureGate is false`() {
        // Pre-start/after-kill markers protect the next capture without enabling it.
        Everframe.captureGate = false
        val v = View(ctx)
        Everframe.markSensitive(v)
        assertTrue(SensitiveRectRegistry.isSensitive(v))
        assertFalse(Everframe.captureGate)
    }

    @Test
    fun `Everframe_markSensitive on EditText with non-password inputType still tags`() {
        // Mirrors the Payment sample screen — TYPE_CLASS_NUMBER alone is NOT
        // password-classified, so the only thing flagging this EditText as
        // sensitive must be markSensitive's tag write. Direct regression for
        // the no-op-stub bug.
        Everframe.captureGate = true
        try {
            val v = EditText(ctx).apply { inputType = InputType.TYPE_CLASS_NUMBER }
            assertFalse("baseline: TYPE_CLASS_NUMBER alone must not be sensitive",
                SensitiveRectRegistry.isSensitive(v))
            Everframe.markSensitive(v)
            assertTrue("after markSensitive, EditText must be sensitive",
                SensitiveRectRegistry.isSensitive(v))
        } finally {
            Everframe.captureGate = false
        }
    }

    @Test
    fun `nested ViewGroup with TXSensitiveView emits one rect and descendants not walked`() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val root = FrameLayout(activity).apply {
            layout(0, 0, 800, 1200)
        }
        val sensitive = TXSensitiveView(activity).apply {
            // Add a non-sensitive descendant — it must NOT generate its own rect.
            addView(TextView(activity))
            layout(100, 200, 300, 400)
        }
        root.addView(sensitive)
        activity.setContentView(root)
        // Force layout pass — Robolectric needs explicit measure+layout to populate
        // getLocationInWindow + width/height.
        root.measure(
            View.MeasureSpec.makeMeasureSpec(800, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(1200, View.MeasureSpec.EXACTLY),
        )
        root.layout(0, 0, 800, 1200)
        sensitive.layout(100, 200, 300, 400)

        val rects = SensitiveRectRegistry.collectInWindowCoords(activity)
        assertEquals(1, rects.size)
        // Width/height are 200x200 — coords depend on Robolectric window placement
        // (no DecorView insets), so we assert dimensions, not absolute origin.
        assertEquals(200, rects[0].width())
        assertEquals(200, rects[0].height())
    }

    @Test
    fun `non-sensitive ViewGroup with non-sensitive children emits zero rects`() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val root = FrameLayout(activity)
        root.addView(TextView(activity))
        root.addView(View(activity))
        activity.setContentView(root)
        root.measure(0, 0); root.layout(0, 0, 100, 100)

        val rects = SensitiveRectRegistry.collectInWindowCoords(activity)
        assertEquals(0, rects.size)
    }

    @Test
    fun `sensitive parent suppresses sensitive child rect (no double-count)`() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val outer = TXSensitiveView(activity)
        val inner = TXSensitiveView(activity)
        outer.addView(inner)
        // Use a real container so both views get attached to a window via setContentView.
        val container = FrameLayout(activity).apply { addView(outer) }
        activity.setContentView(container)
        container.measure(0, 0); container.layout(0, 0, 400, 400)
        outer.layout(0, 0, 400, 400)
        inner.layout(50, 50, 150, 150)

        val rects = SensitiveRectRegistry.collectInWindowCoords(activity)
        // Outer is the only emitted rect — early-return prevents inner from being walked.
        assertEquals(1, rects.size)
    }

    private fun ViewGroup.addAndLayout(child: View, l: Int, t: Int, r: Int, b: Int) {
        addView(child); child.layout(l, t, r, b)
    }
}
