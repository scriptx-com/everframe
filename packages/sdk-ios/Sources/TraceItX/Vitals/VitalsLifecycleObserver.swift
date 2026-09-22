// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// UIApplication lifecycle bridge (iOS spec 2026-09-05 §2). didEnterBackground /
// willEnterForeground, NOT resign/become-active — see RelayWSClient's header
// for why. Both install() and uninstall() ALWAYS hop to main so the main queue
// is the single ordering authority (Android final review, I3), and install()
// reads the current state inside that hop: enablement arriving while already
// backgrounded takes the background path immediately (round-3, Important 10).
//
// No beacon path exists on iOS, so the background callback (the controller's
// `pause + flushNow`) is wrapped in a background task: iOS otherwise suspends
// the process within seconds and the last chunk dies with the socket. The task
// ends on the next foreground or after `backgroundTaskCapMs`, whichever first.
#if canImport(UIKit)
import Foundation
import UIKit

final class VitalsLifecycleObserver: @unchecked Sendable {
    static let backgroundTaskCapMs: Int64 = 25_000

    private let onForeground: @Sendable () -> Void
    private let onBackground: @Sendable () -> Void
    private let center: NotificationCenter
    private let isBackgrounded: @MainActor () -> Bool
    /// The two UIApplication calls, injected exactly like `isBackgrounded` (round-1, O2). The
    /// suite that CI names as the guard for this wrap could not see them at all: deleting both
    /// left every test green while iOS silently lost the last chunk on every backgrounding, and
    /// deleting only the end left an unbalanced task, which iOS kills the app for. The defaults
    /// carry the `MainActor.assumeIsolated` hop, so the test path never performs one.
    private let beginTask: @Sendable (_ name: String, _ onExpire: @escaping @Sendable () -> Void) -> UIBackgroundTaskIdentifier
    private let endTask: @Sendable (UIBackgroundTaskIdentifier) -> Void
    /// Instance copy of `backgroundTaskCapMs` so a test can drive the cap without waiting 25 s.
    private let capMs: Int64
    private let lock = NSLock()
    private var installed = false
    private var tokens: [NSObjectProtocol] = []
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    init(onForeground: @escaping @Sendable () -> Void, onBackground: @escaping @Sendable () -> Void,
         notificationCenter: NotificationCenter = .default,
         isBackgrounded: @escaping @MainActor () -> Bool = { UIApplication.shared.applicationState == .background },
         capMs: Int64 = VitalsLifecycleObserver.backgroundTaskCapMs,
         beginTask: @escaping @Sendable (_ name: String, _ onExpire: @escaping @Sendable () -> Void) -> UIBackgroundTaskIdentifier
             = { name, onExpire in MainActor.assumeIsolated { UIApplication.shared.beginBackgroundTask(withName: name, expirationHandler: onExpire) } },
         endTask: @escaping @Sendable (UIBackgroundTaskIdentifier) -> Void
             = { id in MainActor.assumeIsolated { UIApplication.shared.endBackgroundTask(id) } }) {
        self.onForeground = onForeground; self.onBackground = onBackground
        self.center = notificationCenter; self.isBackgrounded = isBackgrounded
        self.capMs = capMs; self.beginTask = beginTask; self.endTask = endTask
    }

    func install() {
        DispatchQueue.main.async { [self] in
            dispatch("VitalsLifecycleObserver.install") {
                lock.lock()
                guard !installed else { lock.unlock(); return }
                installed = true
                tokens = [
                    center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in self?.background() },
                    center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in self?.foreground() },
                ]
                lock.unlock()
                if MainActor.assumeIsolated({ isBackgrounded() }) { background() }
            }
        }
    }

    func uninstall() {
        DispatchQueue.main.async { [self] in
            dispatch("VitalsLifecycleObserver.uninstall") {
                lock.lock()
                guard installed else { lock.unlock(); return }
                installed = false
                let t = tokens; tokens = []
                lock.unlock()
                t.forEach { center.removeObserver($0) }
                endBackgroundTask()
            }
        }
    }

    private func background() {
        beginBackgroundTask()
        dispatch("VitalsLifecycleObserver.onBackground") { onBackground() }
    }

    private func foreground() {
        endBackgroundTask()
        dispatch("VitalsLifecycleObserver.onForeground") { onForeground() }
    }

    // `UIApplication` is `@MainActor`-isolated, and the injected `beginTask`/`endTask`
    // defaults are the only place this file touches it outside `isBackgrounded`. Reaching it
    // from a nonisolated context is an iOS/tvOS-only warning that macOS `swift test` cannot see
    // (the whole file compiles out there), so it only ever showed in the xcodebuild jobs.
    //
    // Both are reached ONLY from the main queue, by this class's own contract: the two
    // observers are registered with `queue: .main`, install() and uninstall() run inside the
    // main hop above, the cap timer is an `asyncAfter` on main, and UIKit delivers the
    // expiration handler on the main thread. `assumeIsolated` bridges into that isolation
    // synchronously, exactly as install()'s state read above already does — a hop instead
    // would change behaviour: `begin` has to publish the identifier under the same lock
    // acquisition that reserved the slot, and `end` has to release the identifier it just
    // cleared before any later `begin` can take one.
    private func beginBackgroundTask() {
        lock.lock(); defer { lock.unlock() }
        guard backgroundTask == .invalid else { return }
        let id = beginTask("com.traceitx.vitals.flush") { [weak self] in self?.endBackgroundTask() }
        backgroundTask = id
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Int(capMs))) { [weak self] in
            guard let self else { return }
            self.lock.lock(); let same = self.backgroundTask == id; self.lock.unlock()
            if same { self.endBackgroundTask() }
        }
    }

    private func endBackgroundTask() {
        lock.lock()
        let id = backgroundTask; backgroundTask = .invalid
        lock.unlock()
        if id != .invalid { endTask(id) }
    }
}
#endif
