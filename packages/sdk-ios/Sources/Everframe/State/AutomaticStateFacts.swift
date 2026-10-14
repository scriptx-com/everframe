// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import EverframeProtocol
import Network
#if os(iOS)
import UIKit
import AVFoundation
import UserNotifications
#endif

/// Passive observations only. Callbacks retain their original session owner.
final class AutomaticStateFacts: @unchecked Sendable {
    private let monitor = NWPathMonitor()
    private var observer: NSObjectProtocol?
    private let owner: Int
    private let publish: @Sendable (Int, [String: EverframeStateValue]) -> Void
    init(owner: Int, publish: @escaping @Sendable (Int, [String: EverframeStateValue]) -> Void) {
        self.owner = owner; self.publish = publish
        monitor.pathUpdateHandler = { path in
            let type = path.status != .satisfied ? "offline" : path.usesInterfaceType(.wifi) ? "wifi" :
                path.usesInterfaceType(.cellular) ? "cellular" : path.usesInterfaceType(.wiredEthernet) ? "wired" : "other"
            publish(owner, ["network.type": .string(type)])
        }
        monitor.start(queue: DispatchQueue(label: "dev.everframe.state.network"))
        #if os(iOS)
        observer = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: nil) { [weak self] _ in self?.refresh() }
        #endif
        refresh()
    }
    func stop() { monitor.cancel(); if let observer { NotificationCenter.default.removeObserver(observer) } }
    deinit { stop() }
    func refresh() {
        publish(owner, ["locale": .string(Locale.current.identifier)])
        #if os(iOS)
        // Framework-only runners and extensions may have no application identity;
        // UserNotifications raises an Objective-C exception in that environment.
        guard Bundle.main.bundleURL.pathExtension == "app" else { return }
        func permission(_ value: AVAuthorizationStatus) -> String {
            switch value { case .authorized: return "granted"; case .denied: return "denied"; case .restricted: return "restricted"; case .notDetermined: return "not-requested"; @unknown default: return "unknown" }
        }
        publish(owner, ["permission.camera": .string(permission(AVCaptureDevice.authorizationStatus(for: .video))),
                        "permission.microphone": .string(permission(AVCaptureDevice.authorizationStatus(for: .audio)))])
        let publish = self.publish; let owner = self.owner
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let status: String
            switch settings.authorizationStatus {
            case .authorized: status = "granted"
            case .denied: status = "denied"
            case .notDetermined: status = "not-requested"
            case .provisional: status = "provisional"
            case .ephemeral: status = "ephemeral"
            @unknown default: status = "unknown"
            }
            publish(owner, ["permission.notifications": .string(status)])
        }
        #endif
    }
    static func initial() -> EverframeStateSnapshot {
        let release = AppRelease.current(debugBuild: nil)
        #if os(iOS)
        let os = "iOS"
        let unavailable = "unknown"
        #elseif os(tvOS)
        let os = "tvOS"
        let unavailable = "not-supported"
        #else
        let os = "macOS"
        let unavailable = "not-supported"
        #endif
        return EverframeStateSnapshot(automatic: [
            "app.version": .string(release.version),
            "app.build": .string(release.build ?? "unknown"),
            "os.name": .string(os), "os.version": .string(ProcessInfo.processInfo.operatingSystemVersionString),
            "locale": .string(Locale.current.identifier), "user.status": .string("anonymous"),
            "network.type": .string("unknown"), "permission.camera": .string(unavailable),
            "permission.microphone": .string(unavailable), "permission.notifications": .string(unavailable)
        ], custom: [:])
    }
}
