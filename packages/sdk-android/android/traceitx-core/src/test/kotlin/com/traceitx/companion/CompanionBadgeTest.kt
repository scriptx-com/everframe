// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Task 6 — CompanionBadge unit tests. Covers the contracts this widget owns:
// attach on a naming state transition, detach on loss, the disabled-host
// opt-out, label composition (incl. the empty-label case), the sub-window
// mechanics (TYPE_APPLICATION_PANEL + not-focusable/not-touchable flags +
// gravity/margins per corner), and the hide-races-a-queued-attach threading
// contract inherited from the removed `CompanionSharingIndicator`.
//
// `Dispatchers.setMain(mainDispatcher)` + `runTest(mainDispatcher)` mirrors
// `CompanionPreviewSessionTest`'s documented pattern: `CompanionBadge`'s
// default `scope` is `CoroutineScope(Dispatchers.Main + SupervisorJob())`,
// and a bare `runTest { }` would drive a DIFFERENT `TestCoroutineScheduler`
// unless `Dispatchers.Main` is pointed at the same instance first.
package com.traceitx.companion

import android.app.Activity
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows
import org.robolectric.annotation.Config
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowWindowManagerImpl

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class CompanionBadgeTest {

    private val mainDispatcher = StandardTestDispatcher()

    @Before
    fun setUp() {
        Dispatchers.setMain(mainDispatcher)
        resetCompanionState()
        CompanionBadge.__activityProvider = null
        CompanionBadgeServerConfigSignal.resetForTesting()
    }

    @After
    fun tearDown() {
        resetCompanionState()
        CompanionBadge.__activityProvider = null
        CompanionBadgeServerConfigSignal.resetForTesting()
        Dispatchers.resetMain()
        // `ShadowWindowManagerImpl`'s tracked-view registry is a Multimap
        // keyed by DISPLAY id, not per-Activity/per-WindowManager-instance —
        // so a view a test failed to remove (e.g. an assertion throwing
        // before that test's own `badge.teardown()` line runs) survives into
        // the NEXT test's `viewsOn(...)` count instead of resetting with a
        // fresh Activity. Force it clean unconditionally so one test's
        // assertion failure can't poison another's "before" baseline.
        ShadowWindowManagerImpl.reset()
    }

    private fun resetCompanionState() {
        com.traceitx.companion.Companion.__setAttachedUserName(null)
        com.traceitx.companion.Companion.__setResolvedName(null)
        com.traceitx.companion.Companion.__setCode(null)
    }

    private fun activity(): Activity = Robolectric.buildActivity(Activity::class.java).setup().get()

    private fun viewsOn(activity: Activity): List<View> =
        Shadow.extract<ShadowWindowManagerImpl>(activity.windowManager).views

    /**
     * [viewsOn], filtered to sub-windows of our own `TYPE_APPLICATION_PANEL`
     * type. `ShadowWindowManagerImpl`'s tracked-view registry includes an
     * Activity's own top-level window alongside anything a test attaches, and
     * — being keyed by DISPLAY id, not per-Activity — is the SAME query
     * result for every Activity sharing Robolectric's default display. This
     * isolates "views the badge itself put there" from both kinds of noise.
     */
    private fun badgeViewsOn(activity: Activity): List<View> =
        viewsOn(activity).filter {
            (it.layoutParams as? WindowManager.LayoutParams)?.type == WindowManager.LayoutParams.TYPE_APPLICATION_PANEL
        }

    // ---------------------------------------------------------------------
    // Label composition (pure — no Activity involved)
    // ---------------------------------------------------------------------

    @Test
    fun `label composition joins resolvedName and code with a middle dot`() {
        assertEquals("Aurimas · LMN-421", CompanionBadgeLabel.compose("Aurimas", "LMN-421"))
    }

    @Test
    fun `label composition with only resolvedName omits the separator`() {
        assertEquals("Aurimas", CompanionBadgeLabel.compose("Aurimas", null))
    }

    @Test
    fun `label composition with only code omits the separator`() {
        assertEquals("LMN-421", CompanionBadgeLabel.compose(null, "LMN-421"))
    }

    @Test
    fun `label composition with neither is empty`() {
        assertEquals("", CompanionBadgeLabel.compose(null, null))
    }

    // ---------------------------------------------------------------------
    // Attach / detach via WindowManager
    // ---------------------------------------------------------------------

    @Test
    fun `attach adds exactly one view via WindowManager with sub-window type and inert flags`() = runTest(mainDispatcher) {
        val act = activity()
        CompanionBadge.__activityProvider = { act }
        val before = viewsOn(act).size
        val badge = CompanionBadge()

        com.traceitx.companion.Companion.__setAttachedUserName("Aurimas")
        com.traceitx.companion.Companion.__setResolvedName("Lobby TV")
        advanceUntilIdle()

        assertTrue("badge must report visible once attached", badge.isVisible)
        val views = viewsOn(act)
        assertEquals("exactly one view must be added", before + 1, views.size)

        val added = views.last()
        assertFalse("badge must not be clickable", added.isClickable)
        assertFalse("badge must not be focusable", added.isFocusable)

        val params = added.layoutParams as WindowManager.LayoutParams
        assertEquals(
            "must be a sub-window bound to the host's own token, never an overlay needing SYSTEM_ALERT_WINDOW",
            WindowManager.LayoutParams.TYPE_APPLICATION_PANEL,
            params.type,
        )
        assertTrue(
            "must be FLAG_NOT_FOCUSABLE",
            (params.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE) != 0,
        )
        assertTrue(
            "must be FLAG_NOT_TOUCHABLE",
            (params.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE) != 0,
        )

        badge.teardown()
    }

    @Test
    fun `clearing attachedUserName detaches the view`() = runTest(mainDispatcher) {
        val act = activity()
        CompanionBadge.__activityProvider = { act }
        val badge = CompanionBadge()

        com.traceitx.companion.Companion.__setAttachedUserName("Aurimas")
        com.traceitx.companion.Companion.__setCode("LMN-421")
        advanceUntilIdle()
        assertTrue(badge.isVisible)
        val attachedCount = viewsOn(act).size

        com.traceitx.companion.Companion.__setAttachedUserName(null)
        advanceUntilIdle()

        assertFalse("badge must report hidden once attachedUserName clears", badge.isVisible)
        assertEquals("the view must be removed from the WindowManager", attachedCount - 1, viewsOn(act).size)

        badge.teardown()
    }

    @Test
    fun `an attachedUserName with no resolvedName or code composes an empty label and stays hidden`() = runTest(mainDispatcher) {
        val act = activity()
        CompanionBadge.__activityProvider = { act }
        val before = viewsOn(act).size
        val badge = CompanionBadge()

        com.traceitx.companion.Companion.__setAttachedUserName("Aurimas")
        advanceUntilIdle()

        assertFalse("an empty composed label must never attach", badge.isVisible)
        assertEquals(before, viewsOn(act).size)

        badge.teardown()
    }

    @Test
    fun `disabled options never attach regardless of state`() = runTest(mainDispatcher) {
        val act = activity()
        CompanionBadge.__activityProvider = { act }
        val before = viewsOn(act).size
        val badge = CompanionBadge(options = CompanionBadgeOptions(enabled = false))

        com.traceitx.companion.Companion.__setAttachedUserName("Aurimas")
        com.traceitx.companion.Companion.__setResolvedName("Lobby TV")
        advanceUntilIdle()

        assertFalse("disabled=false with no server override must never attach", badge.isVisible)
        assertEquals(before, viewsOn(act).size)

        badge.teardown()
    }

    @Test
    fun `no activity provider installed is a no-op rather than a crash`() = runTest(mainDispatcher) {
        CompanionBadge.__activityProvider = null
        val badge = CompanionBadge()

        com.traceitx.companion.Companion.__setAttachedUserName("Aurimas")
        com.traceitx.companion.Companion.__setCode("LMN-421")
        advanceUntilIdle() // must not throw

        assertFalse(badge.isVisible)

        badge.teardown()
    }

    @Test
    fun `activity provider returning null is a no-op rather than a crash`() = runTest(mainDispatcher) {
        CompanionBadge.__activityProvider = { null }
        val badge = CompanionBadge()

        com.traceitx.companion.Companion.__setAttachedUserName("Aurimas")
        com.traceitx.companion.Companion.__setCode("LMN-421")
        advanceUntilIdle() // must not throw

        assertFalse(badge.isVisible)

        badge.teardown()
    }

    @Test
    fun `teardown hides and stops reacting to further state changes`() = runTest(mainDispatcher) {
        val act = activity()
        CompanionBadge.__activityProvider = { act }
        val badge = CompanionBadge()

        com.traceitx.companion.Companion.__setAttachedUserName("Aurimas")
        com.traceitx.companion.Companion.__setCode("LMN-421")
        advanceUntilIdle()
        assertTrue(badge.isVisible)

        badge.teardown()
        advanceUntilIdle()
        assertFalse(badge.isVisible)

        val before = viewsOn(act).size
        com.traceitx.companion.Companion.__setAttachedUserName("SomeoneElse")
        advanceUntilIdle()

        assertEquals("teardown must cancel the subscription for good", before, viewsOn(act).size)
    }

    // ---------------------------------------------------------------------
    // Re-anchoring across Activity recreation (task-6 review round 1)
    // ---------------------------------------------------------------------

    @Test
    fun `destroying the host activity resets internal state instead of leaving a stale attach`() = runTest(mainDispatcher) {
        val controller = Robolectric.buildActivity(Activity::class.java).setup()
        val act = controller.get()
        CompanionBadge.__activityProvider = { act }
        val badge = CompanionBadge()

        com.traceitx.companion.Companion.__setAttachedUserName("Aurimas")
        com.traceitx.companion.Companion.__setCode("LMN-421")
        advanceUntilIdle()
        assertTrue(badge.isVisible)
        assertEquals(
            "the badge's sub-window must actually be attached before destroy, or removal below proves nothing",
            1,
            badgeViewsOn(act).size,
        )

        // Real Robolectric teardown — dispatches through the SAME
        // `Application.ActivityLifecycleCallbacks.onActivityDestroyed` a real
        // config-change recreate would, exercising the actual registration,
        // not just the callback's own logic.
        controller.destroy()

        assertFalse(
            "isVisible must not claim a window WindowManagerGlobal already force-removed",
            badge.isVisible,
        )
        assertEquals(
            "a destroyed host must not be retained",
            null,
            badge.hostActivityForTesting(),
        )
        assertEquals(
            "onActivityDestroyed must proactively removeView() from the OLD activity's own " +
                "WindowManager, before WindowManagerGlobal.closeAll() would force-remove it and " +
                "log an error-level \"Activity has leaked window\" against the host",
            0,
            badgeViewsOn(act).size,
        )

        badge.teardown()
    }

    @Test
    fun `switching to a new activity and resuming it re-anchors the badge with the same label`() = runTest(mainDispatcher) {
        val act1 = activity()
        CompanionBadge.__activityProvider = { act1 }
        val badge = CompanionBadge()

        com.traceitx.companion.Companion.__setAttachedUserName("Aurimas")
        com.traceitx.companion.Companion.__setCode("LMN-421")
        advanceUntilIdle()
        assertTrue(badge.isVisible)
        // Filtered to our own sub-window type — see [badgeViewsOn] — so this
        // is robust regardless of whatever else `viewsOn` also tracks (the
        // Activity's own top-level window, in particular).
        val badgeViewsBeforeSwitch = badgeViewsOn(act1)
        assertEquals("exactly our one badge view, nothing else", 1, badgeViewsBeforeSwitch.size)
        val oldView = badgeViewsBeforeSwitch.last()
        val label = (oldView as android.widget.TextView).text.toString()

        // Build the replacement WITHOUT resuming it yet, so the provider can
        // be switched first — exactly the config-change order (old destroyed,
        // new created/started) before the new one becomes foreground.
        val controller2 = Robolectric.buildActivity(Activity::class.java).create().start()
        val act2 = controller2.get()
        CompanionBadge.__activityProvider = { act2 }

        // The re-anchor signal: resuming act2 dispatches
        // `onActivityResumed(act2)` through the SAME registered
        // `Application.ActivityLifecycleCallbacks` act1's earlier attach
        // installed (same Robolectric Application instance for this test).
        controller2.resume()

        val badgeViewsAfterSwitch = badgeViewsOn(act2)
        assertEquals(
            "the old badge view must be removed and the new one attached — never both left behind",
            1,
            badgeViewsAfterSwitch.size,
        )
        assertTrue("the OLD view instance must be gone, not merely covered", oldView !in badgeViewsAfterSwitch)
        assertEquals(
            "the label must carry over unchanged",
            label,
            (badgeViewsAfterSwitch.last() as android.widget.TextView).text.toString(),
        )
        assertEquals(act2, badge.hostActivityForTesting())

        badge.teardown()
    }

    // ---------------------------------------------------------------------
    // Gravity + margins per corner
    // ---------------------------------------------------------------------

    @Test
    fun `bottom-right (default) uses BOTTOM or END gravity`() = runTest(mainDispatcher) {
        assertGravityAndMargins(CompanionBadgePosition.BOTTOM_RIGHT, Gravity.BOTTOM or Gravity.END)
    }

    @Test
    fun `bottom-left uses BOTTOM or START gravity`() = runTest(mainDispatcher) {
        assertGravityAndMargins(CompanionBadgePosition.BOTTOM_LEFT, Gravity.BOTTOM or Gravity.START)
    }

    @Test
    fun `top-right uses TOP or END gravity`() = runTest(mainDispatcher) {
        assertGravityAndMargins(CompanionBadgePosition.TOP_RIGHT, Gravity.TOP or Gravity.END)
    }

    @Test
    fun `top-left uses TOP or START gravity`() = runTest(mainDispatcher) {
        assertGravityAndMargins(CompanionBadgePosition.TOP_LEFT, Gravity.TOP or Gravity.START)
    }

    private suspend fun kotlinx.coroutines.test.TestScope.assertGravityAndMargins(position: CompanionBadgePosition, expectedGravity: Int) {
        val act = activity()
        CompanionBadge.__activityProvider = { act }
        val badge = CompanionBadge(options = CompanionBadgeOptions(position = position))

        com.traceitx.companion.Companion.__setAttachedUserName("Aurimas")
        com.traceitx.companion.Companion.__setCode("LMN-421")
        advanceUntilIdle()

        val params = viewsOn(act).last().layoutParams as WindowManager.LayoutParams
        assertEquals(expectedGravity, params.gravity)
        val density = act.resources.displayMetrics.density
        val expectedMargin = (24 * density).toInt()
        assertEquals("x must carry the 24dp margin", expectedMargin, params.x)
        assertTrue("y must be at least the 24dp margin (plus any system-bar inset)", params.y >= expectedMargin)

        badge.teardown()
    }

    // ---------------------------------------------------------------------
    // Server-config overlay at show time (plan 2026-08-25) — precedence:
    // server field when set (position: when recognized) > inline
    // CompanionBadgeOptions > default. serverConfig is consulted at every
    // apply/show, never captured at construction.
    // ---------------------------------------------------------------------

    @Test
    fun `server enabled=false hides over inline default-on`() = runTest(mainDispatcher) {
        val act = activity()
        CompanionBadge.__activityProvider = { act }
        val badge = CompanionBadge(
            options = CompanionBadgeOptions(),
            serverConfig = { com.traceitx.config.CompanionBadgeConfigWire(enabled = false) },
        )
        // Drain init's own initial (null-state) combine emission BEFORE the
        // direct applyForTesting call below, so it can't fire again — and
        // override our call's result — on a later advanceUntilIdle().
        advanceUntilIdle()

        badge.applyForTesting("member", "TV", "AB12")

        assertFalse("server enabled=false must hide even though the inline default is enabled=true", badge.isVisible)

        badge.teardown()
    }

    @Test
    fun `server enabled=true shows over inline enabled=false`() = runTest(mainDispatcher) {
        val act = activity()
        CompanionBadge.__activityProvider = { act }
        val options = CompanionBadgeOptions(enabled = false)
        val badge = CompanionBadge(
            options = options,
            serverConfig = { com.traceitx.config.CompanionBadgeConfigWire(enabled = true) },
        )
        // See the drain comment in the previous test.
        advanceUntilIdle()

        badge.applyForTesting("member", "TV", "AB12")

        assertTrue(
            "server enabled=true must force-show over an inline enabled=false — requires the badge to " +
                "subscribe unconditionally regardless of options.enabled",
            badge.isVisible,
        )

        badge.teardown()
    }

    @Test
    fun `server position wins and unknown server position falls back to inline`() {
        assertEquals(CompanionBadgePosition.TOP_LEFT, parseCompanionBadgePositionOrNull("top-left"))
        assertEquals(null, parseCompanionBadgePositionOrNull("center"))
        assertEquals(null, parseCompanionBadgePositionOrNull(null))
        // parseCompanionBadgePosition keeps its own defaults-to-BOTTOM_RIGHT contract.
        assertEquals(CompanionBadgePosition.BOTTOM_RIGHT, parseCompanionBadgePosition("center"))
        assertEquals(CompanionBadgePosition.BOTTOM_RIGHT, parseCompanionBadgePosition(null))
        assertEquals(CompanionBadgePosition.TOP_LEFT, parseCompanionBadgePosition("top-left"))
    }

    @Test
    fun `no server block preserves inline behavior`() = runTest(mainDispatcher) {
        val act = activity()
        CompanionBadge.__activityProvider = { act }

        // enabled=false stays hidden with no server block.
        val disabled = CompanionBadge(
            options = CompanionBadgeOptions(enabled = false),
            serverConfig = { null },
        )
        // See the drain comment above the "server enabled=false" test.
        advanceUntilIdle()
        disabled.applyForTesting("member", "TV", "AB12")
        assertFalse("no server block must never override an inline enabled=false", disabled.isVisible)
        disabled.teardown()

        // The inline default (enabled=true) stays visible on attach, unchanged.
        val default = CompanionBadge(
            options = CompanionBadgeOptions(),
            serverConfig = { null },
        )
        advanceUntilIdle()
        default.applyForTesting("member", "TV", "AB12")
        assertTrue("no server block must preserve the existing inline-default-on behavior", default.isVisible)
        default.teardown()
    }

    // ---------------------------------------------------------------------
    // Config-refresh re-apply trigger (final-review fix, plan 2026-08-25,
    // finding 2) — a dashboard config change must re-apply the badge on its
    // own, without waiting for the NEXT identity emission or
    // onActivityResumed.
    // ---------------------------------------------------------------------

    @Test
    fun `server config change re-applies without an identity emission`() = runTest(mainDispatcher) {
        val act = activity()
        CompanionBadge.__activityProvider = { act }
        val badge = CompanionBadge(
            options = CompanionBadgeOptions(),
            serverConfig = { CompanionBadgeServerConfigSignal.flow.value },
        )

        com.traceitx.companion.Companion.__setAttachedUserName("Aurimas")
        com.traceitx.companion.Companion.__setResolvedName("Lobby TV")
        com.traceitx.companion.Companion.__setCode("AB12")
        advanceUntilIdle()
        assertTrue("precondition: badge visible before any server config arrives", badge.isVisible)

        // No identity flow touched below — only the signal.
        CompanionBadgeServerConfigSignal.flow.value = com.traceitx.config.CompanionBadgeConfigWire(enabled = false)
        advanceUntilIdle()
        assertFalse("a server enabled=false must re-apply and hide the badge on its own", badge.isVisible)

        CompanionBadgeServerConfigSignal.flow.value = com.traceitx.config.CompanionBadgeConfigWire(enabled = true)
        advanceUntilIdle()
        assertTrue("a server enabled=true must re-apply and re-show the badge on its own", badge.isVisible)

        badge.teardown()
    }

    // Codex round-2 fix — `TraceItX.kill()` now clears
    // `CompanionBadgeServerConfigSignal.flow` (mirrors `start()`'s existing
    // session-boundary reset). This exercises the reactive consequence of
    // that clear at the badge's own collector: a server override forcing
    // the badge on over an inline `enabled = false` must fall back to the
    // inline (hidden) behavior the instant the signal goes back to null —
    // the same combine trigger "server config change re-applies without an
    // identity emission" above proves for a live config CHANGE, here for
    // the clear-on-kill case specifically.
    @Test
    fun `kill() clearing the signal falls back to inline config`() = runTest(mainDispatcher) {
        val act = activity()
        CompanionBadge.__activityProvider = { act }
        // Simulate a server override delivered before kill() fires.
        CompanionBadgeServerConfigSignal.flow.value = com.traceitx.config.CompanionBadgeConfigWire(enabled = true)
        val badge = CompanionBadge(
            options = CompanionBadgeOptions(enabled = false),
            serverConfig = { CompanionBadgeServerConfigSignal.flow.value },
        )

        com.traceitx.companion.Companion.__setAttachedUserName("Aurimas")
        com.traceitx.companion.Companion.__setResolvedName("Lobby TV")
        com.traceitx.companion.Companion.__setCode("AB12")
        advanceUntilIdle()
        assertTrue(
            "precondition: server enabled=true forces the badge visible over inline enabled=false",
            badge.isVisible,
        )

        // kill()'s clear (TraceItX.kt) — the signal falling back to null.
        CompanionBadgeServerConfigSignal.flow.value = null
        advanceUntilIdle()
        assertFalse(
            "clearing the signal (as kill() now does) must fall back to the inline config and hide the badge",
            badge.isVisible,
        )

        badge.teardown()
    }

    // ---------------------------------------------------------------------
    // Codex round-1 fix E (findings 5+6) — the "already attached, just
    // update text" fast path in show() never re-ran layout, so a dashboard
    // position change waited for a full hide/show cycle before it took
    // effect. Mirrors the "server config change re-applies without an
    // identity emission" test above but asserts the LayoutParams gravity
    // rather than mere visibility.
    // ---------------------------------------------------------------------

    @Test
    fun `a server position change while attached repositions the badge without a hide-show cycle`() = runTest(mainDispatcher) {
        val act = activity()
        CompanionBadge.__activityProvider = { act }
        val badge = CompanionBadge(
            options = CompanionBadgeOptions(),
            serverConfig = { CompanionBadgeServerConfigSignal.flow.value },
        )

        CompanionBadgeServerConfigSignal.flow.value =
            com.traceitx.config.CompanionBadgeConfigWire(enabled = true, position = "top-left")
        com.traceitx.companion.Companion.__setAttachedUserName("Aurimas")
        com.traceitx.companion.Companion.__setResolvedName("Lobby TV")
        advanceUntilIdle()
        assertTrue("precondition: badge visible at position A", badge.isVisible)
        var params = badgeViewsOn(act).last().layoutParams as WindowManager.LayoutParams
        assertEquals(Gravity.TOP or Gravity.START, params.gravity)
        assertEquals(
            "exactly one badge view before the position change",
            1,
            badgeViewsOn(act).size,
        )

        // Dashboard flips only the POSITION — no identity emission, no
        // re-trigger other than the server-config signal itself.
        CompanionBadgeServerConfigSignal.flow.value =
            com.traceitx.config.CompanionBadgeConfigWire(enabled = true, position = "bottom-right")
        advanceUntilIdle()

        assertTrue("the badge must remain visible across the reposition", badge.isVisible)
        assertEquals(
            "the OLD view must be torn down and a new one attached — never both left behind",
            1,
            badgeViewsOn(act).size,
        )
        params = badgeViewsOn(act).last().layoutParams as WindowManager.LayoutParams
        assertEquals(
            "the attached view's LayoutParams gravity must match the NEW server position",
            Gravity.BOTTOM or Gravity.END,
            params.gravity,
        )

        badge.teardown()
    }

    // ---------------------------------------------------------------------
    // Thread-safety basics — mirrors the removed indicator's
    // "a hide() that lands before a queued attach still wins" contract.
    // ---------------------------------------------------------------------

    @Test
    fun `a hide that lands before a queued attach wins the race`() {
        val act = activity()
        CompanionBadge.__activityProvider = { act }
        val badge = CompanionBadge()
        val before = viewsOn(act).size

        // Drive apply() directly from a REAL background thread so
        // Activity.runOnUiThread posts (queues) rather than running
        // synchronously — the test thread IS Robolectric's simulated main
        // thread, so calling this from the test thread would never exercise
        // the race at all.
        val t = Thread { badge.applyForTesting(attachedUserName = "Aurimas", resolvedName = null, code = "LMN-421") }
        t.start()
        t.join()

        // hide() runs on the test/main thread BEFORE the queued attach is
        // drained below.
        badge.hide()
        Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()

        assertFalse("a hide() that lands before the queued attach runs must win", badge.isVisible)
        assertEquals("the queued attach must not have added a view after losing the race", before, viewsOn(act).size)

        badge.teardown()
    }

    @Test
    fun `a show queued from a background thread still attaches once drained`() {
        val act = activity()
        CompanionBadge.__activityProvider = { act }
        val badge = CompanionBadge()
        val before = viewsOn(act).size

        val t = Thread { badge.applyForTesting(attachedUserName = "Aurimas", resolvedName = null, code = "LMN-421") }
        t.start()
        t.join()

        Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()

        assertTrue("a queued attach must land once the main looper drains", badge.isVisible)
        assertEquals(before + 1, viewsOn(act).size)

        badge.teardown()
    }
}
