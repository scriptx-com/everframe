// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import TraceItXKit

final class ShakeToReportTests: XCTestCase {
    func testLocalOptionDefaultsEnabled() {
        XCTAssertTrue(TraceItXConfig(appId: "app").shakeToReportEnabled)
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

    func testRemoteBlockIsLenientAndCapabilityIsDeclared() throws {
        let valid = Data(#"{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1,"shakeToReport":{"enabled":true,"future":"ignored"}}"#.utf8)
        XCTAssertEqual(try ReplayConfigProvider.__decodeForTesting(valid).shakeToReport?.enabled, true)

        let malformed = Data(#"{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1,"shakeToReport":{"enabled":"yes"}}"#.utf8)
        XCTAssertNil(try ReplayConfigProvider.__decodeForTesting(malformed).shakeToReport)
        XCTAssertTrue(ReplayConfigProvider.sdkFeaturesHeaderValue.contains("shaketoreport"))
    }
}
