// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import EverframeKit

final class JSONLOutboxTests: XCTestCase {

    /// Each test gets a private temp directory so the production-path
    /// (Library/Caches/dev.everframe) is never touched.
    private var tempDir: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("everframe-outbox-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tempDir)
        try super.tearDownWithError()
    }

    private func makeOutbox(maxEntries: Int = 50, maxTotalBytes: Int = 5 * 1024 * 1024) -> JSONLOutbox {
        let url = tempDir.appendingPathComponent("outbox.jsonl")
        return JSONLOutbox(testFileURL: url, maxEntries: maxEntries, maxTotalBytes: maxTotalBytes)
    }

    private func makeEntry(reportId: UUID = UUID(), bytes: Int = 64) -> OutboxEntry {
        OutboxEntry(
            reportId: reportId,
            createdAt: Date(),
            envelopeBytes: Data(repeating: 0x41, count: bytes),
            idempotencyKey: "idem-\(reportId.uuidString)",
            attachmentRefs: [],
            sdkKey: "test-key",
            endpoint: "https://test.example.com"
        )
    }

    func test_enqueue_then_hydrate_roundtrip() throws {
        let box = makeOutbox()
        let e1 = makeEntry()
        let e2 = makeEntry()
        try box.enqueue(e1)
        try box.enqueue(e2)

        let hydrated = try box.hydrate()
        XCTAssertEqual(hydrated.count, 2)
        XCTAssertEqual(hydrated[0].reportId, e1.reportId)
        XCTAssertEqual(hydrated[1].reportId, e2.reportId)
        XCTAssertEqual(hydrated[0].envelopeBytes, e1.envelopeBytes)
    }

    #if canImport(UIKit)
    private func requireFileProtectionSupport() throws {
        let probe = tempDir.appendingPathComponent("protection-probe")
        defer { try? FileManager.default.removeItem(at: probe) }
        try Data([0]).write(to: probe, options: .completeFileProtection)
        let attributes = try FileManager.default.attributesOfItem(atPath: probe.path)
        guard attributes[.protectionKey] != nil else {
            throw XCTSkip("This filesystem does not expose file protection; a device test host is required")
        }
    }

    func test_encrypted_queue_uses_after_first_unlock_file_protection() throws {
        try requireFileProtectionSupport()
        let box = makeOutbox()
        let entry = makeEntry()
        try box.enqueue(entry)

        let attributes = try FileManager.default.attributesOfItem(atPath: box.resolvedFileURL.path)
        XCTAssertEqual(attributes[.protectionKey] as? FileProtectionType, .completeUntilFirstUserAuthentication)
        let stored = try Data(contentsOf: box.resolvedFileURL)
        XCTAssertTrue(stored.starts(with: Data("EVRBOX01".utf8)))
        XCTAssertNil(stored.range(of: entry.envelopeBytes))
        XCTAssertEqual(try box.hydrate().map(\.reportId), [entry.reportId])
    }

    func test_enqueue_upgrades_existing_complete_protection_without_losing_entries() throws {
        try requireFileProtectionSupport()
        let box = makeOutbox()
        let first = makeEntry()
        let second = makeEntry()
        try box.enqueue(first)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete],
                                             ofItemAtPath: box.resolvedFileURL.path)
        let before = try FileManager.default.attributesOfItem(atPath: box.resolvedFileURL.path)
        XCTAssertEqual(before[.protectionKey] as? FileProtectionType, .complete)

        try box.enqueue(second)

        let after = try FileManager.default.attributesOfItem(atPath: box.resolvedFileURL.path)
        XCTAssertEqual(after[.protectionKey] as? FileProtectionType, .completeUntilFirstUserAuthentication)
        XCTAssertEqual(try box.hydrate().map(\.reportId), [first.reportId, second.reportId])
    }
    #endif

    func test_hydrate_missing_file_returns_empty() throws {
        let box = makeOutbox()
        let hydrated = try box.hydrate()
        XCTAssertTrue(hydrated.isEmpty)
    }

    func test_capacity_50_evicts_oldest() throws {
        let box = makeOutbox(maxEntries: 50)
        var firstId: UUID?
        for i in 0..<55 {
            let entry = makeEntry()
            if i == 0 { firstId = entry.reportId }
            try box.enqueue(entry)
        }
        let hydrated = try box.hydrate()
        XCTAssertEqual(hydrated.count, 50)
        XCTAssertFalse(hydrated.contains(where: { $0.reportId == firstId }))
    }

    func test_capacity_5MB_evicts_until_under_cap() throws {
        // 1 MB cap, 4 entries × 400 KB → must evict at least 1
        let box = makeOutbox(maxEntries: 50, maxTotalBytes: 1 * 1024 * 1024)
        for _ in 0..<4 {
            try box.enqueue(makeEntry(bytes: 400 * 1024))
        }
        let hydrated = try box.hydrate()
        let total = hydrated.reduce(0) { $0 + $1.envelopeBytes.count }
        XCTAssertLessThanOrEqual(total, 1 * 1024 * 1024)
        XCTAssertLessThan(hydrated.count, 4)
    }

    func test_drain_atomic_predicate() throws {
        let box = makeOutbox()
        let keep = makeEntry()
        let drop = makeEntry()
        try box.enqueue(keep)
        try box.enqueue(drop)

        try box.drain(where: { $0.reportId == drop.reportId })

        let hydrated = try box.hydrate()
        XCTAssertEqual(hydrated.count, 1)
        XCTAssertEqual(hydrated[0].reportId, keep.reportId)
    }

    func test_count_reflects_entries() throws {
        let box = makeOutbox()
        XCTAssertEqual(box.count, 0)
        try box.enqueue(makeEntry())
        XCTAssertEqual(box.count, 1)
    }
}
