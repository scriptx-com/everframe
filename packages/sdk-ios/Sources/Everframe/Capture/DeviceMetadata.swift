// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Codable device-metadata snapshot used by EnvelopeBuilder when assembling a
// crash/feedback envelope. Pulls from UIDevice (when available), ProcessInfo,
// Locale, TimeZone, and Bundle.main.infoDictionary.
//
// Cross-platform notes:
//   • iOS/tvOS — UIDevice supplies model/systemName/systemVersion
//   • macOS (test/CI host) — falls back to ProcessInfo so `swift test` runs
//     work on macOS without UIKit
import Foundation
#if canImport(UIKit)
import UIKit
#endif

public struct DeviceMetadata: Codable, Sendable {
    public let model: String
    public let osName: String
    public let osVersion: String
    public let locale: String
    public let timezone: String
    public let appVersion: String?
    public let appBuild: String?
    public let bundleIdentifier: String?
    /// Logical screen size in points (UIScreen.bounds). 0 when UIKit unavailable.
    public let screenWidth: Double
    public let screenHeight: Double
    /// UIScreen.scale — 2 on @2x, 3 on @3x, 1 on macOS test host.
    public let pixelRatio: Double

    public init(
        model: String,
        osName: String,
        osVersion: String,
        locale: String,
        timezone: String,
        appVersion: String?,
        appBuild: String?,
        bundleIdentifier: String?,
        screenWidth: Double = 0,
        screenHeight: Double = 0,
        pixelRatio: Double = 1
    ) {
        self.model = model
        self.osName = osName
        self.osVersion = osVersion
        self.locale = locale
        self.timezone = timezone
        self.appVersion = appVersion
        self.appBuild = appBuild
        self.bundleIdentifier = bundleIdentifier
        self.screenWidth = screenWidth
        self.screenHeight = screenHeight
        self.pixelRatio = pixelRatio
    }

    @MainActor
    public static func snapshot() -> DeviceMetadata {
        #if canImport(UIKit)
        let device = UIDevice.current
        let osName = device.systemName
        let osVersion = device.systemVersion
        let model = device.model  // "iPhone", "iPad", "Apple TV"
        // Prefer the foreground key window's scene screen (iOS 13+ multi-scene
        // safe). Fall back to UIScreen.main on tvOS / single-scene apps.
        let screen: UIScreen = {
            if let scene = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .first(where: { $0.activationState == .foregroundActive }) {
                return scene.screen
            }
            return UIScreen.main
        }()
        let bounds = screen.bounds
        let screenWidth = Double(bounds.width)
        let screenHeight = Double(bounds.height)
        let pixelRatio = Double(screen.scale)
        #else
        let osName = "macOS"
        let osVersion = ProcessInfo.processInfo.operatingSystemVersionString
        let model = "Mac"
        let screenWidth: Double = 0
        let screenHeight: Double = 0
        let pixelRatio: Double = 1
        #endif
        let info = Bundle.main.infoDictionary ?? [:]
        return DeviceMetadata(
            model: model,
            osName: osName,
            osVersion: osVersion,
            locale: Locale.current.identifier,
            timezone: TimeZone.current.identifier,
            appVersion: info["CFBundleShortVersionString"] as? String,
            appBuild: info["CFBundleVersion"] as? String,
            bundleIdentifier: Bundle.main.bundleIdentifier,
            screenWidth: screenWidth,
            screenHeight: screenHeight,
            pixelRatio: pixelRatio
        )
    }
}
