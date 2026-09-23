// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Built-in attach-PIN surface (spec 2026-08-19). A dedicated UIWindow one
// level above the reporter's (.alert + 2) hosting a passive label — no
// buttons: reading the code to the dashboard IS the consent. Installed by
// `EFReporterPresenter.installResolver()` on iOS and callable directly on
// tvOS hosts (where `installResolver` does not exist).
//
// Gated `#if canImport(UIKit)` ONLY — no `!os(tvOS)`. Apple TV is a PRIMARY
// consumer of companion (see `RelayWSClient`'s header), so this file must
// build and run there, unlike `EFReporterPresenter` (which is iOS-only: TV
// apps route reporting through the phone-companion flow instead, not this
// modal reporter).
//
// Runtime suppression (spec 2026-08-19, controller ruling): `install()`
// itself is unconditional — it always sets `__builtinPinUiInstalled = true`
// so the announce-time capability check degrades honestly. Suppression is
// checked on every `present(_:)` call instead, via
// `CompanionAPI.__builtinPinUiSuppressed` — set by the RN bridge in a later
// task when a custom PIN UI takes over at runtime. `attachChallenge` itself
// keeps updating either way; only the built-in window's rendering is
// silenced, so a custom UI reading the same property never misses a value.
#if canImport(UIKit)
import UIKit
import Combine
import EverframeKit

@MainActor
public enum CompanionPinPresenter {
    private static var window: UIWindow?
    private static var bag = Set<AnyCancellable>()
    private static var installed = false
    private static var expiryTask: Task<Void, Never>?
    private static var activationObserver: NSObjectProtocol?
    // Round-2 review finding 3: `present(_:)` used to require a
    // `.foregroundActive` scene and simply give up otherwise — a challenge
    // that arrived while the app was `.foregroundInactive` (e.g. mid app-
    // switcher transition, a system alert up, or — on tvOS — momentarily
    // losing focus) was NEVER shown, even once the scene came back active,
    // because nothing re-drove `present`. Track the live challenge + its
    // absolute deadline here so `didBecomeActiveNotification` can re-attempt
    // presentation with the REMAINING time.
    private static var currentChallenge: CompanionAttachChallenge?
    private static var currentDeadline: Date?

    /// One-shot installer. Wires a Combine subscription to
    /// `CompanionAPI.attachChallenge` that presents/dismisses the built-in PIN
    /// window, and marks `CompanionAPI.__builtinPinUiInstalled` so the
    /// announce-time capability check can advertise `supportsAttachPin` in
    /// `.builtin` mode. Unconditional — never gated on suppression, which is
    /// a runtime, per-`present` check (see file header).
    ///
    /// Also installs a ONE-TIME `didBecomeActiveNotification` observer (finding
    /// 3): on activation, if a challenge is still live and no window is
    /// currently up, re-present it with the time remaining until its deadline
    /// — never the original `ttlMs`, which would silently extend the code's
    /// lifetime past what the server actually granted.
    public static func install() {
        guard !installed else { return }
        installed = true
        let companion = Everframe.shared.companion
        companion.__builtinPinUiInstalled = true
        companion.$attachChallenge
            .receive(on: DispatchQueue.main)
            .sink { challenge in
                if let challenge { present(challenge) } else { dismiss() }
            }
            .store(in: &bag)
        activationObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: nil
        ) { _ in
            Task { @MainActor in representOnActivationIfNeeded() }
        }
    }

    private static func present(_ challenge: CompanionAttachChallenge) {
        // Suppressed at runtime (RN bridge owns its own PIN UI) — the
        // challenge stays published on `CompanionAPI` either way (a custom UI
        // reads it directly); only the built-in window is silenced. `dismiss`
        // still runs so a window shown before suppression flipped on doesn't
        // linger.
        guard !Everframe.shared.companion.__builtinPinUiSuppressed else {
            dismiss()
            return
        }
        dismiss()
        currentChallenge = challenge
        let deadline = Date().addingTimeInterval(TimeInterval(challenge.ttlMs) / 1000)
        currentDeadline = deadline
        armExpiryTask(deadline: deadline)
        presentWindowIfPossible(challenge: challenge)
    }

    /// (c) The expiry task always arms with the time remaining until the
    /// absolute deadline, never a fresh full `ttlMs` — so re-presenting on
    /// activation (below) can never grant more total lifetime than the
    /// server's original challenge carried.
    private static func armExpiryTask(deadline: Date) {
        expiryTask?.cancel()
        let remaining = CompanionAttachChallenge.remainingMs(deadline: deadline)
        guard remaining > 0 else {
            dismiss()
            return
        }
        expiryTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(remaining) * 1_000_000)
            guard !Task.isCancelled else { return }
            dismiss()
        }
    }

    /// Attempts to put the window up. No-ops (leaves `currentChallenge`/
    /// `currentDeadline` tracked) if no `.foregroundActive` scene exists yet —
    /// `didBecomeActiveNotification` is what re-drives this once one does.
    private static func presentWindowIfPossible(challenge: CompanionAttachChallenge) {
        guard let scene = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .first(where: { $0.activationState == .foregroundActive })
        else { return }
        let w = UIWindow(windowScene: scene)
        w.windowLevel = .alert + 2
        w.isUserInteractionEnabled = false   // passive — never steals focus/keyboard
        w.rootViewController = CompanionPinViewController(challenge: challenge)
        w.isHidden = false                   // visible WITHOUT becoming key
        window = w
    }

    /// (b) Fires on every `didBecomeActiveNotification`. Only acts when a
    /// challenge is still tracked AND no window is already up (an active
    /// window means either presentation already succeeded, or there's
    /// genuinely nothing to show). Dismisses immediately, without ever
    /// showing a window, if the deadline has already passed while inactive.
    private static func representOnActivationIfNeeded() {
        guard window == nil,
              let challenge = currentChallenge,
              let deadline = currentDeadline
        else { return }
        let remaining = CompanionAttachChallenge.remainingMs(deadline: deadline)
        guard remaining > 0 else {
            dismiss()
            return
        }
        armExpiryTask(deadline: deadline)
        presentWindowIfPossible(challenge: challenge)
    }

    private static func dismiss() {
        expiryTask?.cancel()
        expiryTask = nil
        currentChallenge = nil
        currentDeadline = nil
        window?.isHidden = true
        window?.windowScene = nil
        window = nil
    }
}

/// Passive, top-trailing card: requester name, the PIN in a large monospaced
/// font, and a one-line instruction. No interactive elements — this view
/// controller's window has `isUserInteractionEnabled = false` and is never
/// made key, so it draws only and never fights the host for focus.
@MainActor
final class CompanionPinViewController: UIViewController {
    private let challenge: CompanionAttachChallenge

    init(challenge: CompanionAttachChallenge) {
        self.challenge = challenge
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        // A transparent full-screen container — the visible card is the
        // rounded background view laid out inside it, top-trailing.
        let container = UIView()
        container.backgroundColor = .clear
        view = container
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        let card = UIView()
        card.backgroundColor = UIColor.black.withAlphaComponent(0.85)
        card.layer.cornerRadius = 16
        card.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(card)

        let requesterLabel = UILabel()
        requesterLabel.text = "\(challenge.requestedByName) wants to connect"
        requesterLabel.textColor = .white
        requesterLabel.font = .systemFont(ofSize: 18, weight: .semibold)
        requesterLabel.textAlignment = .center
        requesterLabel.numberOfLines = 0

        let codeLabel = UILabel()
        // SECURITY: this is the ONE place the code is ever rendered — never
        // logged, never persisted, never sent anywhere but drawn on screen.
        codeLabel.text = challenge.code
        codeLabel.textColor = .white
        codeLabel.font = UIFont.monospacedDigitSystemFont(ofSize: 40, weight: .bold)
        codeLabel.textAlignment = .center

        let instructionLabel = UILabel()
        instructionLabel.text = "Enter this code in the Everframe dashboard"
        instructionLabel.textColor = UIColor.white.withAlphaComponent(0.8)
        instructionLabel.font = .systemFont(ofSize: 14, weight: .regular)
        instructionLabel.textAlignment = .center
        instructionLabel.numberOfLines = 0

        let stack = UIStackView(arrangedSubviews: [requesterLabel, codeLabel, instructionLabel])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(stack)

        NSLayoutConstraint.activate([
            card.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
            card.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            card.widthAnchor.constraint(lessThanOrEqualToConstant: 320),

            stack.topAnchor.constraint(equalTo: card.topAnchor, constant: 20),
            stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -20),
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -24),
        ])
    }
}
#endif
