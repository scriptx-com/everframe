// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import Foundation
@testable import EverframeKit

final class ReleaseHealthSDKTests: XCTestCase {
    private var root: URL!
    private let key = Data(repeating: 0x78, count: 32)
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    }
    override func tearDownWithError() throws {
        Everframe.__bodyStateResetHookForTesting = nil
        Everframe.__beforeReleaseHealthReservationForTesting = nil
        try FileManager.default.removeItem(at: root)
    }
    private func runtime() -> ReleaseHealthRuntime {
        let key = key; return ReleaseHealthRuntime(root: root, keyProvider: { key }, transport: { _, _ in .retry })
    }
    private func config(_ character: String = "a") -> EverframeConfig {
        .init(appId: "evf_live_" + String(repeating: character, count: 32),
            capture: .init(screenshot: false, focus: false, logs: false, network: false, crash: false), vitals: .init(enabled: false))
    }
    private func health(_ build: String = "native-a") throws -> ReleaseHealthConfiguration {
        try .init(nativeBuildId: build, loadedBuildId: nil, loadedBundleStatus: .notApplicable)
    }
    private func rows() throws -> [ReleaseHealthEntry] { try ReleaseHealthStore(root: root, keyProvider: { self.key }).pending() }
    func testPreparedHealthReservesImmediatelyAndCannotOutliveDisableOrNativeOptIn() async throws {
        let runtime = runtime(); let sdk = Everframe(nativeCrashRuntime: nil, appleDiagnosticRuntime: nil, releaseHealthRuntime: runtime)
        try sdk.start(config: config())
        let old = try XCTUnwrap(sdk.prepareReleaseHealth(health(), expectedConfig: config()))
        XCTAssertNil(runtime.readyPointer, "a reservation must not perform durable IO")
        let disable = try XCTUnwrap(sdk.prepareReleaseHealth(nil, expectedConfig: config()))
        let stale = await old(); XCTAssertFalse(stale)
        let erased = await disable(); XCTAssertTrue(erased); XCTAssertTrue(try rows().isEmpty)
        let queued = try XCTUnwrap(sdk.prepareReleaseHealth(health("queued"), expectedConfig: config()))
        let native = try await sdk.setReleaseHealth(health("native-current")); XCTAssertTrue(native)
        let rejected = await queued(); XCTAssertFalse(rejected)
        XCTAssertEqual(runtime.readyPointer?.nativeBuildID, "native-current")
        sdk.kill(); await runtime.barrier(); _ = await sdk.setReleaseHealth(nil)
    }

    func testPreparedHealthRejectsDifferentConfigAndRepeatedValueRestart() async throws {
        let runtime = runtime(); let sdk = Everframe(nativeCrashRuntime: nil, appleDiagnosticRuntime: nil, releaseHealthRuntime: runtime)
        try sdk.start(config: config())
        XCTAssertNil(try sdk.prepareReleaseHealth(health(), expectedConfig: config("b")))
        let pending = try XCTUnwrap(sdk.prepareReleaseHealth(health(), expectedConfig: config()))
        try sdk.start(config: config())
        let stale = await pending(); XCTAssertFalse(stale); XCTAssertNil(runtime.readyPointer)
        sdk.kill(); await runtime.barrier(); _ = await sdk.setReleaseHealth(nil)
    }

    func testIdenticalPreparedHealthPreservesDurableSessionAndSnapshotOwnsPointer() async throws {
        let runtime = runtime(); let sdk = Everframe(nativeCrashRuntime: nil, appleDiagnosticRuntime: nil, releaseHealthRuntime: runtime)
        try sdk.start(config: config())
        let first = try XCTUnwrap(sdk.prepareReleaseHealth(health(), expectedConfig: config()))
        let enabled = await first(); XCTAssertTrue(enabled)
        let pointer = try XCTUnwrap(runtime.readyPointer)
        let captured = sdk.captureSessionWithNativeExposure()
        XCTAssertEqual(captured.session.config, config()); XCTAssertEqual(try ReleaseHealthDate.encoder().encode(XCTUnwrap(captured.exposure)), try ReleaseHealthDate.encoder().encode(pointer))
        let duplicate = try XCTUnwrap(sdk.prepareReleaseHealth(health(), expectedConfig: config()))
        let stillEnabled = await duplicate(); XCTAssertTrue(stillEnabled)
        XCTAssertEqual(runtime.readyPointer?.exposureID, pointer.exposureID); XCTAssertEqual(try rows().count, 1)
        await sdk.releaseHealthForegroundChanged(false).value
        XCTAssertNil(sdk.captureSessionWithNativeExposure().exposure)
        sdk.kill(); await runtime.barrier(); _ = await sdk.setReleaseHealth(nil)
    }

    func testStartAndPrepareCannotBorrowSameValuedSupersedingStart() async throws {
        let runtime = runtime(); let sdk = Everframe(nativeCrashRuntime: nil, appleDiagnosticRuntime: nil, releaseHealthRuntime: runtime)
        let entered = expectation(description: "first start reserved"), release = DispatchSemaphore(value: 0)
        Everframe.__bodyStateResetHookForTesting = { entered.fulfill(); _ = release.wait(timeout: .now() + 5) }
        let cfg = config(), health = try health()
        let first = Task.detached { try sdk.startAndPrepareReleaseHealth(config: cfg, health: health) }
        await fulfillment(of: [entered], timeout: 3)
        Everframe.__bodyStateResetHookForTesting = nil
        try sdk.start(config: cfg)
        release.signal()
        let stale = try await first.value
        XCTAssertNil(stale, "the first configure did not publish this owner, even though config values match")
        if let stale { _ = await stale() }
        XCTAssertNil(runtime.readyPointer); XCTAssertTrue(try rows().isEmpty)
        sdk.kill(); await runtime.barrier(); _ = await sdk.setReleaseHealth(nil)
    }

    func testUnifiedConfigureDoesNotBorrowSameValuedRestartAfterUnchangedDecision() async throws {
        let runtime = runtime(); let sdk = Everframe(nativeCrashRuntime: nil, appleDiagnosticRuntime: nil, releaseHealthRuntime: runtime)
        try sdk.start(config: config())
        Everframe.__beforeReleaseHealthReservationForTesting = { try! sdk.start(config: self.config()) }
        let stale = try sdk.configureAndPrepareReleaseHealth(config: config(), health: health())
        Everframe.__beforeReleaseHealthReservationForTesting = nil
        XCTAssertNil(stale, "unchanged values do not establish unchanged ownership")
        if let stale { _ = await stale() }
        XCTAssertNil(runtime.readyPointer); XCTAssertTrue(try rows().isEmpty)
        sdk.kill(); await runtime.barrier(); _ = await sdk.setReleaseHealth(nil)
    }

    func testUnifiedConfigureKeepsIdenticalSessionAndHonorsForcedRestart() async throws {
        let runtime = runtime(); let sdk = Everframe(nativeCrashRuntime: nil, appleDiagnosticRuntime: nil, releaseHealthRuntime: runtime)
        let first = try XCTUnwrap(sdk.configureAndPrepareReleaseHealth(config: config(), health: health()))
        let enabled = await first(); XCTAssertTrue(enabled)
        let original = try XCTUnwrap(runtime.readyPointer), epoch = sdk.currentStartEpoch
        let same = try XCTUnwrap(sdk.configureAndPrepareReleaseHealth(config: config(), health: health()))
        let stillEnabled = await same(); XCTAssertTrue(stillEnabled)
        XCTAssertEqual(sdk.currentStartEpoch, epoch); XCTAssertEqual(runtime.readyPointer?.exposureID, original.exposureID)
        let forced = try XCTUnwrap(sdk.configureAndPrepareReleaseHealth(config: config(), health: health(), forceRestart: true))
        let replaced = await forced(); XCTAssertTrue(replaced)
        XCTAssertNotEqual(sdk.currentStartEpoch, epoch); XCTAssertNotEqual(runtime.readyPointer?.exposureID, original.exposureID)
        sdk.kill(); await runtime.barrier(); _ = await sdk.setReleaseHealth(nil)
    }

    func testDefaultOffAndIndependentOfCrashReplayAndVitals() async throws {
        let runtime = runtime(); let sdk = Everframe(nativeCrashRuntime: nil, appleDiagnosticRuntime: nil, releaseHealthRuntime: runtime)
        let before = try await sdk.setReleaseHealth(health()); XCTAssertFalse(before)
        try sdk.start(config: config()); XCTAssertNil(runtime.readyPointer)
        let enabled = try await sdk.setReleaseHealth(health()); XCTAssertTrue(enabled)
        XCTAssertEqual(runtime.readyPointer?.nativeBuildID, "native-a")
        let disabled = await sdk.setReleaseHealth(nil); XCTAssertTrue(disabled)
        XCTAssertNil(runtime.readyPointer); XCTAssertTrue(try rows().isEmpty)
        sdk.kill(); await runtime.barrier()
    }
    func testReplacementRequiresNewOptInAndNeverBorrowsOldRoute() async throws {
        let runtime = runtime(); let sdk = Everframe(nativeCrashRuntime: nil, appleDiagnosticRuntime: nil, releaseHealthRuntime: runtime)
        try sdk.start(config: config()); let first = try await sdk.setReleaseHealth(health()); XCTAssertTrue(first)
        let a = try XCTUnwrap(runtime.readyPointer)
        try sdk.start(config: config("b")); XCTAssertNil(runtime.readyPointer)
        let second = try await sdk.setReleaseHealth(health("native-b")); XCTAssertTrue(second)
        let b = try XCTUnwrap(runtime.readyPointer)
        XCTAssertNotEqual(a.exposureID, b.exposureID); XCTAssertEqual(a.processLaunchID, b.processLaunchID)
        XCTAssertEqual(try rows().map(\.sdkKey), [config().appId, config().appId, config("b").appId])
        sdk.kill(); await runtime.barrier(); let erased = await sdk.setReleaseHealth(nil); XCTAssertTrue(erased)
    }
    func testBackgroundOptInWaitsAndForegroundReopensWithLatestIdentity() async throws {
        let runtime = runtime(); let sdk = Everframe(nativeCrashRuntime: nil, appleDiagnosticRuntime: nil, releaseHealthRuntime: runtime)
        try sdk.start(config: config())
        await sdk.releaseHealthForegroundChanged(false).value
        let a = try ReleaseHealthConfiguration(nativeBuildId: "native", loadedBuildId: "a", loadedBundleStatus: .known, userId: "opaque-a")
        let b = try ReleaseHealthConfiguration(nativeBuildId: "native", loadedBuildId: "b", loadedBundleStatus: .known, userId: "opaque-b")
        let first = await sdk.setReleaseHealth(a); XCTAssertFalse(first)
        let changed = await sdk.setReleaseHealth(b); XCTAssertFalse(changed)
        XCTAssertTrue(try rows().isEmpty)
        await sdk.releaseHealthForegroundChanged(true).value
        XCTAssertNotNil(runtime.readyPointer)
        let body = try JSONSerialization.jsonObject(with: XCTUnwrap(rows().first).body) as! [String: Any]
        let exposure = body["exposure"] as! [String: Any]
        XCTAssertEqual(exposure["loadedBuildId"] as? String, "b")
        XCTAssertEqual(exposure["subject"] as? [String: String], ["kind": "provided", "id": "opaque-b"])
        sdk.kill(); await runtime.barrier(); _ = await sdk.setReleaseHealth(nil)
    }
    func testLaunchOptInWaitsForTheFirstLifecycleSnapshot() async throws {
        // As on iOS: admission reads background until the observer that init installs
        // delivers the first application state on a later main-actor turn.
        let key = key, runtime = ReleaseHealthRuntime(root: root, keyProvider: { key }, initiallyForeground: false, transport: { _, _ in .retry })
        let sdk = Everframe(nativeCrashRuntime: nil, appleDiagnosticRuntime: nil, releaseHealthRuntime: runtime)
        try sdk.start(config: config())
        sdk.releaseHealthLifecycleReady = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 100_000_000)
            _ = sdk.releaseHealthForegroundChanged(true)
        }
        let enabled = try await sdk.setReleaseHealth(health()); XCTAssertTrue(enabled)
        XCTAssertNotNil(runtime.readyPointer); XCTAssertEqual(try rows().count, 1)
        sdk.kill(); await runtime.barrier(); _ = await sdk.setReleaseHealth(nil)
    }
    func testReservedStartEpochCannotPublishHealthWithPreviousConfiguration() async throws {
        let runtime = runtime(); let sdk = Everframe(nativeCrashRuntime: nil, appleDiagnosticRuntime: nil, releaseHealthRuntime: runtime)
        try sdk.start(config: config()); let enabled = try await sdk.setReleaseHealth(health()); XCTAssertTrue(enabled)
        let entered = expectation(description: "start reserved before config publication"), release = DispatchSemaphore(value: 0)
        Everframe.__bodyStateResetHookForTesting = { entered.fulfill(); _ = release.wait(timeout: .now() + 5) }
        let replacementConfig = config("b")
        let replacement = Task.detached { try sdk.start(config: replacementConfig) }
        await fulfillment(of: [entered], timeout: 3)
        let rejected = try await sdk.setReleaseHealth(health("wrong-owner")); XCTAssertFalse(rejected)
        let disabled = await sdk.setReleaseHealth(nil); XCTAssertTrue(disabled)
        release.signal(); try await replacement.value; Everframe.__bodyStateResetHookForTesting = nil
        XCTAssertNil(runtime.readyPointer)
        let accepted = try await sdk.setReleaseHealth(health("native-b")); XCTAssertTrue(accepted)
        XCTAssertEqual(try rows().count, 1); XCTAssertEqual(try rows().first?.sdkKey, config("b").appId)
        sdk.kill(); await runtime.barrier(); _ = await sdk.setReleaseHealth(nil)
    }
}
