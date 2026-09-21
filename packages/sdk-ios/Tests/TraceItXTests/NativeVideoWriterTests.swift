// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
@preconcurrency import AVFoundation
import Foundation
import UIKit
import Testing
@testable import TraceItXKit

struct NativeVideoWriterTests {
    @Test func rolloverEndsAtNextFrameRatherThanNominalCadence() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let writer = NativeVideoSegmentWriter(directory: dir, dimensions: .init(width: 64, height: 64), framesPerSecond: 5)
        #expect(try await writer.append(frame(0)))
        #expect(try await writer.append(frame(1_950_000_000)))
        let segment = try #require(await writer.finish(endNanos: 2_000_000_000))
        #expect(segment.endNanos == 2_000_000_000)
        #expect(abs(AVURLAsset(url: segment.url).duration.seconds - 2) < 0.002)
    }
    @MainActor @Test func sensitivePixelsRemainBlackAfterEncoding() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 64, height: 64))
        window.backgroundColor = .white; window.isHidden = false
        defer { window.isHidden = true }
        let privateView = TXSensitiveView(frame: CGRect(x: 16, y: 16, width: 32, height: 32))
        privateView.backgroundColor = .red; window.addSubview(privateView)
        let capture = NativeVideoCapture()
        let captured = try #require(await capture.capture(window: window, timestampNanos: 0))
        privateView.backgroundColor = .blue
        let changedSecret = try #require(await capture.capture(window: window, timestampNanos: 0))
        #expect(captured.bgraBytes == changedSecret.bgraBytes)
        for y in 16..<48 { for x in 16..<48 {
            let i = y * captured.bytesPerRow + x * 4
            #expect(Array(captured.bgraBytes[i..<i + 4]) == [0, 0, 0, 255])
        } }
        let writer = NativeVideoSegmentWriter(directory: dir, dimensions: .init(width: 64, height: 64), framesPerSecond: 5)
        #expect(try await writer.append(captured))
        let segment = try #require(await writer.finish())
        let asset = AVURLAsset(url: segment.url)
        let track = try #require(asset.tracks(withMediaType: .video).first)
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track,
            outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        reader.add(output); #expect(reader.startReading())
        let sample = try #require(output.copyNextSampleBuffer())
        let buffer = try #require(CMSampleBufferGetImageBuffer(sample))
        #expect(CVPixelBufferLockBaseAddress(buffer, .readOnly) == kCVReturnSuccess)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        let pixels = try #require(CVPixelBufferGetBaseAddress(buffer)).assumingMemoryBound(to: UInt8.self)
        let stride = CVPixelBufferGetBytesPerRow(buffer)
        var nonBlackPixels = 0
        for y in 16..<48 { for x in 16..<48 {
            let i = y * stride + x * 4
            // H.264 round-trip measured +1 RGB in one black macroblock.
            // Exact masking and content independence are asserted above.
            if pixels[i] > 1 || pixels[i + 1] > 1 || pixels[i + 2] > 1 || pixels[i + 3] != 255 {
                nonBlackPixels += 1
            }
        } }
        #expect(nonBlackPixels == 0)
        #expect(pixels[8 * stride + 8 * 4] > 240) // surrounding UI is retained
    }
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    private func frame(_ nanos: UInt64, value: UInt8 = 0) -> NativeVideoFrame {
        var bytes = Data(repeating: value, count: 64 * 64 * 4)
        for i in stride(from: 3, to: bytes.count, by: 4) { bytes[i] = 255 }
        return .init(width: 64, height: 64, bytesPerRow: 256, bgraBytes: bytes, timestampNanos: nanos)
    }
    @Test func encodedTimestampsPreserveCaptureGaps() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let writer = NativeVideoSegmentWriter(directory: dir, dimensions: .init(width: 64, height: 64), framesPerSecond: 10)
        #expect(try await writer.append(frame(1_000_000_000)))
        #expect(try await writer.append(frame(1_100_000_000, value: 128)))
        #expect(try await writer.append(frame(1_400_000_000, value: 255)))
        let segment = try #require(await writer.finish())
        #expect(segment.startNanos == 1_000_000_000)
        #expect(segment.endNanos == 1_500_000_000)
        #expect(segment.byteCount > 0)
        let asset = AVURLAsset(url: segment.url)
        let track = try #require(asset.tracks(withMediaType: .video).first)
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
        reader.add(output); #expect(reader.startReading())
        var milliseconds: [Int] = []
        while let sample = output.copyNextSampleBuffer() {
            // Compressed passthrough also returns zero-sample edit/boundary
            // buffers; those are not video frames and may have invalid PTS.
            guard CMSampleBufferGetNumSamples(sample) > 0 else { continue }
            let time = CMSampleBufferGetPresentationTimeStamp(sample)
            try #require(time.seconds.isFinite)
            milliseconds.append(Int((time.seconds * 1000).rounded()))
        }
        #expect(reader.status == .completed)
        #expect(milliseconds == [0, 100, 400])
        #expect(abs(asset.duration.seconds - 0.5) < 0.002)
        await writer.cancel()
        #expect(FileManager.default.fileExists(atPath: segment.url.path)) // ownership transferred
    }
    @Test func cancelDeletesPartialMovieAndRejectsFurtherFrames() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let writer = NativeVideoSegmentWriter(directory: dir, dimensions: .init(width: 64, height: 64), framesPerSecond: 5)
        #expect(try await writer.append(frame(0)))
        await writer.cancel(); await writer.cancel()
        #expect(try FileManager.default.contentsOfDirectory(atPath: dir.path).isEmpty)
        await #expect(throws: NativeVideoWriterError.closed) { try await writer.append(frame(200_000_000)) }
    }
    @Test func emptyFinishDoesNotCreateMovie() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let writer = NativeVideoSegmentWriter(directory: dir, dimensions: .init(width: 64, height: 64), framesPerSecond: 5)
        #expect(try await writer.finish() == nil)
        #expect(try FileManager.default.contentsOfDirectory(atPath: dir.path).isEmpty)
    }
    @Test func invalidFrameAndNonIncreasingTimestampAreRejected() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let writer = NativeVideoSegmentWriter(directory: dir, dimensions: .init(width: 64, height: 64), framesPerSecond: 5)
        let invalid = NativeVideoFrame(width: 64, height: 64, bytesPerRow: 256, bgraBytes: Data(), timestampNanos: 0)
        await #expect(throws: NativeVideoWriterError.invalidFrame) { try await writer.append(invalid) }
        #expect(try await writer.append(frame(1)))
        await #expect(throws: NativeVideoWriterError.invalidTimestamp) { try await writer.append(frame(1)) }
        await writer.cancel()
    }
}
#endif
