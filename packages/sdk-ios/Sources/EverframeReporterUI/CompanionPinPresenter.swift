// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Everframe Companion has been removed. `CompanionPinPresenter.install()`
// stays, deprecated, until the next major so tvOS hosts that call it keep
// compiling. It installs nothing.
#if canImport(UIKit)
import UIKit

@MainActor
@available(*, deprecated, message: "Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture.")
public enum CompanionPinPresenter {
    /// Does nothing.
    public static func install() {}
}
#endif
