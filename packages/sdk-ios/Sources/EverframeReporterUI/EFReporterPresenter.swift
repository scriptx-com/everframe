// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Async/await seam between the public ReportAPI.open() entry point and the
// UIKit reporter view controller. Wraps the imperative onComplete-callback
// world of UIKit in a CheckedContinuation so callers can `await report.open()`.
//
// Capture-before-reporter ordering (T-04-24, Pitfall 25 LOCKED):
//   1. Call ScreenshotCapture.captureKeyWindow() — this targets the host's
//      foreground key window, which at this point is NOT our reporter window
//      (we haven't constructed it yet).
//   2. Construct ReporterWindowController + present.
// Step 1 MUST happen before step 2. Otherwise the reporter UIWindow becomes
// the key window and the screenshot would render the reporter chrome itself.
//
// This file does not install bubble or TV-key triggers; native mobile shake
// is observed by EverframeKit's existing UIWindow event interception. Here we wire
// `ReportAPI.__resolver` so `await Everframe.shared.report.open()` resolves
// here, AND wires `ReportAPI.__setPresenting` so the Everframe SDK's `report.isPresenting`
// observable surface flips around the present/dismiss cycle.
import Foundation
// tvOS modal reporter removed — TV apps route reporting through the
// phone-companion (QR → phone browser) flow instead.
#if canImport(UIKit) && !os(tvOS)
import UIKit
import EverframeKit
import EverframeProtocol

@MainActor
public enum EFReporterPresenter {
    private static var pendingResolve: ((Result<ReportResult, Error>) -> Void)?
    private static var controller: ReporterWindowController?

    /// One-shot installer — wires ReportAPI.__resolver so `await Everframe.shared.report.open()`
    /// resolves through this presenter, AND wires ReportAPI.__setPresenting so the
    /// presenter is the single writer of `report.isPresenting`. Hosts must call
    /// this once at app launch (typical placement: alongside `Everframe.shared.start(...)`).
    /// Without this hook ReportAPI.open() throws NotImplementedError.openInPlan04_06.
    public static func installResolver() {
        ReportAPI.__resolver = {
            try await EFReporterPresenter.openAndAwait()
        }
        // Single-writer wiring for `report.isPresenting`. The presenter is the
        // only site that flips the flag; hosts read it via Combine `@Published`
        // or the `everframeReporterPresentingChange` Notification.
        ReportAPI.__setPresenting = { value in
            // Hop to MainActor; ReportAPI exposes a static helper that performs
            // the actual private(set) write on the singleton's instance.
            Task { @MainActor in
                ReportAPI.__performSetPresenting(value)
            }
        }
        // Built-in attach-PIN surface (spec 2026-08-19). This gate is
        // iOS-only (`#if canImport(UIKit) && !os(tvOS)`); tvOS hosts have no
        // `installResolver()` to piggyback on (TV apps route reporting
        // through phone-companion, not this modal reporter) and call
        // `CompanionPinPresenter.install()` directly per its own doc comment.
        CompanionPinPresenter.install()
    }

    /// Opens the reporter and resolves when the user submits or cancels.
    /// Idempotency: if a reporter is already open, the second call resolves
    /// immediately with .cancelled (we never stack reporter windows).
    public static func openAndAwait() async throws -> ReportResult {
        if pendingResolve != nil { return .cancelled }

        // Final whole-branch review, fix round 2, Critical 1 — re-warm the
        // identity cache the INSTANT the reporter opens, same rationale as
        // the replay freeze below: real time before the Send tap, off the
        // capture's own critical path. Without this, a provider-form host
        // worked for exactly one token lifetime (at most 10 minutes) after
        // `setIdentityToken` and then went permanently anonymous — see
        // `Everframe.__warmIdentityToken()`'s doc comment for the full chain.
        // Fired before capture (not just "somewhere in this function") to
        // give the provider the maximum time to resolve before Send.
        //
        // ACCEPTED LIMITATION (independent review, round 7) — this warm is
        // fire-and-forget, not awaited: `__warmIdentityToken()` returns
        // immediately and the provider is given up to `IDENTITY_PROVIDER_TIMEOUT`
        // (2s) to answer in the background. If the cache was already cold when
        // the reporter opened (the previous token aged past
        // `IDENTITY_REFRESH_MARGIN`) and the user fills in a title/description
        // and taps Send faster than their own backend responds, the SYNCHRONOUS
        // capture below reads the still-cold cache, stamps `identitySubject`
        // nil, and the report ships anonymous — even though the warm would have
        // completed moments later.
        //
        // Deliberately not fixed. Both alternatives are worse than the defect:
        //   - Awaiting the warm here would make `captureUserSnapshot()`'s
        //     synchronous, non-blocking contract meaningless one call site
        //     removed — this function would block the Send-tap-adjacent path
        //     on an arbitrary host network call, trading a GUARANTEED cost (a
        //     stalled capture, on the UI path, up to 2s every time) for a
        //     PROBABILISTIC benefit (better attribution only on the rare
        //     cold-cache-plus-fast-Send case).
        //   - Re-resolving identity at submit time when the captured subject
        //     is nil would break the capture-time binding this whole feature
        //     is built on: it is exactly "resolve against the live identity
        //     instead of the captured one" — Alice opens the reporter
        //     anonymous, Bob signs in before she taps Send, and the report
        //     resolves to Bob. That misattribution is the one failure this
        //     design says is never acceptable; losing attribution (this case)
        //     is the one the spec explicitly nominates as acceptable instead.
        // The window is also narrow in practice: it requires BOTH a cold cache
        // at reporter-open AND a user who fills in the form and taps Send
        // faster than the identity provider's own backend answers. See
        // `the user-recognition contract` for the host-facing statement of
        // this limitation, alongside the launch-drain and crash-path ones.
        Everframe.shared.__warmIdentityToken()

        // CAPTURE FIRST — capture-before-reporter ordering invariant (T-04-24).
        // EverframeReporter window not yet constructed, so the reporter chrome is not
        // picked up by the screenshot.
        let captureResult = ScreenshotCapture.captureKeyWindow()

        // Phase 22-04 (VTREE-02): freeze the session-replay buffer NOW — at the
        // top of reporter-open, BEFORE the reporter UIWindow is constructed below.
        // This is the same capture-before-reporter ordering as the screenshot
        // above: the freeze promotes the rolling buffer to a frozen window
        // and stops the sampling tick, so the reporter chrome is NEVER recorded.
        // No-op when replay is OFF. The frozen window is consumed on submit via
        // ReporterSubmission (lifecycle.complete) or discarded on cancel below.
        Everframe.shared.__replayFreeze()   // lifecycle freeze at reporter-open

        // Drain host-attached sticky payload now (NOT inside ReporterSubmission)
        // so the VC can preview it and the user can toggle inclusion via the
        // section include-switches. The sticky state is consumed once per
        // open — same auto-clear semantics as before; what changes is where
        // in the flow the drain happens.
        //
        // The second element (a host-attached React fiber tree) is drained and
        // DISCARDED: tap-to-identify is gone (spec 2026-08-29) and nothing
        // consumes `payload.reactTree` any more. `Everframe.attachReactTree`
        // stays on the native public surface for pure-native hosts (the RN
        // TurboModule method is gone); draining keeps its consume-once
        // contract honest.
        let (hostExtra, _) = await Everframe.shared.__consumePendingAttachments()
        let hostExtraNormalized = (hostExtra?.isEmpty == true) ? nil : hostExtra

        // Flip presenting=true now that capture is done and we are about to
        // actually present.
        ReportAPI.__setPresenting?(true)

        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<ReportResult, Error>) in
            pendingResolve = { result in
                switch result {
                case .success(let r): cont.resume(returning: r)
                case .failure(let e): cont.resume(throwing: e)
                }
            }
            // Branding (iOS spec 2026-08-26, Approach A): resolve ONCE per
            // presentation from the server box + the host's inline option. Fail
            // closed: no validated config ⇒ watermark shown, default palette.
            let brandingServer = BrandingServerConfigBox.shared.value
            let palette = ResolvedPalette(
                ThemeResolver.resolve(server: brandingServer, inline: Everframe.shared.currentConfig?.theme)
            )
            let showWatermark = shouldShowWatermark(brandingServer)

            let wc = ReporterWindowController()
            self.controller = wc
            let vc = EFReporterViewController(
                captureResult: captureResult,
                hostExtra: hostExtraNormalized,
                palette: palette,
                showWatermark: showWatermark,
                onComplete: { result in resolveResult(result) }
            )
            let nav = UINavigationController(rootViewController: vc)
            nav.modalPresentationStyle = .formSheet
            wc.present(rootController: nav)
        }
    }

    /// Internal — invoked by EFReporterViewController on Send / Cancel.
    static func resolveResult(_ result: Result<ReportResult, Error>) {
        controller?.dismiss()
        controller = nil
        let resolve = pendingResolve
        pendingResolve = nil

        // Phase 22-04 (VTREE-02): if the user CANCELLED (or the flow errored),
        // discard the frozen replay window + resume a fresh buffer. The SUBMIT
        // path instead consumes the frozen window via ReporterSubmission
        // (__replayComplete) before this resolve fires, so we only cancel on a
        // non-submit outcome. No-op when replay is OFF.
        switch result {
        case .success(.submitted), .success(.queued):
            Everframe.shared.__replayReporterDidClose()
        case .success(.cancelled), .failure:
            Everframe.shared.__replayCancel()
        }
        // Flip presenting=false BEFORE resolving so observers seeing the
        // continuation's resume have already seen the state transition.
        ReportAPI.__setPresenting?(false)
        resolve?(result)
    }

    /// Test seam — synchronously resolve a pending presentation. Used by
    /// ReporterFlowSmokeTest to verify the cancellation path round-trips
    /// through the continuation without standing up an actual UIWindowScene.
    public static func __resolveForTesting(_ result: ReportResult) {
        resolveResult(.success(result))
    }
}
#endif
