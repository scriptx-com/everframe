// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

/// The kind of Apple device quick capture runs on.
///
/// - `phone`: iPhone or iPad (`os(iOS)`, not Mac Catalyst). The gesture is a shake.
/// - `tv`: Apple TV (`os(tvOS)`). The gesture is a Siri Remote binding.
/// - `other`: Mac Catalyst and macOS. Quick capture never arms.
enum QuickCaptureDevicePlatform: Equatable, Sendable {
    case phone, tv, other

    static let current: Self = {
        #if os(tvOS)
        return .tv
        #elseif os(iOS) && !targetEnvironment(macCatalyst)
        return .phone
        #else
        return .other
        #endif
    }()
}

/// Where quick capture runs.
///
/// - `simulator`: the shipped path. The CLI credentials token, the hotkey and
///   `notifyutil`; never a hello, never a Keychain device token.
/// - `device`: a real iPhone, iPad or Apple TV. The capture gesture (shake, or
///   the Siri Remote binding) captures when the device is linked or the build
///   is a debug build, and an unlinked device can link itself.
/// - `unsupported`: a Mac Catalyst app or macOS. Quick capture never arms.
///
/// `EVERFRAME_SIMULATE_DEVICE=1` in the app's launch environment makes an
/// iPhone or Apple TV simulator behave as a real device, for testing. It is
/// read only in simulator builds.
enum QuickCaptureHostMode: Equatable, Sendable {
    case simulator, device, unsupported

    static let simulateDeviceEnvironmentKey = "EVERFRAME_SIMULATE_DEVICE"

    static func resolve(isSimulator: Bool, platform: QuickCaptureDevicePlatform, environment: [String: String]) -> Self {
        let isDevicePlatform = platform == .phone || platform == .tv
        if isSimulator {
            return isDevicePlatform && environment[simulateDeviceEnvironmentKey] == "1" ? .device : .simulator
        }
        return isDevicePlatform ? .device : .unsupported
    }

    static let current: Self = {
        #if targetEnvironment(simulator)
        // The test switch is read only in simulator builds.
        return resolve(isSimulator: true, platform: .current, environment: ProcessInfo.processInfo.environment)
        #else
        return resolve(isSimulator: false, platform: .current, environment: [:])
        #endif
    }()
}
