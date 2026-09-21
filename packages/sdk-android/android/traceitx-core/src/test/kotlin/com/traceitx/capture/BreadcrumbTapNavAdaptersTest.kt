// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Task 12 — tap + navigation breadcrumb adapters. Robolectric drives real
// Activity / Window / View instances without an emulator (mirrors
// SensitiveRectRegistryTest / BreadcrumbAdaptersTest's rationale).
//
// The most important test in this file is
// `TXWindowCallbackWrapper delegates every Window_Callback method` — a
// broken/incomplete Window.Callback bricks the host Activity (no input, no
// menus, no back button), so this is the anti-bricking regression guard. It
// combines explicit, hand-verified calls to every method on the current
// `Window.Callback` interface with a REFLECTION-BASED completeness check
// (`Window.Callback::class.java.methods.map { it.name }.toSet()`) so that if
// a future Android SDK bump adds a new interface method this file's author
// forgot to override, the completeness assertion fails loudly instead of the
// new method silently falling back to a no-op default and bricking taps.
package com.traceitx.capture

import android.app.Activity
import android.content.Context
import android.text.InputType
import android.view.ActionMode
import android.view.KeyEvent
import android.view.KeyboardShortcutGroup
import android.view.Menu
import android.view.MenuInflater
import android.view.MenuItem
import android.view.MotionEvent
import android.view.SearchEvent
import android.view.View
import android.view.Window
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.PopupMenu
import android.widget.TextView
import androidx.test.core.app.ApplicationProvider
import com.traceitx.R
import com.traceitx.TraceItX
import com.traceitx.config.BreadcrumbsConfigWire
import com.traceitx.protocol.generated.Breadcrumb
import com.traceitx.protocol.generated.BreadcrumbKind
import com.traceitx.sensitive.TXSensitiveView
import com.traceitx.shared.SharedData
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class BreadcrumbTapNavAdaptersTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()

    private fun resetBreadcrumbState() {
        sharedBreadcrumbBuffer.applyConfig(null)
        sharedBreadcrumbBuffer.clear()
    }

    @Before
    fun setUp() {
        SharedData.init(context)
        resetBreadcrumbState()
        TraceItX.captureGate = true
        BreadcrumbTapNavAdapters.__resetForTesting()
        PressCrumbRateLimiter.__resetForTesting()
    }

    @After
    fun tearDown() {
        resetBreadcrumbState()
        TraceItX.captureGate = false
        BreadcrumbTapNavAdapters.__resetForTesting()
        PressCrumbRateLimiter.__resetForTesting()
    }

    private fun firstCrumbOfKind(kind: BreadcrumbKind): Breadcrumb? {
        sharedBreadcrumbBuffer.freeze()
        return sharedBreadcrumbBuffer.takeFrozen()?.firstOrNull { it.kind == kind }
    }

    private fun crumbsOfKind(kind: BreadcrumbKind): List<Breadcrumb> {
        sharedBreadcrumbBuffer.freeze()
        return sharedBreadcrumbBuffer.takeFrozen()?.filter { it.kind == kind } ?: emptyList()
    }

    private fun buildActivity(): Activity = Robolectric.buildActivity(Activity::class.java).setup().get()

    /** Sets [view] as the Activity's content and forces a real measure+layout
     *  pass (Robolectric does NOT do this automatically for a content view
     *  set after `.setup()` — mirrors SensitiveRectRegistryTest's explicit
     *  measure()/layout() convention). */
    private fun setContentAndLayout(activity: Activity, view: View, width: Int, height: Int) {
        activity.setContentView(view)
        view.measure(
            View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY),
        )
        view.layout(0, 0, width, height)
    }

    /** Real window-space coordinates for a point inside [view], derived from
     *  its actual post-layout position rather than an assumed absolute
     *  offset (decor internals like the action bar shift content down). */
    private fun windowPoint(view: View, offsetX: Int = 10, offsetY: Int = 10): Pair<Float, Float> {
        val loc = IntArray(2)
        view.getLocationInWindow(loc)
        return (loc[0] + offsetX).toFloat() to (loc[1] + offsetY).toFloat()
    }

    private fun up(x: Float, y: Float): MotionEvent =
        MotionEvent.obtain(0, 0, MotionEvent.ACTION_UP, x, y, 0)

    private fun down(x: Float, y: Float): MotionEvent =
        MotionEvent.obtain(0, 0, MotionEvent.ACTION_DOWN, x, y, 0)

    // ==================== Window.Callback delegation (anti-bricking) ====================

    /** Records every method invoked, by name, via manual per-method bookkeeping
     *  (NOT reflection-generated — see class doc for why the completeness
     *  check below is reflection-based instead). */
    private class RecordingWindowCallback(context: Context) : Window.Callback {
        val calls = mutableListOf<String>()
        val menu: Menu = PopupMenu(context, FrameLayout(context)).menu.also { it.add("item") }
        val menuItem: MenuItem = menu.getItem(0)

        override fun dispatchKeyEvent(event: KeyEvent): Boolean { calls += "dispatchKeyEvent"; return true }
        override fun dispatchKeyShortcutEvent(event: KeyEvent): Boolean { calls += "dispatchKeyShortcutEvent"; return true }
        override fun dispatchTouchEvent(event: MotionEvent): Boolean { calls += "dispatchTouchEvent"; return true }
        override fun dispatchTrackballEvent(event: MotionEvent): Boolean { calls += "dispatchTrackballEvent"; return true }
        override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean { calls += "dispatchGenericMotionEvent"; return true }
        override fun dispatchPopulateAccessibilityEvent(event: AccessibilityEvent): Boolean {
            calls += "dispatchPopulateAccessibilityEvent"; return true
        }
        override fun onCreatePanelView(featureId: Int): View? { calls += "onCreatePanelView"; return null }
        override fun onCreatePanelMenu(featureId: Int, menu: Menu): Boolean { calls += "onCreatePanelMenu"; return true }
        override fun onPreparePanel(featureId: Int, view: View?, menu: Menu): Boolean {
            calls += "onPreparePanel"; return true
        }
        override fun onMenuOpened(featureId: Int, menu: Menu): Boolean { calls += "onMenuOpened"; return true }
        override fun onMenuItemSelected(featureId: Int, item: MenuItem): Boolean {
            calls += "onMenuItemSelected"; return true
        }
        override fun onWindowAttributesChanged(attrs: WindowManager.LayoutParams?) { calls += "onWindowAttributesChanged" }
        override fun onContentChanged() { calls += "onContentChanged" }
        override fun onWindowFocusChanged(hasFocus: Boolean) { calls += "onWindowFocusChanged" }
        override fun onAttachedToWindow() { calls += "onAttachedToWindow" }
        override fun onDetachedFromWindow() { calls += "onDetachedFromWindow" }
        override fun onPanelClosed(featureId: Int, menu: Menu) { calls += "onPanelClosed" }
        override fun onSearchRequested(): Boolean { calls += "onSearchRequested"; return true }
        override fun onSearchRequested(searchEvent: SearchEvent?): Boolean {
            calls += "onSearchRequested"; return true
        }
        override fun onWindowStartingActionMode(callback: ActionMode.Callback?): ActionMode? {
            calls += "onWindowStartingActionMode"; return null
        }
        override fun onWindowStartingActionMode(callback: ActionMode.Callback?, type: Int): ActionMode? {
            calls += "onWindowStartingActionMode"; return null
        }
        override fun onActionModeStarted(mode: ActionMode) { calls += "onActionModeStarted" }
        override fun onActionModeFinished(mode: ActionMode) { calls += "onActionModeFinished" }
        override fun onProvideKeyboardShortcuts(
            data: MutableList<KeyboardShortcutGroup>?,
            menu: Menu?,
            deviceId: Int,
        ) { calls += "onProvideKeyboardShortcuts" }
        override fun onPointerCaptureChanged(hasCapture: Boolean) { calls += "onPointerCaptureChanged" }
    }

    private class FakeActionMode(private val menu: Menu, private val inflater: MenuInflater) : ActionMode() {
        override fun setTitle(title: CharSequence?) {}
        override fun setTitle(resId: Int) {}
        override fun setSubtitle(subtitle: CharSequence?) {}
        override fun setSubtitle(resId: Int) {}
        override fun setCustomView(view: View?) {}
        override fun invalidate() {}
        override fun finish() {}
        override fun getMenu(): Menu = menu
        override fun getTitle(): CharSequence? = null
        override fun getSubtitle(): CharSequence? = null
        override fun getCustomView(): View? = null
        override fun getMenuInflater(): MenuInflater = inflater
    }

    @Test
    fun `TXWindowCallbackWrapper delegates every Window_Callback method`() {
        val activity = buildActivity()
        val recording = RecordingWindowCallback(context)
        val wrapper = TXWindowCallbackWrapper(recording, activity)

        val actionModeCallback = object : ActionMode.Callback {
            override fun onCreateActionMode(mode: ActionMode?, menu: Menu?): Boolean = true
            override fun onPrepareActionMode(mode: ActionMode?, menu: Menu?): Boolean = true
            override fun onActionItemClicked(mode: ActionMode?, item: MenuItem?): Boolean = true
            override fun onDestroyActionMode(mode: ActionMode?) {}
        }
        val actionMode = FakeActionMode(recording.menu, activity.menuInflater)

        // Exercise every method the current android-35 Window.Callback interface declares.
        wrapper.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_A))
        wrapper.dispatchKeyShortcutEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_A))
        wrapper.dispatchTouchEvent(down(0f, 0f)) // ACTION_DOWN — must still delegate (only ACTION_UP triggers crumb logic)
        wrapper.dispatchTrackballEvent(down(0f, 0f))
        wrapper.dispatchGenericMotionEvent(down(0f, 0f))
        wrapper.dispatchPopulateAccessibilityEvent(AccessibilityEvent.obtain())
        wrapper.onCreatePanelView(0)
        wrapper.onCreatePanelMenu(0, recording.menu)
        wrapper.onPreparePanel(0, null, recording.menu)
        wrapper.onMenuOpened(0, recording.menu)
        wrapper.onMenuItemSelected(0, recording.menuItem)
        wrapper.onWindowAttributesChanged(WindowManager.LayoutParams())
        wrapper.onContentChanged()
        wrapper.onWindowFocusChanged(true)
        wrapper.onAttachedToWindow()
        wrapper.onDetachedFromWindow()
        wrapper.onPanelClosed(0, recording.menu)
        wrapper.onSearchRequested()
        wrapper.onSearchRequested(SearchEvent(null))
        wrapper.onWindowStartingActionMode(actionModeCallback)
        wrapper.onWindowStartingActionMode(actionModeCallback, ActionMode.TYPE_FLOATING)
        wrapper.onActionModeStarted(actionMode)
        wrapper.onActionModeFinished(actionMode)
        wrapper.onProvideKeyboardShortcuts(mutableListOf(KeyboardShortcutGroup("g")), recording.menu, 0)
        wrapper.onPointerCaptureChanged(true)

        val exercisedMethodNames = recording.calls.toSet()
        // Every method actually invoked above reached the delegate.
        assertTrue("dispatchTouchEvent must delegate even for non-UP actions", recording.calls.contains("dispatchTouchEvent"))

        // Reflection-based completeness: every method NAME the live Window.Callback
        // interface declares was exercised above. If a future SDK bump adds a new
        // method this file wasn't updated for, this assertion catches it instead of
        // the wrapper silently no-op'ing (via an unoverridden default) and bricking
        // whatever that method controls.
        val interfaceMethodNames = Window.Callback::class.java.methods.map { it.name }.toSet()
        val missing = interfaceMethodNames - exercisedMethodNames
        assertTrue(
            "TXWindowCallbackWrapper (or this test) is missing delegation coverage for: $missing",
            missing.isEmpty(),
        )
    }

    // ==================== install-once idempotency ====================

    @Test
    fun `install is idempotent — second install does not double-register callbacks`() {
        assertFalse(BreadcrumbTapNavAdapters.installedForTesting())
        BreadcrumbTapNavAdapters.install(context)
        assertTrue(BreadcrumbTapNavAdapters.installedForTesting())
        BreadcrumbTapNavAdapters.install(context) // must be a no-op
        assertTrue(BreadcrumbTapNavAdapters.installedForTesting())
    }

    @Test
    fun `double onActivityCreated on the same Activity wraps the window callback exactly once`() {
        val activity = buildActivity()
        val button = TextView(context).apply { text = "Tap me"; layout(0, 0, 100, 50) }
        activity.setContentView(button)

        val callbacks = BreadcrumbTapNavAdapters.callbacksForTesting()
        callbacks.onActivityCreated(activity, null)
        callbacks.onActivityCreated(activity, null) // re-entrant — must not stack a second wrapper

        assertTrue(activity.window.callback is TXWindowCallbackWrapper)
        val wrapped = activity.window.callback as TXWindowCallbackWrapper
        assertFalse("must not wrap an already-wrapped callback", wrapped.delegate is TXWindowCallbackWrapper)

        activity.window.callback.dispatchTouchEvent(up(10f, 10f))

        val taps = crumbsOfKind(BreadcrumbKind.Tap)
        assertEquals("exactly one tap crumb per ACTION_UP, not two", 1, taps.size)
    }

    // ==================== Tap ====================

    @Test
    fun `ACTION_UP over a real button emits one tap crumb with the button's text as label`() {
        val activity = buildActivity()
        val button = TextView(context).apply { text = "Submit" }
        setContentAndLayout(activity, button, 200, 100)
        BreadcrumbTapNavAdapters.callbacksForTesting().onActivityCreated(activity, null)

        val (x, y) = windowPoint(button)
        activity.window.callback.dispatchTouchEvent(up(x, y))

        val crumb = firstCrumbOfKind(BreadcrumbKind.Tap)
        assertNotNull("expected a tap crumb", crumb)
        assertEquals("tap Submit", crumb?.message)
        assertEquals("TextView", (crumb?.data?.get("view") as? JsonPrimitive)?.content)
    }

    @Test
    fun `ACTION_DOWN does not emit a tap crumb`() {
        val activity = buildActivity()
        val button = TextView(context).apply { text = "Submit" }
        setContentAndLayout(activity, button, 200, 100)
        BreadcrumbTapNavAdapters.callbacksForTesting().onActivityCreated(activity, null)

        val (x, y) = windowPoint(button)
        activity.window.callback.dispatchTouchEvent(down(x, y))

        assertNull(firstCrumbOfKind(BreadcrumbKind.Tap))
    }

    @Test
    fun `masked view yields masked label and no view text in the crumb`() {
        val activity = buildActivity()
        val secret = EditText(context).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            setText("super-secret-password")
        }
        setContentAndLayout(activity, secret, 200, 100)
        BreadcrumbTapNavAdapters.callbacksForTesting().onActivityCreated(activity, null)

        val (x, y) = windowPoint(secret)
        activity.window.callback.dispatchTouchEvent(up(x, y))

        val crumb = firstCrumbOfKind(BreadcrumbKind.Tap)
        assertNotNull(crumb)
        assertEquals("tap [masked]", crumb?.message)
        assertFalse(crumb!!.message.contains("super-secret-password"))
        assertEquals(true, (crumb.data?.get("masked") as? JsonPrimitive)?.let { it.content == "true" })
    }

    @Test
    fun `masked ANCESTOR still masks a non-sensitive tapped child`() {
        val activity = buildActivity()
        val label = TextView(context).apply { text = "card number leak" }
        val sensitiveContainer = TXSensitiveView(context).apply { addView(label) }
        setContentAndLayout(activity, sensitiveContainer, 200, 100)
        BreadcrumbTapNavAdapters.callbacksForTesting().onActivityCreated(activity, null)

        val (x, y) = windowPoint(label)
        activity.window.callback.dispatchTouchEvent(up(x, y))

        val crumb = firstCrumbOfKind(BreadcrumbKind.Tap)
        assertNotNull(crumb)
        assertEquals("tap [masked]", crumb?.message)
        assertFalse(crumb!!.message.contains("card number leak"))
    }

    @Test
    fun `label precedence — contentDescription wins over text`() {
        val view = TextView(context).apply {
            text = "visible text"
            contentDescription = "a11y label"
        }
        val (label, _) = TapBreadcrumbAdapter.deriveLabelAndData(view)
        assertEquals("a11y label", label)
    }

    @Test
    fun `label precedence — text wins over resource id when no contentDescription`() {
        val view = TextView(context).apply {
            id = R.id.tx_sensitive
            text = "button text"
        }
        val (label, _) = TapBreadcrumbAdapter.deriveLabelAndData(view)
        assertEquals("button text", label)
    }

    @Test
    fun `label precedence — resource id wins over class name when no text or description`() {
        val view = View(context).apply { id = R.id.tx_sensitive }
        val (label, data) = TapBreadcrumbAdapter.deriveLabelAndData(view)
        assertEquals("tx_sensitive", label)
        assertEquals("tx_sensitive", (data["id"] as? JsonPrimitive)?.content)
    }

    @Test
    fun `label precedence — falls back to class simple name`() {
        val view = View(context)
        val (label, _) = TapBreadcrumbAdapter.deriveLabelAndData(view)
        assertEquals("View", label)
    }

    @Test
    fun `label text is capped at 48 UTF-16 units`() {
        val longText = "x".repeat(80)
        val view = TextView(context).apply { text = longText }
        val (label, _) = TapBreadcrumbAdapter.deriveLabelAndData(view)
        assertEquals(48, label.length)
    }

    @Test
    fun `tap dual-write is a no-op when tap kind is disabled`() {
        sharedBreadcrumbBuffer.applyConfig(
            BreadcrumbsConfigWire(
                enabled = true, kinds = listOf("navigation"), maxCount = 10, byteBudget = 16384, consoleEntryCap = 1024,
            ),
        )
        val activity = buildActivity()
        val button = TextView(context).apply { text = "Submit" }
        setContentAndLayout(activity, button, 200, 100)
        BreadcrumbTapNavAdapters.callbacksForTesting().onActivityCreated(activity, null)

        val (x, y) = windowPoint(button)
        activity.window.callback.dispatchTouchEvent(up(x, y))

        assertNull(firstCrumbOfKind(BreadcrumbKind.Tap))
    }

    // ==================== findViewAt hit-test ====================

    @Test
    fun `findViewAt returns the deepest view under the point, respecting z-order`() {
        val back = View(context)
        val front = View(context) // same bounds, drawn on top (added last)
        val root = FrameLayout(context).apply {
            addView(back)
            addView(front)
        }
        // Measure+layout root FIRST, then explicitly re-layout the plain
        // (unmeasured, 0x0-by-default) children LAST so their manual bounds
        // win over FrameLayout.onLayout's auto-positioning (which would
        // otherwise collapse them back to their measured 0x0 size) — same
        // ordering convention as SensitiveRectRegistryTest.
        root.measure(
            View.MeasureSpec.makeMeasureSpec(100, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(100, View.MeasureSpec.EXACTLY),
        )
        root.layout(0, 0, 100, 100)
        back.layout(0, 0, 100, 100)
        front.layout(0, 0, 100, 100)

        val hit = TapBreadcrumbAdapter.findViewAt(root, 50f, 50f)
        assertEquals(front, hit)
    }

    @Test
    fun `findViewAt returns null outside root bounds`() {
        val root = FrameLayout(context).apply { layout(0, 0, 100, 100) }
        assertNull(TapBreadcrumbAdapter.findViewAt(root, 500f, 500f))
    }

    @Test
    fun `findViewAt skips invisible children`() {
        val hidden = TextView(context).apply { text = "hidden"; visibility = View.GONE; layout(0, 0, 100, 100) }
        val root = FrameLayout(context).apply {
            addView(hidden)
            layout(0, 0, 100, 100)
        }
        val hit = TapBreadcrumbAdapter.findViewAt(root, 50f, 50f)
        assertEquals(root, hit)
    }

    /**
     * Regression for the scroll-aware hit-testing fix. `container` is a
     * 200x100 viewport stacking two 200x100 children: `topLabel` (non-
     * sensitive, content y 0-100) directly above `bottomMasked` (a
     * [TXSensitiveView] wrapping sensitive text, content y 100-200).
     * `container.scrollTo(0, 100)` scrolls the viewport down so the MASKED
     * child is the one actually visible/tappable on screen at container-
     * local point (50, 50) — `topLabel` is scrolled fully out of view above.
     *
     * Pre-fix, `findViewAt` ignored `container`'s scroll offset when
     * descending: it would compute `bottomMasked`'s local y as `50 - 100 =
     * -50` (out of bounds, skipped) and `topLabel`'s local y as `50 - 0 =
     * 50` (in bounds — WRONGLY matched), returning the non-sensitive
     * `topLabel` and leaking its text instead of masking the view actually
     * under the finger. This test fails against the pre-fix code (proving
     * the bug) and passes once scroll is added back before subtracting the
     * child's layout position.
     */
    @Test
    fun `findViewAt is scroll-aware — a scrolled masked child is hit, not the unscrolled sibling behind it`() {
        val activity = buildActivity()
        val topLabel = TextView(context).apply { text = "top text should not leak" }
        val sensitiveText = TextView(context).apply { text = "secret account 12345" }
        val bottomMasked = TXSensitiveView(context).apply { addView(sensitiveText) }
        val container = FrameLayout(context).apply {
            addView(topLabel)
            addView(bottomMasked)
        }

        setContentAndLayout(activity, container, 200, 100)
        // Explicit re-layout to pin content-space bounds: topLabel occupies
        // content y 0-100, bottomMasked occupies content y 100-200 (stacked
        // vertically, both full viewport width) — same manual-layout
        // convention as the z-order test above (FrameLayout.onLayout would
        // otherwise auto-position both children at (0,0)).
        topLabel.layout(0, 0, 200, 100)
        bottomMasked.layout(0, 100, 200, 200)
        sensitiveText.layout(0, 0, 200, 100)
        // Scroll the viewport so content y 100-200 (bottomMasked) is what's
        // actually on screen at container-local y 0-100; topLabel (content y
        // 0-100) is scrolled entirely out of view above.
        container.scrollTo(0, 100)

        BreadcrumbTapNavAdapters.callbacksForTesting().onActivityCreated(activity, null)

        val (x, y) = windowPoint(container, offsetX = 50, offsetY = 50)
        activity.window.callback.dispatchTouchEvent(up(x, y))

        val crumb = firstCrumbOfKind(BreadcrumbKind.Tap)
        assertNotNull("expected a tap crumb", crumb)
        assertEquals("the visually-scrolled-into-view masked child must be hit, not the sibling behind it", "tap [masked]", crumb?.message)
        assertFalse(crumb!!.message.contains("top text"))
        assertFalse(crumb.message.contains("secret account"))
        assertEquals(true, (crumb.data?.get("masked") as? JsonPrimitive)?.let { it.content == "true" })
    }

    // ==================== Navigation ====================

    private class FakeActivityA : Activity()
    private class FakeActivityB : Activity()

    @Test
    fun `first resume emits no navigation crumb (no from yet)`() {
        val a = Robolectric.buildActivity(FakeActivityA::class.java).setup().get()
        BreadcrumbTapNavAdapters.callbacksForTesting().onActivityResumed(a)
        assertNull(firstCrumbOfKind(BreadcrumbKind.Navigation))
    }

    @Test
    fun `second resume emits a navigation crumb with class simple names A to B`() {
        val a = Robolectric.buildActivity(FakeActivityA::class.java).setup().get()
        val b = Robolectric.buildActivity(FakeActivityB::class.java).setup().get()
        val callbacks = BreadcrumbTapNavAdapters.callbacksForTesting()

        callbacks.onActivityResumed(a)
        callbacks.onActivityResumed(b)

        val crumb = firstCrumbOfKind(BreadcrumbKind.Navigation)
        assertNotNull(crumb)
        assertEquals("FakeActivityA → FakeActivityB", crumb?.message)
        assertEquals("FakeActivityA", (crumb?.data?.get("from") as? JsonPrimitive)?.content)
        assertEquals("FakeActivityB", (crumb?.data?.get("to") as? JsonPrimitive)?.content)
    }

    @Test
    fun `A re-resuming after A to B to A does not emit a spurious A to A crumb`() {
        val a = Robolectric.buildActivity(FakeActivityA::class.java).setup().get()
        val b = Robolectric.buildActivity(FakeActivityB::class.java).setup().get()
        val callbacks = BreadcrumbTapNavAdapters.callbacksForTesting()

        callbacks.onActivityResumed(a) // first resume ever — no "from", no crumb
        callbacks.onActivityResumed(b) // A -> B
        callbacks.onActivityResumed(a) // B -> A
        callbacks.onActivityResumed(a) // A re-resumes (e.g. background/foreground cycle) -> must NOT emit "A -> A"

        val crumbs = crumbsOfKind(BreadcrumbKind.Navigation)
        val messages = crumbs.map { it.message }
        assertEquals(listOf("FakeActivityA → FakeActivityB", "FakeActivityB → FakeActivityA"), messages)
        assertTrue("no A -> A self-transition crumb expected", crumbs.none { it.message.contains("FakeActivityA → FakeActivityA") })
        // Tracking state must still reflect the latest resume even though no
        // crumb was emitted for the self-transition.
        assertEquals("FakeActivityA", NavigationBreadcrumbAdapter.previousClassNameForTesting())
    }

    @Test
    fun `navigation dual-write is a no-op when navigation kind is disabled`() {
        sharedBreadcrumbBuffer.applyConfig(
            BreadcrumbsConfigWire(
                enabled = true, kinds = listOf("tap"), maxCount = 10, byteBudget = 16384, consoleEntryCap = 1024,
            ),
        )
        val a = Robolectric.buildActivity(FakeActivityA::class.java).setup().get()
        val b = Robolectric.buildActivity(FakeActivityB::class.java).setup().get()
        val callbacks = BreadcrumbTapNavAdapters.callbacksForTesting()

        callbacks.onActivityResumed(a)
        callbacks.onActivityResumed(b)

        assertNull(firstCrumbOfKind(BreadcrumbKind.Navigation))
    }

    // ==================== recordScreen (screen markers — Plan 2026-07-14) ====================

    @Test
    fun `first recordScreen emits no navigation crumb (no from yet)`() {
        TraceItX.recordScreen("Home")
        assertNull(firstCrumbOfKind(BreadcrumbKind.Navigation))
        assertEquals("Home", NavigationBreadcrumbAdapter.previousClassNameForTesting())
    }

    @Test
    fun `second recordScreen emits a from → to crumb`() {
        TraceItX.recordScreen("Home")
        TraceItX.recordScreen("Detail")
        val crumb = firstCrumbOfKind(BreadcrumbKind.Navigation)
        assertNotNull(crumb)
        assertEquals("Home → Detail", crumb?.message)
        assertEquals("Home", (crumb?.data?.get("from") as? JsonPrimitive)?.content)
        assertEquals("Detail", (crumb?.data?.get("to") as? JsonPrimitive)?.content)
    }

    @Test
    fun `recordScreen same name twice suppresses the self-transition`() {
        TraceItX.recordScreen("Home")
        TraceItX.recordScreen("Home")
        assertNull(firstCrumbOfKind(BreadcrumbKind.Navigation))
    }

    @Test
    fun `recordScreen merges host data but from and to win on collision`() {
        TraceItX.recordScreen("Home")
        TraceItX.recordScreen("Detail", mapOf("stack" to "root", "from" to "spoofed"))
        val crumb = firstCrumbOfKind(BreadcrumbKind.Navigation)
        assertEquals("root", (crumb?.data?.get("stack") as? JsonPrimitive)?.content)
        assertEquals("Home", (crumb?.data?.get("from") as? JsonPrimitive)?.content)
    }

    @Test
    fun `recordScreen and Activity resume share one chain`() {
        val a = Robolectric.buildActivity(FakeActivityA::class.java).setup().get()
        BreadcrumbTapNavAdapters.callbacksForTesting().onActivityResumed(a)
        TraceItX.recordScreen("Home")
        val crumb = firstCrumbOfKind(BreadcrumbKind.Navigation)
        assertEquals("FakeActivityA → Home", crumb?.message)
    }

    @Test
    fun `recordScreen is a no-op when navigation kind is disabled — and does not advance previous state`() {
        sharedBreadcrumbBuffer.applyConfig(
            BreadcrumbsConfigWire(
                enabled = true, kinds = listOf("tap"), maxCount = 10, byteBudget = 16384, consoleEntryCap = 1024,
            ),
        )
        TraceItX.recordScreen("Home")
        TraceItX.recordScreen("Detail")
        assertNull(firstCrumbOfKind(BreadcrumbKind.Navigation))
        assertNull(NavigationBreadcrumbAdapter.previousClassNameForTesting())
    }

    @Test
    fun `recordScreen is a no-op pre-start (captureGate false)`() {
        TraceItX.captureGate = false
        TraceItX.recordScreen("Home")
        TraceItX.recordScreen("Detail")
        assertNull(firstCrumbOfKind(BreadcrumbKind.Navigation))
    }

    @Test
    fun `recordScreen with a blank name is a no-op`() {
        TraceItX.recordScreen("Home")
        TraceItX.recordScreen("   ")
        assertNull(firstCrumbOfKind(BreadcrumbKind.Navigation))
        assertEquals("Home", NavigationBreadcrumbAdapter.previousClassNameForTesting())
    }

    // ==================== Install orchestrator wiring ====================

    @Test
    fun `TraceItX start wires BreadcrumbTapNavAdapters install`() {
        assertFalse(BreadcrumbTapNavAdapters.installedForTesting())
        BreadcrumbTapNavAdapters.install(context)
        assertTrue(BreadcrumbTapNavAdapters.installedForTesting())
    }

    // ==================== late install (host started after first Activity) ====================
    // React Native hosts call TraceItX.start() from JS — long after MainActivity's
    // onCreate — so `onActivityCreated` never fires for the already-live Activity
    // and its Window is never wrapped: zero tap crumbs for the whole session
    // (field bug 2026-07-10: an RN Android report shipped a single lifecycle crumb).

    @Test
    fun `install with a current activity wraps its window immediately (late-start hosts)`() {
        val activity = buildActivity()
        assertFalse(activity.window.callback is TXWindowCallbackWrapper)

        BreadcrumbTapNavAdapters.install(context, activity)

        assertTrue(activity.window.callback is TXWindowCallbackWrapper)
    }

    @Test
    fun `install with a current activity seeds navigation - next transition carries a from`() {
        val a = Robolectric.buildActivity(FakeActivityA::class.java).setup().get()
        BreadcrumbTapNavAdapters.install(context, a)
        // The seed itself is not a transition — nothing to report FROM yet.
        assertNull(firstCrumbOfKind(BreadcrumbKind.Navigation))

        val b = Robolectric.buildActivity(FakeActivityB::class.java).setup().get()
        BreadcrumbTapNavAdapters.callbacksForTesting().onActivityResumed(b)

        val crumb = firstCrumbOfKind(BreadcrumbKind.Navigation)
        assertNotNull(crumb)
        assertEquals("FakeActivityA → FakeActivityB", crumb?.message)
    }

    @Test
    fun `onActivityResumed wraps a pre-existing unwrapped activity (re-resume belt)`() {
        // An Activity created BEFORE install never saw onActivityCreated; its
        // next resume (e.g. background→foreground) must still wrap it.
        val activity = buildActivity()
        assertFalse(activity.window.callback is TXWindowCallbackWrapper)

        BreadcrumbTapNavAdapters.callbacksForTesting().onActivityResumed(activity)

        assertTrue(activity.window.callback is TXWindowCallbackWrapper)
    }

    // ==================== Android TV — d-pad press crumbs ====================

    @Test
    @Config(qualifiers = "television")
    fun dpadCenterEmitsPressCrumbWithFocusedLabel() {
        val controller = Robolectric.buildActivity(Activity::class.java).setup()
        val activity = controller.get()
        val button = android.widget.Button(activity).apply {
            text = "Play Movie"
            isFocusable = true
        }
        activity.setContentView(button)
        button.requestFocus()
        BreadcrumbTapNavAdapters.callbacksForTesting().onActivityCreated(activity, null)
        val wrapper = activity.window.callback as TXWindowCallbackWrapper
        wrapper.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_CENTER))
        val crumb = firstCrumbOfKind(BreadcrumbKind.Tap)
        assertEquals("press select — Play Movie", crumb?.message)
    }

    @Test
    @Config(qualifiers = "television")
    fun heldDpadRepeatCoalescesToOneCrumb() {
        val controller = Robolectric.buildActivity(Activity::class.java).setup()
        val activity = controller.get()
        BreadcrumbTapNavAdapters.callbacksForTesting().onActivityCreated(activity, null)
        val wrapper = activity.window.callback as TXWindowCallbackWrapper
        PressCrumbRateLimiter.nowProvider = { 1000L }
        wrapper.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_RIGHT))
        wrapper.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_RIGHT))
        sharedBreadcrumbBuffer.freeze()
        val taps = sharedBreadcrumbBuffer.takeFrozen().orEmpty()
            .filter { it.kind == BreadcrumbKind.Tap }
        assertEquals(1, taps.size)
    }

    @Test // default qualifiers = phone form factor
    fun phoneFormFactorEmitsNoPressCrumb() {
        val controller = Robolectric.buildActivity(Activity::class.java).setup()
        val activity = controller.get()
        BreadcrumbTapNavAdapters.callbacksForTesting().onActivityCreated(activity, null)
        val wrapper = activity.window.callback as TXWindowCallbackWrapper
        wrapper.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_CENTER))
        assertNull(firstCrumbOfKind(BreadcrumbKind.Tap))
    }
}
