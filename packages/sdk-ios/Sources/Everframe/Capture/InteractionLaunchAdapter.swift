// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit

/// UIApplication notifications are app-level; individual scene callbacks do not create extra launches.
@MainActor final class InteractionLaunchAdapter {
    static let shared = InteractionLaunchAdapter(recorder: .shared)
    private let recorder: InteractionEventRecorder
    private var seeded = false, seenForeground = false, isForeground = false, observedLaunch = false
    private var observers: [NSObjectProtocol] = []
    init(recorder: InteractionEventRecorder) { self.recorder = recorder }
    func install() {
        guard observers.isEmpty else { return }
        seed(alreadyForeground: UIApplication.shared.applicationState == .active)
        for name in [UIApplication.didFinishLaunchingNotification, UIApplication.didBecomeActiveNotification, UIApplication.didEnterBackgroundNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in
                guard Thread.isMainThread else { return }
                MainActor.assumeIsolated {
                    if name == UIApplication.didFinishLaunchingNotification { self?.launched() }
                    else if name == UIApplication.didEnterBackgroundNotification { self?.background() }
                    else { self?.foreground() }
                }
            })
        }
    }
    func seed(alreadyForeground: Bool) { guard !seeded else { return }; seeded = true; isForeground = alreadyForeground; seenForeground = alreadyForeground }
    // A late installation cannot distinguish an earlier cold launch from a return
    // from background. Only an observed launch notification authorizes "cold".
    func launched() { observedLaunch = true }
    func foreground() {
        guard !isForeground else { return }; isForeground = true
        let start = observedLaunch && !seenForeground ? "cold" : "warm"; seenForeground = true
        guard let owner = recorder.owner() else { return }
        _ = recorder.observe(.init(owner: owner, event: nativeInteractionEvent("launch", ["start": start])))
    }
    func background() { isForeground = false }
}
#endif
