// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Everframe Companion has been removed. `RelayWSClient` stays, deprecated,
// until the next major so apps that build one keep compiling. It never opens
// a socket, never starts a timer and never makes an HTTP call: `connect()`
// logs one warning per process and does nothing else.
import Foundation

/// How the removed Companion flow advertised attach-PIN support. Ignored.
@available(*, deprecated, message: "Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture.")
public enum AttachPinUi: String, Sendable {
    case builtin
    case custom
    case off
}

/// Corner of the removed Companion name badge. Ignored.
@available(*, deprecated, message: "Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture.")
public enum CompanionBadgePosition: Sendable, Equatable {
    case topLeft
    case topRight
    case bottomLeft
    case bottomRight
}

/// Options for the removed Companion name badge. Ignored.
@available(*, deprecated, message: "Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture.")
public struct CompanionBadgeOptions: Sendable, Equatable {
    public var enabled: Bool
    public var position: CompanionBadgePosition

    public init(enabled: Bool = true, position: CompanionBadgePosition = .bottomRight) {
        self.enabled = enabled
        self.position = position
    }
}

/// The removed Companion relay client. Does nothing.
@available(*, deprecated, message: "Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture.")
public final class RelayWSClient: NSObject, @unchecked Sendable {
    /// Every argument is accepted and ignored.
    public init(
        endpoint: URL = IngestEndpoint.url,
        companion: CompanionAPI,
        sdkKey: String? = nil,
        deviceLabel: String? = nil,
        attachPinUi: AttachPinUi = .builtin,
        companionDeviceId: String? = nil,
        companionBadge: CompanionBadgeOptions = CompanionBadgeOptions()
    ) {
        super.init()
    }

    /// Logs the removal warning once per process. Opens nothing.
    public func connect() {
        CompanionDeprecation.warnOnce()
    }

    /// Does nothing.
    public func disconnect() {}
}
