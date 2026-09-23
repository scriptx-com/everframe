// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Companion device-naming badge (spec 2026-08-24, Task 5).
//
// IDENTIFICATION ONLY. This is a small "paired as <name>" / "<code>" label so
// whoever is standing in front of the TV can confirm which device the
// dashboard is talking to. It is NOT the fail-closed "Sharing screen to
// phone" indicator removed 2026-08-13 (`git show 4011fad0` —
// `CompanionSharingIndicator.swift`, ported from spec 2026-07-17 §3) and it
// must NEVER be cited as a privacy mitigation. That indicator's whole reason
// to exist was refusing to let a preview stream without host-visible proof;
// this badge has no such veto. `CompanionPreviewSession` does not consult it,
// `enabled = false` only removes the label, and there is no `show() -> Bool`
// for a caller to gate on. If a future feature needs a fail-closed,
// provably-on-screen guarantee again, that is a new control, not a repaint of
// this one.
//
// Reuses ONLY the window-mechanics half of the removed indicator (same
// commit): a dedicated `UIWindow(windowScene:)` from the foreground-active
// scene, `windowLevel = .alert + 2`, `backgroundColor = .clear`,
// `isUserInteractionEnabled = false`, a plain `UIViewController` root,
// `isHidden = false`, and NEVER `makeKeyAndVisible()` — an overlay that could
// steal input or become key is a bug the host cannot escape from. None of the
// old fail-closed/visibility-proof machinery (the `Bool`-returning `show()`,
// the invisible-customView gate, the self-heal-every-tick contract) is
// reused: this badge is driven purely by `CompanionAPI` state transitions,
// not by a per-frame capture tick.
//
// Capture exclusion is STRUCTURAL, not a per-view opt-out: every capture path
// — screenshots, preview frames, VTree replay, UITree — resolves the host
// window through `ScreenshotCapture.activeKeyWindow()`
// (Capture/ScreenshotCapture.swift:238-253), which deliberately picks the
// LOWEST-level *visible* window. Anything above that level, including this
// badge's `.alert + 2` overlay, is skipped for free. `ReporterWindowController`
// sits at `.alert + 1` (ReporterUI/ReporterWindowController.swift:47) and
// `AreaCaptureViewController` / `CompanionPinPresenter` already share this
// badge's own `.alert + 2` — sharing a level with those is fine (cosmetic
// coexistence only): exclusion depends on being ABOVE the app's main window,
// not on holding a unique level.
//
// State: observes `CompanionAPI.$attachedUserName` / `$resolvedName` /
// `$code` (Tasks 1-2). Visible iff `attachedUserName != nil`, the composed
// label is non-empty, AND `CompanionBadgeResolution.enabled` resolves true —
// the dashboard-configured `companionBadge` server block (plan 2026-08-25),
// read via the injected `serverConfig` closure, wins per-field over
// `CompanionBadgeOptions.enabled`/`.position` when present; the inline option
// is the fallback, not the whole story. See `CompanionBadgeResolution` and
// `CompanionBadgeServerConfigBox` below.
// Label text is `[resolvedName, code].compactMap { $0 }.joined(separator: "
// · ")` (see `CompanionBadgeLabel.compose`, deliberately outside the UIKit
// gate below so it stays testable on the macOS host, where UIKit does not
// exist).
//
// Strict-concurrency (`EverframeKit` builds with `StrictConcurrency=complete`):
// `CompanionBadge` is `@unchecked Sendable`, NOT `@MainActor` — matching
// `RelayWSClient`'s own idiom (see that file's header) rather than
// `CompanionPinPresenter`'s (`EverframeReporterUI` has no strict-concurrency
// setting, so `@MainActor public enum` there compiles under looser checking
// that this target does not have). Every UIKit-touching method here is only
// ever entered from the Combine sink's `.receive(on: DispatchQueue.main)`
// callback, so correctness rests on that serialization, exactly like
// `RelayWSClient`'s own `stateLock`-guarded state rests on manual discipline
// rather than actor isolation. `__surfaceProvider` is `nonisolated(unsafe)`
// for the same reason `RelayWSClient.__scheduleReconnectHook` and friends are
// — a test-only seam, always touched from the main thread in both production
// and tests.
#if canImport(UIKit)
import UIKit
#endif
import Combine
import Foundation

/// Which corner of the safe area the badge attaches to. Bottom-right is the
/// default so it clears a top status bar / notch and a bottom home indicator
/// on phones without a host decision either way; hosts on TV layouts (the
/// primary companion consumer) may prefer a different corner depending on
/// where their own on-screen chrome lives.
public enum CompanionBadgePosition: Sendable, Equatable {
    case topLeft
    case topRight
    case bottomLeft
    case bottomRight
}

/// Host configuration for the companion name badge (spec 2026-08-24).
///
/// iOS has no start-options object the way `sdk-react`'s companion start call
/// does, so this mirrors that surface as closely as the platform allows: a
/// plain, all-defaulted struct captured ONCE by `RelayWSClient`'s
/// initializer (first-client-wins, matching web — a later config change
/// requires a fresh `RelayWSClient`, not a live mutation of a running one).
public struct CompanionBadgeOptions: Sendable, Equatable {
    /// Default ON. This is the INLINE fallback, consulted only where the
    /// dashboard-configured `companionBadge` server block (plan 2026-08-25,
    /// `CompanionBadgeResolution.enabled`) is absent — the server can still
    /// force-enable the badge over `enabled: false` here. Unlike the removed
    /// sharing indicator, there is nothing else here for a caller to gate
    /// behavior on.
    public var enabled: Bool
    public var position: CompanionBadgePosition

    public init(enabled: Bool = true, position: CompanionBadgePosition = .bottomRight) {
        self.enabled = enabled
        self.position = position
    }
}

/// Pure label composition, deliberately outside the `#if canImport(UIKit)`
/// gate below: `CompanionBadge` itself only exists where UIKit exists, so
/// without this split the one piece of genuinely host-testable logic here —
/// "what text does the badge show" — would report zero tests under the
/// macOS-host `swift test` job, same failure mode `TESTING.md` warns about
/// for every other UIKit-gated suite.
public enum CompanionBadgeLabel {
    public static func compose(resolvedName: String?, code: String?) -> String {
        [resolvedName, code].compactMap { $0 }.joined(separator: " · ")
    }
}

/// Thread-safe snapshot of the fetched server badge block (plan 2026-08-25).
/// Written by ReplaySession on every successful config apply (the same site
/// that writes `configBox.value`); read by CompanionBadge's default
/// `serverConfig` closure. Backed by a `CurrentValueSubject` — Combine
/// subjects are thread-safe on their own, but the class also keeps an
/// `NSLock`-guarded mirror so `value`'s getter stays a plain synchronous read
/// with no Combine round-trip on the hot apply path. A plain box rather than
/// a hop through `Everframe.currentReplayConfig()` because that accessor is
/// async (`@MainActor` into `_replaySession`) and the badge needs a sync read
/// on its apply path. Stays nil on platforms/paths with no replay session —
/// the badge then keeps its inline/default behavior.
///
/// Final-review fix (plan 2026-08-25, finding 2): natives had no trigger tied
/// to config refresh — `CompanionBadge` only re-applied on an identity-state
/// emission (iOS) or additionally `onActivityResumed` (Android, still
/// unbounded on an always-resumed TV app). A dashboard `enabled: false`
/// landed only at the NEXT identity/resume event, not at the next config
/// refresh. `publisher` turns this box into an extra TRIGGER source for
/// `CompanionBadge`'s existing Combine subscription — its element value is
/// never consumed by `apply()`, resolution still goes through the injected
/// `serverConfig` closure.
final class CompanionBadgeServerConfigBox: @unchecked Sendable {
    static let shared = CompanionBadgeServerConfigBox()
    private let lock = NSLock()
    private let subject = CurrentValueSubject<CompanionBadgeConfigWire?, Never>(nil)
    private var _value: CompanionBadgeConfigWire?
    var value: CompanionBadgeConfigWire? {
        get { lock.lock(); defer { lock.unlock() }; return _value }
        set {
            lock.lock()
            _value = newValue
            lock.unlock()
            subject.send(newValue)
        }
    }
    var publisher: AnyPublisher<CompanionBadgeConfigWire?, Never> {
        subject.eraseToAnyPublisher()
    }
}

/// Pure per-field precedence (plan 2026-08-25): server field when set (and,
/// for position, recognized) → inline option. Outside the UIKit gate so its
/// tests run on the macOS host (TESTING.md's false-green rule).
public enum CompanionBadgeResolution {
    public static func enabled(server: CompanionBadgeConfigWire?, inline: CompanionBadgeOptions) -> Bool {
        server?.enabled ?? inline.enabled
    }
    public static func position(server: CompanionBadgeConfigWire?, inline: CompanionBadgeOptions) -> CompanionBadgePosition {
        switch server?.position {
        case "bottom-right": return .bottomRight
        case "bottom-left": return .bottomLeft
        case "top-right": return .topRight
        case "top-left": return .topLeft
        default: return inline.position
        }
    }
}

#if canImport(UIKit)
/// Marker subclass for the badge's overlay window — external review, finding
/// N4. `ScreenshotCapture.activeKeyWindow()` used to pick the LOWEST-level
/// visible window as a proxy for "the host's main window", which is right
/// when the host's real window is genuinely there but wrong the moment it is
/// transiently hidden: with the host window's `isHidden` momentarily true
/// (a scene transition, a host animating its own window out and back), this
/// badge's own overlay becomes the lowest surviving candidate and capture
/// resolves to an Everframe SDK overlay — leaking the badge into every capture path
/// (screenshot, VTree, UITree, preview) that routes through
/// `activeKeyWindow()`. Naming the type lets `activeKeyWindow()` filter it
/// out BEFORE the level sort runs, independent of level/visibility timing.
final class EFCompanionBadgeWindow: UIWindow {}

public final class CompanionBadge: @unchecked Sendable {

    /// Host override for where the badge attaches. Nil (production) builds a
    /// dedicated overlay `UIWindow` via `defaultSurface()`. Tests inject a
    /// plain container view instead: a SwiftPM test bundle has NO UI scenes
    /// at all (`UIApplication.shared.connectedScenes` is empty — verified,
    /// same probe the removed sharing indicator's tests relied on), so
    /// `UIWindow(windowScene:)` cannot be constructed there and every attach
    /// assertion would otherwise be untestable.
    nonisolated(unsafe) static var __surfaceProvider: (() -> UIView?)?

    /// Must stay ABOVE `.alert + 1` (the reporter window) — see the file
    /// header for the full capture-exclusion argument and the
    /// `ScreenshotCapture.activeKeyWindow()` file:line it depends on.
    public static let windowLevel: UIWindow.Level = .alert + 2

    private let options: CompanionBadgeOptions
    private let serverConfig: () -> CompanionBadgeConfigWire?
    private var bag = Set<AnyCancellable>()
    private var overlayWindow: UIWindow?
    private var attachedLabel: UILabel?
    private var hostSurface: UIView?

    /// Codex round-1 fix E (findings 5+6) — the position `attachedLabel` was
    /// last constrained with. The "already up, just update text" fast path
    /// in `show(text:)` used to never re-run `activateConstraints`, so a
    /// dashboard position change (server `companionBadge.position` flipping
    /// mid-session) waited for a full hide/show cycle before it took effect.
    /// `nil` before the first attach.
    private var appliedPosition: CompanionBadgePosition?

    public var isVisible: Bool { attachedLabel != nil }

    /// Subscribes to `companion`'s published identity state and starts
    /// driving the badge immediately. Always subscribes, regardless of
    /// `options.enabled` — the dashboard-configured `serverConfig` block can
    /// force-enable the badge over an inline `enabled: false` (plan
    /// 2026-08-25), so the subscription has to exist for that precedence to
    /// be resolvable at every apply. `serverConfig` is `nil` by default,
    /// which reads the Everframe SDK's fetched-config snapshot — a sync read of
    /// `CompanionBadgeServerConfigBox.shared`, which `ReplaySession`
    /// snapshots on every successful config apply; tests inject a closure
    /// instead.
    public init(
        companion: CompanionAPI,
        options: CompanionBadgeOptions = CompanionBadgeOptions(),
        serverConfig: (() -> CompanionBadgeConfigWire?)? = nil
    ) {
        self.options = options
        self.serverConfig = serverConfig ?? { CompanionBadgeServerConfigBox.shared.value }
        // Final-review fix (plan 2026-08-25, finding 2): the server-config box
        // publisher is folded in as a 4th TRIGGER source, ALONGSIDE the
        // identity fields — not in place of them. Its element is deliberately
        // ignored in the sink below; `apply()` keeps its 3-arg signature and
        // resolution still goes through `serverConfig()`. This fires even when
        // a custom `serverConfig` closure is injected (tests): that extra
        // re-apply is harmless. `combineLatest` replays the box's CURRENT
        // value immediately (CurrentValueSubject semantics), so this does not
        // delay the first apply.
        companion.$attachedUserName
            .combineLatest(companion.$resolvedName, companion.$code)
            .combineLatest(CompanionBadgeServerConfigBox.shared.publisher)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] combined, _ in
                let (attachedUserName, resolvedName, code) = combined
                self?.apply(attachedUserName: attachedUserName, resolvedName: resolvedName, code: code)
            }
            .store(in: &bag)
    }

    private func apply(attachedUserName: String?, resolvedName: String?, code: String?) {
        guard CompanionBadgeResolution.enabled(server: serverConfig(), inline: options) else { hide(); return }
        guard attachedUserName != nil else { hide(); return }
        let text = CompanionBadgeLabel.compose(resolvedName: resolvedName, code: code)
        guard !text.isEmpty else { hide(); return }
        show(text: text)
    }

    private func show(text: String) {
        guard let surface = Self.__surfaceProvider?() ?? defaultSurface() else {
            hide()
            return
        }
        let position = CompanionBadgeResolution.position(server: serverConfig(), inline: options)
        // Already up, on the right surface, still in the hierarchy, AND
        // constrained to the SAME position — just update the text in place
        // rather than tearing down and re-adding. `NSLayoutConstraint`s
        // installed by `activateConstraints` are fixed at attach time and
        // are not something this fast path can update in place, so a server
        // position change must fall through to the detach+rebuild below,
        // exactly like a different-surface attach already does.
        if let existing = attachedLabel, hostSurface === surface, existing.superview === surface,
           appliedPosition == position {
            existing.text = text
            existing.accessibilityLabel = text
            return
        }
        detachLabel()

        let label = UILabel()
        label.text = text
        label.accessibilityLabel = text
        label.isAccessibilityElement = true
        label.textColor = .white
        label.font = .systemFont(ofSize: 13, weight: .semibold)
        label.backgroundColor = UIColor.black.withAlphaComponent(0.6)
        label.layer.cornerRadius = 6
        label.layer.masksToBounds = true
        label.textAlignment = .center
        label.isUserInteractionEnabled = false
        label.translatesAutoresizingMaskIntoConstraints = false
        surface.addSubview(label)
        activateConstraints(label: label, surface: surface, position: position)

        attachedLabel = label
        hostSurface = surface
        appliedPosition = position
    }

    public func hide() {
        detachLabel()
        overlayWindow?.isHidden = true
        overlayWindow?.rootViewController = nil
        overlayWindow = nil
    }

    /// Tears the badge down permanently: hides any attached label/overlay
    /// window and cancels the Combine subscription to `companion`, so no
    /// later identity update (`attachedUserName` going non-nil again on the
    /// SAME instance) can resurrect it. Called from `RelayWSClient.disconnect()`
    /// — the badge dies with the client that owns it, exactly like Android's
    /// `CompanionBadge.teardown()` dies with `RelayWSClient.stop()`.
    ///
    /// Idempotent (repeated calls are harmless — `hide()` already tolerates
    /// being called with nothing attached, and cancelling an already-empty
    /// `bag` is a no-op), and safe to call from any thread: like every other
    /// UIKit-touching entry point in this class, the actual work only ever
    /// happens on the main thread, mirroring the Combine sink's own
    /// `.receive(on: DispatchQueue.main)` in `init`.
    public func teardown() {
        if Thread.isMainThread {
            hide()
            bag.forEach { $0.cancel() }
            bag.removeAll()
        } else {
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                self.hide()
                self.bag.forEach { $0.cancel() }
                self.bag.removeAll()
            }
        }
    }

    private func detachLabel() {
        attachedLabel?.removeFromSuperview()
        attachedLabel = nil
        hostSurface = nil
        appliedPosition = nil
    }

    /// Production surface: a dedicated overlay window on the foreground
    /// scene, reused across calls as long as it is still hooked to the same
    /// scene and still visible.
    private func defaultSurface() -> UIView? {
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive })
        else {
            overlayWindow = nil
            return nil
        }

        if let existing = overlayWindow, existing.windowScene === scene, !existing.isHidden {
            return existing.rootViewController?.view
        }

        let overlay = EFCompanionBadgeWindow(windowScene: scene)
        overlay.windowLevel = Self.windowLevel
        overlay.backgroundColor = .clear
        // Never key, never interactive — see the file header.
        overlay.isUserInteractionEnabled = false
        let root = UIViewController()
        root.view.backgroundColor = .clear
        root.view.isUserInteractionEnabled = false
        overlay.rootViewController = root
        overlay.isHidden = false
        overlayWindow = overlay
        return root.view
    }

    /// Safe-area anchored, ≥24pt insets — TV overscan needs real margin, not
    /// the 8-12pt the removed phone-only sharing indicator used.
    private func activateConstraints(label: UILabel, surface: UIView, position: CompanionBadgePosition) {
        let inset: CGFloat = 24
        let guide = surface.safeAreaLayoutGuide
        var constraints: [NSLayoutConstraint] = []
        switch position {
        case .topLeft:
            constraints = [
                label.topAnchor.constraint(equalTo: guide.topAnchor, constant: inset),
                label.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: inset),
            ]
        case .topRight:
            constraints = [
                label.topAnchor.constraint(equalTo: guide.topAnchor, constant: inset),
                label.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -inset),
            ]
        case .bottomLeft:
            constraints = [
                label.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -inset),
                label.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: inset),
            ]
        case .bottomRight:
            constraints = [
                label.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -inset),
                label.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -inset),
            ]
        }
        NSLayoutConstraint.activate(constraints)
    }
}
#endif
