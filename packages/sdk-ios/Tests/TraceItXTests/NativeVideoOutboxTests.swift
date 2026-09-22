// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import Testing
@testable import TraceItXKit

struct NativeVideoOutboxTests {
    @Test func separateInstancesCannotLoseConcurrentReports() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("outbox")
        let a = JSONLOutbox(fileURL: url, keyProvider: { Data(repeating: 7, count: 32) })
        let b = JSONLOutbox(fileURL: url, keyProvider: { Data(repeating: 7, count: 32) })
        let entries = (0..<20).map { _ in entry(bytes: 1000) }
        try await withThrowingTaskGroup(of: Void.self) { group in
            for (index, report) in entries.enumerated() {
                group.addTask { try (index.isMultiple(of: 2) ? a : b).enqueue(report) }
            }
            try await group.waitForAll()
        }
        #expect(try Set(a.hydrate().map(\.reportId)) == Set(entries.map(\.reportId)))
    }
    private func entry(bytes: Int = 128) -> OutboxEntry {
        .init(reportId: UUID(), createdAt: Date(timeIntervalSince1970: 1000),
            envelopeBytes: Data("private-envelope".utf8), idempotencyKey: "private-idempotency",
            attachmentRefs: [.init(name: "replay", filename: "replay.mp4", contentType: "video/mp4",
                dataBase64: Data(repeating: 42, count: bytes).base64EncodedString(), sha256Hex: "hash")],
            sdkKey: "private-key", endpoint: "https://example.invalid/ingest")
    }
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    @Test func encryptedMovieSurvivesOutboxRecreationWithoutPlaintextOnDisk() throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("outbox")
        let key: @Sendable () throws -> Data = { Data(repeating: 7, count: 32) }
        let report = entry()
        try JSONLOutbox(fileURL: url, keyProvider: key).enqueue(report)
        let stored = try Data(contentsOf: url)
        #expect(stored.range(of: Data("private-key".utf8)) == nil)
        #expect(stored.range(of: Data(report.attachmentRefs[0].dataBase64.utf8)) == nil)
        #expect(try JSONLOutbox(fileURL: url, keyProvider: key).hydrate() == [report])
    }
    @Test func attachmentsCountAgainstActualPersistedByteLimit() throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("outbox")
        let box = JSONLOutbox(fileURL: url, maxTotalBytes: 3000, keyProvider: { Data(repeating: 7, count: 32) })
        let a = entry(bytes: 1000), b = entry(bytes: 1000)
        try box.enqueue(a); try box.enqueue(b)
        #expect(try box.hydrate().map(\.reportId) == [b.reportId])
        #expect(try Data(contentsOf: url).count <= 3000)
        #expect(throws: OutboxStorageError.capacityExceeded) { try box.enqueue(entry(bytes: 4000)) }
        #expect(try box.hydrate().map(\.reportId) == [b.reportId])
    }
    @Test func tamperingAndWrongKeyFailClosed() throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("outbox")
        let box = JSONLOutbox(fileURL: url, keyProvider: { Data(repeating: 7, count: 32) })
        try box.enqueue(entry())
        #expect(throws: (any Error).self) {
            try JSONLOutbox(fileURL: url, keyProvider: { Data(repeating: 8, count: 32) }).hydrate()
        }
        var stored = try Data(contentsOf: url)
        stored[stored.count - 1] ^= 1
        try stored.write(to: url)
        #expect(throws: (any Error).self) { try box.hydrate() }
    }
    @Test func unavailableKeyNeverWritesPlaintextFallback() throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("outbox")
        let box = JSONLOutbox(fileURL: url, keyProvider: { throw CocoaError(.fileReadNoPermission) })
        #expect(throws: (any Error).self) { try box.enqueue(entry()) }
        #expect(!FileManager.default.fileExists(atPath: url.path))
    }
}
