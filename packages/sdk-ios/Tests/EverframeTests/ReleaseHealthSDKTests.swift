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
        let key = key; return ReleaseHealthRuntime(root: root, keyProvider: { key }, appRelease: { _ in .testRelease }, transport: { _, _ in .retry })
    }
    /// The detector is injected so the suite gives the same answer on the macOS host and in the simulator.
    private func makeSDK(_ runtime: ReleaseHealthRuntime, debug: Bool = false, notices: NoticeLog = NoticeLog()) -> Everframe {
        Everframe(nativeCrashRuntime: nil, appleDiagnosticRuntime: nil, releaseHealthRuntime: runtime,
            isDebugBuild: { $0 ?? debug }, releaseHealthNotice: { notices.append($0) })
    }
    /// The SDK default: release health on and anonymous.
    private func defaultConfig(_ character: String = "a") -> EverframeConfig {
        .init(sdkKey: "evf_live_" + String(repeating: character, count: 32),
            capture: .init(screenshot: false, focus: false, logs: false, network: false, crash: false), vitals: .init(enabled: false))
    }
    /// Most tests drive release health through setReleaseHealth or the bridge path, so they start with it off.
    private func config(_ character: String = "a", health: ReleaseHealthConfiguration? = nil) -> EverframeConfig {
        var config = defaultConfig(character); config.releaseHealth = health; return config
    }
    /// The release-health work that start(config:) deferred.
    private func started(_ sdk: Everframe) async throws -> Bool {
        try await XCTUnwrap(sdk.releaseHealthStartTask, "start deferred no release-health work").value
    }
    /// Owners differ by user ID; nil is the anonymous owner.
    private func health(_ user: String? = nil) throws -> ReleaseHealthConfiguration {
        try .init(userId: user)
    }
    private func subjects() throws -> [String?] {
        try rows().map { entry in
            let body = try JSONSerialization.jsonObject(with: entry.body) as! [String: Any]
            return ((body["exposure"] as! [String: Any])["subject"] as! [String: String])["id"]
        }
    }
    private func rows() throws -> [ReleaseHealthEntry] { try ReleaseHealthStore(root: root, keyProvider: { self.key }).pending() }
    func testPreparedHealthReservesImmediatelyAndCannotOutliveDisableOrNativeOptIn() async throws {
        let runtime = runtime(); let sdk = makeSDK(runtime)
        try sdk.start(config: config())
        let old = try XCTUnwrap(sdk.prepareReleaseHealth(health(), expectedConfig: config()))
        XCTAssertNil(runtime.readyPointer, "a reservation must not perform durable IO")
        let disable = try XCTUnwrap(sdk.prepareReleaseHealth(nil, expectedConfig: config()))
        let stale = await old(); XCTAssertFalse(stale)
        let erased = await disable(); XCTAssertTrue(erased); XCTAssertTrue(try rows().isEmpty)
        let queued = try XCTUnwrap(sdk.prepareReleaseHealth(health("queued"), expectedConfig: config()))
        let native = try await sdk.setReleaseHealth(health("current")); XCTAssertTrue(native)
        let rejected = await queued(); XCTAssertFalse(rejected)
        XCTAssertNotNil(runtime.readyPointer); XCTAssertEqual(try subjects(), ["current"])
        sdk.kill(); await runtime.barrier(); _ = await sdk.setReleaseHealth(nil)
    }

    func testPreparedHealthRejectsDifferentConfigAndRepeatedValueRestart() async throws {
        let runtime = runtime(); let sdk = makeSDK(runtime)
        try sdk.start(config: config())
        XCTAssertNil(try sdk.prepareReleaseHealth(health(), expectedConfig: config("b")))
        let pending = try XCTUnwrap(sdk.prepareReleaseHealth(health(), expectedConfig: config()))
        try sdk.start(config: config())
        let stale = await pending(); XCTAssertFalse(stale); XCTAssertNil(runtime.readyPointer)
        sdk.kill(); await runtime.barrier(); _ = await sdk.setReleaseHealth(nil)
    }

    func testIdenticalPreparedHealthPreservesDurableSessionAndSnapshotOwnsPointer() async throws {
        let runtime = runtime(); let sdk = makeSDK(runtime)
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
        let runtime = runtime(); let sdk = makeSDK(runtime)
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
        let runtime = runtime(); let sdk = makeSDK(runtime)
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
        let runtime = runtime(); let sdk = makeSDK(runtime)
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

    func testDefaultOnAndIndependentOfCrashReplayAndVitals() async throws {
        let runtime = runtime(); let sdk = makeSDK(runtime)
        let before = try await sdk.setReleaseHealth(health()); XCTAssertFalse(before)
        // Crash capture, replay and vitals are all off in this configuration; release health is on anyway.
        try sdk.start(config: defaultConfig())
        let enabled = try await started(sdk); XCTAssertTrue(enabled)
        XCTAssertEqual(runtime.readyPointer?.app.version, "2.4.0"); XCTAssertEqual(runtime.readyPointer?.app.build, "412")
        let disabled = await sdk.setReleaseHealth(nil); XCTAssertTrue(disabled)
        XCTAssertNil(runtime.readyPointer); XCTAssertTrue(try rows().isEmpty)
        sdk.kill(); await runtime.barrier()
    }
    func testReplacementStartAppliesItsOwnHealthAndNeverBorrowsOldRoute() async throws {
        let runtime = runtime(); let sdk = makeSDK(runtime)
        try sdk.start(config: defaultConfig()); let first = try await started(sdk); XCTAssertTrue(first)
        let a = try XCTUnwrap(runtime.readyPointer)
        try sdk.start(config: defaultConfig("b"))
        // The boundary retires A's pointer before start returns; B's arrives only from B's own work.
        XCTAssertNotEqual(runtime.readyPointer?.exposureID, a.exposureID)
        let second = try await started(sdk); XCTAssertTrue(second)
        let b = try XCTUnwrap(runtime.readyPointer)
        XCTAssertNotEqual(a.exposureID, b.exposureID); XCTAssertEqual(a.processLaunchID, b.processLaunchID)
        XCTAssertEqual(try rows().map(\.sdkKey), [defaultConfig().sdkKey, defaultConfig().sdkKey, defaultConfig("b").sdkKey])
        sdk.kill(); await runtime.barrier(); let erased = await sdk.setReleaseHealth(nil); XCTAssertTrue(erased)
    }
    func testBackgroundOptInWaitsAndForegroundReopensWithLatestIdentity() async throws {
        let runtime = runtime(); let sdk = makeSDK(runtime)
        try sdk.start(config: config())
        await sdk.releaseHealthForegroundChanged(false).value
        let a = try ReleaseHealthConfiguration(userId: "opaque-a", loadedBuildId: "a", loadedBundleStatus: .known)
        let b = try ReleaseHealthConfiguration(userId: "opaque-b", loadedBuildId: "b", loadedBundleStatus: .known)
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
        let key = key, runtime = ReleaseHealthRuntime(root: root, keyProvider: { key }, appRelease: { _ in .testRelease }, initiallyForeground: false, transport: { _, _ in .retry })
        let sdk = makeSDK(runtime)
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
        let runtime = runtime(); let sdk = makeSDK(runtime)
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
        let accepted = try await sdk.setReleaseHealth(health("user-b")); XCTAssertTrue(accepted)
        XCTAssertEqual(try rows().count, 1); XCTAssertEqual(try rows().first?.sdkKey, config("b").sdkKey)
        sdk.kill(); await runtime.barrier(); _ = await sdk.setReleaseHealth(nil)
    }
    func testStartAloneArmsReleaseHealth() async throws {
        XCTAssertEqual(defaultConfig().releaseHealth, ReleaseHealthConfiguration())
        let runtime = runtime(); let sdk = makeSDK(runtime)
        try sdk.start(config: defaultConfig())
        let armed = try await started(sdk); XCTAssertTrue(armed)
        XCTAssertEqual(runtime.readyPointer?.app.version, "2.4.0"); XCTAssertEqual(try subjects(), [nil])
        sdk.kill(); await runtime.barrier(); _ = await sdk.setReleaseHealth(nil)
    }
    func testNilReleaseHealthIsOffAndErasesAtStart() async throws {
        let runtime = runtime(); let sdk = makeSDK(runtime)
        try sdk.start(config: defaultConfig())
        let armed = try await started(sdk); XCTAssertTrue(armed); XCTAssertEqual(try rows().count, 1)
        try sdk.start(config: config())
        let erased = try await started(sdk); XCTAssertTrue(erased)
        XCTAssertNil(runtime.readyPointer); XCTAssertTrue(try rows().isEmpty)
        sdk.kill(); await runtime.barrier()
    }
    func testSetReleaseHealthOverridesUntilTheNextStart() async throws {
        let runtime = runtime(); let sdk = makeSDK(runtime)
        try sdk.start(config: defaultConfig())
        let armed = try await started(sdk); XCTAssertTrue(armed)
        // Login: a new owner ends the anonymous session and opens one for the user.
        let login = try await sdk.setReleaseHealth(health("user-a")); XCTAssertTrue(login)
        XCTAssertEqual(try subjects(), [nil, nil, "user-a"])
        // The next start applies the configuration's anonymous health again.
        try sdk.start(config: defaultConfig())
        let restarted = try await started(sdk); XCTAssertTrue(restarted)
        XCTAssertEqual(try subjects(), [nil, nil, "user-a", "user-a", nil])
        // Off at run time also lasts only until the next start.
        let off = await sdk.setReleaseHealth(nil); XCTAssertTrue(off)
        XCTAssertNil(runtime.readyPointer); XCTAssertTrue(try rows().isEmpty)
        try sdk.start(config: defaultConfig())
        let again = try await started(sdk); XCTAssertTrue(again)
        XCTAssertNotNil(runtime.readyPointer); XCTAssertEqual(try subjects(), [nil])
        sdk.kill(); await runtime.barrier(); _ = await sdk.setReleaseHealth(nil)
    }
    /// `EverframeConfig.debugBuild` decides the skip, exactly as it decides `context.app.debug`.
    func testDebugBuildOverridesTheDetectedAnswerInBothDirections() async throws {
        let runtime = runtime(); let notices = NoticeLog()
        // A detected debug build that the host calls a release build still records, without a line.
        let sdk = makeSDK(runtime, debug: true, notices: notices)
        var forcedRelease = defaultConfig(); forcedRelease.debugBuild = false
        try sdk.start(config: forcedRelease)
        let recorded = try await started(sdk); XCTAssertTrue(recorded)
        XCTAssertNotNil(runtime.readyPointer); XCTAssertEqual(notices.lines, [])
        sdk.kill(); await runtime.barrier(); _ = await sdk.setReleaseHealth(nil)
        // A detected release build that the host calls a debug build is skipped, with one line.
        let other = makeSDK(runtime, debug: false, notices: notices)
        var forcedDebug = defaultConfig(); forcedDebug.debugBuild = true
        try other.start(config: forcedDebug)
        let skipped = try await started(other); XCTAssertFalse(skipped)
        XCTAssertNil(runtime.readyPointer); XCTAssertEqual(notices.lines, ["[everframe] Release health is off in debug builds."])
        // The configured value also reaches the session's record.
        other.kill(); await runtime.barrier(); _ = await other.setReleaseHealth(nil)
    }
    func testDebugBuildIsSkippedErasesAndLogsOncePerStart() async throws {
        XCTAssertNotEqual(ReleaseHealthConfiguration(), ReleaseHealthConfiguration(includeDebugBuilds: true))
        let runtime = runtime(); let notices = NoticeLog()
        let sdk = makeSDK(runtime, debug: true, notices: notices)
        // includeDebugBuilds records in a debug build, for checking an integration.
        try sdk.start(config: config(health: ReleaseHealthConfiguration(includeDebugBuilds: true)))
        let included = try await started(sdk); XCTAssertTrue(included)
        XCTAssertEqual(try rows().count, 1); XCTAssertEqual(notices.lines, [])
        // The default is skipped: no session, the earlier run's records erased, one line.
        try sdk.start(config: defaultConfig())
        let skipped = try await started(sdk); XCTAssertFalse(skipped)
        XCTAssertNil(runtime.readyPointer); XCTAssertTrue(try rows().isEmpty)
        XCTAssertEqual(notices.lines, ["[everframe] Release health is off in debug builds."])
        // setReleaseHealth reports false and stays quiet for the same start.
        let login = try await sdk.setReleaseHealth(health("user-a")); XCTAssertFalse(login)
        XCTAssertNil(runtime.readyPointer); XCTAssertTrue(try rows().isEmpty); XCTAssertEqual(notices.lines.count, 1)
        // The next start logs again. Turning release health off is not a skip and logs nothing.
        try sdk.start(config: defaultConfig()); _ = try await started(sdk)
        XCTAssertEqual(notices.lines.count, 2)
        try sdk.start(config: config()); _ = try await started(sdk)
        XCTAssertEqual(notices.lines.count, 2)
        sdk.kill(); await runtime.barrier(); _ = await sdk.setReleaseHealth(nil)
    }
}

/// Collects SDK console lines from the injected notice seam.
private final class NoticeLog: @unchecked Sendable {
    private let lock = NSLock(); private var stored: [String] = []
    var lines: [String] { lock.withLock { stored } }
    func append(_ line: String) { lock.withLock { stored.append(line) } }
}
