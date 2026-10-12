// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import Foundation
@testable import EverframeKit

final class AppleDiagnosticStoreTests: XCTestCase {
    private var root: URL!
    private let key = Data(repeating: 0x42, count: 32)
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }
    private func store() throws -> AppleDiagnosticStore { let key = key; return try AppleDiagnosticStore(root: root, keyProvider: { key }) }
    private func entry(at date: Date = Date()) -> OutboxEntry {
        let id = UUID(); return OutboxEntry(reportId: id, createdAt: date, envelopeBytes: Data("frozen secret owner".utf8),
            idempotencyKey: id.uuidString, attachmentRefs: [], sdkKey: "old-key", endpoint: "https://old.example/ingest")
    }
    func testPendingReceiptSurvivesFreshStoreWithExactBytesAndOwner() throws {
        let old = entry(); let first = try store(); try first.finishErasure(); try first.activate()
        try first.stage(old, hash: String(repeating: "a", count: 64))
        let restored = try store()
        XCTAssertEqual(restored.pending, [old]); XCTAssertFalse(restored.isRevoked)
        XCTAssertNil(try Data(contentsOf: root.appendingPathComponent("state")).range(of: old.envelopeBytes))
        try restored.settle(old.reportId)
        XCTAssertEqual(try store().pending, [])
    }
    func testRevocationSurvivesRestartAndCannotResurrectPriorReceipt() throws {
        let first = try store(); try first.finishErasure(); try first.activate(); try first.stage(entry(), hash: String(repeating: "a", count: 64))
        let oldAuthority = first.authorityID; try first.revoke()
        let second = try store(); XCTAssertTrue(second.isRevoked); XCTAssertTrue(second.needsOutboxErase)
        XCTAssertEqual(second.pending, []); XCTAssertNotEqual(second.authorityID, oldAuthority)
        try second.finishErasure(); try second.activate(); XCTAssertEqual(try store().pending, [])
    }
    func testInterruptedReplacementAndCorruptionCannotGrantAuthority() throws {
        let first = try store(); try first.finishErasure(); try first.activate(); try first.stage(entry(), hash: String(repeating: "a", count: 64))
        try Data("partial".utf8).write(to: root.appendingPathComponent(".pending"))
        XCTAssertThrowsError(try store())
        try FileManager.default.removeItem(at: root.appendingPathComponent(".pending"))
        try Data("corrupt".utf8).write(to: root.appendingPathComponent("state"))
        XCTAssertThrowsError(try store())
    }
    func testFailedAtomicCommitKeepsPreviousAuthorityAndExactReceipt() throws {
        let old = entry(); let first = try store(); try first.finishErasure(); try first.activate()
        try first.stage(old, hash: String(repeating: "a", count: 64))
        let key = key
        let failing = try AppleDiagnosticStore(root: root, keyProvider: { key }, beforeCommit: { throw CocoaError(.fileWriteNoPermission) })
        XCTAssertThrowsError(try failing.revoke())
        XCTAssertFalse(failing.isRevoked); XCTAssertEqual(try store().pending, [old])
        XCTAssertThrowsError(try failing.settle(old.reportId))
        XCTAssertEqual(try store().pending, [old])
    }
    func testCapacityDoesNotReplaceEarlierFrozenReceiptsAndExpiryRemovesThem() throws {
        let first = try store(); try first.finishErasure(); try first.activate(); let now = Date()
        for n in 0..<32 { try first.stage(entry(at: now), hash: String(format: "%064x", n)) }
        XCTAssertThrowsError(try first.stage(entry(at: now), hash: String(repeating: "f", count: 64)))
        XCTAssertEqual(try store().pending.count, 32)
        try first.maintain(now: now.addingTimeInterval(7 * 86400 + 1))
        XCTAssertTrue(try store().pending.isEmpty)
    }
}
