// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import TraceItXKit

final class VitalsDimsTests: XCTestCase {
    func testDimsFromBundleMachineAndOSVersion() {
        let d = VitalsDims.current(sdkVersion: "0.7.0", infoDictionary: ["CFBundleShortVersionString": "1.4.2"],
                                   machine: "iPhone16,1", osVersion: OperatingSystemVersion(majorVersion: 18, minorVersion: 5, patchVersion: 0))
        #if os(tvOS)
        XCTAssertEqual(d.platform, "tvos")
        #else
        XCTAssertEqual(d.platform, "ios")
        #endif
        XCTAssertEqual(d.appVersion, "1.4.2"); XCTAssertEqual(d.sdkVersion, "0.7.0")
        XCTAssertEqual(d.deviceModel, "iPhone16,1"); XCTAssertEqual(d.osVersion, "18.5.0")
    }
    func testMissingAppVersionFallsBackToZero() {
        XCTAssertEqual(VitalsDims.current(sdkVersion: "x", infoDictionary: [:], machine: "m",
                                          osVersion: OperatingSystemVersion(majorVersion: 1, minorVersion: 0, patchVersion: 0)).appVersion, "0.0.0")
    }
    func testMachineIdentifierIsNonEmpty() {
        XCTAssertFalse(VitalsDims.machineIdentifier().isEmpty)
    }
}
