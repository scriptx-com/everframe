// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The quick-capture confirmation toast. Created only after the screenshot,
// in its own overlay window that `ScreenshotCapture.activeKeyWindow()` filters
// out, so neither this capture nor the next one (nor a replay frame) shows
// it. Same window mechanics as the companion badge: never key, never
// interactive, `.alert + 2`. On Apple TV it uses the TV sizes, and its root
// controller offers nothing to focus.
#if canImport(UIKit)
import UIKit

final class EFQuickCaptureToastWindow: EFOverlayWindow {}

@MainActor
enum QuickCaptureToast {
    static let windowLevel: UIWindow.Level = .alert + 2
    static let visibleSeconds: Double = 1.6
    static let fadeSeconds: Double = 0.3

    private static var window: EFQuickCaptureToastWindow?
    private static var generation = 0
    /// Replaces the foreground scene's window in tests (a test bundle has no scene).
    static var __windowFactoryForTesting: (() -> EFQuickCaptureToastWindow)?
    static var __windowForTesting: EFQuickCaptureToastWindow? { window }
    static func __dismissForTesting() { dismiss() }

    /// Shown when the capture is handed off, before its upload finishes.
    nonisolated static func confirmedText(deviceName: String) -> String { "Captured · \(deviceName)" }

    /// The toast after the pipeline ends, if any. A sent or queued capture was
    /// already confirmed and says nothing more; an ignored trigger never does.
    nonisolated static func text(for outcome: QuickCaptureOutcome) -> String? {
        switch outcome {
        case .sent, .queued, .ignored: return nil
        case .failed: return "Capture failed"
        case .rejected: return "Capture didn't upload"
        case .unlinked: return "This device was unlinked"
        }
    }

    static func show(text: String) {
        guard let overlay = makeWindow() else { return }
        dismiss()
        let style = OverlayStyle.current
        overlay.windowLevel = windowLevel
        overlay.backgroundColor = .clear
        overlay.isUserInteractionEnabled = false
        let root = EFOverlayRootViewController()
        overlay.rootViewController = root

        let pill = UIView()
        pill.backgroundColor = UIColor.black.withAlphaComponent(0.75)
        pill.layer.cornerRadius = style.cornerRadius
        pill.layer.masksToBounds = true
        pill.translatesAutoresizingMaskIntoConstraints = false
        let label = UILabel()
        label.text = text
        label.textColor = .white
        label.font = .systemFont(ofSize: style.toastSize, weight: .semibold)
        label.textAlignment = .center
        label.numberOfLines = 1
        label.translatesAutoresizingMaskIntoConstraints = false
        pill.addSubview(label)
        root.view.addSubview(pill)
        let guide = root.view.safeAreaLayoutGuide
        // The toast is a little tighter than the banner (8 pt on a phone).
        let vPadding = (style.vPadding * 0.8).rounded()
        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: pill.topAnchor, constant: vPadding),
            label.bottomAnchor.constraint(equalTo: pill.bottomAnchor, constant: -vPadding),
            label.leadingAnchor.constraint(equalTo: pill.leadingAnchor, constant: style.hPadding),
            label.trailingAnchor.constraint(equalTo: pill.trailingAnchor, constant: -style.hPadding),
            pill.centerXAnchor.constraint(equalTo: guide.centerXAnchor),
            pill.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -style.bottomInset),
            pill.leadingAnchor.constraint(greaterThanOrEqualTo: guide.leadingAnchor, constant: 16),
            pill.trailingAnchor.constraint(lessThanOrEqualTo: guide.trailingAnchor, constant: -16),
        ])
        if let maxWidth = style.maxWidth {
            pill.widthAnchor.constraint(lessThanOrEqualToConstant: maxWidth).isActive = true
        }
        UIAccessibility.post(notification: .announcement, argument: text)

        // Never `makeKeyAndVisible()`: the toast must not take key focus.
        overlay.isHidden = false
        window = overlay
        generation += 1
        let shown = generation
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(visibleSeconds * 1_000_000_000))
            guard shown == generation else { return }
            UIView.animate(withDuration: fadeSeconds, animations: { pill.alpha = 0 }, completion: { _ in
                guard shown == generation else { return }
                dismiss()
            })
        }
    }

    private static func makeWindow() -> EFQuickCaptureToastWindow? {
        if let factory = __windowFactoryForTesting { return factory() }
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive })
        else { return nil }
        return EFQuickCaptureToastWindow(windowScene: scene)
    }

    private static func dismiss() {
        window?.isHidden = true
        window?.rootViewController = nil
        window = nil
    }
}
#endif
