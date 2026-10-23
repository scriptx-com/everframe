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

    /// The link session carries its start() epoch, which admits ingest takeovers.
    func testStartTagsTheLinkSessionWithItsEpoch() throws {
        defer { Everframe.shared.kill(); Everframe.__setConfigForTesting(nil) }
        try Everframe.shared.start(config: EverframeConfig(sdkKey: key, capture: CaptureConfig(logs: false), releaseHealth: nil))
        XCTAssertEqual(DeviceLinkCoordinator.shared.__sessionStartEpochForTesting, Everframe.shared.currentStartEpoch)
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

    #if canImport(UIKit)
    /// A config apply publishes the app's TV binding to quick capture, under
    /// the session's epoch guard, right after the `captureHotkey` block.
    @MainActor
    func testConfigApplyPublishesTheTvBinding() async {
        await withGlobalCaptureStateLock {
            QuickCapture.shared.beginSession(localEnabled: true, debug: true)
            defer { QuickCapture.shared.teardown() }
            let body = #"{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1,"captureHotkey":{"enabled":true},"#
                + #""captureGesture":{"tv":{"kind":"sequence","keys":["DPAD_UP","DPAD_DOWN"],"windowMs":800}}}"#
            let provider = ReplayConfigProvider(configUrl: URL(string: "https://example.test/api/config")!,
                                                sdkKey: "test", fetcher: WiringConfigFetcher(body))
            let session = ReplaySession(provider: provider, locallyDisabled: false)
            defer { session.teardown() }
            XCTAssertNil(QuickCapture.shared.publishedTvBinding)
            await session.refreshConfigNow()
            XCTAssertEqual(QuickCapture.shared.publishedTvBinding,
                           .sequence(keys: ["DPAD_UP", "DPAD_DOWN"], windowMs: 800))
        }
    }
    #endif
}

#if canImport(UIKit)
private final class WiringConfigFetcher: URLSessionFetching, @unchecked Sendable {
    let body: String
    init(_ body: String) { self.body = body }
    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}
#endif
