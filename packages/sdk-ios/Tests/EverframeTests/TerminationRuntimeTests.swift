// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import EverframeProtocol
@testable import EverframeKit

final class TerminationRuntimeTests: XCTestCase {
    final class Box<T>: @unchecked Sendable {
        private let lock = NSLock(); private var value: T?
        init(_ value: T? = nil) { self.value = value }
        func set(_ next: T) { lock.withLock { value = next } }
        func get() -> T? { lock.withLock { value } }
    }
    private var directory: URL!
    private let key = Data(repeating: 0x47, count: 32)
    private let launch = UUID()
    private var root: URL { directory.appendingPathComponent("native") }
    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: directory) }
    private func box() -> JSONLOutbox { let key = key; return JSONLOutbox(fileURL: directory.appendingPathComponent("queue"), maxEntries: 50, keyProvider: { key }) }
    private func makeRuntime(publish: Box<Bool> = Box(true), enabled: Bool = true) -> (NativeCrashRuntime, Box<TerminationStateFile>) {
        let key = key, captured = Box<TerminationStateFile>()
        let runtime = NativeCrashRuntime(rootURL: root, outbox: box(),
            recorder: .init(install: { _ in true }, disable: {}, publish: { _ in publish.get() ?? false }),
            keyProvider: { key },
            termination: .init(enabled: enabled, identity: { TerminationStateFileTests.identity }, now: { Date() },
                launchID: launch, startTracking: { captured.set($0) }))
        return (runtime, captured)
    }
    private func armed(_ captured: Box<TerminationStateFile>) throws -> TerminationRunRecord {
        try TerminationRunRecord(bytes: Data(contentsOf: XCTUnwrap(captured.get()).url))
    }
    /// A previous SDK process that was killed while active and armed. Returns its launch ID.
    private func closedKilledRun(at offset: TimeInterval) throws -> UUID {
        let key = key, live = try NativeCrashRecovery(rootURL: root, activeRunIDs: [], keyProvider: { key })
        let started = Date().addingTimeInterval(offset), run = try live.prepareRun(now: started, terminationState: true)
        let contextID = try live.writeContext(NativeRecoveryTestData.context(), runID: run.id)
        let state = try XCTUnwrap(run.terminationState), launch = UUID()
        state.writeHeader(launchID: launch, identity: TerminationStateFileTests.identity, startedAt: started)
        state.store(TerminationAppState.active.rawValue, at: TerminationLayout.appStateAt)
        state.store(started.addingTimeInterval(10), at: TerminationLayout.stateChangedAt)
        state.arm(contextID: contextID)
        return launch
    }

    func testPublishArmsAndInvalidateDisarms() async throws {
        let (runtime, captured) = makeRuntime()
        let ok = await runtime.refresh(ticket: runtime.invalidate(), context: { try NativeRecoveryTestData.context() })
        XCTAssertTrue(ok)
        let record = try armed(captured); XCTAssertTrue(record.armed); XCTAssertNotNil(record.contextID)
        XCTAssertEqual(record.launchID, launch); XCTAssertEqual(record.identity, TerminationStateFileTests.identity)
        _ = runtime.invalidate()
        XCTAssertFalse(try armed(captured).armed)
    }
    func testFailedPublishLeavesTheStateDisarmed() async throws {
        let (runtime, captured) = makeRuntime(publish: Box(false))
        let ok = await runtime.refresh(ticket: runtime.invalidate(), context: { try NativeRecoveryTestData.context() })
        XCTAssertFalse(ok)
        XCTAssertFalse(try armed(captured).armed)
    }
    func testRepublishingAnotherContextRearmsWithTheLatestIdentifier() async throws {
        let (runtime, captured) = makeRuntime()
        let first = await runtime.refresh(ticket: runtime.invalidate(), context: { try NativeRecoveryTestData.context(owner: "sdk-A") })
        XCTAssertTrue(first)
        let a = try armed(captured).contextID
        let second = await runtime.refresh(ticket: runtime.invalidate(), context: { try NativeRecoveryTestData.context(owner: "sdk-B") })
        XCTAssertTrue(second)
        let b = try armed(captured); XCTAssertTrue(b.armed); XCTAssertNotNil(b.contextID); XCTAssertNotEqual(b.contextID, a)
    }
    func testRetiringTheExposureRearmsOnlyOnMain() async throws {
        let (runtime, captured) = makeRuntime()
        let ok = await runtime.refresh(ticket: runtime.invalidate(), context: { try NativeRecoveryTestData.context() })
        XCTAssertTrue(ok)
        XCTAssertTrue(try armed(captured).armed)
        await Task.detached { _ = runtime.retireExposure() }.value   // off main: no rearm until the next refresh
        XCTAssertFalse(try armed(captured).armed)
        let again = await runtime.refresh(ticket: runtime.invalidate(), context: { try NativeRecoveryTestData.context() })
        XCTAssertTrue(again)
        // Without a release-health pointer the published context is its own unlinked twin.
        let published = try armed(captured).contextID
        await MainActor.run { _ = runtime.retireExposure() }          // on main: the unlinked twin is rearmed at once
        let record = try armed(captured)
        XCTAssertTrue(record.armed); XCTAssertNotNil(published); XCTAssertEqual(record.contextID, published)
    }
    func testRecoveryEvaluatesOnlyTheNewestClosedRun() async throws {
        let older = try closedKilledRun(at: -120), newer = try closedKilledRun(at: -60)
        let (runtime, _) = makeRuntime()
        let ok = await runtime.refresh(ticket: runtime.invalidate(), context: { try NativeRecoveryTestData.context() })
        XCTAssertTrue(ok)
        let entries = try box().hydrate()
        XCTAssertEqual(entries.count, 1)
        let launch = try EverframeReportEnvelope(data: XCTUnwrap(entries.first).envelopeBytes).payload.inferredTermination?.processLaunchID
        XCTAssertEqual(launch, newer.uuidString.lowercased()); XCTAssertNotEqual(launch, older.uuidString.lowercased())
    }
    func testDisabledInferenceCreatesNoStateAndInfersNothing() async throws {
        _ = try closedKilledRun(at: -60)
        let (runtime, captured) = makeRuntime(enabled: false)
        let ok = await runtime.refresh(ticket: runtime.invalidate(), context: { try NativeRecoveryTestData.context() })
        XCTAssertTrue(ok)
        XCTAssertNil(captured.get())
        XCTAssertTrue(try box().hydrate().isEmpty)
    }
}
