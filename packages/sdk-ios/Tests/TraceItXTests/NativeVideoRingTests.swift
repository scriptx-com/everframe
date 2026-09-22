// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import Testing
@testable import TraceItXKit

struct NativeVideoRingTests {
    @Test func foreignAndDuplicateFilesAreNeverDeleted() throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let foreign = try directory(); defer { try? FileManager.default.removeItem(at: foreign) }
        var ring = NativeVideoRing(directory: dir, durationNanos: 10, byteLimit: 100)
        let a = try segment(dir, start: 0, end: 2)
        let outside = try segment(foreign, start: 2, end: 4)
        #expect(try ring.insert(a))
        #expect(try ring.insert(a) == false)
        #expect(try ring.insert(outside) == false)
        #expect(FileManager.default.fileExists(atPath: a.url.path))
        #expect(FileManager.default.fileExists(atPath: outside.url.path))
    }
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    private func segment(_ directory: URL, start: UInt64, end: UInt64, bytes: Int = 10) throws -> NativeVideoSegment {
        let url = directory.appendingPathComponent(UUID().uuidString + ".mp4")
        try Data(repeating: 1, count: bytes).write(to: url)
        return .init(url: url, startNanos: start, endNanos: end, byteCount: bytes)
    }
    @Test func durationEvictsWholeOldSegmentsAndDeletesTheirFiles() throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        var ring = NativeVideoRing(directory: dir, durationNanos: 4, byteLimit: 100)
        let a = try segment(dir, start: 0, end: 2)
        let b = try segment(dir, start: 2, end: 4)
        let c = try segment(dir, start: 4, end: 6)
        #expect(try ring.insert(a)); #expect(try ring.insert(b)); #expect(try ring.insert(c))
        #expect(ring.segments.map(\.startNanos) == [2, 4])
        #expect(ring.byteCount == 20)
        #expect(!FileManager.default.fileExists(atPath: a.url.path))
        #expect(FileManager.default.fileExists(atPath: b.url.path))
        try ring.clear(); try ring.clear()
        #expect(ring.segments.isEmpty)
        #expect(try FileManager.default.contentsOfDirectory(atPath: dir.path).isEmpty)
    }
    @Test func byteBudgetEvictsIndependentlyAndRejectsOversizedInput() throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        var ring = NativeVideoRing(directory: dir, durationNanos: 100, byteLimit: 15)
        let a = try segment(dir, start: 0, end: 2)
        let b = try segment(dir, start: 2, end: 4)
        let huge = try segment(dir, start: 4, end: 6, bytes: 16)
        #expect(try ring.insert(a)); #expect(try ring.insert(b))
        #expect(ring.segments.map(\.url) == [b.url])
        #expect(try ring.insert(huge) == false)
        #expect(!FileManager.default.fileExists(atPath: huge.url.path))
        #expect(ring.byteCount == 10)
    }
    @Test func drainTransfersOwnershipAndClearDoesNotDeleteTransferredFiles() throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        var ring = NativeVideoRing(directory: dir, durationNanos: 10, byteLimit: 100)
        let a = try segment(dir, start: 0, end: 2)
        #expect(try ring.insert(a))
        let frozen = ring.drain()
        try ring.clear()
        #expect(frozen.map(\.url) == [a.url]); #expect(ring.byteCount == 0)
        #expect(FileManager.default.fileExists(atPath: a.url.path))
    }
    @Test func invalidOrOverlappingMetadataCannotEnterRing() throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        var ring = NativeVideoRing(directory: dir, durationNanos: 10, byteLimit: 100)
        let a = try segment(dir, start: 1, end: 3)
        let overlap = try segment(dir, start: 2, end: 4)
        let backwards = try segment(dir, start: 5, end: 4)
        #expect(try ring.insert(a))
        #expect(try ring.insert(overlap) == false)
        #expect(try ring.insert(backwards) == false)
        #expect(ring.segments.map(\.url) == [a.url])
        #expect(!FileManager.default.fileExists(atPath: overlap.url.path))
    }
}
