// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Everframe Companion has been removed. `CompanionCaptureBridge` stays,
// deprecated, until the next major so apps that build one keep compiling.
// It observes nothing and captures nothing.
import Foundation

/// The removed Companion capture bridge. Does nothing.
@available(*, deprecated, message: "Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture.")
public final class CompanionCaptureBridge: @unchecked Sendable {
    public init(client: RelayWSClient) {}
}
