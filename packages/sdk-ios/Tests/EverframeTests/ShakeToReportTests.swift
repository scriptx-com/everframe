// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import EverframeKit

final class ShakeToReportTests: XCTestCase {
    func testLocalOptionDefaultsEnabled() {
        XCTAssertTrue(EverframeConfig(sdkKey: "app").shakeToReportEnabled)
    }

    func testLocalAndDashboardSwitchesMustBothBeEnabled() {
        let gate = ShakeToReportGate(localEnabled: true)

        XCTAssertFalse(gate.tryBegin(presenting: false, applicationActive: true))
        gate.setRemoteEnabled(true)
        XCTAssertTrue(gate.tryBegin(presenting: false, applicationActive: true))
        XCTAssertFalse(gate.tryBegin(presenting: false, applicationActive: true))
        gate.complete()
        XCTAssertFalse(gate.tryBegin(presenting: true, applicationActive: true))
        XCTAssertFalse(gate.tryBegin(presenting: false, applicationActive: false))

        gate.setRemoteEnabled(false)
        XCTAssertFalse(gate.tryBegin(presenting: false, applicationActive: true))
        gate.setRemoteEnabled(true)
        gate.setLocalEnabled(false)
        XCTAssertFalse(gate.tryBegin(presenting: false, applicationActive: true))
    }

    /// A crash-only session has no on-device reporter, so `start` never arms shake for it,
    /// whatever `shakeToReportEnabled` says.
    func testACrashOnlySessionNeverArmsShake() throws {
        defer { Everframe.shared.kill(); Everframe.__setConfigForTesting(nil) }
        let sdkKey = "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"
        try Everframe.shared.start(config: EverframeConfig(
            sdkKey: sdkKey, capture: CaptureConfig(logs: false), releaseHealth: nil, reporterEnabled: false))
        XCTAssertFalse(ShakeToReportTrigger.shared.__localEnabledForTesting)
        try Everframe.shared.start(config: EverframeConfig(
            sdkKey: sdkKey, capture: CaptureConfig(logs: false), releaseHealth: nil))
        XCTAssertTrue(ShakeToReportTrigger.shared.__localEnabledForTesting)
    }

    func testRemoteBlockIsLenientAndCapabilityIsDeclared() throws {
        let valid = Data(#"{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1,"shakeToReport":{"enabled":true,"future":"ignored"}}"#.utf8)
        XCTAssertEqual(try ReplayConfigProvider.__decodeForTesting(valid).shakeToReport?.enabled, true)

        let malformed = Data(#"{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1,"shakeToReport":{"enabled":"yes"}}"#.utf8)
        XCTAssertNil(try ReplayConfigProvider.__decodeForTesting(malformed).shakeToReport)
        XCTAssertTrue(ReplayConfigProvider.sdkFeaturesHeaderValue.contains("shaketoreport"))
    }
}
