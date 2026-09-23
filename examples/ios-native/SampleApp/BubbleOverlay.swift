// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// BubbleOverlay — sample-owned floating-bubble trigger for iOS / iPadOS.
//
// Phase 05.1 contract (D-01): floating bubble overlays are a HOST-APP concern,
// not Everframe SDK code. This file is the canonical iOS recipe. It is NOT promoted to
// the Everframe SDK; it lives in the sample so hosts can copy/paste and adapt.
//
// Recipe (per RESEARCH Q5 finding 5):
//   • A separate `UIWindow` at `windowLevel = .normal + 1` keeps the bubble
//     visible across every host screen, including modals the host presents in
//     its own windows. We sit BELOW the reporter window (`.alert + 1`) so the
//     reporter draws over us.
//   • A `BubblePassthroughWindow` subclass overrides `hitTest(_:with:)` to
//     return the bubble button only when the tap is inside its frame; every
//     other tap returns nil so the touch forwards to the host's UI underneath.
//     Without this trick, the overlay window would swallow every touch.
//   • Pure UIKit — UIButton inside a UIViewController. We skip SwiftUI here
//     because UIHostingController's root view captures all touches inside its
//     frame, defeating the passthrough trick (early implementation tried
//     SwiftUI + Color.clear and the bubble appeared to "depress visually" on
//     tap but the action never ran because the hosting view ate the gesture).
//
// Caveats / what we deliberately do NOT do:
//   • No SYSTEM_ALERT_WINDOW equivalent — we stay inside the host's
//     `UIWindowScene`. The bubble disappears when the app is backgrounded.
//   • No drag handling in this minimal recipe — bubbles can be made draggable
//     with a `UIPanGestureRecognizer` but we keep this short.
//   • No persistence of bubble position — pinned bottom-right with safe-area
//     insets. Hosts that want left-/top-anchored placement edit the layout
//     constraints in `BubbleRootController.viewDidLoad`.

import UIKit
import Combine
import EverframeKit

@MainActor
enum BubbleOverlay {
    /// One bubble window per scene. Stored as a strong reference so it isn't
    /// deallocated by ARC after `install` returns.
    private static var window: BubblePassthroughWindow?

    /// Install the bubble overlay on the first foreground-active
    /// `UIWindowScene`. Idempotent — calling twice is a no-op.
    static func install() {
        guard window == nil else { return }
        guard let scene = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .first(where: { $0.activationState == .foregroundActive
                              || $0.activationState == .foregroundInactive })
        else {
            // No scene yet (init() ran before scene attached). Retry shortly.
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 200_000_000)
                install()
            }
            return
        }

        let w = BubblePassthroughWindow(windowScene: scene)
        w.windowLevel = .normal + 1
        w.backgroundColor = .clear
        w.isHidden = false
        w.rootViewController = BubbleRootController()
        // Do NOT call makeKeyAndVisible — the bubble window must NOT be key,
        // otherwise it steals first-responder from the host's text fields etc.
        window = w
    }
}

/// UIWindow subclass whose `hitTest` only claims taps that land inside the
/// bubble button's frame. Every other tap returns nil so the touch forwards
/// to the host's UI underneath. Without this, the overlay window would
/// swallow every tap on screen.
private final class BubblePassthroughWindow: UIWindow {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard let root = rootViewController as? BubbleRootController,
              let bubble = root.bubbleButton
        else { return nil }
        // Convert the window-space point into the bubble's superview-space.
        let pointInBubble = bubble.convert(point, from: self)
        guard bubble.bounds.contains(pointInBubble) else {
            return nil  // forward to host's window stack
        }
        return super.hitTest(point, with: event)
    }
}

/// Root view controller hosting a single circular UIButton anchored
/// bottom-right with safe-area insets. Subscribes to `report.isPresenting`
/// to disable + dim the button while the reporter is up — exercises the new
/// `@Published` Combine surface.
@MainActor
private final class BubbleRootController: UIViewController {
    fileprivate var bubbleButton: UIButton?
    private var cancellables = Set<AnyCancellable>()

    override func loadView() {
        // Transparent root view — required so the bubble window doesn't paint
        // over the host (and so our hitTest can decide whether to forward).
        let v = UIView()
        v.backgroundColor = .clear
        view = v
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        let button = UIButton(type: .system)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.backgroundColor = .systemBlue
        button.tintColor = .white
        button.setImage(UIImage(systemName: "ladybug.fill",
                                withConfiguration: UIImage.SymbolConfiguration(pointSize: 22, weight: .semibold)),
                        for: .normal)
        button.layer.cornerRadius = 28
        button.layer.shadowColor = UIColor.black.cgColor
        button.layer.shadowOpacity = 0.25
        button.layer.shadowOffset = CGSize(width: 0, height: 3)
        button.layer.shadowRadius = 6
        button.accessibilityLabel = "Open Everframe reporter"
        button.addTarget(self, action: #selector(bubbleTapped), for: .touchUpInside)

        view.addSubview(button)
        NSLayoutConstraint.activate([
            button.widthAnchor.constraint(equalToConstant: 56),
            button.heightAnchor.constraint(equalToConstant: 56),
            button.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
            button.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -16),
        ])
        bubbleButton = button

        // Bind isPresenting → button.isEnabled + alpha. Combine surface from
        // Phase 05.1: ReportAPI is an ObservableObject; isPresenting is
        // @Published.
        Everframe.shared.report.$isPresenting
            .receive(on: DispatchQueue.main)
            .sink { [weak button] presenting in
                button?.isEnabled = !presenting
                button?.alpha = presenting ? 0.4 : 1.0
            }
            .store(in: &cancellables)
    }

    @objc private func bubbleTapped() {
        Task { try? await Everframe.shared.report.open() }
    }
}
