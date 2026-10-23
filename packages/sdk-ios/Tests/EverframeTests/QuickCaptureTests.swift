// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Simulator quick capture: the gate, the headless pipeline and the toast
// window's capture exclusion. UIKit-gated, so `swift test` on the macOS host
// compiles this to nothing; run it on a simulator (see TESTING.md).
//
// A SwiftPM test bundle has no UI scenes, so the screenshot comes from a
// plain `UIWindow(frame:)` handed to `ScreenshotCapture.__windowsOverrideForTesting`,
// and the replay lifecycle is a counting stub so no test leaves the shared
// breadcrumb/replay buffers frozen for the next one. The one test that runs the
// production lifecycle releases those buffers itself.
#if canImport(UIKit)
import UIKit
import XCTest
@testable import EverframeKit

@MainActor
final class QuickCaptureTests: XCTestCase {
    private var home: String!
    private var hostWindow: UIWindow!
    private var submitted: [ReporterSubmission.Inputs] = []
    private var freezes = 0
    private var closes: [UUID] = []
    private var cancels: [UUID] = []
    private var savedCaptureGate = false

    override func setUp() async throws {
        // An open capture gate, as after `start()`; the kill-switch test closes it.
        savedCaptureGate = Everframe.captureGate
        Everframe.captureGate = true
        home = NSTemporaryDirectory() + "evf-qc-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: home + "/.everframe", withIntermediateDirectories: true)
        try #"{"token":"t1"}"#.write(toFile: home + "/.everframe/credentials", atomically: true, encoding: .utf8)
        hostWindow = UIWindow(frame: CGRect(x: 0, y: 0, width: 120, height: 200))
        hostWindow.isHidden = false
        ScreenshotCapture.__windowsOverrideForTesting = [hostWindow]
        submitted = []
        freezes = 0
        closes = []
        cancels = []
    }

    override func tearDown() async throws {
        Everframe.captureGate = savedCaptureGate
        ScreenshotCapture.__windowsOverrideForTesting = nil
        ReportAPI.__performSetPresenting(false)
        hostWindow.isHidden = true
        try? FileManager.default.removeItem(atPath: home)
    }

    /// A fully armed capture with every seam stubbed. `submit` defaults to an
    /// immediate `.submitted`.
    private func makeArmed(
        submit: (@MainActor (ReporterSubmission.Inputs) async throws -> ReportResult)? = nil
    ) -> QuickCapture {
        let qc = QuickCapture()
        qc.isSimulator = true
        qc.isApplicationActive = { true }
        qc.environment = ["SIMULATOR_HOST_HOME": home, "SIMULATOR_DEVICE_NAME": "iPhone Test"]
        qc.showToast = { _ in }
        qc.lifecycle = QuickCapture.Lifecycle(
            open: { [unowned self] in self.freezes += 1; return UUID() },
            didClose: { [unowned self] in self.closes.append($0) },
            cancel: { [unowned self] in self.cancels.append($0) }
        )
        qc.submit = submit ?? { [unowned self] inputs in
            self.submitted.append(inputs)
            return .submitted(reportId: UUID())
        }
        qc.beginSession(localEnabled: true, debug: true)
        qc.publish(remote: CaptureHotkeyConfigWire(enabled: true))
        return qc
    }

    private func isIgnored(_ outcome: QuickCaptureOutcome, reason: String? = nil) -> Bool {
        guard case let .ignored(got) = outcome else { return false }
        return reason.map { $0 == got } ?? true
    }

    private func postCaptureNotification() {
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(QuickCapture.darwinCaptureNotification as CFString), nil, nil, true)
    }

    func testDarwinNotificationTriggersCaptureWhenArmed() async {
        let qc = makeArmed()
        let fired = expectation(description: "capture triggered")
        fired.assertForOverFulfill = true
        qc.triggerOverride = { fired.fulfill() }
        postCaptureNotification()
        // A short extra wait so a duplicate delivery would over-fulfill.
        await fulfillment(of: [fired], timeout: 5)
        try? await Task.sleep(nanoseconds: 200_000_000)
        withExtendedLifetime(qc) {}
    }

    func testDarwinNotificationIgnoredWhenDisarmed() async {
        let qc = makeArmed()
        qc.publish(remote: nil)
        let fired = expectation(description: "capture triggered")
        fired.isInverted = true
        qc.triggerOverride = { fired.fulfill() }
        postCaptureNotification()
        await fulfillment(of: [fired], timeout: 0.5)
        withExtendedLifetime(qc) {}
    }

    func testDarwinObserverRegisteredOnce() async {
        let qc = makeArmed()
        qc.beginSession(localEnabled: true, debug: true)
        qc.publish(remote: CaptureHotkeyConfigWire(enabled: true))
        let fired = expectation(description: "capture triggered")
        fired.assertForOverFulfill = true
        qc.triggerOverride = { fired.fulfill() }
        postCaptureNotification()
        await fulfillment(of: [fired], timeout: 5)
        try? await Task.sleep(nanoseconds: 200_000_000)
        withExtendedLifetime(qc) {}
    }

    func testIgnoredWithoutRemoteBlock() async {
        let qc = makeArmed()
        qc.publish(remote: nil)
        let outcome = await qc.capture()
        XCTAssertTrue(isIgnored(outcome), "\(outcome)")
        XCTAssertTrue(submitted.isEmpty)
        XCTAssertEqual(freezes, 0)
        XCTAssertFalse(qc.isArmed)
    }

    func testIgnoredWhenRemoteDisabled() async {
        let qc = makeArmed()
        qc.publish(remote: CaptureHotkeyConfigWire(enabled: false))
        let outcome = await qc.capture()
        XCTAssertTrue(isIgnored(outcome), "\(outcome)")
        XCTAssertTrue(submitted.isEmpty)
    }

    func testIgnoredWhenLocalDisabled() async {
        let qc = makeArmed()
        qc.beginSession(localEnabled: false, debug: true)
        qc.publish(remote: CaptureHotkeyConfigWire(enabled: true))
        let outcome = await qc.capture()
        XCTAssertTrue(isIgnored(outcome), "\(outcome)")
        XCTAssertTrue(submitted.isEmpty)
        XCTAssertFalse(qc.isArmed)
    }

    func testIgnoredOnReleaseBuildOrDevice() async {
        let release = makeArmed()
        release.beginSession(localEnabled: true, debug: false)
        release.publish(remote: CaptureHotkeyConfigWire(enabled: true))
        let releaseOutcome = await release.capture()
        XCTAssertTrue(isIgnored(releaseOutcome), "\(releaseOutcome)")

        let device = makeArmed()
        device.isSimulator = false
        let deviceOutcome = await device.capture()
        XCTAssertTrue(isIgnored(deviceOutcome), "\(deviceOutcome)")
        XCTAssertFalse(device.isArmed)
        XCTAssertTrue(submitted.isEmpty)
    }

    func testIgnoredWhenApplicationInactive() async {
        let qc = makeArmed()
        qc.isApplicationActive = { false }
        let outcome = await qc.capture()
        XCTAssertTrue(isIgnored(outcome), "\(outcome)")
        XCTAssertTrue(submitted.isEmpty)
    }

    /// Android parity: a killed session (or revoked consent) closes the capture
    /// gate, and a press must not freeze, submit or toast "Capture failed".
    func testIgnoredWhenCaptureGateClosed() async {
        await withGlobalCaptureStateLock {
            Everframe.captureGate = true
            var toasts: [String] = []
            let qc = makeArmed()
            qc.showToast = { toasts.append($0) }
            Everframe.captureGate = false
            let outcome = await qc.capture()
            XCTAssertTrue(isIgnored(outcome, reason: "kill_switch"), "\(outcome)")
            XCTAssertEqual(freezes, 0)
            XCTAssertTrue(submitted.isEmpty)
            XCTAssertTrue(toasts.isEmpty)
        }
    }

    func testBeginSessionClearsThePreviousSessionsRemoteBlock() async {
        let qc = makeArmed()
        XCTAssertTrue(qc.isArmed)
        qc.beginSession(localEnabled: true, debug: true)
        XCTAssertFalse(qc.isArmed)
        qc.publish(remote: CaptureHotkeyConfigWire(enabled: true))
        XCTAssertTrue(qc.isArmed)
        qc.teardown()
        XCTAssertFalse(qc.isArmed)
    }

    /// `captureHotkey.replay` forces replay only while every arming gate holds.
    func testForcesReplayOnlyWhileArmedWithTheFlag() async {
      await withGlobalCaptureStateLock {
        Everframe.captureGate = true
        let qc = makeArmed()
        XCTAssertFalse(qc.forcesReplay)
        qc.publish(remote: CaptureHotkeyConfigWire(enabled: true, replay: false))
        XCTAssertFalse(qc.forcesReplay)
        qc.publish(remote: CaptureHotkeyConfigWire(enabled: true, replay: true))
        XCTAssertTrue(qc.forcesReplay)
        qc.isSimulator = false
        XCTAssertFalse(qc.forcesReplay, "a device never forces replay")
        qc.isSimulator = true
        Everframe.captureGate = false
        XCTAssertFalse(qc.forcesReplay, "a closed kill switch never forces replay")
        Everframe.captureGate = true
        XCTAssertTrue(qc.forcesReplay)
        qc.teardown()
        XCTAssertFalse(qc.forcesReplay)
        qc.beginSession(localEnabled: true, debug: true)
        XCTAssertFalse(qc.forcesReplay, "a new session waits for its own block")
      }
    }

    func testSubmitsQuickCaptureWithToken() async throws {
        let qc = makeArmed()
        let outcome = await qc.capture()
        guard case .sent = outcome else { return XCTFail("expected .sent, got \(outcome)") }
        let inputs = try XCTUnwrap(submitted.first)
        XCTAssertEqual(submitted.count, 1)
        XCTAssertTrue(inputs.quickCapture)
        XCTAssertEqual(inputs.captureToken, "t1")
        XCTAssertEqual(inputs.shots.count, 1)
        XCTAssertEqual(inputs.shots.first?.annotated, false)
        XCTAssertEqual(inputs.title, "")
        XCTAssertEqual(inputs.description, "")
        XCTAssertTrue(inputs.includeLogs)
        XCTAssertTrue(inputs.includeNetwork)
        XCTAssertTrue(inputs.includeMetadata)
        XCTAssertNil(inputs.companionAttribution)
        XCTAssertEqual(freezes, 1)
        XCTAssertEqual(closes.count, 1)
        XCTAssertTrue(cancels.isEmpty)
    }

    // MARK: Host evidence and capture.screenshot

    private func solidImage(_ color: UIColor = .red) -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: 6, height: 4)).image { ctx in
            color.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 6, height: 4))
        }
    }

    /// A Flutter-style session: `capture.screenshot = false`.
    private func makeArmedWithScreenshotDisabled() -> QuickCapture {
        let qc = makeArmed()
        qc.beginSession(localEnabled: true, debug: true, screenshot: false)
        qc.publish(remote: CaptureHotkeyConfigWire(enabled: true))
        return qc
    }

    func testProviderEvidenceIsSubmittedWithoutNativeScreenshot() async throws {
        let qc = makeArmedWithScreenshotDisabled()
        qc.screenshotter = { XCTFail("the native screenshot must not be taken"); return nil }
        let image = solidImage()
        let vtree = Data(#"{"version":"everframe-vtree-v1"}"#.utf8)
        qc.setEvidenceProvider { QuickCaptureHostEvidence(image: image, hostReplayVTree: vtree) }

        let outcome = await qc.capture()

        guard case .sent = outcome else { return XCTFail("expected .sent, got \(outcome)") }
        let inputs = try XCTUnwrap(submitted.first)
        XCTAssertEqual(submitted.count, 1)
        XCTAssertTrue(inputs.captureResult.image === image)
        XCTAssertEqual(inputs.shots.count, 1)
        XCTAssertTrue(inputs.shots.first?.image === image)
        XCTAssertEqual(inputs.shots.first?.annotated, false)
        XCTAssertEqual(inputs.hostReplayVTree, vtree)
        XCTAssertTrue(inputs.quickCapture)
        XCTAssertEqual(inputs.captureToken, "t1")
        XCTAssertEqual(freezes, 1)
        XCTAssertEqual(closes.count, 1)
    }

    /// Like `openWithMaskedPng`: host evidence without frames still owns replay,
    /// so the empty value keeps the unmasked native video fallback off.
    func testProviderEvidenceWithoutReplaySendsEmptyHostReplay() async throws {
        let qc = makeArmedWithScreenshotDisabled()
        qc.screenshotter = { XCTFail("the native screenshot must not be taken"); return nil }
        let image = solidImage()
        qc.setEvidenceProvider { QuickCaptureHostEvidence(image: image, hostReplayVTree: nil) }

        let outcome = await qc.capture()

        guard case .sent = outcome else { return XCTFail("expected .sent, got \(outcome)") }
        XCTAssertEqual(try XCTUnwrap(submitted.first).hostReplayVTree, Data())
    }

    func testNilProviderResultFailsWithoutNativeScreenshot() async {
        let qc = makeArmedWithScreenshotDisabled()
        var nativeShots = 0
        qc.screenshotter = { nativeShots += 1; return nil }
        var toasts: [String] = []
        qc.showToast = { toasts.append($0) }
        qc.setEvidenceProvider { nil }

        let outcome = await qc.capture()

        guard case .failed = outcome else { return XCTFail("expected .failed, got \(outcome)") }
        XCTAssertEqual(nativeShots, 0)
        XCTAssertTrue(submitted.isEmpty)
        XCTAssertEqual(freezes, 0)
        XCTAssertEqual(toasts, ["Capture failed"])
    }

    /// The provider is asynchronous: a kill() or a reporter opening while the
    /// host renders must stop the capture before it freezes anything.
    func testProviderRaceWithKillOrReporterFailsWithoutFreezing() async {
        await withGlobalCaptureStateLock {
            Everframe.captureGate = true
            let killed = makeArmedWithScreenshotDisabled()
            let image = solidImage()
            killed.setEvidenceProvider {
                Everframe.captureGate = false
                return QuickCaptureHostEvidence(image: image, hostReplayVTree: nil)
            }
            let killedOutcome = await killed.capture()
            guard case .failed = killedOutcome else { return XCTFail("expected .failed, got \(killedOutcome)") }
            Everframe.captureGate = true

            let presenting = makeArmedWithScreenshotDisabled()
            presenting.setEvidenceProvider {
                ReportAPI.__performSetPresenting(true)
                return QuickCaptureHostEvidence(image: image, hostReplayVTree: nil)
            }
            let presentingOutcome = await presenting.capture()
            guard case .failed = presentingOutcome else { return XCTFail("expected .failed, got \(presentingOutcome)") }
            ReportAPI.__performSetPresenting(false)

            XCTAssertEqual(freezes, 0)
            XCTAssertTrue(submitted.isEmpty)
        }
    }

    func testScreenshotDisabledWithoutProviderIsIgnored() async {
        let qc = makeArmedWithScreenshotDisabled()
        var nativeShots = 0
        qc.screenshotter = { nativeShots += 1; return nil }
        var toasts: [String] = []
        qc.showToast = { toasts.append($0) }

        let outcome = await qc.capture()

        XCTAssertTrue(isIgnored(outcome, reason: "screenshot_disabled"), "\(outcome)")
        XCTAssertEqual(nativeShots, 0)
        XCTAssertTrue(submitted.isEmpty)
        XCTAssertEqual(freezes, 0)
        XCTAssertTrue(toasts.isEmpty)
    }

    func testDefaultConfigStillUsesNativeScreenshot() async throws {
        let qc = makeArmed()
        var nativeShots = 0
        let native = qc.screenshotter
        qc.screenshotter = { nativeShots += 1; return native() }

        let outcome = await qc.capture()

        guard case .sent = outcome else { return XCTFail("expected .sent, got \(outcome)") }
        XCTAssertEqual(nativeShots, 1)
        let inputs = try XCTUnwrap(submitted.first)
        XCTAssertNil(inputs.hostReplayVTree)
        XCTAssertEqual(inputs.shots.first?.annotated, false)
    }

    /// The SPI installs on the shared capture; `kill()` clears it with the rest
    /// of the session, after which a screenshot-disabled session is ignored again.
    func testKillClearsTheEvidenceProvider() {
        defer { Everframe.shared.kill(); Everframe.__setConfigForTesting(nil) }
        Everframe.shared.__setQuickCaptureEvidenceProvider { nil }
        XCTAssertTrue(QuickCapture.shared.hasEvidenceProvider)
        Everframe.shared.kill()
        XCTAssertFalse(QuickCapture.shared.hasEvidenceProvider)
        Everframe.shared.__setQuickCaptureEvidenceProvider { nil }
        Everframe.shared.__setQuickCaptureEvidenceProvider(nil)
        XCTAssertFalse(QuickCapture.shared.hasEvidenceProvider)
    }

    /// `start` carries the session's `capture.screenshot` into the gate.
    func testStartCarriesCaptureScreenshotIntoTheSession() throws {
        defer { Everframe.shared.kill(); Everframe.__setConfigForTesting(nil) }
        let sdkKey = "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"
        try Everframe.shared.start(config: EverframeConfig(
            sdkKey: sdkKey, capture: CaptureConfig(screenshot: false, logs: false), releaseHealth: nil))
        XCTAssertFalse(QuickCapture.shared.sessionScreenshotEnabled)
        try Everframe.shared.start(config: EverframeConfig(
            sdkKey: sdkKey, capture: CaptureConfig(logs: false), releaseHealth: nil))
        XCTAssertTrue(QuickCapture.shared.sessionScreenshotEnabled)
    }

    func testNoTokenStillSubmits() async throws {
        let qc = makeArmed()
        qc.environment = [:]
        let outcome = await qc.capture()
        guard case .sent = outcome else { return XCTFail("expected .sent, got \(outcome)") }
        XCTAssertNil(try XCTUnwrap(submitted.first).captureToken)
    }

    func testQueuedAndFailedOutcomesReleaseTheLifecycle() async {
        struct Boom: Error {}
        let queued = makeArmed(submit: { _ in .queued(reportId: UUID()) })
        let queuedOutcome = await queued.capture()
        guard case .queued = queuedOutcome else { return XCTFail("expected .queued, got \(queuedOutcome)") }
        XCTAssertEqual(closes.count, 1)

        let failing = makeArmed(submit: { _ in throw Boom() })
        let failedOutcome = await failing.capture()
        guard case .failed = failedOutcome else { return XCTFail("expected .failed, got \(failedOutcome)") }
        XCTAssertEqual(cancels.count, 1)
        XCTAssertEqual(closes.count, 1)
    }

    /// The production lifecycle, not the counting stub: a sent capture releases
    /// the real freeze owner through the close path, which leaves the frozen
    /// breadcrumb snapshot for the submit to consume, and a throwing submit
    /// releases it through cancel, which discards that snapshot. Swapping the two
    /// calls fails both halves. Android twin: `successfulUploadReleasesTheFreeze`.
    func testProductionLifecycleClosesOnSuccessAndCancelsOnFailure() async {
        struct Boom: Error {}
        BreadcrumbRingBuffer.shared.discardAndResume()
        // Close leaves the frozen snapshots for the (stubbed) submit; drop them.
        defer { Everframe.shared.__replayCancel(owner: Everframe.shared.__replayFreeze()) }

        let sent = makeArmed()
        sent.lifecycle = .live
        let sentOutcome = await sent.capture()
        guard case .sent = sentOutcome else { return XCTFail("expected .sent, got \(sentOutcome)") }
        XCTAssertFalse(Everframe.shared.__replayHasReporterOwner, "a sent capture must release the freeze owner")
        XCTAssertNotNil(BreadcrumbRingBuffer.shared.takeFrozen(), "released via close: the frozen snapshot is not discarded")

        let failing = makeArmed(submit: { _ in throw Boom() })
        failing.lifecycle = .live
        let failedOutcome = await failing.capture()
        guard case .failed = failedOutcome else { return XCTFail("expected .failed, got \(failedOutcome)") }
        XCTAssertFalse(Everframe.shared.__replayHasReporterOwner, "a failed capture must release the freeze owner")
        XCTAssertNil(BreadcrumbRingBuffer.shared.takeFrozen(), "released via cancel: the frozen snapshot is discarded")

        // Reusable: the next capture is not refused as `capture_frozen`.
        let next = makeArmed()
        next.lifecycle = .live
        let nextOutcome = await next.capture()
        guard case .sent = nextOutcome else { return XCTFail("expected .sent, got \(nextOutcome)") }
    }

    func testNoWindowFailsWithoutFreezing() async {
        let qc = makeArmed()
        ScreenshotCapture.__windowsOverrideForTesting = []
        let outcome = await qc.capture()
        guard case .failed = outcome else { return XCTFail("expected .failed, got \(outcome)") }
        XCTAssertEqual(freezes, 0)
        XCTAssertTrue(submitted.isEmpty)
    }

    func testSecondTriggerWhileInFlightIgnored() async {
        var release: CheckedContinuation<Void, Never>?
        let entered = expectation(description: "submit entered")
        let qc = makeArmed(submit: { [unowned self] inputs in
            self.submitted.append(inputs)
            // Only the first submit parks; the post-flight one returns at once.
            if self.submitted.count == 1 {
                await withCheckedContinuation { release = $0; entered.fulfill() }
            }
            return .submitted(reportId: UUID())
        })
        let first = Task { await qc.capture() }
        await fulfillment(of: [entered], timeout: 5)

        let second = await qc.capture()
        XCTAssertTrue(isIgnored(second, reason: "in_flight"), "\(second)")
        // The flag the shake gate reads while a capture is in flight.
        XCTAssertTrue(qc.isCapturing)

        release?.resume()
        let firstOutcome = await first.value
        guard case .sent = firstOutcome else { return XCTFail("expected .sent, got \(firstOutcome)") }
        XCTAssertFalse(qc.isCapturing)
        XCTAssertEqual(submitted.count, 1)
        XCTAssertEqual(freezes, 1)

        // The flight is over: the next press captures again.
        let third = await qc.capture()
        guard case .sent = third else { return XCTFail("expected .sent, got \(third)") }
        XCTAssertEqual(submitted.count, 2)
    }

    func testIgnoredWhileReporterPresenting() async {
        let qc = makeArmed()
        ReportAPI.__performSetPresenting(true)
        let outcome = await qc.capture()
        XCTAssertTrue(isIgnored(outcome, reason: "reporter_presenting"), "\(outcome)")
        XCTAssertEqual(freezes, 0)
        XCTAssertTrue(submitted.isEmpty)
    }

    /// The reporter freezes before it flips `isPresenting`, so a held reporter
    /// owner (reporter opening, companion capture) must also stop a quick capture
    /// from freezing over and consuming that frozen evidence.
    func testIgnoredWhileAnotherCaptureHoldsTheFrozenReplay() async {
        let qc = makeArmed()
        let owner = Everframe.shared.__replayFreeze()
        defer { Everframe.shared.__replayCancel(owner: owner) }
        XCTAssertTrue(Everframe.shared.__replayHasReporterOwner)
        let outcome = await qc.capture()
        XCTAssertTrue(isIgnored(outcome, reason: "capture_frozen"), "\(outcome)")
        XCTAssertTrue(submitted.isEmpty)
        XCTAssertEqual(freezes, 0)
        Everframe.shared.__replayCancel(owner: owner)
        XCTAssertFalse(Everframe.shared.__replayHasReporterOwner)
    }

    func testDoubleShiftViaHandleTriggersCapture() async {
        let didSubmit = expectation(description: "submit")
        let qc = makeArmed(submit: { [unowned self] inputs in
            self.submitted.append(inputs)
            didSubmit.fulfill()
            return .submitted(reportId: UUID())
        })
        qc.handle(.down(key: .shift, modifiers: [.shift], isRepeat: false, at: 0))
        qc.handle(.down(key: .shift, modifiers: [.shift], isRepeat: false, at: 0.2))
        await fulfillment(of: [didSubmit], timeout: 5)
        XCTAssertEqual(submitted.count, 1)
        XCTAssertTrue(submitted.first?.quickCapture == true)
    }

    /// The hook passes each press's identity. A key-down that reaches it twice
    /// must not count as the second Shift of a double Shift.
    func testTheSamePressFedTwiceDoesNotFire() async throws {
        let qc = makeArmed()
        let press = NSObject()
        let id = CapturePressID(press: ObjectIdentifier(press), timestamp: 42)
        qc.handle(.down(key: .shift, modifiers: [.shift], isRepeat: false, at: 0), press: id)
        qc.handle(.down(key: .shift, modifiers: [.shift], isRepeat: false, at: 0.01), press: id)
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertTrue(submitted.isEmpty)
        XCTAssertEqual(freezes, 0)

        // A second, distinct press completes the double Shift.
        let didSubmit = expectation(description: "submit")
        qc.submit = { [unowned self] inputs in
            self.submitted.append(inputs)
            didSubmit.fulfill()
            return .submitted(reportId: UUID())
        }
        let other = NSObject()
        qc.handle(.down(key: .shift, modifiers: [.shift], isRepeat: false, at: 0.2),
                  press: CapturePressID(press: ObjectIdentifier(other), timestamp: 42.2))
        await fulfillment(of: [didSubmit], timeout: 5)
        XCTAssertEqual(submitted.count, 1)
        withExtendedLifetime((press, other)) {}
    }

    func testHandleIsInertWhenDisarmed() async throws {
        let qc = makeArmed()
        qc.publish(remote: nil)
        qc.handle(.down(key: .shift, modifiers: [.shift], isRepeat: false, at: 0))
        qc.handle(.down(key: .shift, modifiers: [.shift], isRepeat: false, at: 0.2))
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertTrue(submitted.isEmpty)
        XCTAssertEqual(freezes, 0)
    }

    func testRemoteBindingSelectsTheChord() async {
        let didSubmit = expectation(description: "submit")
        let qc = makeArmed(submit: { [unowned self] inputs in
            self.submitted.append(inputs)
            didSubmit.fulfill()
            return .submitted(reportId: UUID())
        })
        qc.publish(remote: CaptureHotkeyConfigWire(enabled: true, binding: "Mod+Shift+B"))
        // Double Shift no longer fires once the server picked a chord.
        qc.handle(.down(key: .shift, modifiers: [.shift], isRepeat: false, at: 0))
        qc.handle(.down(key: .shift, modifiers: [.shift], isRepeat: false, at: 0.1))
        qc.handle(.down(key: .character("b"), modifiers: [.command, .shift], isRepeat: false, at: 0.3))
        await fulfillment(of: [didSubmit], timeout: 5)
        XCTAssertEqual(submitted.count, 1)
    }

    func testToastWindowExcludedFromScreenshot() {
        let toast = EFQuickCaptureToastWindow(frame: CGRect(x: 0, y: 0, width: 120, height: 40))
        toast.windowLevel = .normal - 1
        toast.isHidden = false
        defer { toast.isHidden = true }

        // Alone, the toast is never the capture target.
        ScreenshotCapture.__windowsOverrideForTesting = [toast]
        XCTAssertNil(ScreenshotCapture.activeKeyWindow())

        // Even below the host window's level, listed first, the host wins.
        ScreenshotCapture.__windowsOverrideForTesting = [toast, hostWindow]
        XCTAssertTrue(ScreenshotCapture.activeKeyWindow() === hostWindow)
        XCTAssertFalse(ScreenshotCapture.activeKeyWindow() is EFQuickCaptureToastWindow)
    }

    func testToastCopy() {
        XCTAssertEqual(QuickCaptureToast.text(for: .sent, deviceName: "iPhone 18 Pro"), "Captured · iPhone 18 Pro")
        XCTAssertEqual(QuickCaptureToast.text(for: .queued, deviceName: "iPhone 18 Pro"), "Captured · uploads when online")
        XCTAssertEqual(QuickCaptureToast.text(for: .failed, deviceName: "iPhone 18 Pro"), "Capture failed")
        XCTAssertNil(QuickCaptureToast.text(for: .ignored(reason: "in_flight"), deviceName: "iPhone 18 Pro"))
        XCTAssertEqual(QuickCaptureToast.windowLevel, .alert + 2)
    }

    /// `start` arms the local half only with both `reporterEnabled` and
    /// `quickCaptureEnabled`; the server block still has to arrive; `kill` disarms.
    func testStartAndKillWireTheSessionGate() throws {
        defer { Everframe.shared.kill(); Everframe.__setConfigForTesting(nil) }
        let sdkKey = "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"
        try Everframe.shared.start(config: EverframeConfig(
            sdkKey: sdkKey, capture: CaptureConfig(logs: false), releaseHealth: nil, reporterEnabled: false))
        XCTAssertEqual(QuickCapture.shared.configurationGateReason, "disabled")

        var optedOut = EverframeConfig(sdkKey: sdkKey, capture: CaptureConfig(logs: false), releaseHealth: nil)
        optedOut.quickCaptureEnabled = false
        try Everframe.shared.start(config: optedOut)
        XCTAssertEqual(QuickCapture.shared.configurationGateReason, "disabled")

        try Everframe.shared.start(config: EverframeConfig(
            sdkKey: sdkKey, capture: CaptureConfig(logs: false), releaseHealth: nil))
        XCTAssertEqual(QuickCapture.shared.configurationGateReason, "remote_disabled")

        Everframe.shared.kill()
        XCTAssertEqual(QuickCapture.shared.configurationGateReason, "not_debug")
    }

    /// `CaptureKeyMapping` works on raw values so the host can test it; pin
    /// them to UIKit's own constants.
    func testKeyMappingRawValuesMatchUIKit() {
        XCTAssertEqual(UIKeyboardHIDUsage.keyboardLeftShift.rawValue, CaptureKeyMapping.leftShiftUsage)
        XCTAssertEqual(UIKeyboardHIDUsage.keyboardRightShift.rawValue, CaptureKeyMapping.rightShiftUsage)
        XCTAssertEqual(UIKeyModifierFlags.shift.rawValue, CaptureKeyMapping.shiftFlag)
        XCTAssertEqual(UIKeyModifierFlags.control.rawValue, CaptureKeyMapping.controlFlag)
        XCTAssertEqual(UIKeyModifierFlags.alternate.rawValue, CaptureKeyMapping.optionFlag)
        XCTAssertEqual(UIKeyModifierFlags.command.rawValue, CaptureKeyMapping.commandFlag)
    }

    func testQuickCaptureTriggerNamesItself() {
        XCTAssertEqual(ReporterTrigger.quickCapture.rawValue, "quick_capture")
    }
}
#endif
