// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import Foundation
import EverframeProtocol
@testable import EverframeKit

final class ReleaseHealthRuntimeTests: XCTestCase {
    private var root: URL!
    private let key = Data(repeating: 0x72, count: 32)
    private let now = Date(timeIntervalSince1970: 1_791_421_323.456)
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }
    private func configuration(_ id: String = "native-a") throws -> ReleaseHealthConfiguration {
        try .init(nativeBuildId: id, loadedBuildId: nil, loadedBundleStatus: .notApplicable)
    }
    private func runtime(beforeCommit: @escaping () throws -> Void = {}) -> ReleaseHealthRuntime {
        let key = key, now = now
        return ReleaseHealthRuntime(root: root, keyProvider: { key }, now: { now },
            beforeCommit: beforeCommit, transport: { _, _ in .retry })
    }
    private func enable(_ runtime: ReleaseHealthRuntime, id: String = "native-a", key: String = "key-a") async throws -> Bool {
        let config = try configuration(id)
        let ticket = runtime.requestEnable(configuration: config, sdkKey: key, endpoint: "https://a.example/api/ingest/release-health")
        return await runtime.enable(ticket: ticket, sdkVersion: "1.0.0")
    }
    private func rows() throws -> [ReleaseHealthEntry] { try ReleaseHealthStore(root: root, keyProvider: { self.key }).pending() }
    func testForegroundSubjectsAreFrozenAcrossAccountRotation() async throws {
        let runtime = runtime()
        let first = try ReleaseHealthConfiguration(nativeBuildId: "native", loadedBuildId: "bundle-a", loadedBundleStatus: .known, userId: "opaque-a")
        let ticket = runtime.requestEnable(configuration: first, sdkKey: "key-a", endpoint: "https://a.example/api/ingest/release-health")
        let accepted = await runtime.enable(ticket: ticket, sdkVersion: "test"); XCTAssertTrue(accepted)
        let a = try XCTUnwrap(runtime.readyPointer)
        runtime.boundary()
        let second = try ReleaseHealthConfiguration(nativeBuildId: "native", loadedBuildId: "bundle-b", loadedBundleStatus: .known, userId: "opaque-b")
        let next = runtime.requestEnable(configuration: second, sdkKey: "key-a", endpoint: "https://a.example/api/ingest/release-health")
        let replaced = await runtime.enable(ticket: next, sdkVersion: "test"); XCTAssertTrue(replaced)
        XCTAssertEqual(a.processLaunchID, runtime.readyPointer?.processLaunchID)
        let records = try rows().map { try JSONSerialization.jsonObject(with: $0.body) as! [String: Any] }
        XCTAssertEqual(records.count, 3)
        for record in records { XCTAssertEqual(record["schemaVersion"] as? Int, 3) }
        let exposures = records.map { $0["exposure"] as! [String: Any] }
        XCTAssertEqual(exposures[0]["subject"] as? [String: String], ["kind": "provided", "id": "opaque-a"])
        XCTAssertEqual(exposures[1]["subject"] as? [String: String], ["kind": "provided", "id": "opaque-a"])
        XCTAssertEqual(exposures[2]["subject"] as? [String: String], ["kind": "provided", "id": "opaque-b"])
        XCTAssertEqual(exposures[2]["sessionPolicy"] as? String, "foreground-v1")
        let erased = await runtime.finishRevocation(runtime.revoke()); XCTAssertTrue(erased)
        XCTAssertTrue(try rows().isEmpty)
    }
    func testCanonicallyEquivalentOpaqueIDsRotateWithoutAnExplicitBoundary() async throws {
        let runtime = runtime(), composed = "\u{00e9}", decomposed = "e\u{0301}"
        let a = try ReleaseHealthConfiguration(nativeBuildId: "native", loadedBuildId: nil, loadedBundleStatus: .notApplicable, userId: composed)
        let first = runtime.requestEnable(configuration: a, sdkKey: "key", endpoint: "https://example.test")
        let accepted = await runtime.enable(ticket: first, sdkVersion: "test"); XCTAssertTrue(accepted)
        let pointer = try XCTUnwrap(runtime.readyPointer)
        let b = try ReleaseHealthConfiguration(nativeBuildId: "native", loadedBuildId: nil, loadedBundleStatus: .notApplicable, userId: decomposed)
        let second = runtime.requestEnable(configuration: b, sdkKey: "key", endpoint: "https://example.test")
        XCTAssertNotEqual(first, second); XCTAssertNil(runtime.readyPointer)
        let changed = await runtime.enable(ticket: second, sdkVersion: "test"); XCTAssertTrue(changed)
        XCTAssertNotEqual(pointer.exposureID, runtime.readyPointer?.exposureID)
        XCTAssertEqual(pointer.processLaunchID, runtime.readyPointer?.processLaunchID)
        let ids = try rows().map { entry -> [UInt8] in
            let record = try JSONSerialization.jsonObject(with: entry.body) as! [String: Any]
            let subject = (record["exposure"] as! [String: Any])["subject"] as! [String: String]
            return Array(subject["id"]!.utf8)
        }
        XCTAssertEqual(ids, [Array(composed.utf8), Array(composed.utf8), Array(decomposed.utf8)])
        runtime.boundary(); await runtime.barrier()
    }
    func testCompletedEndClampsWallClockRollbackAndKeepsMonotonicElapsed() throws {
        let segment = ReleaseHealthSegment(configuration: try configuration(), sdkVersion: "test", sdkKey: "key",
            endpoint: "https://example.test", processLaunchID: UUID(), now: now, uptime: 10)
        let body = try JSONSerialization.jsonObject(with: segment.entry(end: true, now: now.addingTimeInterval(-30), uptime: 12).body) as! [String: Any]
        XCTAssertEqual(body["schemaVersion"] as? Int, 3)
        XCTAssertEqual(body["outcome"] as? String, "completed")
        XCTAssertEqual(body["capturedAt"] as? String, "2026-10-08T01:02:03.456Z")
        XCTAssertEqual(body["elapsedMs"] as? Int, 2000)
    }
    func testInvalidProvidedSubjectIsRefused() throws {
        for id in ["", " ", String(repeating: "a", count: 129), "a\u{0000}", "\u{feff}", " \u{feff}\u{00a0}"] {
            XCTAssertThrowsError(try ReleaseHealthConfiguration(nativeBuildId: "native", loadedBuildId: nil, loadedBundleStatus: .notApplicable, userId: id))
        }
        XCTAssertNoThrow(try ReleaseHealthConfiguration(nativeBuildId: "native", loadedBuildId: nil, loadedBundleStatus: .notApplicable, userId: String(repeating: "a", count: 128)))
    }
    func testReadinessIsAbsentUntilDurableAppendAndSameOwnerEnableIsIdempotent() async throws {
        let runtime = runtime(); let config = try configuration()
        let ticket = runtime.requestEnable(configuration: config, sdkKey: "key-a", endpoint: "https://a.example/api/ingest/release-health")
        XCTAssertNil(runtime.readyPointer)
        let accepted = await runtime.enable(ticket: ticket, sdkVersion: "1.0.0"); XCTAssertTrue(accepted)
        let pointer = try XCTUnwrap(runtime.readyPointer)
        XCTAssertEqual(pointer.nativeBuildID, "native-a")
        XCTAssertEqual(try rows().count, 1)
        let again = try await enable(runtime); XCTAssertTrue(again)
        XCTAssertEqual(runtime.readyPointer?.exposureID, pointer.exposureID)
        XCTAssertEqual(try rows().count, 1)
        runtime.boundary(); await runtime.barrier()
    }
    func testReplacementHasDistinctSegmentSameProcessAndExplicitOldEnd() async throws {
        let runtime = runtime(); let first = try await enable(runtime); XCTAssertTrue(first)
        let a = try XCTUnwrap(runtime.readyPointer)
        runtime.boundary(); XCTAssertNil(runtime.readyPointer)
        let second = try await enable(runtime, id: "native-b"); XCTAssertTrue(second)
        let b = try XCTUnwrap(runtime.readyPointer)
        XCTAssertNotEqual(a.exposureID, b.exposureID); XCTAssertEqual(a.processLaunchID, b.processLaunchID)
        let records = try rows().map { try JSONSerialization.jsonObject(with: $0.body) as! [String: Any] }
        XCTAssertEqual(records.compactMap { $0["phase"] as? String }, ["start", "end", "start"])
        XCTAssertEqual((records[1]["exposure"] as? [String: Any])?["nativeRelease"] as? [String: String], ["buildId": "native-a"])
        runtime.boundary(); await runtime.barrier()
    }
    func testStalePendingEnableCannotPublishOrReopenAfterDisable() async throws {
        let runtime = runtime(); let ticket = runtime.requestEnable(configuration: try configuration(), sdkKey: "key-a", endpoint: "https://a.example/api/ingest/release-health")
        let erase = runtime.revoke()
        let stale = await runtime.enable(ticket: ticket, sdkVersion: "1.0.0"); XCTAssertFalse(stale)
        let erased = await runtime.finishRevocation(erase); XCTAssertTrue(erased)
        XCTAssertNil(runtime.readyPointer); XCTAssertTrue(try rows().isEmpty)
    }
    func testFailedPurgeCannotBeForgottenByReenable() async throws {
        let state = FailureFlag(); let runtime = runtime(beforeCommit: { if state.value { throw CocoaError(.fileWriteNoPermission) } })
        let first = try await enable(runtime); XCTAssertTrue(first)
        state.value = true; let erase = runtime.revoke()
        let erased = await runtime.finishRevocation(erase); XCTAssertFalse(erased)
        let blocked = try await enable(runtime, id: "native-b"); XCTAssertFalse(blocked); XCTAssertNil(runtime.readyPointer)
        state.value = false
        let accepted = try await enable(runtime, id: "native-b"); XCTAssertTrue(accepted)
        let bodies = try rows().map { String(decoding: $0.body, as: UTF8.self) }
        XCTAssertEqual(bodies.count, 1); XCTAssertFalse(bodies.contains { $0.contains("native-a") })
        runtime.boundary(); await runtime.barrier()
    }
    func testStartAndFrozenPointerUseIdenticalMillisecondTimestampAndNullBundle() async throws {
        let runtime = runtime(); let accepted = try await enable(runtime); XCTAssertTrue(accepted)
        let body = try JSONSerialization.jsonObject(with: XCTUnwrap(rows().first).body) as! [String: Any]
        let exposure = body["exposure"] as! [String: Any]
        XCTAssertEqual(exposure["startedAt"] as? String, "2026-10-08T01:02:03.456Z")
        XCTAssertTrue(exposure["loadedBuildId"] is NSNull)
        XCTAssertEqual(exposure["subject"] as? [String: String], ["kind": "anonymous"])
        XCTAssertEqual(body["schemaVersion"] as? Int, 3)
        XCTAssertEqual(body["capturedAt"] as? String, exposure["startedAt"] as? String)
        let pointer = try XCTUnwrap(runtime.readyPointer)
        XCTAssertEqual(Int64((pointer.startedAt.timeIntervalSince1970 * 1000).rounded()), Int64((now.timeIntervalSince1970 * 1000).rounded()))
        runtime.boundary(); await runtime.barrier()
    }
    func testDisableDuringDurableAppendNeverPublishesReadiness() async throws {
        let entered = expectation(description: "append reached durable boundary")
        let release = DispatchSemaphore(value: 0); let blocked = FailureFlag(); blocked.value = true
        let runtime = runtime(beforeCommit: {
            if blocked.value { blocked.value = false; entered.fulfill(); _ = release.wait(timeout: .now() + 5) }
        })
        let ticket = runtime.requestEnable(configuration: try configuration(), sdkKey: "key-a", endpoint: "https://a.example/api/ingest/release-health")
        let pending = Task { await runtime.enable(ticket: ticket, sdkVersion: "1.0.0") }
        await fulfillment(of: [entered], timeout: 3)
        let erase = runtime.revoke(); XCTAssertNil(runtime.readyPointer); release.signal()
        let accepted = await pending.value; XCTAssertFalse(accepted)
        let erased = await runtime.finishRevocation(erase); XCTAssertTrue(erased)
        XCTAssertTrue(try rows().isEmpty); XCTAssertNil(runtime.readyPointer)
    }
    func testPreparedTransportCannotStartAfterRevocation() async throws {
        let prepared = expectation(description: "transport prepared")
        let gate = HealthAsyncGate(); let sent = FailureFlag(); let key = key, now = now
        let runtime = ReleaseHealthRuntime(root: root, keyProvider: { key }, now: { now }, transport: { _, admission in
            prepared.fulfill(); await gate.wait()
            _ = admission { sent.value = true }
            return .retry
        })
        let accepted = try await enable(runtime); XCTAssertTrue(accepted)
        await fulfillment(of: [prepared], timeout: 3)
        let erase = runtime.revoke()
        let erased = await runtime.finishRevocation(erase); XCTAssertTrue(erased)
        await gate.release(); await runtime.flush()
        XCTAssertFalse(sent.value); XCTAssertTrue(try rows().isEmpty)
    }
    func testFailedStartAppendNeverPublishesReadiness() async throws {
        let holder = HealthRuntimeHolder(), readyDuringCommit = HealthValues<Bool?>()
        let runtime = runtime(beforeCommit: {
            readyDuringCommit.append(holder.runtime.map { $0.readyPointer != nil })
            throw CocoaError(.fileWriteOutOfSpace)
        })
        holder.runtime = runtime
        let accepted = try await enable(runtime); XCTAssertFalse(accepted)
        XCTAssertEqual(readyDuringCommit.values, [false])
        XCTAssertNil(runtime.readyPointer); XCTAssertTrue(try rows().isEmpty)
    }
    func testFullJournalRejectsStartWithoutReadiness() async throws {
        let store = try ReleaseHealthStore(root: root, keyProvider: { self.key })
        for _ in 0..<256 {
            try store.append(.init(recordID: UUID(), createdAt: now, sdkKey: "key-a",
                endpoint: "https://a.example/api/ingest/release-health", body: Data("{}".utf8)))
        }
        let runtime = runtime(); let accepted = try await enable(runtime); XCTAssertFalse(accepted)
        XCTAssertNil(runtime.readyPointer); XCTAssertEqual(try rows().count, 256)
    }
    func testInterruptedStagingIsErasedBeforeTheNextStart() async throws {
        let old = ReleaseHealthSegment(configuration: try configuration("native-old"), sdkVersion: "1.0.0", sdkKey: "key-a",
            endpoint: "https://a.example/api/ingest/release-health", processLaunchID: UUID(), now: now, uptime: 1)
        try ReleaseHealthStore(root: root, keyProvider: { self.key }).append(old.entry(end: false, now: now, uptime: 1))
        try Data("partial encrypted staging".utf8).write(to: root.appendingPathComponent(".pending"))
        let runtime = runtime(); let accepted = try await enable(runtime); XCTAssertTrue(accepted)
        let pointer = try XCTUnwrap(runtime.readyPointer); XCTAssertNotEqual(pointer.exposureID, old.pointer.exposureID)
        let records = try rows().map { try JSONSerialization.jsonObject(with: $0.body) as! [String: Any] }
        XCTAssertEqual(records.compactMap { ($0["exposure"] as? [String: Any])?["exposureId"] as? String }, [pointer.exposureID])
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(".pending").path))
        runtime.boundary(); await runtime.barrier()
    }
    func testDrainSendsOnlyTheEnabledOwnersRecords() async throws {
        let foreign = ReleaseHealthEntry(recordID: UUID(), createdAt: now, sdkKey: "key-a",
            endpoint: "https://a.example/api/ingest/release-health", body: Data("{}".utf8))
        try ReleaseHealthStore(root: root, keyProvider: { self.key }).append(foreign)
        let sent = HealthValues<String>(), key = key, now = now
        let runtime = ReleaseHealthRuntime(root: root, keyProvider: { key }, now: { now }, transport: { entry, admission in
            _ = admission { sent.append(entry.sdkKey) }; return .settled
        })
        let accepted = try await enable(runtime, key: "key-b"); XCTAssertTrue(accepted)
        await runtime.flush()
        XCTAssertEqual(sent.values, ["key-b"]); XCTAssertEqual(try rows().map(\.recordID), [foreign.recordID])
        runtime.boundary(); await runtime.barrier()
    }
    func testUnknownFilesStayUnavailableWithoutDeletingUnownedData() async throws {
        try Data("unowned".utf8).write(to: root.appendingPathComponent("not-ours"))
        let runtime = runtime(); let accepted = try await enable(runtime); XCTAssertFalse(accepted)
        XCTAssertNil(runtime.readyPointer)
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("not-ours").path))
    }
}
private final class FailureFlag: @unchecked Sendable {
    private let lock = NSLock(); private var storage = false
    var value: Bool { get { lock.lock(); defer { lock.unlock() }; return storage } set { lock.lock(); storage = newValue; lock.unlock() } }
}

private final class HealthRuntimeHolder: @unchecked Sendable {
    private let lock = NSLock(); private weak var storage: ReleaseHealthRuntime?
    var runtime: ReleaseHealthRuntime? { get { lock.withLock { storage } } set { lock.withLock { storage = newValue } } }
}
private final class HealthValues<Value>: @unchecked Sendable {
    private let lock = NSLock(); private var storage: [Value] = []
    func append(_ value: Value) { lock.withLock { storage.append(value) } }
    var values: [Value] { lock.withLock { storage } }
}

private actor HealthAsyncGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var released = false
    func wait() async { if !released { await withCheckedContinuation { continuation = $0 } } }
    func release() { released = true; continuation?.resume(); continuation = nil }
}
