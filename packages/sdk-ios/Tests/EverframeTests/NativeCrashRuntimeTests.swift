// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import EverframeProtocol
@testable import EverframeKit

final class NativeCrashRuntimeTests: XCTestCase {
    private var directory: URL!
    private let key = Data(repeating: 0x47, count: 32)
    private var root: URL { directory.appendingPathComponent("native") }
    private var outbox: JSONLOutbox { let key = key; return JSONLOutbox(fileURL: directory.appendingPathComponent("queue"), keyProvider: { key }) }
    private final class Recorder: @unchecked Sendable {
        let lock = NSLock()
        var installs = 0, enabled = false, identifiers: [UUID] = []
        var path: URL?, installResult = true, duringInstall: (() -> Void)?
        var adapter: NativeCrashRuntime.Recorder {
            .init(install: { url in
                self.lock.withLock { self.installs += 1; self.path = url }
                self.duringInstall?()
                return self.installResult
            }, disable: { self.lock.withLock { self.enabled = false } }, publish: { id in
                self.lock.withLock { self.identifiers.append(id); self.enabled = true }
                return true
            })
        }
    }
    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: directory) }
    private func runtime(_ recorder: Recorder) -> NativeCrashRuntime {
        let key = key
        return NativeCrashRuntime(rootURL: root, outbox: outbox, recorder: recorder.adapter, keyProvider: { key })
    }
    private func priorRun() throws -> (UUID, URL) {
        let key = key
        let store = try NativeCrashRecovery(rootURL: root, activeRunIDs: [], keyProvider: { key })
        let run = try store.prepareRun()
        let id = try store.writeContext(NativeRecoveryTestData.context(), runID: run.id)
        let reports = run.recorderURL.appendingPathComponent("Reports")
        try FileManager.default.createDirectory(at: reports, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let path = reports.appendingPathComponent("Everframe-report-0000000000000001.json")
        let report = UUID()
        try NativeRecoveryTestData.raw(context: id, report: report).write(to: path)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: path.path)
        return (report, path)
    }
    func testPriorOwnerRecoveredBeforeInstallationAndNewContextIsDurableBeforeEnable() async throws {
        let (report, _) = try priorRun()
        let recorder = Recorder()
        let current = self.runtime(recorder)
        recorder.duringInstall = { XCTAssertEqual(try? self.outbox.hydrate().first?.reportId, report) }
        let context = try NativeRecoveryTestData.context(owner: "sdk-B")
        let armed = await current.refresh(ticket: current.invalidate(), context: { context })
        XCTAssertTrue(armed); XCTAssertTrue(recorder.enabled); XCTAssertEqual(recorder.installs, 1)
        XCTAssertEqual(try outbox.hydrate().first?.sdkKey, "sdk-A")
        let runID = try XCTUnwrap(UUID(uuidString: try XCTUnwrap(recorder.path).deletingLastPathComponent().lastPathComponent))
        let key = key
        let contexts = try NativeCrashContextStore(rootURL: root.appendingPathComponent("contexts"), keyProvider: { key })
        XCTAssertEqual(try contexts.readContext(runID: runID, contextID: XCTUnwrap(recorder.identifiers.last)), try context.encoded())
    }
    func testInvalidationDuringInstallCannotArmOldOwnerAndInstallIsNotRepeated() async throws {
        let recorder = Recorder(), context = try NativeRecoveryTestData.context()
        let runtime = runtime(recorder)
        recorder.duringInstall = { _ = runtime.invalidate() }
        let obsolete = await runtime.refresh(ticket: runtime.invalidate(), context: { context })
        XCTAssertFalse(obsolete); XCTAssertFalse(recorder.enabled); XCTAssertTrue(recorder.identifiers.isEmpty)
        recorder.duringInstall = nil
        let current = await runtime.refresh(ticket: runtime.invalidate(), context: { context })
        XCTAssertTrue(current); XCTAssertEqual(recorder.installs, 1)
    }
    func testInvalidationDuringSnapshotAndAfterEnableClosesGate() async throws {
        let recorder = Recorder(), context = try NativeRecoveryTestData.context()
        let runtime = runtime(recorder)
        let obsolete = await runtime.refresh(ticket: runtime.invalidate(), context: {
            _ = runtime.invalidate()
            return context
        })
        XCTAssertFalse(obsolete); XCTAssertFalse(recorder.enabled)
        let current = await runtime.refresh(ticket: runtime.invalidate(), context: { context })
        XCTAssertTrue(current)
        _ = runtime.invalidate()
        XCTAssertFalse(recorder.enabled)
    }
    func testInvalidationReturnsWhileContextPersistenceIsBlockedAndNeverPublishesThatOwner() async throws {
        let recorder = Recorder(), key = key
        let entered = expectation(description: "context encryption holds the store lock")
        let gate = PersistenceKeyGate(key: key, entered: entered)
        let runtime = NativeCrashRuntime(rootURL: root, outbox: outbox,
            recorder: recorder.adapter, keyProvider: { gate.read() })
        let original = try NativeRecoveryTestData.context(owner: "sdk-A")
        let first = await runtime.refresh(ticket: runtime.invalidate(), context: { original })
        XCTAssertTrue(first); XCTAssertTrue(recorder.enabled)
        gate.blockNext()
        let obsolete = try NativeRecoveryTestData.context(owner: "sdk-B")
        let ticket = runtime.invalidate()
        XCTAssertFalse(recorder.enabled, "an installed recorder closes synchronously")
        let writing = Task { await runtime.refresh(ticket: ticket, context: { obsolete }) }
        await fulfillment(of: [entered], timeout: 5)
        let invalidated = expectation(description: "invalidation does not wait for persistence")
        let invalidating = Task.detached { let next = runtime.invalidate(); invalidated.fulfill(); return next }
        await fulfillment(of: [invalidated], timeout: 1)
        gate.release.signal()
        let next = await invalidating.value
        let staleResult = await writing.value
        XCTAssertFalse(staleResult); XCTAssertFalse(recorder.enabled)
        XCTAssertEqual(recorder.identifiers.count, 1, "persisted obsolete context must never be published")
        let current = try NativeRecoveryTestData.context(owner: "sdk-C")
        let armed = await runtime.refresh(ticket: next, context: { current })
        XCTAssertTrue(armed); XCTAssertEqual(recorder.installs, 1)
        let runID = try XCTUnwrap(UUID(uuidString: XCTUnwrap(recorder.path).deletingLastPathComponent().lastPathComponent))
        let store = try NativeCrashContextStore(rootURL: root.appendingPathComponent("contexts"), keyProvider: { key })
        XCTAssertEqual(try store.readContext(runID: runID, contextID: XCTUnwrap(recorder.identifiers.last)), try current.encoded())
    }
    private final class PersistenceKeyGate: @unchecked Sendable {
        let key: Data, entered: XCTestExpectation
        let release = DispatchSemaphore(value: 0)
        private let lock = NSLock()
        private var block = false
        init(key: Data, entered: XCTestExpectation) { self.key = key; self.entered = entered }
        func blockNext() { lock.withLock { block = true } }
        func read() -> Data {
            let shouldBlock = lock.withLock { let value = block; block = false; return value }
            if shouldBlock {
                // This is called from inside the actual context store's
                // encryption/write operation while its persistence lock is held.
                entered.fulfill()
                XCTAssertEqual(release.wait(timeout: .now() + 5), .success)
            }
            return key
        }
    }
    func testStaleWorkDoesNotInvokeSnapshotAndNilContextDoesNotRecoverOrInstall() async throws {
        let (_, raw) = try priorRun(), recorder = Recorder()
        let runtime = runtime(recorder), stale = runtime.invalidate()
        let latest = runtime.invalidate()
        let old = await runtime.refresh(ticket: stale, context: { XCTFail("stale snapshot evaluated"); return nil })
        let off = await runtime.refresh(ticket: latest, context: { nil })
        XCTAssertFalse(old); XCTAssertFalse(off); XCTAssertEqual(recorder.installs, 0)
        XCTAssertTrue(try outbox.hydrate().isEmpty); XCTAssertTrue(FileManager.default.fileExists(atPath: raw.path))
    }
    func testIdenticalContextReusesSlotAndProcessRunAcrossTransitions() async throws {
        let recorder = Recorder(), context = try NativeRecoveryTestData.context()
        let runtime = runtime(recorder)
        for _ in 0..<4 {
            let armed = await runtime.refresh(ticket: runtime.invalidate(), context: { context })
            XCTAssertTrue(armed)
        }
        XCTAssertEqual(recorder.installs, 1); XCTAssertEqual(Set(recorder.identifiers).count, 1)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("runs").path).count, 1)
    }
    func testInstallationFailureIsTerminalButKeyFailureNeverInstalls() async throws {
        let recorder = Recorder(), context = try NativeRecoveryTestData.context()
        recorder.installResult = false
        let runtime = runtime(recorder)
        for _ in 0..<2 {
            let result = await runtime.refresh(ticket: runtime.invalidate(), context: { context })
            XCTAssertFalse(result)
        }
        XCTAssertEqual(recorder.installs, 1); XCTAssertFalse(recorder.enabled)
        let other = Recorder()
        let unavailable = NativeCrashRuntime(rootURL: directory.appendingPathComponent("unavailable"), outbox: outbox,
            recorder: other.adapter, keyProvider: { throw NativeCrashRecovery.Failure.unavailable })
        let result = await unavailable.refresh(ticket: unavailable.invalidate(), context: { context })
        XCTAssertFalse(result); XCTAssertEqual(other.installs, 0)
    }
    func testMalformedPriorRecordDoesNotBlockIndependentValidRecovery() async throws {
        let (_, raw) = try priorRun()
        try Data("invalid".utf8).write(to: raw)
        let (valid, _) = try priorRun()
        let recorder = Recorder()
        let current = self.runtime(recorder)
        let armed = await current.refresh(ticket: current.invalidate(), context: { try NativeRecoveryTestData.context(owner: "sdk-B") })
        XCTAssertTrue(armed); XCTAssertEqual(try outbox.hydrate().map(\.reportId), [valid])
        XCTAssertEqual(try Data(contentsOf: raw), Data("invalid".utf8))
    }
    func testAlreadyPublishedRevisionDoesNotCloseGateOrRebuildContext() async throws {
        let recorder = Recorder(), context = try NativeRecoveryTestData.context()
        let runtime = runtime(recorder), ticket = runtime.invalidate()
        let first = await runtime.refresh(ticket: ticket, context: { context })
        XCTAssertTrue(first)
        let duplicate = await runtime.refresh(ticket: ticket, context: {
            XCTAssertTrue(recorder.enabled, "unchanged ownership must not open a capture gap")
            XCTFail("a published revision must not rebuild its context")
            return context
        })
        XCTAssertTrue(duplicate); XCTAssertEqual(recorder.identifiers.count, 1)
    }

    func testContextLifetimeCapacityFailsClosedWithoutReplacingActiveRun() async throws {
        let recorder = Recorder()
        let current = self.runtime(recorder)
        for index in 0...256 {
            let context = try NativeRecoveryTestData.context(owner: "sdk-\(index)")
            let armed = await current.refresh(ticket: current.invalidate(), context: { context })
            XCTAssertEqual(armed, index < 256, "context \(index)")
        }
        XCTAssertFalse(recorder.enabled); XCTAssertEqual(recorder.installs, 1)
        XCTAssertEqual(recorder.identifiers.count, 256)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("runs").path).count, 1)
    }
}
