// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Companion device-naming badge (spec 2026-08-24, Task 6). Mirrors the iOS
// twin (`CompanionBadge.swift`, Task 5) as closely as the platform allows.
//
// IDENTIFICATION ONLY. This is a small "paired as <name>" / "<code>" label so
// whoever is standing in front of the TV can confirm which device the
// dashboard is talking to. It is NOT the fail-closed "Sharing screen to
// phone" indicator removed 2026-08-13 (`git show 360c90a3^` —
// `CompanionSharingIndicator.kt`, ported from spec 2026-07-17 §3) and it must
// NEVER be cited as a privacy mitigation. That indicator's whole reason to
// exist was refusing to let a preview stream without host-visible proof;
// this badge has no such veto. `CompanionPreviewSession` does not consult it,
// `enabled = false` only removes the label, and there is no `show(): Boolean`
// for a caller to gate on. If a future feature needs a fail-closed,
// provably-on-screen guarantee again, that is a new control, not a repaint
// of this one.
//
// Reuses ONLY the window-mechanics half of the removed indicator (same
// commit): the `__activityProvider: (() -> Activity?)?` seam (the core AAR
// cannot resolve a foreground Activity itself — see that class's own header,
// line ~53), the `@Volatile` attach state + `wantVisible` flag +
// `runOnUiThread` show/hide threading contract (lines ~89-114 of the removed
// file), and the general "attach lazily, detach defensively, never crash the
// host" shape. Does NOT reuse decor-view attachment, fail-closed gating, or
// the per-tick visibility probes — those belonged to a control this badge is
// deliberately not.
//
// THE CRITICAL DIFFERENCE from the removed indicator: this attaches via
// `activity.windowManager.addView(view, params)` with a
// `WindowManager.LayoutParams(TYPE_APPLICATION_PANEL, ...)` — a SUB-WINDOW
// bound to the host Activity's own window token via `params.token`, NOT the
// decor view, and NOT `TYPE_APPLICATION_OVERLAY` (which needs
// `SYSTEM_ALERT_WINDOW` — `.github/workflows/android.yml`'s zero-permission
// AAR gate fails the build on any manifest permission). `FLAG_NOT_FOCUSABLE
// or FLAG_NOT_TOUCHABLE` keeps it inert: never key, never interactive, never
// dismissible by the user.
//
// Capture exclusion is STRUCTURAL, not a per-view opt-out:
//   • `ScreenshotCapture.captureBeforeReporter` / `.captureRegion` both call
//     `PixelCopy.request(activity.window, ...)`
//     (capture/ScreenshotCapture.kt:217 and :305) — PixelCopy copies ONLY
//     that Activity WINDOW's surface. A WindowManager sub-window added via
//     `windowManager.addView` is a DIFFERENT window with its own surface, so
//     it is never in the copied buffer.
//   • `SensitiveRectRegistry.collectInWindowCoords(activity)`
//     (capture/SensitiveRectRegistry.kt:95-98) walks from
//     `activity.findViewById(android.R.id.content)` — the Activity's own
//     content view. The VTree walk starts from the same root. A
//     sub-window's view tree is never reachable from there either.
// Both exclusions fall out of "this is a different window", the same
// property that makes the badge safe — no capture path needs to know this
// class exists.
//
// State: `Companion.attachedUserName` / `.resolvedName` / `.code` StateFlows
// (Tasks 1-3). Visible iff `attachedUserName != null`, the composed label is
// non-empty, AND the RESOLVED enabled flag is true (server override 2026-08-25
// below). Label text is `listOfNotNull(resolvedName, code).joinToString(" · ")`
// (see [CompanionBadgeLabel.compose], deliberately a top-level object so it
// stays unit-testable without an Activity).
//
// Config: `CompanionBadgeOptions(enabled, position)` is captured ONCE by
// `RelayWSClient`'s constructor (first-client-wins, mirroring iOS and web) —
// change the INLINE option by building a fresh `RelayWSClient`, not by
// mutating a running badge.
//
// Server-config overlay (plan 2026-08-25): the badge also consults a
// `serverConfig: () -> CompanionBadgeConfigWire?` lambda — defaulting to
// `TraceItX.currentReplayConfig().companionBadge` — at EVERY apply/show, never
// captured at construction, so a config refresh after `startCompanion()`
// still takes effect. Overlay is PER-FIELD: the server's `enabled` wins when
// present (see `resolvedEnabled()`), falling back to the inline option
// otherwise; the server's `position` wins ONLY when it decodes to a
// recognised corner (see `resolvedPosition()`/`parseCompanionBadgePositionOrNull`),
// so a future position string this build doesn't understand falls back to the
// inline option rather than a hard-coded corner. Because the server can
// force-enable over an inline `enabled = false`, the StateFlow subscription
// below is unconditional — see the doc comment on `init`.
//
// Threading: [Companion] (the object, not this class — fully qualified below
// to dodge the identifier collision with Kotlin's own `companion object`
// keyword, matching every other file in this package) is a StateFlow
// singleton updated from the OkHttp WS reader thread. This class collects
// the combined flow on its own [scope] (default `Dispatchers.Main`, same
// default as `CompanionPreviewSession`), so [apply] normally already runs on
// the main thread — but [show]/[hide] are additionally safe to call directly
// from any thread (as the removed indicator's were), because the actual
// attach/detach is always marshaled through `Activity.runOnUiThread`, guarded
// by the same [wantVisible] flag the removed indicator used to close its
// "hide raced a queued show" hole: a `hide()` that lands before a posted
// attach runs still wins, because the posted block re-checks [wantVisible]
// before touching the window.
//
// RE-ANCHORING ACROSS ACTIVITY RECREATION (task-6 review round 1, IMPORTANT).
// The identity StateFlows are the ONLY thing [apply] reacts to — but a config
// change or TV multi-window swap destroys and recreates the host Activity
// with those flows completely UNCHANGED, so nothing above would ever fire
// again. Left alone, `WindowManagerGlobal` force-removes this class's
// sub-window the moment its owning Activity is destroyed — logging an
// error-level "Activity has leaked window" with a stack trace, attributed to
// the HOST's Activity, on every single rotation or config change while
// attached — and [attached]/[hostActivity] never learn about that either:
// [isVisible] would keep reporting true against a window the system already
// tore down, [hostActivity] would pin a reference to a dead Activity, and the
// badge would never reappear on the replacement — the removed indicator
// dodged exactly this by re-validating on every capture tick, a poll this
// badge deliberately has no equivalent of (it is not driven by a tick).
//
// Fix: [activityLifecycleCallbacks] (an `Application.ActivityLifecycleCallbacks`,
// registered lazily — mirrors `BreadcrumbTapNavAdapters.install()`'s own
// install-once idiom in this same module, chosen over a
// `CompanionBadge.__onHostActivityChanged()` seam pushed from
// `TraceItXModule` because it needs no new interface on the RN bridge and
// self-heals for EVERY host, not only the ones a future caller remembers to
// wire) does two things:
//   • `onActivityDestroyed(activity)` — if it's [hostActivity], proactively
//     removes the attached view via `activity.windowManager.removeView(view)`
//     (try/catch — never let the badge crash the host app) BEFORE resetting
//     [attached]/[hostActivity] to null. `dispatchActivityDestroyed` fires
//     from `Activity.onDestroy()`, strictly before `WindowManagerGlobal`'s own
//     `closeAll()` runs, so this callback beats it to the removal every time:
//     the window is already gone by the time `closeAll()` would have force-
//     removed it, so the leaked-window log never fires at all — this is
//     legitimate removal, not a race that merely usually wins. Deliberately
//     does NOT try to re-attach here: on a config-change recreate the OLD
//     Activity fully finishes destroying before the NEW one is created, so
//     [__activityProvider] would still resolve to the dying Activity (or
//     null) at this exact moment.
//   • `onActivityResumed(activity)` — unconditionally re-runs [apply] against
//     the CURRENT identity StateFlow values. This is the actual re-anchor:
//     whichever Activity [__activityProvider] resolves to next (almost
//     always the replacement, once it resumes) gets the badge, via the same
//     show()/detach() path an ordinary identity transition already uses.
//     Firing on every resumed Activity in the process (not just a provable
//     "the" host) is deliberate over-triggering — [show]'s existing
//     already-attached-to-this-Activity fast path makes every extra call a
//     cheap no-op, and it removes any need to know which Activity is "the"
//     host ahead of time.
// [teardown] unregisters the callbacks (via the `Application` captured at
// registration time, since [hostActivity] may already be null by then) so a
// stopped client's badge doesn't keep listening for the lifetime of the
// process.
package com.traceitx.companion

import android.app.Activity
import android.app.Application
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.WindowInsets
import android.view.WindowManager
import android.widget.TextView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach

/**
 * Which corner of the window the badge attaches to. Bottom-right is the
 * default so it clears a top status bar/notch and a bottom home indicator on
 * phones without a host decision either way; hosts on TV layouts (the
 * primary companion consumer) may prefer a different corner depending on
 * where their own on-screen chrome lives. Mirrors iOS `CompanionBadgePosition`.
 */
enum class CompanionBadgePosition { TOP_LEFT, TOP_RIGHT, BOTTOM_LEFT, BOTTOM_RIGHT }

/**
 * Host configuration for the companion name badge (spec 2026-08-24). Mirrors
 * iOS `CompanionBadgeOptions` — a plain, all-defaulted data class captured
 * ONCE by `RelayWSClient`'s constructor (first-client-wins, matching web and
 * iOS — a later config change requires a fresh `RelayWSClient`, not a live
 * mutation of a running one).
 */
data class CompanionBadgeOptions(
    /**
     * Default ON. Setting this `false` removes the badge entirely — unlike
     * the removed sharing indicator, there is nothing here for a caller to
     * gate behavior on, so "disabled" simply means "never shown."
     */
    val enabled: Boolean = true,
    val position: CompanionBadgePosition = CompanionBadgePosition.BOTTOM_RIGHT,
)

/**
 * Coerce a flat, wire-shaped `companionBadgePosition` string into
 * [CompanionBadgePosition]. `null` (field absent) and any unrecognised value
 * both degrade to [CompanionBadgePosition.BOTTOM_RIGHT] — matches
 * [CompanionBadgeOptions.position]'s own default, so an absent field behaves
 * exactly like never touching the option at all.
 *
 * Moved here (external review, finding N3) from a private copy on
 * `TraceItXModule` (the RN bridge) so `TraceItX.startCompanion()` — the core
 * facade's own native-host companion start path added by that same finding —
 * can share it instead of drifting a second copy. The RN bridge now
 * delegates to this one; its own `ConfigOpts.companionBadgePosition` field
 * has the identical flat shape.
 */
fun parseCompanionBadgePosition(raw: String?): CompanionBadgePosition =
    parseCompanionBadgePositionOrNull(raw) ?: CompanionBadgePosition.BOTTOM_RIGHT

/**
 * Like [parseCompanionBadgePosition] but WITHOUT the bottom-right fallback:
 * the server-override path (plan 2026-08-25) must distinguish "server did
 * not set / does not recognizably set a position" (→ fall back to the
 * INLINE option) from a legitimately parsed corner. The original function
 * keeps its defaulting contract for the flat host-config path and now
 * delegates here.
 */
fun parseCompanionBadgePositionOrNull(raw: String?): CompanionBadgePosition? = when (raw) {
    "bottom-right" -> CompanionBadgePosition.BOTTOM_RIGHT
    "bottom-left" -> CompanionBadgePosition.BOTTOM_LEFT
    "top-right" -> CompanionBadgePosition.TOP_RIGHT
    "top-left" -> CompanionBadgePosition.TOP_LEFT
    else -> null
}

/**
 * Minimal current-Activity tracker for [com.traceitx.TraceItX.startCompanion]
 * — the pure-native (no RN bridge) companion start path added by external
 * review finding N3. Core has no OTHER queryable "current Activity":
 * `BreadcrumbTapNavAdapters` only wraps `Window.callback` for tap crumbs, it
 * never stores a reference one could read back.
 *
 * Feeds [CompanionBadge.__activityProvider] ONLY when that seam is still
 * null (checked at [installIfNeeded] time, once) — an RN host installs its
 * own provider from `TraceItXModule.startCompanion()`
 * (`reactContext.currentActivity`, authoritative for that host), and this
 * tracker must never clobber it. Symmetric with `stopCompanion()`'s own
 * "never touch a provider you didn't install" contract is out of scope here
 * on purpose: this tracker's provider is a `WeakReference` read, harmless to
 * leave installed, and there is exactly one process-wide instance either way
 * (mirrors `BreadcrumbTapNavAdapters`'s own install-once object idiom).
 */
internal object CompanionActivityTracker : Application.ActivityLifecycleCallbacks {
    private val installed = java.util.concurrent.atomic.AtomicBoolean(false)

    @Volatile
    private var current: java.lang.ref.WeakReference<Activity>? = null

    fun installIfNeeded(context: android.content.Context) {
        val app = context.applicationContext as? Application ?: return
        if (installed.compareAndSet(false, true)) {
            app.registerActivityLifecycleCallbacks(this)
        }
        if (CompanionBadge.__activityProvider == null) {
            CompanionBadge.__activityProvider = { current?.get() }
        }
    }

    override fun onActivityResumed(activity: Activity) {
        current = java.lang.ref.WeakReference(activity)
    }

    override fun onActivityPaused(activity: Activity) {
        if (current?.get() === activity) current = null
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
    override fun onActivityStarted(activity: Activity) {}
    override fun onActivityStopped(activity: Activity) {}
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
    override fun onActivityDestroyed(activity: Activity) {}

    /** Test seam — resets install-once state and the tracked Activity between
     *  tests sharing this process-global object. */
    @androidx.annotation.VisibleForTesting
    internal fun resetForTesting() {
        installed.set(false)
        current = null
    }
}

/**
 * Pure label composition, deliberately a top-level object rather than a
 * private method on [CompanionBadge]: it is the one piece of genuinely
 * host-testable logic here that needs neither an `Activity` nor a
 * `WindowManager`, mirroring iOS `CompanionBadgeLabel.compose` living outside
 * that file's `#if canImport(UIKit)` gate.
 */
object CompanionBadgeLabel {
    @JvmStatic
    fun compose(resolvedName: String?, code: String?): String =
        listOfNotNull(resolvedName, code).joinToString(" · ")
}

/**
 * Observable snapshot of the server badge block (final-review fix, plan
 * 2026-08-25): written by ReplaySession on every config commit, collected by
 * CompanionBadge as a TRIGGER so a dashboard change re-applies without
 * waiting for an identity emission or onActivityResumed. Resolution still
 * reads [CompanionBadge]'s serverConfig lambda — this flow's value is not
 * consumed by apply().
 */
// LIBRARY_GROUP (#136 review follow-up, paired deliberately with
// BrandingServerConfigSignal in config/Branding.kt): observable plumbing for
// modules in the com.traceitx library group, never host API.
@androidx.annotation.RestrictTo(androidx.annotation.RestrictTo.Scope.LIBRARY_GROUP)
object CompanionBadgeServerConfigSignal {
    val flow = kotlinx.coroutines.flow.MutableStateFlow<com.traceitx.config.CompanionBadgeConfigWire?>(null)

    /** Serialized destination mutation; guard must never acquire the facade state lock. */
    @Synchronized
    internal fun publish(value: com.traceitx.config.CompanionBadgeConfigWire?, isCurrent: () -> Boolean) {
        if (isCurrent()) flow.value = value
    }

    @androidx.annotation.VisibleForTesting
    fun resetForTesting() { flow.value = null }
}

/**
 * Drives the capture-excluded name badge from `Companion`'s identity
 * StateFlows. See the file header for the full capture-exclusion argument,
 * the "not the removed indicator" disclaimer, and the threading contract.
 */
class CompanionBadge(
    private val options: CompanionBadgeOptions = CompanionBadgeOptions(),
    /**
     * Server-driven dashboard override (plan 2026-08-25), consulted at every
     * apply/show — NOT captured at construction, so a config refresh that
     * lands after startCompanion() still takes effect. Defaults to the live
     * fetched-config snapshot; tests inject a lambda.
     */
    private val serverConfig: () -> com.traceitx.config.CompanionBadgeConfigWire? =
        { com.traceitx.TraceItX.currentReplayConfig().companionBadge },
    /**
     * Scheduler for the StateFlow collector. Defaults to `Dispatchers.Main`
     * (same default `CompanionPreviewSession` uses) — tests install a
     * `StandardTestDispatcher` via `Dispatchers.setMain` and drive it with
     * `runTest`/`advanceUntilIdle`, exactly like
     * `CompanionPreviewSessionTest`.
     */
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.Main + SupervisorJob()),
) {

    companion object {
        /**
         * Installed by the RN bridge (`TraceItXModule.startCompanion`),
         * nulled on `stopCompanion` — same seam, same reasoning as the
         * removed indicator's own `__activityProvider` (and
         * `CompanionCaptureBridge.__captureProvider`/`__previewProvider`):
         * `:traceitx-core` is a plain AAR that cannot resolve a foreground
         * Activity on its own.
         */
        @JvmStatic
        var __activityProvider: (() -> Activity?)? = null

        private const val MARGIN_DP = 24
        private const val CORNER_RADIUS_DP = 6
        private const val H_PADDING_DP = 10
        private const val V_PADDING_DP = 6
    }

    /**
     * The view currently attached via [WindowManager.addView], or null when
     * hidden. `@Volatile` for the same reason as the removed indicator's
     * `attached`: [show]/[hide] can be called from a different thread than
     * the one that eventually mutates the window.
     */
    @Volatile
    private var attached: TextView? = null

    /**
     * The Activity [attached] was added to. Captured at attach time and
     * reused by [detach] instead of re-invoking [__activityProvider] — the
     * provider may already have been nulled by `stopCompanion()`, or the
     * foreground Activity may simply have changed, by the time [detach]
     * runs, and removal must target the SAME WindowManager the view was
     * added through.
     */
    @Volatile
    private var hostActivity: Activity? = null

    /**
     * Desired state, set SYNCHRONOUSLY by [show]/[hide] on the calling
     * thread, as opposed to [attached] which only changes on the UI thread.
     * Closes the same ordering hole the removed indicator's `wantVisible`
     * closed: a `hide()` that arrives while an attach is only queued (not
     * yet run) must still win when that queued attach finally runs.
     */
    @Volatile
    private var wantVisible: Boolean = false

    /**
     * Codex round-1 fix E (findings 5+6) — the position [attached] was last
     * built/attached with. The "already attached, just update text" fast
     * path in [show] used to never re-run layout, so a dashboard position
     * change (server `companionBadge.position` flipping mid-session) waited
     * for a full hide/show cycle (attachedUserName clearing and coming back)
     * before it took effect — unbounded on an ordinarily-always-attached TV
     * companion session. `null` before the first attach.
     */
    @Volatile
    private var appliedPosition: CompanionBadgePosition? = null

    val isVisible: Boolean
        get() = attached != null

    /**
     * The `Application` [activityLifecycleCallbacks] was registered on, or
     * null before the first successful [show]. Held separately from
     * [hostActivity] because [teardown] needs it to unregister AFTER [hide]
     * has already cleared [hostActivity] — see the file header's
     * "RE-ANCHORING" section.
     */
    @Volatile
    private var registeredApplication: Application? = null

    /**
     * Re-anchors the badge across Activity recreation — see the file
     * header's "RE-ANCHORING ACROSS ACTIVITY RECREATION" section for why
     * this exists and why it lives here rather than a seam pushed from
     * `TraceItXModule`. Exposed via [activityLifecycleCallbacksForTesting]
     * so a test can drive it directly, mirroring
     * `BreadcrumbTapNavAdapters.callbacksForTesting()`'s idiom in this same
     * module.
     */
    private val activityLifecycleCallbacks = object : Application.ActivityLifecycleCallbacks {
        override fun onActivityDestroyed(activity: Activity) {
            if (activity !== hostActivity) return
            // Remove the sub-window BEFORE clearing state — see the file
            // header's "RE-ANCHORING" section. This fires from
            // `Activity.onDestroy()`, strictly before `WindowManagerGlobal`'s
            // own `closeAll()`, so getting here first means `closeAll()` has
            // nothing left to force-remove and never logs the leaked-window
            // error. try/catch: never let the badge crash the host app, e.g.
            // if the window was already detached some other way.
            val view = attached
            if (view != null) {
                try {
                    activity.windowManager.removeView(view)
                } catch (t: Throwable) {
                    // Best-effort — see above.
                }
            }
            attached = null
            hostActivity = null
            appliedPosition = null
        }

        override fun onActivityResumed(activity: Activity) {
            reapply()
        }

        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
        override fun onActivityStarted(activity: Activity) {}
        override fun onActivityPaused(activity: Activity) {}
        override fun onActivityStopped(activity: Activity) {}
        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
    }

    /** Test-only accessor — drives [activityLifecycleCallbacks] directly
     *  without depending on a live `Application` registration's dispatch
     *  timing. */
    internal fun activityLifecycleCallbacksForTesting(): Application.ActivityLifecycleCallbacks =
        activityLifecycleCallbacks

    /** Test-only accessor — the Activity [attached] believes it owns, or
     *  null. Used to assert a destroyed host is not retained. */
    internal fun hostActivityForTesting(): Activity? = hostActivity

    /**
     * Registers [activityLifecycleCallbacks] on [activity]'s `Application`
     * the first time [show] resolves a live Activity. Install-once per
     * badge instance (mirrors `BreadcrumbTapNavAdapters.install()`): every
     * subsequent Activity `__activityProvider` hands back is, in every real
     * host, backed by the SAME `Application`, so double-registering would
     * only double-fire [onActivityResumed] — harmless but wasteful.
     */
    private fun ensureLifecycleCallbacksInstalled(activity: Activity) {
        if (registeredApplication != null) return
        synchronized(this) {
            if (registeredApplication != null) return
            val app = activity.applicationContext as? Application ?: return
            app.registerActivityLifecycleCallbacks(activityLifecycleCallbacks)
            registeredApplication = app
        }
    }

    /**
     * Per-field overlay precedence (plan 2026-08-25): the server field WHEN
     * SET wins, falling back to the inline [options] value. Consulted fresh
     * at every [apply]/[show] — never cached — via [serverConfig].
     */
    private fun resolvedEnabled(): Boolean = serverConfig()?.enabled ?: options.enabled

    /**
     * Same precedence as [resolvedEnabled], but for position an UNRECOGNISED
     * server value (or an absent one) falls back to the inline option rather
     * than a hard-coded corner — see [parseCompanionBadgePositionOrNull].
     */
    private fun resolvedPosition(): CompanionBadgePosition =
        serverConfig()?.position?.let { parseCompanionBadgePositionOrNull(it) } ?: options.position

    /** Re-runs [apply] against the CURRENT identity StateFlow values —
     *  the actual re-anchor step; see the file header. */
    private fun reapply() {
        apply(
            com.traceitx.companion.Companion.attachedUserName.value,
            com.traceitx.companion.Companion.resolvedName.value,
            com.traceitx.companion.Companion.code.value,
        )
    }

    /**
     * Subscribes to `Companion`'s identity StateFlows and starts driving the
     * badge immediately — UNCONDITIONALLY (plan 2026-08-25). Used to be
     * gated on `options.enabled` (a disabled badge subscribed to nothing),
     * but the server can now force-enable the badge over an inline
     * `enabled = false` — see [resolvedEnabled] — so the subscription must
     * always exist for that override to ever have anything to act on. The
     * enabled/disabled decision itself still happens per-apply, in [apply].
     *
     * Final-review fix (plan 2026-08-25, finding 2): widened to a 4-source
     * combine — [CompanionBadgeServerConfigSignal.flow] is folded in ALONGSIDE
     * the three identity flows, purely as a TRIGGER. Its element is
     * deliberately ignored in the lambda below; [apply] keeps its 3-arg
     * signature and resolution still goes through [resolvedEnabled] /
     * [resolvedPosition] (i.e. [serverConfig]). Without this, a dashboard
     * `enabled: false` would only take effect at the next identity emission
     * or `onActivityResumed` — unbounded on an always-resumed TV app.
     */
    init {
        combine(
            com.traceitx.companion.Companion.attachedUserName,
            com.traceitx.companion.Companion.resolvedName,
            com.traceitx.companion.Companion.code,
            CompanionBadgeServerConfigSignal.flow,
        ) { attachedUserName, resolvedName, code, _ -> Triple(attachedUserName, resolvedName, code) }
            .onEach { (attachedUserName, resolvedName, code) -> apply(attachedUserName, resolvedName, code) }
            .launchIn(scope)
    }

    private fun apply(attachedUserName: String?, resolvedName: String?, code: String?) {
        if (!resolvedEnabled()) {
            hide()
            return
        }
        if (attachedUserName == null) {
            hide()
            return
        }
        val label = CompanionBadgeLabel.compose(resolvedName, code)
        if (label.isEmpty()) {
            hide()
            return
        }
        show(label)
    }

    /** Test-only seam: drives [apply] directly, bypassing the StateFlow
     *  subscription, so a test can exercise the show/hide race without
     *  fighting a `StandardTestDispatcher`. */
    internal fun applyForTesting(attachedUserName: String?, resolvedName: String?, code: String?) =
        apply(attachedUserName, resolvedName, code)

    private fun show(text: String) {
        wantVisible = true
        val activity = __activityProvider?.invoke()
        if (activity == null) {
            // Nothing can be on screen without an Activity — drop any stale
            // bookkeeping rather than leave isVisible claiming a view that's
            // gone.
            detach()
            return
        }
        ensureLifecycleCallbacksInstalled(activity)

        val current = attached
        val position = resolvedPosition()
        // Fix E — a fast-path text-only update is only valid when the
        // ALREADY-ATTACHED view was built with the SAME position: WindowManager
        // LayoutParams (gravity/margins) are fixed at addView() time and are
        // not something a caller can update in place, so a server position
        // change must fall through to the detach+rebuild path below, exactly
        // like a different-Activity attach already does.
        if (current != null && hostActivity === activity && appliedPosition == position) {
            activity.runOnUiThread {
                if (!wantVisible) return@runOnUiThread
                current.text = text
                current.contentDescription = text
            }
            return
        }

        // Either a different Activity than the one currently attached, a
        // resolved position that no longer matches the attached view's, or
        // nothing attached yet.
        detach()

        val view = buildLabel(activity, text)
        val params = buildParams(activity, position)
        activity.runOnUiThread {
            // Re-checked on the UI thread: [wantVisible] may have flipped
            // false (a hide() that raced this post) or another attach may
            // already have landed first.
            if (!wantVisible || attached != null) return@runOnUiThread
            try {
                activity.windowManager.addView(view, params)
                attached = view
                hostActivity = activity
                appliedPosition = position
            } catch (t: Throwable) {
                // Never let the badge crash the host app.
                android.util.Log.w("TraceItX.companion", "name badge failed to attach", t)
            }
        }
    }

    fun hide() {
        wantVisible = false
        detach()
    }

    /**
     * Cancels the StateFlow subscription and removes any attached view.
     * Called from `RelayWSClient.stop()` — the badge dies with the client
     * that owns it, exactly like `CompanionPreviewSession.teardown()`.
     */
    fun teardown() {
        hide()
        scope.cancel()
        // Captured at registration time — [hide] above already cleared
        // [hostActivity], so its `.applicationContext` is not available here.
        registeredApplication?.unregisterActivityLifecycleCallbacks(activityLifecycleCallbacks)
        registeredApplication = null
    }

    private fun detach() {
        val view = attached ?: return
        val activity = hostActivity
        attached = null
        hostActivity = null
        appliedPosition = null
        val remove: () -> Unit = {
            try {
                activity?.windowManager?.removeView(view)
            } catch (t: Throwable) {
                // Never let the badge crash the host app.
            }
        }
        if (activity != null) {
            activity.runOnUiThread(remove)
        } else {
            remove()
        }
    }

    private fun buildLabel(activity: Activity, text: String): TextView = TextView(activity).apply {
        this.text = text
        contentDescription = text
        isClickable = false
        isFocusable = false
        setTextColor(Color.WHITE)
        textSize = 13f
        background = GradientDrawable().apply {
            setColor(Color.argb(153, 0, 0, 0)) // black @ 0.6 alpha, matches the iOS label
            cornerRadius = dp(activity, CORNER_RADIUS_DP).toFloat()
        }
        val hPad = dp(activity, H_PADDING_DP)
        val vPad = dp(activity, V_PADDING_DP)
        setPadding(hPad, vPad, hPad, vPad)
    }

    /**
     * Sub-window bound to the host Activity's own window token — see the
     * file header for why this, and not the decor view or
     * `TYPE_APPLICATION_OVERLAY`, is what keeps this class capture-excluded
     * and permission-free.
     */
    private fun buildParams(activity: Activity, position: CompanionBadgePosition): WindowManager.LayoutParams {
        val gravity = when (position) {
            CompanionBadgePosition.TOP_LEFT -> Gravity.TOP or Gravity.START
            CompanionBadgePosition.TOP_RIGHT -> Gravity.TOP or Gravity.END
            CompanionBadgePosition.BOTTOM_LEFT -> Gravity.BOTTOM or Gravity.START
            CompanionBadgePosition.BOTTOM_RIGHT -> Gravity.BOTTOM or Gravity.END
        }
        val isTop = position == CompanionBadgePosition.TOP_LEFT || position == CompanionBadgePosition.TOP_RIGHT
        val margin = dp(activity, MARGIN_DP)
        // TV overscan needs real margin, not a phone-only 8-12dp constant —
        // matches the iOS badge's own reasoning for using 24pt instead of the
        // removed indicator's 8dp. Only the leading edge (status bar for a
        // top corner, navigation/gesture bar for a bottom one) gets a system
        // inset added; the trailing edge is a plain margin.
        val edgeInset = margin + systemBarInsetPx(activity, top = isTop)
        return WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_PANEL,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
            PixelFormat.TRANSLUCENT,
        ).apply {
            // TYPE_APPLICATION_PANEL is a SUB-window: it must be bound to the
            // host Activity's own window token, or WindowManager refuses to
            // add it (`BadTokenException`). This is what makes it a
            // different window from the decor view the removed indicator
            // attached to, and what keeps it off PixelCopy's/the sensitive
            // walk's radar — see the file header.
            token = activity.window?.decorView?.windowToken
            this.gravity = gravity
            x = margin
            y = edgeInset
        }
    }

    private fun dp(activity: Activity, value: Int): Int =
        (value * activity.resources.displayMetrics.density).toInt()

    /**
     * Height of the relevant system bar, so the badge sits clear of it
     * rather than under/behind it. Returns 0 when insets aren't available
     * yet (window not attached), which only costs a few dp of placement —
     * never correctness. Mirrors the removed indicator's `statusBarInsetPx`,
     * generalized to the bottom edge too (see [buildParams]).
     */
    private fun systemBarInsetPx(activity: Activity, top: Boolean): Int = try {
        val insets = activity.window?.decorView?.rootWindowInsets
        when {
            insets == null -> 0
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ->
                if (top) {
                    insets.getInsets(WindowInsets.Type.statusBars()).top
                } else {
                    insets.getInsets(WindowInsets.Type.navigationBars()).bottom
                }
            else -> @Suppress("DEPRECATION") if (top) insets.systemWindowInsetTop else insets.systemWindowInsetBottom
        }
    } catch (t: Throwable) {
        0
    }
}
