// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

/// Where quick capture runs.
///
/// - `simulator`: the shipped path. The CLI credentials token, the hotkey and
///   `notifyutil`; never a hello, never a Keychain device token.
/// - `device`: a real iPhone or iPad. Shake captures when the device is linked
///   or the build is a debug build, and an unlinked device can link itself.
/// - `unsupported`: a real Apple TV or a Mac Catalyst app. Quick capture never arms.
///
/// `EVERFRAME_SIMULATE_DEVICE=1` in the app's launch environment makes an iOS
/// simulator behave as a real phone, for testing. It is read only in
/// simulator builds.
enum QuickCaptureHostMode: Equatable, Sendable {
    case simulator, device, unsupported

    static let simulateDeviceEnvironmentKey = "EVERFRAME_SIMULATE_DEVICE"

    static func resolve(isSimulator: Bool, isPhoneOS: Bool, environment: [String: String]) -> Self {
        if isSimulator {
            return isPhoneOS && environment[simulateDeviceEnvironmentKey] == "1" ? .device : .simulator
        }
        return isPhoneOS ? .device : .unsupported
    }

    static let current: Self = {
        #if targetEnvironment(simulator)
        let isSimulator = true
        #else
        let isSimulator = false
        #endif
        #if os(iOS) && !targetEnvironment(macCatalyst)
        let isPhoneOS = true
        #else
        let isPhoneOS = false
        #endif
        return resolve(isSimulator: isSimulator, isPhoneOS: isPhoneOS,
                       environment: isSimulator ? ProcessInfo.processInfo.environment : [:])
    }()
}
