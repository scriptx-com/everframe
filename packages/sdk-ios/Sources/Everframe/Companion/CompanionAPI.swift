// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Everframe Companion has been removed. `CompanionAPI` stays, deprecated,
// until the next major so apps that read `Everframe.shared.companion` keep
// compiling. Every value is idle and never changes: `state` is `.unpaired`,
// everything else is `nil`, and no notification is posted.
import Foundation
import Combine

/// A dashboard-initiated attach request from the removed Companion flow.
/// Nothing produces one any more.
@available(*, deprecated, message: "Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture.")
public struct CompanionAttachChallenge: Sendable, Equatable {
    public let code: String
    public let requestedByName: String
    public let ttlMs: Int

    public init(code: String, requestedByName: String, ttlMs: Int) {
        self.code = code
        self.requestedByName = requestedByName
        self.ttlMs = ttlMs
    }

    /// Milliseconds left until `deadline`, clamped to >= 0.
    public static func remainingMs(deadline: Date, now: Date = Date()) -> Int {
        max(0, Int(deadline.timeIntervalSince(now) * 1000))
    }
}

/// The removed Companion observation surface. Every value is idle.
@available(*, deprecated, message: "Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture.")
public final class CompanionAPI: ObservableObject, @unchecked Sendable {
    /// Always `.unpaired`.
    @Published public private(set) var state: CompanionState = .unpaired
    /// Always `nil`.
    @Published public private(set) var pairUrl: String? = nil
    /// Always `nil`.
    @Published public private(set) var code: String? = nil
    /// Always `nil`.
    @Published public private(set) var attachedUserName: String? = nil
    /// Always `nil`.
    @Published public private(set) var resolvedName: String? = nil
    /// Always `nil`.
    @Published public private(set) var attachChallenge: CompanionAttachChallenge? = nil

    public init() {}

    /// Does nothing.
    public func __setBuiltinPinUiSuppressed(_ v: Bool) {}
}
