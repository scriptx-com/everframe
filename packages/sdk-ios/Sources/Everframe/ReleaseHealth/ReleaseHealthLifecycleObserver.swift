// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
#if os(iOS)
import UIKit
#endif

/// Process-wide app lifecycle; transient inactive states do not end a session.
/// Notifications are delivered synchronously so the SDK can retire fatal pointers
/// before returning from the background notification. Persistence runs elsewhere.
final class ReleaseHealthLifecycleObserver: @unchecked Sendable {
    private let center: NotificationCenter
    private let lock = NSRecursiveLock()
    private var foreground: Bool
    private var tokens: [NSObjectProtocol] = []
    private let onChange: @Sendable (Bool) -> Void

    init(center: NotificationCenter, foregroundNotification: Notification.Name,
         backgroundNotification: Notification.Name, initiallyForeground: Bool,
         onChange: @escaping @Sendable (Bool) -> Void) {
        self.center = center; foreground = initiallyForeground; self.onChange = onChange
        tokens = [
            center.addObserver(forName: foregroundNotification, object: nil, queue: nil) { [weak self] _ in self?.update(true) },
            center.addObserver(forName: backgroundNotification, object: nil, queue: nil) { [weak self] _ in self?.update(false) },
        ]
    }
    deinit { for token in tokens { center.removeObserver(token) } }
    private func update(_ value: Bool) {
        lock.lock(); defer { lock.unlock() }
        guard foreground != value else { return }
        foreground = value; onChange(value)
    }
    #if os(iOS)
    @MainActor static func observeApplication(onChange: @escaping @Sendable (Bool) -> Void) -> ReleaseHealthLifecycleObserver {
        // Launch is commonly inactive until didBecomeActive. It is already in
        // foreground unless UIKit explicitly says background (e.g. a fetch launch).
        let foreground = UIApplication.shared.applicationState != .background
        let observer = ReleaseHealthLifecycleObserver(center: .default,
            foregroundNotification: UIApplication.willEnterForegroundNotification,
            backgroundNotification: UIApplication.didEnterBackgroundNotification,
            initiallyForeground: foreground, onChange: onChange)
        onChange(foreground)
        return observer
    }
    #endif
}
