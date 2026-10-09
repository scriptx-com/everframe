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
