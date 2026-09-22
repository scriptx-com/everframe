// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Task 12 (Kotlin mirror of iOS Task 8 —
// packages/sdk-ios/Sources/TraceItX/Capture/BreadcrumbTapNavAdapters.swift)
// — converts Activity-level tap + navigation events into `.tap` /
// `.navigation` breadcrumbs.
//
// Mechanism (deliberately NOT a UIKit-style swizzle — Android has no ObjC
// runtime): `Application.ActivityLifecycleCallbacks` gives a framework-native
// hook into every Activity's lifecycle without any bytecode rewriting.
//   • Tap: `onActivityCreated` wraps `activity.window.callback` in
//     [TXWindowCallbackWrapper], a delegating `Window.Callback` that
//     intercepts `dispatchTouchEvent`'s `ACTION_UP` to hit-test the decor
//     view, then ALWAYS calls through to the original callback (see the
//     class doc for the anti-bricking contract).
//   • Navigation: `onActivityResumed` emits "<prev> → <this>" using Activity
//     class SIMPLE NAMES only (never titles — PII), tracking the previous
//     Activity across the process.
//
// Fragment-level navigation — DEFERRED GAP (documented, not a silent
// omission): `androidx.fragment` is NOT a dependency of `traceitx-core`
// (verified against build.gradle.kts before writing this file — no
// `implementation`/`compileOnly` entry for `androidx.fragment:fragment*`,
// and no transitive dependency brings its types onto this module's compile
// classpath either — `androidx.lifecycle.process`/`androidx.lifecycle.common`
// do not depend on fragment). `FragmentManager.FragmentLifecycleCallbacks`
// is an ABSTRACT CLASS, not an interface, so unlike the Window.Callback
// wrapper above it cannot be implemented via `java.lang.reflect.Proxy`
// (Proxy only synthesizes interfaces) — a reflection-only, dependency-free
// fragment adapter is not mechanically possible here, only a real subclass
// compiled against the real type would work, which requires the dependency.
// Per the plan's pre-approved fallback, this file therefore implements
// ACTIVITY-LEVEL navigation only and stops there; fragment-level nav is a
// known gap, analogous to iOS's documented SwiftUI-navigation gap (see the
// iOS twin's file header).
// Hosts that need fragment-level breadcrumbs call `TraceItX.recordScreen(name)`
// from their own `FragmentManager.FragmentLifecycleCallbacks` (host-owned,
// since the host app itself DOES depend on androidx.fragment in virtually
// all real apps) — first-class since the 2026-07-14 screen-markers spec:
// it feeds the same from→to chain as the Activity-level auto-capture below.
//
// Never crash the host: [TXWindowCallbackWrapper] delegates EVERY method
// unconditionally — the crumb-derivation logic in `dispatchTouchEvent` is
// wrapped in `txGuardVoid` so a failure there can never prevent
// `delegate.dispatchTouchEvent(event)` from running (a broken Window.Callback
// bricks the Activity: no input, no menus, no back button). Adapter bodies
// (`TapBreadcrumbAdapter.recordTap`, `NavigationBreadcrumbAdapter.recordResume`)
// are similarly guarded. Install is idempotent both at the SDK-wide level
// (`BreadcrumbTapNavAdapters.install` — AtomicBoolean, mirrors Task 11) and
// per-window (`installWindowCallbackWrapper` checks `current is
// TXWindowCallbackWrapper` before wrapping, so re-entrant `onActivityCreated`
// calls can never stack two wrappers on the same Window).
package com.traceitx.capture

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.ActionMode
import android.view.KeyEvent
import android.view.KeyboardShortcutGroup
import android.view.Menu
import android.view.MenuItem
import android.view.MotionEvent
import android.view.SearchEvent
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.widget.TextView
import androidx.annotation.VisibleForTesting
import com.traceitx.envelope.txGuardVoid
import com.traceitx.protocol.generated.BreadcrumbKind
import kotlinx.serialization.json.JsonObject
import java.util.concurrent.atomic.AtomicBoolean

/** Same-button repeat suppression for remote-press crumbs (parity with the
 *  iOS PressCrumbRateLimiter): one crumb per 300 ms per button, so a held
 *  d-pad edge can't flood the 100-entry ring. */
internal object PressCrumbRateLimiter {
    private const val WINDOW_MS = 300L
    private var lastButton: String? = null
    private var lastAtMs: Long = Long.MIN_VALUE

    @VisibleForTesting
    internal var nowProvider: () -> Long = { android.os.SystemClock.uptimeMillis() }

    @Synchronized
    fun shouldRecord(button: String): Boolean {
        val now = nowProvider()
        if (button == lastButton && now - lastAtMs < WINDOW_MS) return false
        lastButton = button
        lastAtMs = now
        return true
    }

    @Synchronized
    fun __resetForTesting() {
        lastButton = null
        lastAtMs = Long.MIN_VALUE
        nowProvider = { android.os.SystemClock.uptimeMillis() }
    }
}

// ---------------- Tap (kind: .tap) ----------------

/**
 * Derives + records `.tap` crumbs from a hit-tested [View]. Called from
 * [TXWindowCallbackWrapper.dispatchTouchEvent] on `ACTION_UP`, AFTER the
 * clicked view has already been located by [findViewAt].
 */
internal object TapBreadcrumbAdapter {

    /** Message-label UTF-16-unit cap — mirrors `BreadcrumbRingBuffer`'s own
     *  capping convention (Kotlin's String is already UTF-16-native, so
     *  `.length`/`.substring` operate on code units directly). */
    private const val labelMaxChars: Int = 48

    /**
     * Gated + guarded entry point. `isKindEnabled` is a hot-path
     * optimization (skip label derivation entirely when `.tap` is off);
     * `sharedBreadcrumbBuffer.add` re-gates for correctness.
     */
    fun recordTap(view: View) {
        txGuardVoid("TapBreadcrumbAdapter.recordTap") {
            if (!sharedBreadcrumbBuffer.isKindEnabled(BreadcrumbKind.Tap)) return@txGuardVoid
            val (label, data) = deriveLabelAndData(view)
            sharedBreadcrumbBuffer.add(kind = BreadcrumbKind.Tap, message = "tap $label", data = data)
        }
    }

    private val REMOTE_KEY_NAMES = mapOf(
        KeyEvent.KEYCODE_DPAD_UP to "up",
        KeyEvent.KEYCODE_DPAD_DOWN to "down",
        KeyEvent.KEYCODE_DPAD_LEFT to "left",
        KeyEvent.KEYCODE_DPAD_RIGHT to "right",
        KeyEvent.KEYCODE_DPAD_CENTER to "select",
        KeyEvent.KEYCODE_ENTER to "select",
        KeyEvent.KEYCODE_BACK to "back",
        KeyEvent.KEYCODE_MENU to "menu",
        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE to "playPause",
    )

    /** Android-TV remote-press crumb — same `.Tap` kind as touch crumbs,
     *  tagged `inputType: remote` (spec 2026-07-17 §1). No dedup guard is
     *  needed against `recordTap`: `recordTap` is only ever invoked from
     *  [TXWindowCallbackWrapper.dispatchTouchEvent]'s `MotionEvent`
     *  `ACTION_UP` branch, and a `KEYCODE_DPAD_CENTER`/`ENTER` press never
     *  synthesizes a `MotionEvent` or otherwise reaches `dispatchTouchEvent`
     *  — a focused View's own key-driven `performClick()` (from
     *  `View.onKeyUp`) is a separate call chain that does not pass through
     *  `Window.Callback` at all. So a single remote select-press can never
     *  double-record here the way iOS's sendAction + press crumb did. */
    fun recordRemotePress(keyCode: Int, focused: View?) {
        if (!sharedBreadcrumbBuffer.isKindEnabled(BreadcrumbKind.Tap)) return
        val button = REMOTE_KEY_NAMES[keyCode] ?: return
        if (!PressCrumbRateLimiter.shouldRecord(button)) return
        val label = focused?.let { deriveLabelAndData(it).first } ?: "screen"
        val dict = LinkedHashMap<String, Any?>()
        dict["inputType"] = "remote"
        dict["button"] = button
        if (focused != null) dict["view"] = focused.javaClass.simpleName
        sharedBreadcrumbBuffer.add(
            kind = BreadcrumbKind.Tap,
            message = "press $button — $label",
            data = BreadcrumbRingBuffer.coerceHostData(dict),
        )
    }

    /**
     * Pure-ish derivation (only reads View state, never mutates) — its own
     * testable unit rather than inlined into [recordTap].
     *
     * Masked-aware precedence: the clicked view OR any ancestor sensitive
     * (per [SensitiveRectRegistry.isSensitive], walked here since that
     * function itself only inspects the single view passed to it) → label
     * `"[masked]"`, data `{view, masked:true}`, NO text read at all. Else:
     * `contentDescription` → button/text-view text (≤48 UTF-16 units) →
     * resource-id entry name → class simple name.
     */
    internal fun deriveLabelAndData(view: View): Pair<String, JsonObject> {
        val className = view.javaClass.simpleName
        if (isSensitiveOrAncestorSensitive(view)) {
            return "[masked]" to BreadcrumbRingBuffer.coerceHostData(
                mapOf("view" to className, "masked" to true),
            )
        }

        val resourceId = resourceEntryName(view)
        val dict = LinkedHashMap<String, Any?>()
        dict["view"] = className
        if (resourceId != null) dict["id"] = resourceId

        val label =
            nonEmpty(view.contentDescription?.toString())
                ?: nonEmpty((view as? TextView)?.text?.toString())?.let { capChars(it, labelMaxChars) }
                ?: resourceId
                ?: className
        return label to BreadcrumbRingBuffer.coerceHostData(dict)
    }

    /**
     * Walks [view] then every `.parent` up to the root, per the "clicked
     * view OR an ancestor is sensitive" rule.
     */
    private fun isSensitiveOrAncestorSensitive(view: View): Boolean {
        var current: View? = view
        while (current != null) {
            if (SensitiveRectRegistry.isSensitive(current)) return true
            current = current.parent as? View
        }
        return false
    }

    private fun resourceEntryName(view: View): String? {
        if (view.id == View.NO_ID) return null
        return try {
            view.resources?.getResourceEntryName(view.id)
        } catch (_: Throwable) {
            null
        }
    }

    private fun nonEmpty(s: String?): String? {
        if (s.isNullOrEmpty()) return null
        return s
    }

    private fun capChars(s: String, n: Int): String = if (s.length > n) s.substring(0, n) else s

    /**
     * Recursive hit-test over the decor view — the standard hit-test
     * convention (rect-contains + reverse child order for z-order:
     * the LAST child is drawn on top, so it is tested first). [x]/[y] are in
     * [root]'s own local coordinate space (0,0 = root's top-left); each
     * descent translates into the child's local space via `child.left` /
     * `child.top`, PLUS [root]'s own `scrollX`/`scrollY` — mirrors Android's
     * own `ViewGroup.dispatchTouchEvent` translation (`localX = x + mScrollX
     * - child.mLeft`): a scrolled container (e.g. `ScrollView`,
     * `NestedScrollView`, `RecyclerView`) offsets its children's on-screen
     * position by its scroll amount, so the scroll offset must be ADDED back
     * before subtracting the child's layout position, or descent lands on
     * the wrong child — see this file's tests for why that's a masking
     * bypass, not just a mislabeled tap. Returns the deepest (most specific)
     * View under the point, or [root] itself if no child matches but the
     * point is still within [root]'s bounds; `null` if the point is outside
     * [root] entirely or [root] is not visible.
     */
    internal fun findViewAt(root: View, x: Float, y: Float): View? {
        if (root.visibility != View.VISIBLE) return null
        if (x < 0f || y < 0f || x > root.width || y > root.height) return null
        if (root is ViewGroup) {
            for (i in root.childCount - 1 downTo 0) {
                val child = root.getChildAt(i)
                if (child.visibility != View.VISIBLE) continue
                val childX = x - child.left + root.scrollX
                val childY = y - child.top + root.scrollY
                val hit = findViewAt(child, childX, childY)
                if (hit != null) return hit
            }
        }
        return root
    }
}

// ---------------- Navigation (kind: .navigation) ----------------

/**
 * Bridges TWO entry points into `.navigation` crumbs, sharing one global
 * from→to chain: `Application.ActivityLifecycleCallbacks.onActivityResumed`
 * ([recordResume], Activity-level auto-capture — see the file header for the
 * fragment-level deferred-gap decision), and `TraceItX.recordScreen`
 * ([recordTransition] directly, the framework-agnostic screen marker used by
 * Compose/RN/manual callers — spec 2026-07-14).
 */
internal object NavigationBreadcrumbAdapter {

    /** Serializes the previous→next read-modify-write. Historically this was
     *  implicitly main-thread-only (`onActivityResumed`); `recordScreen` is
     *  callable from any thread (Compose effect, RN bridge thread), so the
     *  transition is now explicitly locked. */
    private val transitionLock = Any()

    /** The most recently seen screen name — the "from" half of the NEXT
     *  transition. `null` until the first screen this process has ever seen.
     *
     *  Previous-screen tracking is deliberately GLOBAL and chronological —
     *  the trail answers "what screen did the user go from/to", so a tab
     *  switch correctly reads TabA → TabB; per-stack scoping would hide it.
     *  (Spec 2026-07-08 ruling.) Shared by BOTH entry points (Activity
     *  resume + recordScreen) so a mixed app reads as one coherent chain. */
    @Volatile
    private var previousClassName: String? = null

    /** Test-only reset seam. */
    @VisibleForTesting
    internal fun __resetForTesting() {
        previousClassName = null
    }

    /** Test-only accessor. */
    @VisibleForTesting
    internal fun previousClassNameForTesting(): String? = previousClassName

    /** Activity-level entry point — `onActivityResumed`. */
    fun recordResume(activity: Activity) {
        recordTransition(activity.javaClass.simpleName)
    }

    /**
     * The single transition core (spec 2026-07-14 — screen markers). Owns:
     * kind-gating (BEFORE state update, matching historical `recordResume`
     * behavior), the global previous-screen state, the `A → A`
     * self-transition suppression (also absorbs Compose recomposition /
     * React StrictMode double-emits from the marker path), and crumb
     * emission. `from`/`to` win over [hostData] keys on collision.
     */
    fun recordTransition(toName: String, hostData: Map<String, Any?>? = null) {
        txGuardVoid("NavigationBreadcrumbAdapter.recordTransition") {
            if (!sharedBreadcrumbBuffer.isKindEnabled(BreadcrumbKind.Navigation)) return@txGuardVoid
            val fromName = synchronized(transitionLock) {
                val f = previousClassName
                previousClassName = toName
                f
            }
            // No "from" yet (first screen this process has seen) — nothing
            // to report a transition FROM.
            if (fromName == null) return@txGuardVoid
            // Same screen re-appearing (background→foreground, refocus,
            // recomposition) is not a navigation — suppress "A → A".
            if (fromName == toName) return@txGuardVoid
            val dict = LinkedHashMap<String, Any?>()
            if (hostData != null) dict.putAll(hostData)
            dict["from"] = fromName
            dict["to"] = toName
            sharedBreadcrumbBuffer.add(
                kind = BreadcrumbKind.Navigation,
                message = "$fromName → $toName",
                data = BreadcrumbRingBuffer.coerceHostData(dict),
            )
        }
    }
}

// ---------------- Window.Callback wrapper ----------------

/**
 * Delegating `Window.Callback` — wraps [delegate] (the Activity's own
 * `Window.Callback`, normally the Activity itself) and intercepts ONLY
 * `dispatchTouchEvent`'s `ACTION_UP` to emit a `.tap` crumb. EVERY other
 * method (and even `dispatchTouchEvent` itself, on the return path) is a
 * verbatim pass-through — a broken/incomplete `Window.Callback` bricks the
 * host Activity (no input, no menus, no back button), so this class is the
 * single most safety-critical piece of this file. The crumb logic is scoped
 * to a `txGuardVoid` block that runs BEFORE the delegate call, so a failure
 * there can never prevent `delegate.dispatchTouchEvent(event)` from running.
 */
internal class TXWindowCallbackWrapper(
    @VisibleForTesting internal val delegate: Window.Callback,
    private val activity: Activity,
) : Window.Callback {

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (event.action == MotionEvent.ACTION_UP) {
            txGuardVoid("TXWindowCallbackWrapper.dispatchTouchEvent") {
                val decor = activity.window?.decorView
                if (decor != null) {
                    val hit = TapBreadcrumbAdapter.findViewAt(decor, event.x, event.y)
                    if (hit != null) TapBreadcrumbAdapter.recordTap(hit)
                }
            }
        }
        return delegate.dispatchTouchEvent(event)
    }

    // TV form factor only (same signals as DeviceMetadata.isTv,
    // DeviceMetadata.kt:39-40): on phones dispatchKeyEvent also carries
    // hardware-keyboard traffic, which is noise, not navigation.
    //
    // NOTE: an earlier draft of this check used
    // `UiModeManager.currentModeType`, mirroring a task-brief snippet — but
    // that shadow is never populated by Robolectric's
    // `@Config(qualifiers = "television")` (verified: `currentModeType`
    // reads back `0`/UI_MODE_TYPE_NORMAL even under the "television"
    // qualifier, and `hasSystemFeature(FEATURE_LEANBACK)` is also `false`
    // there — only `Configuration.uiMode` reflects the qualifier). Using
    // `Configuration.uiMode` directly, exactly as DeviceMetadata.kt does,
    // is both test-observable AND the actual documented signal source.
    private val isTvHost: Boolean by lazy {
        val cfg = activity.resources.configuration
        activity.packageManager.hasSystemFeature(
            android.content.pm.PackageManager.FEATURE_LEANBACK) ||
            (cfg.uiMode and android.content.res.Configuration.UI_MODE_TYPE_MASK) ==
                android.content.res.Configuration.UI_MODE_TYPE_TELEVISION
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_UP && isTvHost) {
            txGuardVoid("TXWindowCallbackWrapper.dispatchKeyEvent") {
                TapBreadcrumbAdapter.recordRemotePress(
                    event.keyCode, activity.window?.currentFocus)
            }
        }
        return delegate.dispatchKeyEvent(event)
    }

    override fun dispatchKeyShortcutEvent(event: KeyEvent): Boolean = delegate.dispatchKeyShortcutEvent(event)

    override fun dispatchTrackballEvent(event: MotionEvent): Boolean = delegate.dispatchTrackballEvent(event)

    override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean =
        delegate.dispatchGenericMotionEvent(event)

    override fun dispatchPopulateAccessibilityEvent(event: AccessibilityEvent): Boolean =
        delegate.dispatchPopulateAccessibilityEvent(event)

    override fun onCreatePanelView(featureId: Int): View? = delegate.onCreatePanelView(featureId)

    override fun onCreatePanelMenu(featureId: Int, menu: Menu): Boolean =
        delegate.onCreatePanelMenu(featureId, menu)

    override fun onPreparePanel(featureId: Int, view: View?, menu: Menu): Boolean =
        delegate.onPreparePanel(featureId, view, menu)

    override fun onMenuOpened(featureId: Int, menu: Menu): Boolean = delegate.onMenuOpened(featureId, menu)

    override fun onMenuItemSelected(featureId: Int, item: MenuItem): Boolean =
        delegate.onMenuItemSelected(featureId, item)

    override fun onWindowAttributesChanged(attrs: WindowManager.LayoutParams?) {
        delegate.onWindowAttributesChanged(attrs)
    }

    override fun onContentChanged() {
        delegate.onContentChanged()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        delegate.onWindowFocusChanged(hasFocus)
    }

    override fun onAttachedToWindow() {
        delegate.onAttachedToWindow()
    }

    override fun onDetachedFromWindow() {
        delegate.onDetachedFromWindow()
    }

    override fun onPanelClosed(featureId: Int, menu: Menu) {
        delegate.onPanelClosed(featureId, menu)
    }

    override fun onSearchRequested(): Boolean = delegate.onSearchRequested()

    override fun onSearchRequested(searchEvent: SearchEvent?): Boolean = delegate.onSearchRequested(searchEvent)

    override fun onWindowStartingActionMode(callback: ActionMode.Callback?): ActionMode? =
        delegate.onWindowStartingActionMode(callback)

    override fun onWindowStartingActionMode(callback: ActionMode.Callback?, type: Int): ActionMode? =
        delegate.onWindowStartingActionMode(callback, type)

    override fun onActionModeStarted(mode: ActionMode) {
        delegate.onActionModeStarted(mode)
    }

    override fun onActionModeFinished(mode: ActionMode) {
        delegate.onActionModeFinished(mode)
    }

    override fun onProvideKeyboardShortcuts(
        data: MutableList<KeyboardShortcutGroup>?,
        menu: Menu?,
        deviceId: Int,
    ) {
        delegate.onProvideKeyboardShortcuts(data, menu, deviceId)
    }

    override fun onPointerCaptureChanged(hasCapture: Boolean) {
        delegate.onPointerCaptureChanged(hasCapture)
    }
}

// ---------------- Activity lifecycle callbacks ----------------

/**
 * The single [Application.ActivityLifecycleCallbacks] registered by
 * [BreadcrumbTapNavAdapters.install]. Every method body is wrapped in
 * `txGuardVoid` — a failure here must never propagate into the host's
 * Activity lifecycle dispatch.
 */
internal class TapNavActivityLifecycleCallbacks : Application.ActivityLifecycleCallbacks {

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
        txGuardVoid("TapNavActivityLifecycleCallbacks.onActivityCreated") {
            installWindowCallbackWrapper(activity)
        }
    }

    override fun onActivityResumed(activity: Activity) {
        txGuardVoid("TapNavActivityLifecycleCallbacks.onActivityResumed") {
            // Belt for late installs: an Activity created BEFORE install never
            // saw onActivityCreated — wrap on its next resume (per-window
            // idempotent, so already-wrapped windows are untouched).
            installWindowCallbackWrapper(activity)
            NavigationBreadcrumbAdapter.recordResume(activity)
        }
    }

    override fun onActivityStarted(activity: Activity) {}
    override fun onActivityPaused(activity: Activity) {}
    override fun onActivityStopped(activity: Activity) {}
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
    override fun onActivityDestroyed(activity: Activity) {}

    /**
     * Wraps `activity.window.callback` in [TXWindowCallbackWrapper] exactly
     * once per Window. If the current callback is ALREADY a
     * [TXWindowCallbackWrapper] (re-entrant `onActivityCreated`, or a second
     * SDK-wide install racing this Activity), this is a no-op — prevents
     * stacking two wrappers on the same Window, which would double-fire tap
     * crumbs per real touch.
     */
    internal fun installWindowCallbackWrapper(activity: Activity) {
        val window = activity.window ?: return
        val current = window.callback ?: return
        if (current is TXWindowCallbackWrapper) return
        window.callback = TXWindowCallbackWrapper(current, activity)
    }
}

// ---------------- Install orchestrator ----------------

internal object BreadcrumbTapNavAdapters {

    private val installed = AtomicBoolean(false)

    /** Held across the process lifetime once installed — same single-instance
     *  idiom as Task 11's `LifecycleBreadcrumbObserver` object. */
    private val callbacks = TapNavActivityLifecycleCallbacks()

    /** Test-only flag. */
    @VisibleForTesting
    internal fun installedForTesting(): Boolean = installed.get()

    /** Test-only accessor — lets tests drive `onActivityCreated` /
     *  `onActivityResumed` directly without a live `Application` registration. */
    @VisibleForTesting
    internal fun callbacksForTesting(): Application.ActivityLifecycleCallbacks = callbacks

    /**
     * Wired from `TraceItX.start(context, config)` after the kill-gate is
     * set, alongside `BreadcrumbAdapters.install()` (Task 11). Install-once
     * — a second call (even from a second `start()`) is a no-op, so
     * `registerActivityLifecycleCallbacks` is never called twice for the
     * same `callbacks` instance (which would otherwise wrap every Window
     * twice → two `TXWindowCallbackWrapper`s → two tap crumbs per touch).
     *
     * Resolves `applicationContext as? Application` BEFORE flipping the
     * install-once flag: if the cast ever fails (non-`Application` host
     * context), `installed` is left `false` so a later `install()` call with
     * a valid `Application` context can still succeed, instead of the
     * adapter permanently self-disabling on a transient bad-context call.
     */
    fun install(context: Context, currentActivity: Activity? = null) {
        val app = context.applicationContext as? Application ?: return
        if (installed.compareAndSet(false, true)) {
            app.registerActivityLifecycleCallbacks(callbacks)
        }
        // Late-start hosts (React Native: `TraceItX.start()` runs from JS long
        // after MainActivity's onCreate) never get an `onActivityCreated` for
        // the already-live Activity — without this, its Window is never
        // wrapped and the session ships ZERO tap crumbs (field bug
        // 2026-07-10). Wrap it now (per-window idempotent) and seed the
        // navigation "from" state so the first real transition reads
        // "MainActivity → Next" instead of being silently dropped.
        if (currentActivity != null) {
            // Window.callback mutation belongs on the main thread (the
            // onActivityCreated path always runs there); install() itself is
            // called from the IO-dispatched heavy-init coroutine.
            val wrap = Runnable {
                txGuardVoid("BreadcrumbTapNavAdapters.installCurrentActivity") {
                    callbacks.installWindowCallbackWrapper(currentActivity)
                    NavigationBreadcrumbAdapter.recordResume(currentActivity)
                }
            }
            if (Looper.myLooper() == Looper.getMainLooper()) {
                wrap.run()
            } else {
                Handler(Looper.getMainLooper()).post(wrap)
            }
        }
    }

    /** Test-only reset seam. Does NOT unregister `callbacks` from any live
     *  `Application` (tests drive the callbacks object directly — see
     *  [callbacksForTesting] — rather than relying on a real registration). */
    @VisibleForTesting
    internal fun __resetForTesting() {
        installed.set(false)
        NavigationBreadcrumbAdapter.__resetForTesting()
    }
}
