// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Everframe Companion has been removed. Its documented API stays as
// deprecated no-op stubs: these tests pin that the stubs never connect,
// stay idle, warn once, and that the wire changes hold (no `companionbadge`
// feature token, a config carrying `companionBadge` still parses).
import Foundation
import XCTest
@testable import EverframeKit

@available(*, deprecated)
final class CompanionStubTests: XCTestCase {
    override func setUp() {
        super.setUp()
        CompanionDeprecation.__resetForTests()
    }

    override func tearDown() {
        CompanionDeprecation.__resetForTests()
        super.tearDown()
    }

    func testStartWarnsOnceAndNeverConnects() {
        let companion = Everframe.shared.companion
        let client = RelayWSClient(companion: companion)
        client.disconnect() // stop before start is safe
        client.connect()
        client.connect()
        client.disconnect()
        // A second client in the same process does not warn again.
        RelayWSClient(companion: companion, sdkKey: "k", attachPinUi: .custom).connect()
        _ = CompanionCaptureBridge(client: client)

        XCTAssertEqual(CompanionDeprecation.emittedCount, 1)
        XCTAssertEqual(companion.state, .unpaired)
        XCTAssertNil(companion.pairUrl)
        XCTAssertNil(companion.code)
        XCTAssertNil(companion.attachedUserName)
        XCTAssertNil(companion.resolvedName)
        XCTAssertNil(companion.attachChallenge)
    }

    func testStateNeverChangesAndNoNotificationIsPosted() {
        let companion = Everframe.shared.companion
        var posted = 0
        let observer = NotificationCenter.default.addObserver(
            forName: .everframeCompanionStateChange, object: nil, queue: nil) { _ in posted += 1 }
        defer { NotificationCenter.default.removeObserver(observer) }
        var states: [CompanionState] = []
        let sink = companion.$state.sink { states.append($0) }
        defer { sink.cancel() }

        let client = RelayWSClient(companion: companion)
        client.connect()
        client.disconnect()
        companion.__setBuiltinPinUiSuppressed(true)

        XCTAssertEqual(states, [.unpaired])
        XCTAssertEqual(posted, 0)
    }

    func testReporterTriggerCompanionStillEncodes() {
        XCTAssertEqual(ReporterTrigger.companion.rawValue, "companion")
    }

    func testConfigWithCompanionBadgeStillParses() throws {
        let body = #"""
            {"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
            "companionBadge":{"enabled":true,"position":"top-left"},
            "captureHotkey":{"enabled":true,"binding":"Shift+B","replay":true}}
            """#
        let config = try ReplayConfigProvider.__decodeForTesting(Data(body.utf8))
        XCTAssertTrue(config.replayEnabled)
        XCTAssertEqual(config.captureHotkey?.enabled, true)
        XCTAssertEqual(config.captureHotkey?.binding, "Shift+B")
    }

    func testFeaturesHeaderOmitsCompanionBadge() {
        XCTAssertFalse(ReplayConfigProvider.sdkFeaturesHeaderValue.contains("companionbadge"))
    }

    func testConfigAcceptsDeprecatedCompanionParams() {
        let config = EverframeConfig(sdkKey: "k", companionDeviceId: "x", companionBadgeEnabled: false,
                                     companionBadgePosition: "top-left")
        XCTAssertEqual(config.sdkKey, "k")
        XCTAssertEqual(config.companionDeviceId, "x")
        XCTAssertFalse(config.companionBadgeEnabled)
    }

    func testDeprecatedOptionTypesStillBuild() {
        let options = CompanionBadgeOptions(enabled: false, position: .topLeft)
        XCTAssertFalse(options.enabled)
        XCTAssertEqual(AttachPinUi.builtin.rawValue, "builtin")
        XCTAssertEqual(CompanionAttachChallenge.remainingMs(deadline: Date(timeIntervalSince1970: 0),
                                                             now: Date(timeIntervalSince1970: 1)), 0)
    }
}
