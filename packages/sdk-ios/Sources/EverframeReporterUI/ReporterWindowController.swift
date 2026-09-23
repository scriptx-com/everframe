// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Hosts the reporter modal in a SEPARATE UIWindow at windowLevel = .alert + 1
// attached to the active foreground UIWindowScene.
//
// Rationale (RESEARCH Finding 7 + Pitfall 6):
//   • Using a dedicated UIWindow keeps the reporter floating above the host's
//     existing window stack without mutating the host's root view controller.
//   • windowLevel = .alert + 1 sits above system alerts (we never want the
//     reporter to be obscured) but below the bubble-trigger window (.normal + 1)
//     because the bubble must remain reachable when the reporter is dismissed.
//   • Targeting `UIWindowScene.activationState == .foregroundActive` (NOT the
//     deprecated shared-screen API) is mandatory for Stage Manager / external
//     display safety — we never want to attach the reporter to a backgrounded scene.
//   • On dismiss we explicitly restore the previously-key window so the host
//     regains keyboard / first-responder focus (Pitfall 25 — modal focus stability).
//
// Capture-before-reporter ordering invariant (T-04-24): callers MUST run
// `ScreenshotCapture.captureKeyWindow()` BEFORE calling `present(...)` on this
// controller. Once our UIWindow becomes key, any subsequent capture would render
// the reporter chrome itself (self-capture).
#if canImport(UIKit)
import UIKit

@MainActor
final class ReporterWindowController {
    private var window: UIWindow?
    private weak var previousKeyWindow: UIWindow?

    /// Task 9 (area capture) plumbing — `EFReporterViewController` has no
    /// other handle back to the UIWindow that hosts it (it's constructed
    /// here, not passed in). Weak + static: `EFReporterPresenter.openAndAwait`
    /// guarantees only one reporter is ever presented at a time (idempotency
    /// check up front), so a single static slot is sufficient; weak so this
    /// mirror never keeps the window alive past `dismiss()`/`present()`
    /// reassigning it.
    private(set) static weak var currentWindow: UIWindow?

    func present(rootController: UIViewController) {
        guard let scene = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .first(where: { $0.activationState == .foregroundActive })
        else { return }
        previousKeyWindow = scene.windows.first(where: { $0.isKeyWindow })
        let w = UIWindow(windowScene: scene)
        w.windowLevel = .alert + 1
        w.backgroundColor = .clear
        w.rootViewController = rootController
        w.makeKeyAndVisible()
        self.window = w
        Self.currentWindow = w
    }

    func dismiss() {
        window?.isHidden = true
        window?.windowScene = nil
        window = nil
        previousKeyWindow?.makeKey()
        Self.currentWindow = nil
    }

    /// Test seam — exposes the underlying UIWindow so smoke tests can assert
    /// windowLevel and key-window restoration invariants.
    var __windowForTesting: UIWindow? { window }
}
#endif
