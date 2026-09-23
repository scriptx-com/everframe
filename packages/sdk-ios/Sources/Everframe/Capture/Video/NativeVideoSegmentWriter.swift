// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
@preconcurrency import AVFoundation
import CoreVideo
import Foundation

enum NativeVideoWriterError: Error, Equatable {
    case closed, invalidFrame, invalidTimestamp, setupFailed, allocationFailed, appendFailed, finishFailed
}

/// All encoder operations run on this actor, never the main actor. No queued raw
/// frames: an unready encoder returns false immediately and the scheduler drops
/// that frame. The caller must allow only one append request in flight.
actor NativeVideoSegmentWriter {
    private let url: URL
    private let dimensions: NativeVideoDimensions
    private let framesPerSecond: Int
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var firstNanos: UInt64?
    private var lastNanos: UInt64?
    private enum State { case open, finishing, cancelled, transferred }
    private var state = State.open

    init(directory: URL, dimensions: NativeVideoDimensions, framesPerSecond: Int) {
        url = directory.appendingPathComponent(UUID().uuidString + ".mp4")
        self.dimensions = dimensions
        self.framesPerSecond = framesPerSecond
    }

    func append(_ frame: NativeVideoFrame) throws -> Bool {
        dispatchPrecondition(condition: .notOnQueue(.main))
        try Task.checkCancellation()
        guard state == .open else { throw NativeVideoWriterError.closed }
        guard dimensions.width > 0, dimensions.height > 0,
              dimensions.width <= 854, dimensions.height <= 854,
              dimensions.width.isMultiple(of: 2), dimensions.height.isMultiple(of: 2),
              framesPerSecond == 5 || framesPerSecond == 10,
              frame.width == dimensions.width, frame.height == dimensions.height,
              frame.bytesPerRow >= dimensions.width * 4,
              frame.bytesPerRow <= Int.max / frame.height,
              frame.bgraBytes.count >= frame.bytesPerRow * frame.height
        else { throw NativeVideoWriterError.invalidFrame }
        let start = firstNanos ?? frame.timestampNanos
        guard frame.timestampNanos >= start,
              frame.timestampNanos - start <= UInt64(Int64.max),
              lastNanos.map({ frame.timestampNanos > $0 }) ?? true,
              frame.timestampNanos <= UInt64.max - 1_000_000_000 / UInt64(framesPerSecond)
        else { throw NativeVideoWriterError.invalidTimestamp }
        if writer == nil {
            do { try prepare() }
            catch { cancel(); throw error }
        }
        guard let writer, let input, let adaptor, writer.status == .writing
        else { throw NativeVideoWriterError.appendFailed }
        guard input.isReadyForMoreMediaData else { return false }
        guard let pool = adaptor.pixelBufferPool else { throw NativeVideoWriterError.allocationFailed }
        var allocated: CVPixelBuffer?
        let options = [kCVPixelBufferPoolAllocationThresholdKey as String: 3] as CFDictionary
        let result = CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(kCFAllocatorDefault, pool, options, &allocated)
        if result == kCVReturnWouldExceedAllocationThreshold { return false }
        guard result == kCVReturnSuccess, let buffer = allocated,
              CVPixelBufferLockBaseAddress(buffer, []) == kCVReturnSuccess
        else { throw NativeVideoWriterError.allocationFailed }
        guard let destination = CVPixelBufferGetBaseAddress(buffer) else {
            CVPixelBufferUnlockBaseAddress(buffer, [])
            throw NativeVideoWriterError.allocationFailed
        }
        let destinationStride = CVPixelBufferGetBytesPerRow(buffer)
        frame.bgraBytes.withUnsafeBytes { bytes in
            for row in 0..<frame.height {
                destination.advanced(by: row * destinationStride).copyMemory(
                    from: bytes.baseAddress!.advanced(by: row * frame.bytesPerRow), byteCount: frame.width * 4)
            }
        }
        CVPixelBufferUnlockBaseAddress(buffer, [])
        let time = CMTime(value: Int64(frame.timestampNanos - start), timescale: 1_000_000_000)
        guard adaptor.append(buffer, withPresentationTime: time) else { throw NativeVideoWriterError.appendFailed }
        firstNanos = start; lastNanos = frame.timestampNanos
        return true
    }

    func finish(endNanos requestedEnd: UInt64? = nil) async throws -> NativeVideoSegment? {
        guard state == .open else { throw NativeVideoWriterError.closed }
        if Task.isCancelled { cancel(); throw CancellationError() }
        guard let writer, let input, let firstNanos, let lastNanos else {
            cancel()
            return nil
        }
        let endNanos = requestedEnd ?? (lastNanos + 1_000_000_000 / UInt64(framesPerSecond))
        guard endNanos > lastNanos, endNanos - firstNanos <= UInt64(Int64.max)
        else { throw NativeVideoWriterError.invalidTimestamp }
        state = .finishing
        writer.endSession(atSourceTime: CMTime(value: Int64(endNanos - firstNanos), timescale: 1_000_000_000))
        input.markAsFinished()
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                writer.finishWriting { continuation.resume() }
            }
        } onCancel: {
            Task { await self.cancel() }
        }
        guard state == .finishing, !Task.isCancelled, writer.status == .completed else {
            cancel()
            throw NativeVideoWriterError.finishFailed
        }
        do {
            let bytes = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard bytes > 0 else { throw NativeVideoWriterError.finishFailed }
            state = .transferred
            self.writer = nil; self.input = nil; self.adaptor = nil
            return .init(url: url, startNanos: firstNanos, endNanos: endNanos, byteCount: bytes)
        } catch { cancel(); throw error }
    }

    func cancel() {
        guard state != .transferred else { return }
        state = .cancelled
        if writer?.status == .writing { writer?.cancelWriting() }
        writer = nil; input = nil; adaptor = nil
        try? FileManager.default.removeItem(at: url)
    }

    private func prepare() throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: dimensions.width, AVVideoHeightKey: dimensions.height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 1_200_000,
                AVVideoExpectedSourceFrameRateKey: framesPerSecond,
                AVVideoMaxKeyFrameIntervalKey: framesPerSecond * 2,
                AVVideoAllowFrameReorderingKey: false,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264BaselineAutoLevel,
            ],
        ])
        input.expectsMediaDataInRealTime = true
        input.mediaTimeScale = 1_000_000_000
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: dimensions.width,
            kCVPixelBufferHeightKey as String: dimensions.height,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
        ])
        self.writer = writer; self.input = input; self.adaptor = adaptor
        guard writer.canAdd(input) else { throw NativeVideoWriterError.setupFailed }
        writer.add(input)
        guard writer.startWriting() else { throw NativeVideoWriterError.setupFailed }
        // Protect the empty output before any masked pixel data is appended.
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
        writer.startSession(atSourceTime: .zero)
    }
}
#endif
