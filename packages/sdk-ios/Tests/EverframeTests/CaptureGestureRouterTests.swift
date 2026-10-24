// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The shake router: it applies the mode rule and never reads the
// shake-to-report switch itself. UIKit-gated: run on a simulator.
#if canImport(UIKit)
import UIKit
import XCTest
@testable import EverframeKit

@MainActor
final class CaptureGestureRouterTests: XCTestCase {
    private var quickCaptures: [QuickCaptureTrigger] = []
    private var reporters = 0
    private var hellos = 0

    override func setUp() async throws {
        quickCaptures = []
        reporters = 0
        hellos = 0
    }

    private func router(mode: QuickCaptureHostMode, configured: Bool, debug: Bool, linked: Bool,
                        linkingEnabled: Bool) -> CaptureGestureRouter {
        CaptureGestureRouter(
            inputs: { (mode, configured, debug, linked, linkingEnabled) },
            quickCapture: { [unowned self] in self.quickCaptures.append($0) },
            reporter: { [unowned self] in self.reporters += 1 },
            hello: { [unowned self] in self.hellos += 1 })
    }

    func testLinkedShakeCapturesEvenWithShakeToReportOff() {
        // The dashboard's shake-to-report switch is off.
        let trigger = ShakeToReportTrigger.shared
        trigger.beginSession(localEnabled: true, ifCurrent: { true })
        trigger.publish(remoteEnabled: false, ifCurrent: { true })
        defer { trigger.teardown(ifCurrent: { true }) }
        router(mode: .device, configured: true, debug: false, linked: true, linkingEnabled: true).handle(.shake)
        XCTAssertEqual(quickCaptures, [.shake])
        XCTAssertEqual(reporters, 0)
        XCTAssertEqual(hellos, 0)
    }

    func testDebugUnlinkedShakeCapturesAndHellos() {
        router(mode: .device, configured: true, debug: true, linked: false, linkingEnabled: true).handle(.shake)
        XCTAssertEqual(quickCaptures, [.shake])
        XCTAssertEqual(hellos, 1)
        XCTAssertEqual(reporters, 0)
    }

    func testReleaseUnlinkedShakeOpensReporterAndHellos() {
        router(mode: .device, configured: true, debug: false, linked: false, linkingEnabled: true).handle(.shake)
        XCTAssertEqual(reporters, 1)
        XCTAssertEqual(hellos, 1)
        XCTAssertEqual(quickCaptures, [])
    }

    func testNotificationNeverOpensTheReporter() {
        router(mode: .simulator, configured: false, debug: true, linked: false, linkingEnabled: false)
            .handle(.simulatorNotification)
        XCTAssertEqual(reporters, 0)
        XCTAssertEqual(quickCaptures, [])
        XCTAssertEqual(hellos, 0)
    }

    func testSimulatorNotificationCapturesAsTheHotkey() {
        router(mode: .simulator, configured: true, debug: true, linked: false, linkingEnabled: false)
            .handle(.simulatorNotification)
        XCTAssertEqual(quickCaptures, [.hotkey])
    }

    func testRemoteStartsARemoteTrigger() {
        let decision = router(mode: .device, configured: true, debug: false, linked: true, linkingEnabled: true)
            .handle(.remote)
        XCTAssertEqual(quickCaptures, [.remote])
        XCTAssertEqual(decision, CaptureGestureDecision(action: .quickCapture, sendHello: false, swallowKeys: true))
        XCTAssertEqual(reporters, 0)
        XCTAssertEqual(hellos, 0)
        let release = router(mode: .device, configured: true, debug: false, linked: false, linkingEnabled: true)
            .handle(.remote)
        XCTAssertEqual(release, CaptureGestureDecision(action: .nothing, sendHello: true, swallowKeys: false))
        XCTAssertEqual(quickCaptures, [.remote])
        XCTAssertEqual(reporters, 0)
        XCTAssertEqual(hellos, 1)
    }

    func testLiveRouterReadsQuickCaptureAndCoordinator() {
        let inputs = CaptureGestureRouter.live.inputs()
        XCTAssertEqual(inputs.hostMode, QuickCapture.shared.hostMode)
        XCTAssertEqual(inputs.configured, QuickCapture.shared.isConfigured)
        XCTAssertEqual(inputs.linkingEnabled, DeviceLinkCoordinator.shared.isLinkingEnabled)
    }
}
#endif
