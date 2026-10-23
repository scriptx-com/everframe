// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Quick capture on a real iPhone or iPad (`hostMode == .device`): a linked
// device captures for its owner with the device token and a fresh link nonce,
// a debug build captures to the shared inbox, and an unlinked release build
// never arms. UIKit-gated: run on a simulator (see TESTING.md).
#if canImport(UIKit)
import UIKit
import XCTest
@testable import EverframeKit

@MainActor
final class QuickCaptureDeviceTests: XCTestCase {
    private var home: String!
    private var hostWindow: UIWindow!
    private var submitted: [ReporterSubmission.Inputs] = []
    private var toasts: [String] = []
    private var cancels: [UUID] = []
    private var forwarded: [(Int, String)] = []
    private var unlinkedTokens: [String] = []
    private var savedCaptureGate = false

    override func setUp() async throws {
        savedCaptureGate = Everframe.captureGate
        Everframe.captureGate = true
        // The simulator credentials file is present: a device must never read it.
        home = NSTemporaryDirectory() + "evf-qcd-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: home + "/.everframe", withIntermediateDirectories: true)
        try #"{"token":"t1"}"#.write(toFile: home + "/.everframe/credentials", atomically: true, encoding: .utf8)
        hostWindow = UIWindow(frame: CGRect(x: 0, y: 0, width: 120, height: 200))
        hostWindow.isHidden = false
        ScreenshotCapture.__windowsOverrideForTesting = [hostWindow]
        submitted = []
        toasts = []
        cancels = []
        forwarded = []
        unlinkedTokens = []
    }

    override func tearDown() async throws {
        Everframe.captureGate = savedCaptureGate
        ScreenshotCapture.__windowsOverrideForTesting = nil
        ReportAPI.__performSetPresenting(false)
        hostWindow.isHidden = true
        try? FileManager.default.removeItem(atPath: home)
    }

    private func makeArmed(
        hostMode: QuickCaptureHostMode = .device, debug: Bool, link: DeviceLink? = nil,
        submit: (@MainActor (ReporterSubmission.Inputs) async throws -> ReportResult)? = nil
    ) -> QuickCapture {
        let qc = QuickCapture()
        qc.hostMode = hostMode
        qc.isApplicationActive = { true }
        qc.environment = ["SIMULATOR_HOST_HOME": home, "SIMULATOR_DEVICE_NAME": "iPhone Test"]
        qc.showToast = { [unowned self] in self.toasts.append($0) }
        qc.lifecycle = QuickCapture.Lifecycle(
            open: { UUID() },
            didClose: { _ in },
            cancel: { [unowned self] in self.cancels.append($0) })
        qc.deviceLink = { link }
        qc.linkPendingReceived = { [unowned self] in self.forwarded.append(($0.number, $1)) }
        qc.deviceUnlinked = { [unowned self] in self.unlinkedTokens.append($0) }
        qc.submit = submit ?? { [unowned self] inputs in
            self.submitted.append(inputs)
            return .submitted(reportId: UUID())
        }
        qc.beginSession(localEnabled: true, debug: debug)
        qc.setLinked(link != nil)
        qc.publish(remote: CaptureHotkeyConfigWire(enabled: true))
        return qc
    }

    private func linkPendingBody(number: Int) -> Data {
        Data(#"{"reportId":"r","linkPending":{"attemptId":"\#(UUID())","number":\#(number)}}"#.utf8)
    }

    func testUnlinkedReleaseDeviceIsNotArmed() async {
        let qc = makeArmed(debug: false)
        XCTAssertFalse(qc.isArmed)
        XCTAssertFalse(qc.isLinked)
        XCTAssertTrue(qc.isConfigured)
        XCTAssertFalse(qc.isDebug)
        let outcome = await qc.capture()
        XCTAssertEqual(outcome, .ignored(reason: "not_debug"))
        XCTAssertTrue(submitted.isEmpty)
        XCTAssertTrue(toasts.isEmpty)
    }

    func testDebugDeviceCapturesSharedWithoutTokenOrNonce() async {
        let qc = makeArmed(debug: true)
        XCTAssertTrue(qc.isArmed)
        let outcome = await qc.capture(trigger: .shake)
        XCTAssertEqual(outcome, .sent)
        XCTAssertEqual(submitted.count, 1)
        XCTAssertNil(submitted.first?.captureToken)
        XCTAssertNil(submitted.first?.linkNonce)
        XCTAssertNil(submitted.first?.onIngestAccepted)
        XCTAssertEqual(submitted.first?.quickCapture, true)
        XCTAssertEqual(toasts.first, "Captured · iPhone Test")
    }

    func testLinkedReleaseDeviceUsesDeviceTokenNotSimulatorCredentials() async {
        let qc = makeArmed(debug: false, link: DeviceLink(token: fixtureToken, owner: .user(name: "Aurimas")))
        XCTAssertTrue(qc.isArmed)
        XCTAssertTrue(qc.isLinked)
        let outcome = await qc.capture(trigger: .shake)
        XCTAssertEqual(outcome, .sent)
        XCTAssertTrue(submitted.first?.captureToken == fixtureToken) // not "t1"
        XCTAssertEqual(submitted.first?.linkNonce?.count, 32)
        XCTAssertEqual(toasts, ["Captured · Aurimas"])
    }

    func testEachLinkedCaptureGetsAFreshNonce() async {
        let qc = makeArmed(debug: false, link: DeviceLink(token: fixtureToken, owner: .team))
        _ = await qc.capture()
        _ = await qc.capture()
        XCTAssertEqual(submitted.count, 2)
        XCTAssertNotEqual(submitted[0].linkNonce, submitted[1].linkNonce)
    }

    func testTeamLinkToast() async {
        let qc = makeArmed(debug: false, link: DeviceLink(token: fixtureToken, owner: .team))
        _ = await qc.capture()
        XCTAssertEqual(toasts.first, "Captured · team device")
    }

    /// The gate still says linked, but the token is gone: a release build
    /// must not fall back to a silent shared capture.
    func testLinkedFlagWithoutAStoredLinkIsIgnoredOnARelease() async {
        let qc = makeArmed(debug: false, link: DeviceLink(token: fixtureToken, owner: .team))
        qc.deviceLink = { nil }
        let outcome = await qc.capture()
        XCTAssertEqual(outcome, .ignored(reason: "not_debug"))
        XCTAssertTrue(submitted.isEmpty)
    }

    func testSimulatorModeIsUnchanged() async {
        let qc = makeArmed(hostMode: .simulator, debug: true)
        qc.deviceLink = { DeviceLink(token: fixtureToken, owner: .team) }
        _ = await qc.capture()
        XCTAssertEqual(submitted.first?.captureToken, "t1")
        XCTAssertNil(submitted.first?.linkNonce)
        XCTAssertEqual(toasts.first, "Captured · iPhone Test")
    }

    func testUnsupportedHostNeverArms() async {
        let qc = makeArmed(hostMode: .unsupported, debug: true)
        XCTAssertFalse(qc.isArmed)
        XCTAssertFalse(qc.forcesReplay)
        let outcome = await qc.capture()
        XCTAssertTrue({ if case .ignored = outcome { return true } else { return false } }())
        XCTAssertTrue(submitted.isEmpty)
    }

    func testIngestLinkPendingIsForwardedWithTheUploadNonce() async {
        let body = linkPendingBody(number: 47)
        var nonce: String?
        let qc = makeArmed(debug: false, link: DeviceLink(token: fixtureToken, owner: .user(name: "Jonas")),
                           submit: { inputs in
            nonce = inputs.linkNonce
            inputs.onIngestAccepted?(body)
            return .submitted(reportId: UUID())
        })
        _ = await qc.capture()
        for _ in 0..<200 where forwarded.isEmpty { await Task.yield() }
        XCTAssertEqual(forwarded.count, 1)
        XCTAssertEqual(forwarded.first?.0, 47)
        XCTAssertTrue(forwarded.first?.1 == nonce)
        XCTAssertNotNil(nonce)
    }

    /// A link-pending reply that lands after `start()` replaced the session
    /// the upload was taken in belongs to that old session: it is dropped,
    /// never followed with the old upload's nonce in the new session.
    func testLateLinkPendingFromAPreviousSessionIsDropped() async throws {
        try await withGlobalCaptureStateLock {
            defer { Everframe.shared.kill(); Everframe.__setConfigForTesting(nil); Everframe.captureGate = true }
            let projectA = "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"
            let projectB = "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rV"
            try Everframe.shared.start(config: EverframeConfig(
                sdkKey: projectA, capture: CaptureConfig(logs: false), releaseHealth: nil))
            let body = linkPendingBody(number: 31)
            var restartError: Error?
            let qc = makeArmed(debug: false, link: DeviceLink(token: fixtureToken, owner: .team), submit: { inputs in
                // The reply is read on the upload's thread; the session is
                // replaced before its hop to the main actor runs.
                inputs.onIngestAccepted?(body)
                do {
                    try Everframe.shared.start(config: EverframeConfig(
                        sdkKey: projectB, capture: CaptureConfig(logs: false), releaseHealth: nil))
                } catch { restartError = error }
                return .submitted(reportId: UUID())
            })
            _ = await qc.capture()
            for _ in 0..<200 { await Task.yield() }
            XCTAssertNil(restartError)
            XCTAssertTrue(forwarded.isEmpty)
        }
    }

    func testIngestBodyWithoutLinkPendingForwardsNothing() async {
        let qc = makeArmed(debug: false, link: DeviceLink(token: fixtureToken, owner: .team), submit: { inputs in
            inputs.onIngestAccepted?(Data(#"{"reportId":"r"}"#.utf8))
            return .submitted(reportId: UUID())
        })
        _ = await qc.capture()
        for _ in 0..<50 { await Task.yield() }
        XCTAssertTrue(forwarded.isEmpty)
    }

    func testDeviceUnlinkedRejection() async {
        let qc = makeArmed(debug: false, link: DeviceLink(token: fixtureToken, owner: .user(name: "Aurimas")),
                           submit: { _ in throw DeviceLinkRejection.deviceUnlinked })
        let outcome = await qc.capture()
        XCTAssertEqual(outcome, .unlinked)
        XCTAssertEqual(toasts, ["Captured · Aurimas", "This device was unlinked"])
        XCTAssertTrue(unlinkedTokens == [fixtureToken])
        XCTAssertEqual(cancels.count, 1)
    }

    /// A linked change from a replaced session is refused under the state lock.
    func testSetLinkedFromAReplacedSessionIsIgnored() {
        let qc = makeArmed(debug: false)
        qc.setLinked(true, ifCurrent: { false })
        XCTAssertFalse(qc.isLinked)
        qc.setLinked(true, ifCurrent: { true })
        XCTAssertTrue(qc.isLinked)
    }

    func testUnlinkedToastCopy() {
        XCTAssertEqual(QuickCaptureToast.text(for: .unlinked), "This device was unlinked")
    }

    func testShakeWithoutHostEvidenceShowsCaptureFailed() async {
        let qc = makeArmed(debug: true)
        qc.beginSession(localEnabled: true, debug: true, screenshot: false)
        qc.publish(remote: CaptureHotkeyConfigWire(enabled: true))
        let shake = await qc.capture(trigger: .shake)
        XCTAssertEqual(shake, .ignored(reason: "screenshot_disabled"))
        XCTAssertEqual(toasts, ["Capture failed"])
        let hotkey = await qc.capture(trigger: .hotkey)
        XCTAssertEqual(hotkey, .ignored(reason: "screenshot_disabled"))
        XCTAssertEqual(toasts, ["Capture failed"])
        XCTAssertTrue(submitted.isEmpty)
    }

    func testGateOrderAndLinkedFlagReset() {
        let qc = makeArmed(debug: false, link: DeviceLink(token: fixtureToken, owner: .team))
        XCTAssertNil(qc.configurationGateReason)
        qc.beginSession(localEnabled: true, debug: false)
        XCTAssertFalse(qc.isLinked)
        XCTAssertEqual(qc.configurationGateReason, "not_debug")
        qc.setLinked(true)
        XCTAssertEqual(qc.configurationGateReason, "remote_disabled")
        qc.beginSession(localEnabled: false, debug: false)
        qc.setLinked(true)
        XCTAssertEqual(qc.configurationGateReason, "disabled")
        qc.teardown()
        XCTAssertFalse(qc.isLinked)
        XCTAssertEqual(qc.configurationGateReason, "not_debug")
    }
}
#endif
