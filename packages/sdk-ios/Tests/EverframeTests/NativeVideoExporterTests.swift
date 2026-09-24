// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
@preconcurrency import AVFoundation
import Foundation
import Testing
@testable import EverframeKit

struct NativeVideoExporterTests {
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    private func segment(_ directory: URL, start: UInt64, width: Int = 64) async throws -> NativeVideoSegment {
        let writer = NativeVideoSegmentWriter(directory: directory, dimensions: .init(width: width, height: 64), framesPerSecond: 10)
        var bytes = Data(repeating: 0, count: width * 64 * 4)
        for i in stride(from: 3, to: bytes.count, by: 4) { bytes[i] = 255 }
        for offset: UInt64 in [0, 100_000_000] {
            #expect(try await writer.append(.init(width: width, height: 64, bytesPerRow: width * 4,
                bgraBytes: bytes, timestampNanos: start + offset)))
        }
        return try #require(await writer.finish())
    }
    @Test func remuxPreservesGapsAndTransfersOneMovie() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let a = try await segment(dir, start: 1_000_000_000)
        let b = try await segment(dir, start: 1_400_000_000)
        let exporter = NativeVideoExporter(directory: dir)
        let artifact = try #require(await exporter.export(segments: [a, b], dimensions: .init(width: 64, height: 64),
            anchorNanos: 500_000_000, anchorEpochMs: 10_000))
        #expect(artifact.startEpochMs == 10_500)
        #expect(abs(artifact.durationMs - 600) < 2)
        #expect(artifact.width == 64); #expect(artifact.height == 64)
        #expect(artifact.byteCount > 0)
        #expect(!FileManager.default.fileExists(atPath: a.url.path))
        #expect(!FileManager.default.fileExists(atPath: b.url.path))
        let asset = AVURLAsset(url: artifact.url)
        let track = try #require(asset.tracks(withMediaType: .video).first)
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track,
            outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        reader.add(output); #expect(reader.startReading())
        var times: [Int] = []
        while let sample = output.copyNextSampleBuffer() {
            guard CMSampleBufferGetNumSamples(sample) > 0 else { continue }
            let seconds = CMSampleBufferGetPresentationTimeStamp(sample).seconds
            try #require(seconds.isFinite)
            times.append(Int((seconds * 1000).rounded()))
            #expect(CMSampleBufferGetImageBuffer(sample) != nil)
        }
        #expect(reader.status == .completed)
        // Decoding an empty MP4 edit emits a black frame at its start (200 ms).
        // The real frames after it must still be at 400/500, not accelerated.
        #expect(times == [0, 100, 200, 400, 500])
        await exporter.cancel()
        #expect(FileManager.default.fileExists(atPath: artifact.url.path))
    }
    @Test func incompatibleDimensionsFailAndCleanOwnedInputs() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let a = try await segment(dir, start: 0)
        let b = try await segment(dir, start: 200_000_000, width: 32)
        let exporter = NativeVideoExporter(directory: dir)
        await #expect(throws: NativeVideoExportError.invalidSegments) {
            try await exporter.export(segments: [a, b], dimensions: .init(width: 64, height: 64),
                anchorNanos: 0, anchorEpochMs: 0)
        }
        #expect(!FileManager.default.fileExists(atPath: dir.path))
    }
    @Test func emptyFreezeProducesNoAttachment() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let exporter = NativeVideoExporter(directory: dir)
        #expect(try await exporter.export(segments: [], dimensions: .init(width: 64, height: 64),
            anchorNanos: 0, anchorEpochMs: 0) == nil)
        #expect(!FileManager.default.fileExists(atPath: dir.path))
    }
}
#endif
