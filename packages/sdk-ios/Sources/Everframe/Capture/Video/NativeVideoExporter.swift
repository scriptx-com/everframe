// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
@preconcurrency import AVFoundation
import Foundation

struct NativeVideoArtifact: Sendable {
    let url: URL
    let byteCount: Int
    let startEpochMs: Double
    let durationMs: Double
    let width: Int
    let height: Int
    var ownedDirectory: URL? = nil

    func removeOwnedFile() {
        try? FileManager.default.removeItem(at: url)
        if let ownedDirectory { NativeVideoStorage.removeIfEmpty(ownedDirectory) }
    }
}

enum NativeVideoExportError: Error { case closed, invalidSegments, exportFailed, oversized }

/// Consumes frozen segments, returning one owned movie. All intermediate files
/// are removed on success or failure; a returned artifact belongs to the caller.
actor NativeVideoExporter {
    private let directory: URL
    private let removeSegment: @Sendable (URL) -> Void
    private var session: AVAssetExportSession?
    private var closed = false
    private var cancelled = false

    init(directory: URL, removeSegment: @escaping @Sendable (URL) -> Void = { try? FileManager.default.removeItem(at: $0) }) {
        self.removeSegment = removeSegment
        self.directory = directory.appendingPathComponent("", isDirectory: true).standardizedFileURL
    }

    func cancel() {
        cancelled = true
        session?.cancelExport()
    }

    func export(segments: [NativeVideoSegment], dimensions: NativeVideoDimensions,
                anchorNanos: UInt64, anchorEpochMs: Double, endNanos: UInt64? = nil,
                durationNanos: UInt64 = NativeVideoLimits.maxDurationNanos) async throws -> NativeVideoArtifact? {
        guard !closed else { throw NativeVideoExportError.closed }
        closed = true
        // Only accept files inside this recording's private directory. Refuse
        // foreign paths before taking ownership or attempting any deletion.
        guard segments.allSatisfy({ $0.url.isFileURL &&
            $0.url.deletingLastPathComponent().standardizedFileURL == directory }),
              Set(segments.map { $0.url.standardizedFileURL }).count == segments.count
        else { throw NativeVideoExportError.invalidSegments }
        defer {
            for segment in segments { removeSegment(segment.url) }
            NativeVideoStorage.removeIfEmpty(directory)
        }
        guard !cancelled, !Task.isCancelled else { throw CancellationError() }
        guard let first = segments.first, let last = segments.last else { return nil }
        guard first.startNanos >= anchorNanos, last.endNanos > first.startNanos,
              last.endNanos - first.startNanos <= NativeVideoLimits.maxDurationNanos,
              anchorEpochMs.isFinite, anchorEpochMs >= 0 else { throw NativeVideoExportError.invalidSegments }
        let cutoff = endNanos ?? last.endNanos
        guard cutoff > first.startNanos else { return nil }
        guard cutoff - first.startNanos <= UInt64(Int64.max), durationNanos > 0 else {
            throw NativeVideoExportError.invalidSegments
        }
        let window = min(durationNanos, NativeVideoLimits.maxDurationNanos)
        let start = max(first.startNanos, cutoff > window ? cutoff - window : 0)
        func time(_ nanos: UInt64) -> CMTime {
            CMTimeConvertScale(CMTime(value: Int64(nanos), timescale: 1_000_000_000),
                timescale: 1_000_000, method: .roundHalfAwayFromZero)
        }
        let epoch = anchorEpochMs + Double(start - anchorNanos) / 1_000_000
        guard epoch.isFinite else { throw NativeVideoExportError.invalidSegments }
        let composition = AVMutableComposition()
        guard let destination = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)
        else { throw NativeVideoExportError.exportFailed }
        var previous: NativeVideoSegment?
        var totalBytes = 0
        for (index, segment) in segments.enumerated() {
            guard previous.map({ $0.canPrecede(segment) }) ?? true, segment.endNanos > segment.startNanos,
                  segment.endNanos - segment.startNanos <= NativeVideoLimits.maxDurationNanos,
                  segment.lastFrameNanos.map({ $0 >= segment.startNanos && $0 < segment.endNanos }) ?? true,
                  segment.byteCount > 0,
                  segment.byteCount <= 8 * 1024 * 1024 - totalBytes
            else { throw NativeVideoExportError.invalidSegments }
            totalBytes += segment.byteCount
            previous = segment
            let asset = AVURLAsset(url: segment.url)
            guard let track = asset.tracks(withMediaType: .video).first,
                  track.naturalSize == CGSize(width: dimensions.width, height: dimensions.height),
                  track.preferredTransform == .identity
            else { throw NativeVideoExportError.invalidSegments }
            let duration = CMTime(value: Int64(segment.endNanos - segment.startNanos), timescale: 1_000_000_000)
            guard asset.duration.seconds.isFinite, abs(asset.duration.seconds - duration.seconds) < 0.002
            else { throw NativeVideoExportError.invalidSegments }
            let nextStart = index + 1 < segments.count ? segments[index + 1].startNanos : cutoff
            let end = min(nextStart, cutoff)
            let outputStart = max(segment.startNanos, start)
            if end <= outputStart { continue }
            // Clip to the retained window before extending a hold. A long idle
            // gap must not create an equally long sample outside that window.
            let tailStart = segment.lastFrameNanos.map { time($0 - segment.startNanos) }
            let sourceStart = CMTimeMinimum(time(outputStart - segment.startNanos), tailStart ?? track.timeRange.duration)
            let wanted = time(end - outputStart)
            let included = CMTimeMinimum(wanted, track.timeRange.duration - sourceStart)
            let offset = time(outputStart - start)
            guard included > .zero else { throw NativeVideoExportError.invalidSegments }
            try destination.insertTimeRange(CMTimeRange(start: sourceStart, duration: included), of: track, at: offset)
            if wanted > included, let tailStart {
                // Only the final sample's hold changes. Its pixels were already
                // captured; every newer frame keeps its real presentation time.
                let tailOffset = CMTimeMaximum(.zero, tailStart - sourceStart)
                guard tailOffset < included else { throw NativeVideoExportError.invalidSegments }
                destination.scaleTimeRange(CMTimeRange(start: offset + tailOffset, duration: included - tailOffset),
                    toDuration: wanted - tailOffset)
            }
        }
        guard let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough)
        else { throw NativeVideoExportError.exportFailed }
        let output = directory.appendingPathComponent(UUID().uuidString + ".mp4")
        var transferred = false
        defer {
            session = nil
            if !transferred { try? FileManager.default.removeItem(at: output) }
        }
        // The new file inherits protection before export writes any video bytes.
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: directory.path)
        exporter.outputURL = output; exporter.outputFileType = .mp4
        exporter.shouldOptimizeForNetworkUse = true
        exporter.timeRange = CMTimeRange(start: .zero, duration: time(cutoff - start))
        session = exporter
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                exporter.exportAsynchronously { continuation.resume() }
            }
        } onCancel: {
            Task { await self.cancel() }
        }
        guard !cancelled, !Task.isCancelled, exporter.status == .completed else {
            throw NativeVideoExportError.exportFailed
        }
        let byteCount = try output.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard byteCount > 0, byteCount <= 8 * 1024 * 1024 else { throw NativeVideoExportError.oversized }
        let duration = AVURLAsset(url: output).duration.seconds * 1000
        guard duration.isFinite, duration > 0, duration <= Double(NativeVideoLimits.maxDurationSec * 1000) else { throw NativeVideoExportError.exportFailed }
        transferred = true
        return .init(url: output, byteCount: byteCount, startEpochMs: epoch, durationMs: duration,
            width: dimensions.width, height: dimensions.height, ownedDirectory: directory)
    }
}
#endif
