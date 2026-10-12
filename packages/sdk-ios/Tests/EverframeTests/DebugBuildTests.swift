// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import EverframeKit

final class DebugBuildTests: XCTestCase {
    private func profile(getTaskAllow: Bool) -> Data {
        let plist = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict><key>Entitlements</key><dict><key>get-task-allow</key><\(getTaskAllow)/></dict></dict></plist>"
        return Data(("garbage-cms-prefix" + plist + "garbage-cms-suffix").utf8)
    }
    func testSimulatorIsDebug() {
        XCTAssertTrue(DebugBuild.detect(configured: nil, isSimulator: true, provisioningProfile: nil))
    }
    func testDevelopmentSignedIsDebug() {
        XCTAssertTrue(DebugBuild.detect(configured: nil, isSimulator: false, provisioningProfile: profile(getTaskAllow: true)))
    }
    func testDistributionSignedIsRelease() {
        XCTAssertFalse(DebugBuild.detect(configured: nil, isSimulator: false, provisioningProfile: profile(getTaskAllow: false)))
    }
    func testAppStoreHasNoProfileAndIsRelease() {
        XCTAssertFalse(DebugBuild.detect(configured: nil, isSimulator: false, provisioningProfile: nil))
    }
    func testConfiguredWins() {
        XCTAssertFalse(DebugBuild.detect(configured: false, isSimulator: true, provisioningProfile: nil))
        XCTAssertTrue(DebugBuild.detect(configured: true, isSimulator: false, provisioningProfile: nil))
        XCTAssertTrue(DebugBuild.detect(configured: true, isSimulator: false, provisioningProfile: profile(getTaskAllow: false)))
        XCTAssertFalse(DebugBuild.detect(configured: false, isSimulator: false, provisioningProfile: profile(getTaskAllow: true)))
    }
    /// The running app's answer follows `debugBuild` whatever the test host's own signing says.
    func testCurrentFollowsTheConfiguredValueAndOtherwiseTheDetector() {
        XCTAssertTrue(DebugBuild.current(configured: true))
        XCTAssertFalse(DebugBuild.current(configured: false))
        XCTAssertEqual(DebugBuild.current(configured: nil), DebugBuildDetector.current)
    }
    func testEverframeConfigDefaultsDebugBuildToNilInEveryInitializer() {
        XCTAssertNil(EverframeConfig(sdkKey: "evf_live_" + String(repeating: "a", count: 32)).debugBuild)
        XCTAssertEqual(EverframeConfig(sdkKey: "evf_live_" + String(repeating: "a", count: 32), debugBuild: false).debugBuild, false)
    }
    /// The deprecated spelling forwards it too.
    @available(*, deprecated)
    func testDeprecatedInitializerForwardsDebugBuild() {
        let key = "evf_live_" + String(repeating: "a", count: 32)
        XCTAssertNil(EverframeConfig(appId: key).debugBuild)
        XCTAssertEqual(EverframeConfig(appId: key, debugBuild: true).debugBuild, true)
    }
}
