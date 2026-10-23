// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import EverframeKit

/// `start()` begins a device-link session for the configured key and
/// `kill()` ends it.
final class DeviceLinkSessionWiringTests: XCTestCase {
    private let key = "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"

    func testStartBeginsALinkSessionForTheConfiguredKey() throws {
        defer { Everframe.shared.kill(); Everframe.__setConfigForTesting(nil) }
        try Everframe.shared.start(config: EverframeConfig(sdkKey: key, capture: CaptureConfig(logs: false), releaseHealth: nil))
        XCTAssertEqual(DeviceLinkCoordinator.shared.__sessionKeyForTesting, key)
    }

    func testKillEndsTheLinkSession() throws {
        defer { Everframe.__setConfigForTesting(nil) }
        try Everframe.shared.start(config: EverframeConfig(sdkKey: key, capture: CaptureConfig(logs: false), releaseHealth: nil))
        Everframe.shared.kill()
        XCTAssertNil(DeviceLinkCoordinator.shared.__sessionKeyForTesting)
    }

    func testASupersedingStartMovesTheSessionToTheNewKey() throws {
        defer { Everframe.shared.kill(); Everframe.__setConfigForTesting(nil) }
        try Everframe.shared.start(config: EverframeConfig(sdkKey: key, capture: CaptureConfig(logs: false), releaseHealth: nil))
        let other = "txx_live_" + String(repeating: "Q", count: 32)
        try Everframe.shared.start(config: EverframeConfig(sdkKey: other, capture: CaptureConfig(logs: false), releaseHealth: nil))
        XCTAssertEqual(DeviceLinkCoordinator.shared.__sessionKeyForTesting, other)
    }
}
