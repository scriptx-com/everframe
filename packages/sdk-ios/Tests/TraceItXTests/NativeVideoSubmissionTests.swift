// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import Foundation
import CryptoKit
import Testing
@testable import TraceItXKit

@MainActor struct NativeVideoSubmissionTests {
    @Test func reportBudgetIncludesEnvelopeAndMultipartFileCount() {
        #expect(NativeVideoReportBudget.omissionReason(envelopeBytes: 1000, attachmentBytes: [24_999_000]) == nil)
        #expect(NativeVideoReportBudget.omissionReason(envelopeBytes: 1001, attachmentBytes: [24_999_000]) == "replay_report_budget")
        #expect(NativeVideoReportBudget.omissionReason(envelopeBytes: 1000, attachmentBytes: [100, 100, 100, 100, 100]) == nil)
        #expect(NativeVideoReportBudget.omissionReason(envelopeBytes: 1000, attachmentBytes: [100, 100, 100, 100, 100, 100]) == "replay_part_limit")
        #expect(NativeVideoReportBudget.omissionReason(envelopeBytes: 1000, attachmentBytes: [Int.max]) == "replay_report_budget")
    }

    private func artifact() async throws -> NativeVideoArtifact {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let recorder = try NativeVideoRecorder(directory: directory, framesPerSecond: 10)
        var pixels = Data(repeating: 0, count: 64 * 64 * 4)
        for i in stride(from: 3, to: pixels.count, by: 4) { pixels[i] = 255 }
        for timestamp: UInt64 in [1_000_000_000, 1_100_000_000, 1_400_000_000] {
            #expect(try await recorder.append(.init(width: 64, height: 64, bytesPerRow: 256,
                bgraBytes: pixels, timestampNanos: timestamp)))
        }
        return try #require(await recorder.finish(anchorNanos: 0, anchorEpochMs: 10_000))
    }

    @Test func realMovieBecomesBinaryAttachmentWithActualTimingAndHash() async throws {
        let movie = try await artifact()
        defer { try? FileManager.default.removeItem(at: movie.url.deletingLastPathComponent()) }
        let bytes = try Data(contentsOf: movie.url)
        let part = try #require(await ReporterSubmission.buildReplayAttachment(artifact: movie, byteBudget: 25_000_000))
        #expect(part.envelope.format == .traceitxVideoV1)
        #expect(part.envelope.kind == .sessionReplay)
        #expect(part.envelope.contentType == "video/mp4")
        #expect(part.envelope.replayStartEpochMS == 11_000)
        #expect(abs((part.envelope.durationMS ?? 0) - 500) < 2)
        #expect(part.envelope.width == 64 && part.envelope.height == 64)
        #expect(part.envelope.byteLength == Double(bytes.count))
        #expect(part.multipart.data == bytes)
        #expect(part.multipart.filename == "replay.mp4")
        let hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        #expect(part.envelope.sha256 == hash && part.multipart.sha256Hex == hash)
        #expect(!FileManager.default.fileExists(atPath: movie.url.path))
    }

    @Test func oversizedMovieIsOmittedAndOwnedFileRemoved() async throws {
        let movie = try await artifact()
        defer { try? FileManager.default.removeItem(at: movie.url.deletingLastPathComponent()) }
        #expect(await ReporterSubmission.buildReplayAttachment(artifact: movie, byteBudget: movie.byteCount - 1) == nil)
        #expect(!FileManager.default.fileExists(atPath: movie.url.path))
    }

    @Test func changedFileSizeFailsSoftWithoutLeavingArtifact() async throws {
        let movie = try await artifact()
        defer { try? FileManager.default.removeItem(at: movie.url.deletingLastPathComponent()) }
        try Data().write(to: movie.url)
        #expect(await ReporterSubmission.buildReplayAttachment(artifact: movie, byteBudget: 25_000_000) == nil)
        #expect(!FileManager.default.fileExists(atPath: movie.url.path))
    }
}
#endif
