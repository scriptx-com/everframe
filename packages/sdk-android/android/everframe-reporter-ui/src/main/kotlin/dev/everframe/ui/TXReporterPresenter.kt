// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// TXReporterPresenter — capture-before-reporter orchestrator. The single
// public entry point that the host's `report.open()` call funnels through.
//
// Ordering invariant (T-05-06-T mitigation):
//   1. Walk SensitiveRectRegistry → window-coord rects
//   2. ScreenshotCapture.captureBeforeReporter (PixelCopy + bake-black)
//   3. Construct + show the reporter Dialog
//
// Steps 1-2 are atomic from the caller's perspective; the Dialog (step 3)
// is constructed AFTER PixelCopy resolves so it cannot self-capture.
//
// Android TV note: the on-device :everframe-tv Activity was removed. Reporting
// on Android TV now routes through the phone-companion (QR → phone browser SPA)
// flow; hosts on TV form factor should not call report.open() and should drive
// the companion path via CompanionCaptureBridge instead.
package dev.everframe.ui

import android.app.Activity
import dev.everframe.Everframe
import dev.everframe.capture.ScreenshotCapture
import dev.everframe.capture.SensitiveRectRegistry
import dev.everframe.config.ReportResult
import dev.everframe.envelope.txGuardSuspend
import java.lang.ref.WeakReference
import kotlinx.coroutines.CompletableDeferred

internal class TXReporterPresenter(
    private val captureScreenshot: suspend (Activity, List<android.graphics.Rect>) -> ScreenshotCapture.CaptureResult? =
        { activity, rects -> ScreenshotCapture.captureBeforeReporter(activity, rects) },
    // The last argument is called when the dialog leaves the screen (Send or cancel).
    private val showDialog: suspend (Activity, ScreenshotCapture.CaptureResult, dev.everframe.capture.video.FrozenReportCapture, String?, () -> Unit) -> ReportResult =
        { activity, screenshot, capture, extra, onDismissed -> ReporterDialog.show(activity, screenshot, capture, extra, onDismissed = onDismissed) },
) {

    /**
     * Suspending entry — caller awaits a `ReportResult` once the user submits
     * or cancels. Shape is identical to iOS `TXReporterPresenter.openAndAwait`.
     */
    suspend fun openReporter(activity: Activity): ReportResult =
        openReporter(activity) { !activity.isFinishing && !activity.isDestroyed }

    internal suspend fun openReporter(activity: Activity, isCurrent: () -> Boolean): ReportResult {
        // Single-flight: every open path (host `report.open()`, the React Native
        // bridge, the SDK's own shake trigger) funnels through here. Two opens
        // at once used to present two dialogs: the second froze an EMPTY replay
        // capture (the first already owned the freeze), and the hidden first
        // kept the recorder frozen until it closed. A caller arriving while a
        // report is open now joins it and receives the same result.
        val (mine, existing) = synchronized(lock) {
            val running = inFlight?.takeIf { !it.result.isCompleted }
            if (running != null && !running.abandoned) {
                null to running
            } else {
                // A dialog removed with its activity may never settle its
                // open, so joining it could wait forever: release its joiners
                // and present a new reporter instead.
                running?.result?.complete(ReportResult.Cancelled("activity_destroyed"))
                Flight(activity).also { inFlight = it } to null
            }
        }
        if (existing != null) {
            // After Send the dialog is gone while the report uploads; joining
            // then would hand this caller the result of a report it never saw.
            val dismissed = existing.dismissed
            // A joining open presents nothing, so drop its caller's pending
            // extra here rather than let it ship with a later, unrelated
            // report. The owner drains first: opens run on the main thread,
            // and an extra resolver round trip is serialised.
            Everframe.consumePendingAttachments()
            return if (dismissed) ReportResult.Cancelled("already_presenting") else existing.result.await()
        }
        val owned = mine!!
        try {
            return presentOnce(activity, isCurrent) { owned.dismissed = true }.also { owned.result.complete(it) }
        } catch (t: Throwable) {
            owned.result.completeExceptionally(t)
            throw t
        } finally {
            synchronized(lock) { if (inFlight === owned) inFlight = null }
        }
    }

    private suspend fun presentOnce(activity: Activity, isCurrent: () -> Boolean, onDismissed: () -> Unit): ReportResult {
        // Plan 05.1-02: flip the observable presenting-state at entry, and
        // ensure we flip it back at every exit (success / cancel / failure /
        // throw). The try/finally outside txGuardSuspend keeps the flag
        // honest even when the guarded block returns Cancelled.
        Everframe.report.__setPresenting(true)
        var submitted = false
        var frozenCapture: dev.everframe.capture.video.FrozenReportCapture? = null
        try {
        val result: ReportResult? = txGuardSuspend("presenter") {
            // DEFE-03 kill-switch
            if (!Everframe.captureGate) return@txGuardSuspend ReportResult.Cancelled("kill_switch")

            // Consume host-attached payload exactly once — matches iOS
            // TXReporterPresenter.swift:72. `hostExtra` is threaded through to
            // the submission (for `payload.extra`). The React tree that comes
            // back with it is DRAINED AND DISCARDED: tap-to-identify and the
            // UI-tree payload are gone (spec 2026-08-29). The core
            // `Everframe.attachReactTree` is still callable by pure-native
            // hosts, so the pending slot must still be cleared or a stale
            // attach would outlive the report that caused it.
            val (hostExtra, _) = Everframe.consumePendingAttachments()
            val hostExtraNormalized = hostExtra?.takeIf { it.isNotEmpty() }

            // 0. FREEZE the session-replay rolling buffer the INSTANT the reporter
            //    opens — BEFORE the screenshot capture and BEFORE the reporter
            //    Dialog mounts (capture-before-reporter ordering, mirroring iOS).
            //    This guarantees the reporter UI is never recorded into the
            //    replay. No-op when replay is OFF (lifecycle IDLE).
            val reportCapture = Everframe.__replayFreeze()
            frozenCapture = reportCapture

            // 0b. Final whole-branch review, fix round 2, Critical 1 — re-warm
            //     the identity cache the INSTANT the reporter opens, same
            //     rationale as the replay freeze above: real time before the
            //     Send tap, off the capture's own critical path. Without this,
            //     a provider-form host worked for exactly one token lifetime
            //     (at most 10 minutes) after `setIdentityToken` and then went
            //     permanently anonymous — see `Everframe.__warmIdentityToken`'s
            //     doc comment for the full chain.
            //
            //     ACCEPTED LIMITATION (independent review, round 7) — this
            //     warm is fire-and-forget, not awaited: `__warmIdentityToken()`
            //     launches its own coroutine and returns immediately, giving
            //     the provider up to `IDENTITY_PROVIDER_TIMEOUT_MS` (2s) to
            //     answer in the background. If the cache was already cold when
            //     the reporter opened (the previous token aged past
            //     `IDENTITY_REFRESH_MARGIN_MS`) and the user fills in a
            //     title/description and taps Send faster than their own
            //     backend responds, the SYNCHRONOUS capture below reads the
            //     still-cold cache, stamps `identitySubject` null, and the
            //     report ships anonymous — even though the warm would have
            //     completed moments later.
            //
            //     Deliberately not fixed. Both alternatives are worse than the
            //     defect:
            //       - Awaiting the warm here would make
            //         `captureUserSnapshot()`'s synchronous, non-blocking
            //         contract meaningless one call site removed — this
            //         function would block the Send-tap-adjacent path on an
            //         arbitrary host network call, trading a GUARANTEED cost
            //         (a stalled capture, on the UI path, up to 2s every time)
            //         for a PROBABILISTIC benefit (better attribution only on
            //         the rare cold-cache-plus-fast-Send case).
            //       - Re-resolving identity at submit time when the captured
            //         subject is null would break the capture-time binding
            //         this whole feature is built on: it is exactly "resolve
            //         against the live identity instead of the captured one"
            //         — Alice opens the reporter anonymous, Bob signs in
            //         before she taps Send, and the report resolves to Bob.
            //         That misattribution is the one failure this design says
            //         is never acceptable; losing attribution (this case) is
            //         the one the spec explicitly nominates as acceptable
            //         instead.
            //     The window is also narrow in practice: it requires BOTH a
            //     cold cache at reporter-open AND a user who fills in the form
            //     and taps Send faster than the identity provider's own
            //     backend answers. See `the user-recognition contract` for
            //     the host-facing statement of this limitation, alongside the
            //     launch-drain and crash-path ones.
            Everframe.__warmIdentityToken()

            // 1. Walk sensitive rects PRE-PixelCopy
            val rects = SensitiveRectRegistry.collectInWindowCoords(activity)

            // 2. Capture; bake-black inside ScreenshotCapture (PRIV-03)
            val capture = captureScreenshot(activity, rects)

            if (capture == null) return@txGuardSuspend ReportResult.Cancelled("capture_failed")
            if (!isCurrent()) return@txGuardSuspend ReportResult.Cancelled("no_active_activity")

            // 3. Show the phone/tablet Compose Dialog. (Android TV used to
            //    hand off to a separate :everframe-tv Activity; that module
            //    was removed — TV reports go through the phone companion.)
            return@txGuardSuspend showDialog(activity, capture, reportCapture, hostExtraNormalized, onDismissed)
        }
        // Send hands the capture to its submission, which releases it when the
        // upload ends. A caller cancelled after Send must not empty it mid-upload,
        // and stays presenting until the upload settles, so that no other report
        // freezes an empty capture meanwhile. The upload's outcome is the result.
        val submission = if (result == null) frozenCapture?.let { SubmittedCaptures.submissionOf(it) } else null
        if (submission != null) frozenCapture = null
        val final = result
            ?: submission?.let { sent -> kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) { sent.await() } }
            ?: ReportResult.Cancelled("presenter_failed")
        // Parity with iOS resolveResult (TXReporterPresenter.swift:161-163):
        // a cancelled reporter must not leave a frozen snapshot pinned under
        // the next report. Submit paths consume and release their explicit handle.
        if (final is ReportResult.Cancelled) {
            frozenCapture?.cancel()
        }
        submitted = final !is ReportResult.Cancelled
        return final
        } finally {
            if (submitted) frozenCapture?.finishConsumption() else frozenCapture?.cancel()
            Everframe.report.__setPresenting(false)
        }
    }

    /** One presentation, shared by every open that arrives while it is in flight. */
    private class Flight(activity: Activity) {
        val result = CompletableDeferred<ReportResult>()
        private val owner = WeakReference(activity)

        /** The dialog has left the screen: at Send, before the upload, or at cancel. */
        @Volatile var dismissed = false

        /**
         * Before Send, its activity is finishing, destroyed or collected, taking
         * the dialog with it. After Send the upload settles the result regardless.
         */
        val abandoned: Boolean
            get() = !dismissed && owner.get().let { it == null || it.isFinishing || it.isDestroyed }
    }

    internal companion object {
        private val lock = Any()
        private var inFlight: Flight? = null

        /** Tests only: forget a flight that an earlier test left in this process. */
        internal fun __resetSingleFlightForTesting() {
            synchronized(lock) { inFlight = null }
        }
    }
}
