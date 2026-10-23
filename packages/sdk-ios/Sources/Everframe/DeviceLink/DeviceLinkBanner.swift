// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The banner shown while a device is linking: "Linking to Everframe · 47",
// with a subline for the rare end user who shakes during a teammate's link
// window. Same window mechanics as `QuickCaptureToast`: its own overlay window
// that `ScreenshotCapture.activeKeyWindow()` filters out, never key, never
// interactive, `.alert + 2`. It stays until `hide()`. On Apple TV it uses the
// TV sizes, and its root controller offers nothing to focus, so the app's
// remote navigation keeps working while it shows.
#if canImport(UIKit)
import UIKit

final class EFDeviceLinkBannerWindow: EFOverlayWindow {}

@MainActor
enum DeviceLinkBanner {
    static let windowLevel: UIWindow.Level = .alert + 2
    static let subtitle = "A teammate is linking a device. If that's not you, ignore this."

    private static var window: EFDeviceLinkBannerWindow?
    /// Replaces the foreground scene's window in tests (a test bundle has no scene).
    static var __windowFactoryForTesting: (() -> EFDeviceLinkBannerWindow)?
    static var __windowForTesting: EFDeviceLinkBannerWindow? { window }

    static func title(number: Int) -> String { "Linking to Everframe · \(number)" }

    static var isShowing: Bool { window != nil }

    /// Shows the banner, replacing any banner already showing. Does nothing
    /// without a foreground-active scene.
    static func show(number: Int) {
        hide()
        guard let overlay = makeWindow() else { return }
        let style = OverlayStyle.current
        overlay.windowLevel = windowLevel
        overlay.backgroundColor = .clear
        overlay.isUserInteractionEnabled = false
        let root = EFOverlayRootViewController()
        overlay.rootViewController = root

        let pill = UIView()
        pill.backgroundColor = UIColor.black.withAlphaComponent(0.8)
        pill.layer.cornerRadius = style.cornerRadius
        pill.layer.masksToBounds = true
        pill.translatesAutoresizingMaskIntoConstraints = false

        let titleLabel = UILabel()
        titleLabel.text = title(number: number)
        titleLabel.textColor = .white
        titleLabel.font = .systemFont(ofSize: style.titleSize, weight: .semibold)
        titleLabel.textAlignment = .center
        titleLabel.numberOfLines = 1

        let subtitleLabel = UILabel()
        subtitleLabel.text = subtitle
        subtitleLabel.textColor = UIColor.white.withAlphaComponent(0.85)
        subtitleLabel.font = .systemFont(ofSize: style.sublineSize, weight: .regular)
        subtitleLabel.textAlignment = .center
        subtitleLabel.numberOfLines = 0

        let stack = UIStackView(arrangedSubviews: [titleLabel, subtitleLabel])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 2
        stack.translatesAutoresizingMaskIntoConstraints = false
        pill.addSubview(stack)
        root.view.addSubview(pill)
        let guide = root.view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: pill.topAnchor, constant: style.vPadding),
            stack.bottomAnchor.constraint(equalTo: pill.bottomAnchor, constant: -style.vPadding),
            stack.leadingAnchor.constraint(equalTo: pill.leadingAnchor, constant: style.hPadding),
            stack.trailingAnchor.constraint(equalTo: pill.trailingAnchor, constant: -style.hPadding),
            pill.centerXAnchor.constraint(equalTo: guide.centerXAnchor),
            pill.topAnchor.constraint(equalTo: guide.topAnchor, constant: style.topInset),
            pill.leadingAnchor.constraint(greaterThanOrEqualTo: guide.leadingAnchor, constant: 16),
            pill.trailingAnchor.constraint(lessThanOrEqualTo: guide.trailingAnchor, constant: -16),
        ])
        if let maxWidth = style.maxWidth {
            pill.widthAnchor.constraint(lessThanOrEqualToConstant: maxWidth).isActive = true
        }
        UIAccessibility.post(notification: .announcement, argument: title(number: number))

        // Never `makeKeyAndVisible()`: the banner must not take key focus.
        overlay.isHidden = false
        window = overlay
    }

    private static func makeWindow() -> EFDeviceLinkBannerWindow? {
        if let factory = __windowFactoryForTesting { return factory() }
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive })
        else { return nil }
        return EFDeviceLinkBannerWindow(windowScene: scene)
    }

    static func hide() {
        window?.isHidden = true
        window?.rootViewController = nil
        window = nil
    }
}
#endif
