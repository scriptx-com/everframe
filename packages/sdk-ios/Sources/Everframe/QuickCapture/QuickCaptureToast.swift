// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The quick-capture confirmation toast. Created only after the screenshot,
// in its own overlay window that `ScreenshotCapture.activeKeyWindow()` filters
// out, so neither this capture nor the next one (nor a replay frame) shows
// it. Never key, never interactive, `.alert + 2`.
#if canImport(UIKit)
import UIKit

final class EFQuickCaptureToastWindow: UIWindow {}

@MainActor
enum QuickCaptureToast {
    static let windowLevel: UIWindow.Level = .alert + 2
    static let visibleSeconds: Double = 1.6
    static let fadeSeconds: Double = 0.3

    private static var window: EFQuickCaptureToastWindow?
    private static var generation = 0

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
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive })
        else { return }
        dismiss()

        let overlay = EFQuickCaptureToastWindow(windowScene: scene)
        overlay.windowLevel = windowLevel
        overlay.backgroundColor = .clear
        overlay.isUserInteractionEnabled = false
        let root = UIViewController()
        root.view.backgroundColor = .clear
        root.view.isUserInteractionEnabled = false
        overlay.rootViewController = root

        let pill = UIView()
        pill.backgroundColor = UIColor.black.withAlphaComponent(0.75)
        pill.layer.cornerRadius = 16
        pill.layer.masksToBounds = true
        pill.translatesAutoresizingMaskIntoConstraints = false
        let label = UILabel()
        label.text = text
        label.textColor = .white
        label.font = .systemFont(ofSize: 15, weight: .semibold)
        label.textAlignment = .center
        label.numberOfLines = 1
        label.translatesAutoresizingMaskIntoConstraints = false
        pill.addSubview(label)
        root.view.addSubview(pill)
        let guide = root.view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: pill.topAnchor, constant: 8),
            label.bottomAnchor.constraint(equalTo: pill.bottomAnchor, constant: -8),
            label.leadingAnchor.constraint(equalTo: pill.leadingAnchor, constant: 16),
            label.trailingAnchor.constraint(equalTo: pill.trailingAnchor, constant: -16),
            pill.centerXAnchor.constraint(equalTo: guide.centerXAnchor),
            pill.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -24),
            pill.leadingAnchor.constraint(greaterThanOrEqualTo: guide.leadingAnchor, constant: 16),
            pill.trailingAnchor.constraint(lessThanOrEqualTo: guide.trailingAnchor, constant: -16),
        ])
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

    private static func dismiss() {
        window?.isHidden = true
        window?.rootViewController = nil
        window = nil
    }
}
#endif
