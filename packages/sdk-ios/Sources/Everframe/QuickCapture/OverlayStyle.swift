// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Sizes for the quick-capture toast and the device-link banner, and the root
// controller both overlay windows use. On Apple TV the text is read from a
// sofa, so it is larger, and the overlay must never take focus: a window that
// pulls the focus engine away leaves the app's remote navigation dead.
#if canImport(UIKit)
import UIKit

struct OverlayStyle: Equatable {
    var titleSize: CGFloat
    var sublineSize: CGFloat
    var toastSize: CGFloat
    /// Extra inset from the safe area's top (banner) and bottom (toast).
    var topInset: CGFloat
    var bottomInset: CGFloat
    var hPadding: CGFloat
    var vPadding: CGFloat
    var cornerRadius: CGFloat
    var maxWidth: CGFloat?

    static let phone = OverlayStyle(
        titleSize: 15, sublineSize: 13, toastSize: 15, topInset: 12, bottomInset: 24,
        hPadding: 16, vPadding: 10, cornerRadius: 16, maxWidth: nil)

    /// tvOS safe areas already inset for overscan, so no extra inset.
    static let tv = OverlayStyle(
        titleSize: 38, sublineSize: 29, toastSize: 31, topInset: 0, bottomInset: 0,
        hPadding: 32, vPadding: 20, cornerRadius: 28, maxWidth: 1200)

    static var current: OverlayStyle {
        #if os(tvOS)
        return .tv
        #else
        return .phone
        #endif
    }
}

/// An overlay window that can never become key, so it never takes keyboard or
/// focus-engine input from the app.
class EFOverlayWindow: UIWindow {
    override var canBecomeKey: Bool { false }
}

/// The root of the toast and banner windows: no focusable item, no preferred
/// focus, no interaction.
final class EFOverlayRootViewController: UIViewController {
    private final class OverlayView: UIView {
        override var canBecomeFocused: Bool { false }
    }

    override func loadView() {
        let view = OverlayView()
        view.backgroundColor = .clear
        view.isUserInteractionEnabled = false
        self.view = view
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        restoresFocusAfterTransition = false
    }

    override var preferredFocusEnvironments: [UIFocusEnvironment] { [] }
}
#endif
