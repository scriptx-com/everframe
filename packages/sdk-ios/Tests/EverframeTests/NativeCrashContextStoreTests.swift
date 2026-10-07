// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import Foundation
import CryptoKit
@testable import EverframeKit

final class NativeCrashContextStoreTests: XCTestCase {
    private var directory: URL!
    private let key = Data(repeating: 0x47, count: 32)
    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
            .appendingPathComponent("efcr-context-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                              attributes: [.posixPermissions: 0o700])
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: directory) }
    private func store(_ limits: NativeCrashContextStore.Limits = .defaults) throws -> NativeCrashContextStore {
        let key = self.key
        return try NativeCrashContextStore(rootURL: directory.appendingPathComponent("contexts"), limits: limits,
                                           keyProvider: { key })
    }
    private func file(_ store: NativeCrashContextStore, _ run: UUID, _ context: UUID) -> URL {
        store.rootURL.appendingPathComponent(run.uuidString.lowercased())
            .appendingPathComponent(context.uuidString.lowercased() + ".evctx")
    }
    private func assertFailure(_ expected: NativeCrashContextStore.Failure, _ operation: () throws -> Void,
                               file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try operation(), file: file, line: line) { error in
            XCTAssertEqual(error as? NativeCrashContextStore.Failure, expected, file: file, line: line)
        }
    }
    func testOriginalContextSurvivesAnotherContextAndAnotherStoreInstance() throws {
        let first = try store(), run = try first.createRun(now: Date(timeIntervalSince1970: 100))
        let payload = Data(#"{"sdkKey":"owner-a","user":"original","redaction":"original-policy"}"#.utf8)
        let id = try first.writeContext(payload, runID: run.id)
        _ = try first.writeContext(Data("owner-b".utf8), runID: run.id)
        let second = try store()
        XCTAssertEqual(try second.readContext(runID: run.id, contextID: id), payload)
        XCTAssertEqual(try second.runs(), [run])
        XCTAssertNil(try Data(contentsOf: file(first, run.id, id)).range(of: payload))
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: first.rootURL.path)[.posixPermissions] as? NSNumber)?.intValue, 0o700)
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: file(first, run.id, id).path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }
    func testDuplicateIdentifierCannotReplaceOriginalBytes() throws {
        let store = try store(), run = try store.createRun(), id = UUID()
        _ = try store.writeContext(Data("original".utf8), runID: run.id, contextID: id)
        let before = try Data(contentsOf: file(store, run.id, id))
        assertFailure(.alreadyExists) { _ = try store.writeContext(Data("replacement".utf8), runID: run.id, contextID: id) }
        XCTAssertEqual(try Data(contentsOf: file(store, run.id, id)), before)
    }
    func testCiphertextCannotMoveToAnotherContextOrRun() throws {
        let store = try store(), first = try store.createRun(), second = try store.createRun()
        let id = try store.writeContext(Data("owner-a".utf8), runID: first.id), alternate = UUID()
        try FileManager.default.copyItem(at: file(store, first.id, id), to: file(store, first.id, alternate))
        try FileManager.default.copyItem(at: file(store, first.id, id), to: file(store, second.id, id))
        assertFailure(.corrupt) { _ = try store.readContext(runID: first.id, contextID: alternate) }
        assertFailure(.corrupt) { _ = try store.readContext(runID: second.id, contextID: id) }
        XCTAssertEqual(try store.readContext(runID: first.id, contextID: id), Data("owner-a".utf8))
    }
    func testCorruptionIsNotAnEmptyOrReattributedContext() throws {
        let store = try store(), run = try store.createRun(), id = try store.writeContext(Data("owner".utf8), runID: run.id)
        let path = file(store, run.id, id); var bytes = try Data(contentsOf: path); bytes[bytes.count - 1] ^= 1
        try bytes.write(to: path)
        assertFailure(.corrupt) { _ = try store.readContext(runID: run.id, contextID: id) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: path.path))
    }
    func testUnavailableKeyPreservesExistingCiphertextAndPublishesNoNewFile() throws {
        let store = try store(), run = try store.createRun(), id = try store.writeContext(Data("owner".utf8), runID: run.id)
        let before = try Data(contentsOf: file(store, run.id, id))
        let unavailable = try NativeCrashContextStore(rootURL: store.rootURL, keyProvider: { throw NSError(domain: "locked", code: 1) })
        XCTAssertThrowsError(try unavailable.writeContext(Data("next".utf8), runID: run.id))
        XCTAssertThrowsError(try unavailable.readContext(runID: run.id, contextID: id))
        XCTAssertEqual(try Data(contentsOf: file(store, run.id, id)), before)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: store.rootURL.appendingPathComponent(run.id.uuidString.lowercased()).path).count, 2)
    }
    func testInvalidKeyCannotPersistContext() throws {
        let store = try NativeCrashContextStore(rootURL: directory.appendingPathComponent("short-key"), keyProvider: { Data(repeating: 1, count: 31) })
        let run = try store.createRun()
        assertFailure(.invalidKey) { _ = try store.writeContext(Data("payload".utf8), runID: run.id) }
    }
    func testRunCountRefusesOverflowWithoutEviction() throws {
        var limits = NativeCrashContextStore.Limits.defaults; limits.maxRuns = 2
        let store = try store(limits), first = try store.createRun(), second = try store.createRun()
        assertFailure(.capacity) { _ = try store.createRun() }
        XCTAssertEqual(Set(try store.runs().map(\.id)), Set([first.id, second.id]))
    }
    func testContextCountAndPayloadBoundsRefuseOverflow() throws {
        var limits = NativeCrashContextStore.Limits.defaults; limits.maxContextsPerRun = 2; limits.maxPayloadBytes = 8
        let store = try store(limits), run = try store.createRun()
        assertFailure(.capacity) { _ = try store.writeContext(Data(repeating: 1, count: 9), runID: run.id) }
        let first = try store.writeContext(Data(repeating: 2, count: 8), runID: run.id)
        _ = try store.writeContext(Data(), runID: run.id)
        assertFailure(.capacity) { _ = try store.writeContext(Data([3]), runID: run.id) }
        XCTAssertEqual(try store.readContext(runID: run.id, contextID: first), Data(repeating: 2, count: 8))
    }
    func testTotalPersistedByteBudgetIncludesEncryptionOverhead() throws {
        var limits = NativeCrashContextStore.Limits.defaults; limits.maxTotalBytes = 1024; limits.maxPayloadBytes = 1024
        let store = try store(limits), run = try store.createRun()
        _ = try store.writeContext(Data(repeating: 2, count: 700), runID: run.id)
        assertFailure(.capacity) { _ = try store.writeContext(Data(repeating: 3, count: 300), runID: run.id) }
    }
    func testOversizedStoredFileIsRejectedBeforeDecode() throws {
        let store = try store(), run = try store.createRun(), id = try store.writeContext(Data([1]), runID: run.id)
        try Data(repeating: 0, count: 70_000).write(to: file(store, run.id, id))
        assertFailure(.capacity) { _ = try store.readContext(runID: run.id, contextID: id) }
    }
    func testSymlinkedRootIsRejectedAndTargetUntouched() throws {
        let target = directory.appendingPathComponent("target"), link = directory.appendingPathComponent("link")
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        let key = self.key
        assertFailure(.unsafePath) { _ = try NativeCrashContextStore(rootURL: link, keyProvider: { key }) }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: target.path), [])
    }
    func testSymlinkedContextCannotReadOrDeleteOutsideFile() throws {
        let store = try store(), run = try store.createRun(), id = UUID()
        let outside = directory.appendingPathComponent("outside"); try Data("outside".utf8).write(to: outside)
        try FileManager.default.createSymbolicLink(at: file(store, run.id, id), withDestinationURL: outside)
        assertFailure(.unsafePath) { _ = try store.readContext(runID: run.id, contextID: id) }
        assertFailure(.unsafePath) { try store.removeRun(run.id) }
        XCTAssertEqual(try Data(contentsOf: outside), Data("outside".utf8))
    }
    func testUnknownRootContentIsPreservedAndBlocksWrites() throws {
        let store = try store(), unknown = store.rootURL.appendingPathComponent("unexpected")
        try Data("preserve".utf8).write(to: unknown)
        assertFailure(.unknownEntry) { _ = try store.createRun() }
        XCTAssertEqual(try Data(contentsOf: unknown), Data("preserve".utf8))
    }
    func testUnsafeExistingRootPermissionsAreRejected() throws {
        let root = directory.appendingPathComponent("permissive")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o755])
        let key = self.key
        assertFailure(.unsafePath) { _ = try NativeCrashContextStore(rootURL: root, keyProvider: { key }) }
    }
    func testAbandonedUnpublishedStagingCanBeRecovered() throws {
        let store = try store(), run = try store.createRun()
        let staging = store.rootURL.appendingPathComponent(".creating-\(UUID().uuidString.lowercased())")
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let partial = store.rootURL.appendingPathComponent(run.id.uuidString.lowercased()).appendingPathComponent(".context-\(UUID().uuidString.lowercased()).tmp")
        XCTAssertTrue(FileManager.default.createFile(atPath: partial.path, contents: Data([0, 1]), attributes: [.posixPermissions: 0o600]))
        _ = try store.writeContext(Data("complete".utf8), runID: run.id)
        XCTAssertFalse(FileManager.default.fileExists(atPath: staging.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: partial.path))
    }
    func testExplicitRetirementLeavesOtherRunsAndContextsIntact() throws {
        let store = try store(), first = try store.createRun(), second = try store.createRun()
        let id = try store.writeContext(Data("retained".utf8), runID: second.id)
        try store.removeRun(first.id)
        XCTAssertEqual(try store.runs(), [second])
        XCTAssertEqual(try store.readContext(runID: second.id, contextID: id), Data("retained".utf8))
    }
    func testTwoInstancesCannotRaceContextLimit() throws {
        var limits = NativeCrashContextStore.Limits.defaults; limits.maxContextsPerRun = 1
        let first = try store(limits), second = try store(limits), run = try first.createRun()
        final class Results: @unchecked Sendable { let lock = NSLock(); var accepted = 0; var rejected = 0 }
        let results = Results()
        DispatchQueue.concurrentPerform(iterations: 12) { index in
            do { _ = try (index % 2 == 0 ? first : second).writeContext(Data([UInt8(index)]), runID: run.id)
                results.lock.withLock { results.accepted += 1 }
            } catch { results.lock.withLock { results.rejected += 1 } }
        }
        XCTAssertEqual(results.accepted, 1); XCTAssertEqual(results.rejected, 11)
    }
}
