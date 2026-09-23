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
    private var session: AVAssetExportSession?
    private var closed = false
    private var cancelled = false

    init(directory: URL) {
        self.directory = directory.appendingPathComponent("", isDirectory: true).standardizedFileURL
    }

    func cancel() {
        cancelled = true
        session?.cancelExport()
    }

    func export(segments: [NativeVideoSegment], dimensions: NativeVideoDimensions,
                anchorNanos: UInt64, anchorEpochMs: Double) async throws -> NativeVideoArtifact? {
        guard !closed else { throw NativeVideoExportError.closed }
        closed = true
        // Only accept files inside this recording's private directory. Refuse
        // foreign paths before taking ownership or attempting any deletion.
        guard segments.allSatisfy({ $0.url.isFileURL &&
            $0.url.deletingLastPathComponent().standardizedFileURL == directory }),
              Set(segments.map { $0.url.standardizedFileURL }).count == segments.count
        else { throw NativeVideoExportError.invalidSegments }
        defer {
            for segment in segments { try? FileManager.default.removeItem(at: segment.url) }
            NativeVideoStorage.removeIfEmpty(directory)
        }
        guard !cancelled, !Task.isCancelled else { throw CancellationError() }
        guard let first = segments.first, let last = segments.last else { return nil }
        guard first.startNanos >= anchorNanos, last.endNanos > first.startNanos,
              last.endNanos - first.startNanos <= 30_000_000_000,
              anchorEpochMs.isFinite, anchorEpochMs >= 0 else { throw NativeVideoExportError.invalidSegments }
        let epoch = anchorEpochMs + Double(first.startNanos - anchorNanos) / 1_000_000
        guard epoch.isFinite else { throw NativeVideoExportError.invalidSegments }
        let composition = AVMutableComposition()
        guard let destination = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)
        else { throw NativeVideoExportError.exportFailed }
        var previousEnd = first.startNanos
        var totalBytes = 0
        for segment in segments {
            guard segment.startNanos >= previousEnd, segment.endNanos > segment.startNanos,
                  segment.endNanos <= last.endNanos, segment.byteCount > 0,
                  segment.byteCount <= 8 * 1024 * 1024 - totalBytes
            else { throw NativeVideoExportError.invalidSegments }
            totalBytes += segment.byteCount
            previousEnd = segment.endNanos
            let asset = AVURLAsset(url: segment.url)
            guard let track = asset.tracks(withMediaType: .video).first,
                  track.naturalSize == CGSize(width: dimensions.width, height: dimensions.height),
                  track.preferredTransform == .identity
            else { throw NativeVideoExportError.invalidSegments }
            let duration = CMTime(value: Int64(segment.endNanos - segment.startNanos), timescale: 1_000_000_000)
            guard asset.duration.seconds.isFinite, abs(asset.duration.seconds - duration.seconds) < 0.002
            else { throw NativeVideoExportError.invalidSegments }
            let offset = CMTime(value: Int64(segment.startNanos - first.startNanos), timescale: 1_000_000_000)
            try destination.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: track, at: offset)
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
        guard duration.isFinite, duration > 0, duration <= 30_000 else { throw NativeVideoExportError.exportFailed }
        transferred = true
        return .init(url: output, byteCount: byteCount, startEpochMs: epoch, durationMs: duration,
            width: dimensions.width, height: dimensions.height, ownedDirectory: directory)
    }
}
#endif
