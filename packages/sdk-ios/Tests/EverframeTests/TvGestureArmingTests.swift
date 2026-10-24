// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// When an Apple TV watches the Siri Remote for the app's binding
// (`QuickCapture.armedTvBinding`). UIKit-gated: run on a simulator.
#if canImport(UIKit)
import UIKit
import XCTest
@testable import EverframeKit

@MainActor
final class TvGestureArmingTests: XCTestCase {
    private var savedCaptureGate = false
    private var linkingOn = false

    override func setUp() async throws {
        savedCaptureGate = Everframe.captureGate
        Everframe.captureGate = true
        linkingOn = false
    }

    override func tearDown() async throws {
        Everframe.captureGate = savedCaptureGate
    }

    private func make(platform: QuickCaptureDevicePlatform = .tv, hostMode: QuickCaptureHostMode = .device,
                      debug: Bool, linked: Bool = false, quickCapture: Bool = true,
                      gesture: CaptureGestureConfigWire? = CaptureGestureConfigWire(tv: .default)) -> QuickCapture {
        let qc = QuickCapture()
        qc.devicePlatform = platform
        qc.hostMode = hostMode
        qc.linkingEnabled = { [unowned self] in self.linkingOn }
        qc.beginSession(localEnabled: true, debug: debug)
        qc.setLinked(linked)
        qc.publish(remote: CaptureHotkeyConfigWire(enabled: quickCapture))
        qc.publishGesture(gesture)
        return qc
    }

    func testPhonePlatformNeverArms() {
        let qc = make(platform: .phone, debug: true, linked: true)
        XCTAssertNil(qc.armedTvBinding)
        XCTAssertNil(make(platform: .other, hostMode: .unsupported, debug: true).armedTvBinding)
        XCTAssertNil(make(platform: .tv, hostMode: .unsupported, debug: true).armedTvBinding)
    }

    func testReleaseUnlinkedArmsOnlyWhileLinkingIsOn() {
        let qc = make(debug: false)
        XCTAssertNil(qc.armedTvBinding)
        linkingOn = true
        XCTAssertEqual(qc.armedTvBinding, .default)
        // A release simulator never links, so it never arms.
        XCTAssertNil(make(hostMode: .simulator, debug: false).armedTvBinding)
    }

    func testLinkedArms() {
        XCTAssertEqual(make(debug: false, linked: true).armedTvBinding, .default)
    }

    func testDebugArms() {
        XCTAssertEqual(make(debug: true).armedTvBinding, .default)
        XCTAssertEqual(make(hostMode: .simulator, debug: true).armedTvBinding, .default)
    }

    func testQuickCaptureOffNeverArms() {
        linkingOn = true
        XCTAssertNil(make(debug: true, linked: true, quickCapture: false).armedTvBinding)
        let local = make(debug: true, linked: true)
        local.beginSession(localEnabled: false, debug: true)
        local.publish(remote: CaptureHotkeyConfigWire(enabled: true))
        local.publishGesture(CaptureGestureConfigWire(tv: .default))
        XCTAssertNil(local.armedTvBinding)
        let killed = make(debug: true, linked: true)
        Everframe.captureGate = false
        XCTAssertNil(killed.armedTvBinding)
    }

    func testTeardownDisarms() {
        let qc = make(debug: true, linked: true)
        XCTAssertNotNil(qc.armedTvBinding)
        qc.teardown()
        XCTAssertNil(qc.armedTvBinding)
        XCTAssertNil(qc.publishedTvBinding)
        let restarted = make(debug: true)
        restarted.beginSession(localEnabled: true, debug: true)
        XCTAssertNil(restarted.publishedTvBinding, "a new session waits for its own config")
    }

    func testUnreachableBindingArmsTheDefault() {
        let qc = make(debug: true, gesture: CaptureGestureConfigWire(tv: .chord(keys: ["PROG_RED", "PROG_BLUE"])))
        XCTAssertEqual(qc.armedTvBinding, .default)
        let dpad = TvGestureBinding.sequence(keys: ["DPAD_UP", "DPAD_DOWN"], windowMs: 1000)
        qc.publishGesture(CaptureGestureConfigWire(tv: dpad))
        XCTAssertEqual(qc.armedTvBinding, dpad)
    }

    func testNoBlockMeansNoBinding() {
        XCTAssertNil(make(debug: true, linked: true, gesture: nil).armedTvBinding)
        XCTAssertNil(make(debug: true, linked: true, gesture: CaptureGestureConfigWire(tv: nil)).armedTvBinding)
    }

    func testAPublishFromAReplacedSessionIsIgnored() {
        let qc = make(debug: true, gesture: nil)
        qc.publishGesture(CaptureGestureConfigWire(tv: .default), ifCurrent: { false })
        XCTAssertNil(qc.publishedTvBinding)
    }
}
#endif
