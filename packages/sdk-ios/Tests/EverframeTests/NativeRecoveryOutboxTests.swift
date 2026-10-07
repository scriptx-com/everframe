// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import CryptoKit
import Foundation
@testable import EverframeKit

final class NativeRecoveryOutboxTests: XCTestCase {
    private var directory: URL!
    private let key = Data(repeating: 0x47, count: 32)
    private var file: URL { directory.appendingPathComponent("queue") }
    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
            .appendingPathComponent("native-recovery-queue-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: directory) }
    private func box(count: Int = 50, bytes: Int = 1024 * 1024) -> JSONLOutbox {
        let key = key
        return JSONLOutbox(fileURL: file, maxEntries: count, maxTotalBytes: bytes, keyProvider: { key })
    }
    private func entry(_ id: UUID = UUID(), owner: String = "original-A", body: String = "original bytes") -> OutboxEntry {
        OutboxEntry(reportId: id, createdAt: Date(timeIntervalSince1970: 1791331200.123),
            envelopeBytes: Data(body.utf8), idempotencyKey: "stable-key", attachmentRefs: [],
            sdkKey: owner, endpoint: "https://example.invalid/api/ingest", identitySubject: "subject-A")
    }
    private func encrypted(_ plaintext: Data) throws -> Data {
        let magic = Data("EVRBOX01".utf8)
        return magic + (try AES.GCM.seal(plaintext, using: SymmetricKey(data: key), authenticating: magic).combined!)
    }
    private func encoded(_ value: OutboxEntry) throws -> Data {
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
        return try encoder.encode(value)
    }
    func testExactReentryKeepsCiphertextAndOriginalRouting() throws {
        let value = entry()
        XCTAssertEqual(try box().enqueueRecovered(value), .inserted)
        let bytes = try Data(contentsOf: file)
        XCTAssertNil(bytes.range(of: value.envelopeBytes))
        XCTAssertEqual(try box().enqueueRecovered(value), .alreadyPresent)
        XCTAssertEqual(try Data(contentsOf: file), bytes)
        XCTAssertEqual(try box().hydrate().first?.sdkKey, "original-A")
        XCTAssertEqual(try box().hydrate().first?.identitySubject, "subject-A")
    }
    func testSameReportWithDifferentOwnerOrBytesNeverReplacesAcceptedEntry() throws {
        let value = entry(); _ = try box().enqueueRecovered(value); let before = try Data(contentsOf: file)
        for changed in [entry(value.reportId, owner: "new-B"), entry(value.reportId, body: "different")] {
            XCTAssertThrowsError(try box().enqueueRecovered(changed)) { XCTAssertEqual($0 as? JSONLOutbox.RecoveryFailure, .conflict) }
            XCTAssertEqual(try Data(contentsOf: file), before)
        }
    }
    func testUnknownCorruptPartialAndDuplicateQueuesRemainUntouched() throws {
        let value = entry(), line = try encoded(value)
        var corrupt = try encrypted(line); corrupt[corrupt.count - 1] ^= 1
        for bytes in [Data("legacy plaintext secret".utf8), corrupt,
                      try encrypted(line + Data("\nnot-json".utf8)),
                      try encrypted(line + Data("\n".utf8) + line)] {
            try bytes.write(to: file)
            XCTAssertThrowsError(try box().enqueueRecovered(entry()))
            XCTAssertEqual(try Data(contentsOf: file), bytes)
        }
    }
    func testRecoveryCapacityNeverEvictsQueuedEntries() throws {
        let value = entry(); _ = try box(count: 1).enqueueRecovered(value); let before = try Data(contentsOf: file)
        XCTAssertThrowsError(try box(count: 1).enqueueRecovered(entry())) { XCTAssertEqual($0 as? JSONLOutbox.RecoveryFailure, .capacity) }
        XCTAssertEqual(try Data(contentsOf: file), before)
        XCTAssertThrowsError(try box(bytes: 20).enqueueRecovered(entry()))
        XCTAssertEqual(try Data(contentsOf: file), before)
    }
    func testUnavailableKeyPreservesQueue() throws {
        _ = try box().enqueueRecovered(entry()); let before = try Data(contentsOf: file)
        let locked = JSONLOutbox(fileURL: file, keyProvider: { throw OutboxStorageError.invalidKey })
        XCTAssertThrowsError(try locked.enqueueRecovered(entry()))
        XCTAssertEqual(try Data(contentsOf: file), before)
    }
    func testUnsafeLinkAndWritableQueueRejectWithoutModifyingTarget() throws {
        let target = directory.appendingPathComponent("target"); try Data("sentinel".utf8).write(to: target)
        try FileManager.default.createSymbolicLink(at: file, withDestinationURL: target)
        XCTAssertThrowsError(try box().enqueueRecovered(entry())) { XCTAssertEqual($0 as? JSONLOutbox.RecoveryFailure, .unsafePath) }
        XCTAssertEqual(try Data(contentsOf: target), Data("sentinel".utf8))
        try FileManager.default.removeItem(at: file)
        try FileManager.default.linkItem(at: target, to: file)
        XCTAssertThrowsError(try box().enqueueRecovered(entry()))
        try FileManager.default.removeItem(at: file)
        try Data("unsafe".utf8).write(to: file)
        try FileManager.default.setAttributes([.posixPermissions: 0o666], ofItemAtPath: file.path)
        XCTAssertThrowsError(try box().enqueueRecovered(entry())) { XCTAssertEqual($0 as? JSONLOutbox.RecoveryFailure, .unsafePath) }
    }
    func testConcurrentInstancesPreserveAllRecoveredReports() throws {
        let entries = (0..<12).map { _ in entry() }, key = key, path = file
        let lock = NSLock()
        nonisolated(unsafe) var failures = 0
        DispatchQueue.concurrentPerform(iterations: entries.count) { index in
            do { _ = try JSONLOutbox(fileURL: path, keyProvider: { key }).enqueueRecovered(entries[index]) }
            catch { lock.lock(); failures += 1; lock.unlock() }
        }
        XCTAssertEqual(failures, 0)
        XCTAssertEqual(Set(try box().hydrate().map(\.reportId)), Set(entries.map(\.reportId)))
    }
}
