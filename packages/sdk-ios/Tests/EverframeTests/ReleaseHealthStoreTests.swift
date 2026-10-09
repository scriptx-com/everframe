// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import Foundation
@testable import EverframeKit

final class ReleaseHealthStoreTests: XCTestCase {
    private var root: URL!
    private let key = Data(repeating: 0x72, count: 32)
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }
    private func store() throws -> ReleaseHealthStore { try ReleaseHealthStore(root: root, keyProvider: { self.key }) }
    private func entry(_ id: UUID = UUID(), at now: Date = Date(), body: Data = Data("anonymous frozen build-a".utf8)) -> ReleaseHealthEntry {
        .init(recordID: id, createdAt: now, sdkKey: "frozen-key-a", endpoint: "https://a.example/api/ingest/release-health", body: body)
    }
    func testEncryptedRestartPreservesExactOwnerAndDuplicateBytes() throws {
        let value = entry(); let first = try store(); try first.append(value); try first.append(value)
        XCTAssertEqual(try store().pending(), [value])
        let ciphertext = try Data(contentsOf: root.appendingPathComponent("state"))
        XCTAssertNil(ciphertext.range(of: value.body)); XCTAssertNil(ciphertext.range(of: Data(value.sdkKey.utf8)))
        XCTAssertThrowsError(try first.append(entry(value.recordID, at: value.createdAt, body: Data("relabel".utf8))))
        XCTAssertEqual(try store().pending(), [value])
        try first.settle(value.recordID); XCTAssertTrue(try store().pending().isEmpty)
    }
    func testCapacityRejectsNewOwnerAndRetentionIsExplicit() throws {
        let first = try store(); let now = Date()
        for _ in 0..<256 { try first.append(entry(at: now)) }
        XCTAssertThrowsError(try first.append(entry(at: now)))
        XCTAssertEqual(try store().pending().count, 256)
        try first.maintain(now: now.addingTimeInterval(7 * 86400))
        XCTAssertTrue(try store().pending().isEmpty)
        XCTAssertThrowsError(try first.append(entry(body: Data(repeating: 0x61, count: 8193))))
    }
    func testByteBudgetDoesNotEvictEarlierRecords() throws {
        let first = try store(); let body = Data(repeating: 0x61, count: 8192)
        var admitted = 0
        for _ in 0..<256 {
            do { try first.append(entry(body: body)); admitted += 1 } catch { break }
        }
        XCTAssertGreaterThan(admitted, 1); XCTAssertLessThan(admitted, 256)
        XCTAssertEqual(try store().pending().count, admitted)
        XCTAssertLessThanOrEqual(try Data(contentsOf: root.appendingPathComponent("state")).count, 1024 * 1024)
    }
    func testInterruptedStagingRequiresConservativeErasureThenHealthyWritesWork() throws {
        let first = try store(); try first.append(entry())
        try Data("partial encrypted staging".utf8).write(to: root.appendingPathComponent(".pending"))
        XCTAssertThrowsError(try store())
        try ReleaseHealthStore.eraseAmbiguous(root: root)
        let next = try store(); let fresh = entry(); try next.append(fresh)
        XCTAssertEqual(try store().pending(), [fresh])
    }
    func testWrongKeyAndCorruptionNeverExposeRecords() throws {
        try store().append(entry())
        XCTAssertThrowsError(try ReleaseHealthStore(root: root, keyProvider: { Data(repeating: 0x73, count: 32) }))
        try Data("bad".utf8).write(to: root.appendingPathComponent("state"))
        XCTAssertThrowsError(try store())
    }
    func testFailedEraseRemainsUnsettledAndSubsequentHealthyEraseRemovesAll() throws {
        let value = entry(); try store().append(value)
        let failing = try ReleaseHealthStore(root: root, keyProvider: { self.key }, beforeCommit: { throw CocoaError(.fileWriteNoPermission) })
        XCTAssertThrowsError(try failing.erase()); XCTAssertEqual(try store().pending(), [value])
        try store().erase(); XCTAssertTrue(try store().pending().isEmpty)
    }
    func testTwoInstancesCannotOverwriteOneAnothersCommittedRecords() throws {
        let one = try store(), two = try store(); let a = entry(), b = entry()
        try one.append(a); try two.append(b)
        XCTAssertEqual(Set(try store().pending().map(\.recordID)), Set([a.recordID, b.recordID]))
        try one.settle(a.recordID); XCTAssertEqual(try two.pending(), [b])
    }
}
