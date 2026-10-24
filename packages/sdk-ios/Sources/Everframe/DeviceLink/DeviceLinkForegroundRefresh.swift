// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// A linked Apple TV fetches its config when the app returns to the foreground,
// so a Record on device request from the dashboard reaches it without waiting
// for the 5-minute refresh. At most every 10 s, counted from install (the
// launch's own config fetch is already on its way). Unlinked devices never
// refresh this way. Installed by `start()` on tvOS, removed by `kill()`.
import Foundation
#if canImport(UIKit)
import UIKit
#endif

final class DeviceLinkForegroundRefresh: @unchecked Sendable {
    static let minimumInterval: TimeInterval = 10

    static var foregroundNotification: Notification.Name {
        #if canImport(UIKit)
        return UIApplication.willEnterForegroundNotification
        #else
        return Notification.Name("EverframeWillEnterForeground")
        #endif
    }

    private let center: NotificationCenter
    private let name: Notification.Name
    private let now: () -> TimeInterval
    private let isLinked: () -> Bool
    private let refresh: () -> Void

    private let lock = NSLock()
    private var observer: NSObjectProtocol?
    private var lastRefresh: TimeInterval = -.infinity

    init(center: NotificationCenter, name: Notification.Name = DeviceLinkForegroundRefresh.foregroundNotification,
         now: @escaping () -> TimeInterval, isLinked: @escaping () -> Bool, refresh: @escaping () -> Void) {
        self.center = center
        self.name = name
        self.now = now
        self.isLinked = isLinked
        self.refresh = refresh
    }

    deinit { remove() }

    func install() {
        lock.lock()
        lastRefresh = now()
        let installed = observer != nil
        lock.unlock()
        guard !installed else { return }
        let token = center.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in
            self?.foregrounded()
        }
        lock.lock()
        if observer == nil {
            observer = token
            lock.unlock()
        } else {
            lock.unlock()
            center.removeObserver(token)
        }
    }

    func remove() {
        lock.lock()
        let token = observer
        observer = nil
        lock.unlock()
        if let token { center.removeObserver(token) }
    }

    private func foregrounded() {
        let time = now()
        lock.lock()
        guard time - lastRefresh >= Self.minimumInterval else { lock.unlock(); return }
        lock.unlock()
        guard isLinked() else { return }
        lock.lock()
        lastRefresh = time
        lock.unlock()
        refresh()
    }
}

extension DeviceLinkForegroundRefresh {
    private static let liveLock = NSLock()
    nonisolated(unsafe) private static var live: DeviceLinkForegroundRefresh?

    /// `start()` on tvOS: the session's foreground refresh, replacing the
    /// previous session's. Its throttle starts now.
    static func installLive(ifCurrent: () -> Bool) {
        liveLock.lock(); defer { liveLock.unlock() }
        guard ifCurrent() else { return }
        live?.remove()
        let refresher = DeviceLinkForegroundRefresh(
            center: .default,
            now: { ProcessInfo.processInfo.systemUptime },
            isLinked: { DeviceLinkCoordinator.shared.currentLink != nil },
            refresh: { Task { @MainActor in Everframe.shared.__refreshConfigForDeviceLink() } })
        refresher.install()
        live = refresher
    }

    /// `kill()`.
    static func removeLive(ifCurrent: () -> Bool) {
        liveLock.lock(); defer { liveLock.unlock() }
        guard ifCurrent() else { return }
        live?.remove()
        live = nil
    }

    static var __isLiveInstalledForTesting: Bool {
        liveLock.lock(); defer { liveLock.unlock() }
        return live != nil
    }
}
