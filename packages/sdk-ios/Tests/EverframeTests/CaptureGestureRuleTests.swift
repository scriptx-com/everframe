// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import EverframeKit

/// The mode rule: what a shake (or the simulator's notification) does, by host,
/// configuration, build and link.
final class CaptureGestureRuleTests: XCTestCase {
    private func decide(_ source: CaptureGestureSource, _ mode: QuickCaptureHostMode, configured: Bool,
                        debug: Bool, linked: Bool, linkingEnabled: Bool) -> CaptureGestureDecision {
        CaptureGestureRule.decide(source: source, hostMode: mode, quickCaptureConfigured: configured,
                                  debug: debug, linked: linked, linkingEnabled: linkingEnabled)
    }

    private func expect(_ action: CaptureGestureAction, hello: Bool) -> CaptureGestureDecision {
        CaptureGestureDecision(action: action, sendHello: hello)
    }

    func testRow1LinkedDeviceCaptures() {
        XCTAssertEqual(decide(.shake, .device, configured: true, debug: false, linked: true, linkingEnabled: true),
                       expect(.quickCapture, hello: false))
    }

    func testRow2DebugUnlinkedDeviceCapturesAndHellos() {
        XCTAssertEqual(decide(.shake, .device, configured: true, debug: true, linked: false, linkingEnabled: true),
                       expect(.quickCapture, hello: true))
    }

    func testRow3DebugUnlinkedDeviceWithLinkingOffCapturesOnly() {
        XCTAssertEqual(decide(.shake, .device, configured: true, debug: true, linked: false, linkingEnabled: false),
                       expect(.quickCapture, hello: false))
    }

    func testRow4ReleaseUnlinkedDeviceOpensReporterAndHellos() {
        XCTAssertEqual(decide(.shake, .device, configured: true, debug: false, linked: false, linkingEnabled: true),
                       expect(.reporter, hello: true))
    }

    func testRow5QuickCaptureOffMeansReporterAndNoHello() {
        XCTAssertEqual(decide(.shake, .device, configured: false, debug: false, linked: false, linkingEnabled: true),
                       expect(.reporter, hello: false))
    }

    func testRow6QuickCaptureOffOnALinkedDevice() {
        XCTAssertEqual(decide(.shake, .device, configured: false, debug: false, linked: true, linkingEnabled: true),
                       expect(.reporter, hello: false))
    }

    func testRow7SimulatorShakeCaptures() {
        XCTAssertEqual(decide(.shake, .simulator, configured: true, debug: true, linked: false, linkingEnabled: false),
                       expect(.quickCapture, hello: false))
    }

    func testRow8SimulatorShakeWithoutQuickCaptureOpensReporter() {
        XCTAssertEqual(decide(.shake, .simulator, configured: false, debug: true, linked: false, linkingEnabled: false),
                       expect(.reporter, hello: false))
    }

    func testRow9SimulatorNotificationCaptures() {
        XCTAssertEqual(decide(.simulatorNotification, .simulator, configured: true, debug: true, linked: false, linkingEnabled: false),
                       expect(.quickCapture, hello: false))
    }

    func testRow10SimulatorNotificationNeverOpensTheReporter() {
        XCTAssertEqual(decide(.simulatorNotification, .simulator, configured: false, debug: true, linked: false, linkingEnabled: false),
                       expect(.nothing, hello: false))
    }

    func testRow11NotificationOnASimulatedDeviceHellos() {
        XCTAssertEqual(decide(.simulatorNotification, .device, configured: true, debug: false, linked: false, linkingEnabled: true),
                       expect(.nothing, hello: true))
    }

    func testRow12UnsupportedHostKeepsTodaysShake() {
        XCTAssertEqual(decide(.shake, .unsupported, configured: true, debug: true, linked: false, linkingEnabled: true),
                       expect(.reporter, hello: false))
    }

    /// A release simulator (debug false) never captures, even when configured.
    func testReleaseSimulatorNeverCaptures() {
        XCTAssertEqual(decide(.shake, .simulator, configured: true, debug: false, linked: false, linkingEnabled: true),
                       expect(.reporter, hello: false))
        XCTAssertEqual(decide(.simulatorNotification, .simulator, configured: true, debug: false, linked: false, linkingEnabled: true),
                       expect(.nothing, hello: false))
    }
}
