// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import Foundation

/// Longest replay window the device keeps. Matches Android and the dashboard's
/// replay duration setting, which goes up to 60 seconds.
enum NativeVideoLimits {
    static let maxDurationSec = 60
    static let maxDurationNanos = UInt64(maxDurationSec) * 1_000_000_000
}

protocol NativeVideoRecording: Sendable {
    func append(_ frame: NativeVideoFrame) async throws -> Bool
    func finish(anchorNanos: UInt64, anchorEpochMs: Double, endNanos: UInt64?) async throws -> NativeVideoArtifact?
    /// A copy of the retained window; recording continues.
    func snapshot(anchorNanos: UInt64, anchorEpochMs: Double, endNanos: UInt64) async throws -> NativeVideoArtifact?
    func cancel() async
}

/// One recording epoch: bounded complete segments plus one active encoder.
/// Capture/session scheduling remains outside this actor. Concurrent appends are
/// dropped while a frame, rollover or snapshot close is in flight; they never
/// build a raw-frame queue.
actor NativeVideoRecorder: NativeVideoRecording {
    private struct StagedSnapshot {
        let segments: [NativeVideoSegment]
        let dimensions: NativeVideoDimensions
        let directory: URL
    }

    typealias SnapshotExport = @Sendable (URL, [NativeVideoSegment], NativeVideoDimensions, UInt64, Double) async throws -> NativeVideoArtifact?
    private let snapshotExport: SnapshotExport
    private let directory: URL
    private let framesPerSecond: Int
    private var ring: NativeVideoRing
    private var writer: NativeVideoSegmentWriter?
    private var exporter: NativeVideoExporter?
    private var dimensions: NativeVideoDimensions?
    private var segmentStart: UInt64?
    /// Newest encoded frame; a frame at or before it is dropped, never encoded.
    private var lastAppendedNanos: UInt64?
    /// Where a snapshot closed the open segment. The next segment's first frame
    /// is placed here: an export decodes any gap between segments as a black frame.
    private var resumeNanos: UInt64?
    private var busy = false
    private var idleWaiters: [CheckedContinuation<Void, Never>] = []
    private enum State { case active, freezing, closed }
    private var state = State.active

    init(directory: URL, framesPerSecond: Int, durationNanos: UInt64 = 30_000_000_000,
         byteLimit: Int = 8 * 1024 * 1024,
         snapshotExport: @escaping SnapshotExport = { directory, segments, dimensions, anchor, epoch in
             try await NativeVideoExporter(directory: directory).export(segments: segments,
                 dimensions: dimensions, anchorNanos: anchor, anchorEpochMs: epoch)
         }) throws {
        guard NativeVideoSettings.allowedFramesPerSecond.contains(framesPerSecond) else {
            throw NativeVideoWriterError.invalidFrame
        }
        self.snapshotExport = snapshotExport
        self.directory = directory
        self.framesPerSecond = framesPerSecond
        ring = NativeVideoRing(directory: directory, durationNanos: min(NativeVideoLimits.maxDurationNanos, durationNanos),
            byteLimit: min(8 * 1024 * 1024, byteLimit))
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete])
    }

    func append(_ frame: NativeVideoFrame) async throws -> Bool {
        guard state == .active, !busy else { return false }
        if let last = lastAppendedNanos, frame.timestampNanos <= last { return false }
        busy = true
        defer { releaseBusy() }
        do {
            if let dimensions, dimensions.width != frame.width || dimensions.height != frame.height {
                await writer?.cancel()
                writer = nil; segmentStart = nil; resumeNanos = nil
                try ring.clear()
            }
            guard state == .active, !Task.isCancelled else { return false }
            dimensions = .init(width: frame.width, height: frame.height)
            if let start = segmentStart, frame.timestampNanos >= start,
               frame.timestampNanos - start >= 2_000_000_000, let current = writer {
                let closed = try await current.finish(endNanos: frame.timestampNanos)
                writer = nil; segmentStart = nil
                if let closed {
                    guard state != .closed, !Task.isCancelled else {
                        try? FileManager.default.removeItem(at: closed.url)
                        return false
                    }
                    do { try ring.insert(closed) }
                    catch { try? FileManager.default.removeItem(at: closed.url); throw error }
                }
            }
            guard state == .active, !Task.isCancelled else { return false }
            // The first frame of a segment that follows a snapshot starts where
            // the snapshot closed, so the segments stay contiguous.
            let encoded = segmentStart == nil ? (resumeNanos.map { frame.retimed(to: $0) } ?? frame) : frame
            let current = writer ?? NativeVideoSegmentWriter(directory: directory,
                dimensions: .init(width: encoded.width, height: encoded.height), framesPerSecond: framesPerSecond)
            writer = current
            let accepted = try await current.append(encoded)
            guard state != .closed else { await current.cancel(); return false }
            if accepted {
                if segmentStart == nil { segmentStart = encoded.timestampNanos }
                lastAppendedNanos = encoded.timestampNanos
                resumeNanos = nil
            }
            return accepted
        } catch {
            await cancel()
            throw error
        }
    }

    func finish(anchorNanos: UInt64, anchorEpochMs: Double, endNanos: UInt64? = nil) async throws -> NativeVideoArtifact? {
        guard state == .active else { return nil }
        state = .freezing
        if busy { await withCheckedContinuation { idleWaiters.append($0) } }
        guard state == .freezing, !Task.isCancelled else { await cancel(); return nil }
        do {
            if let current = writer {
                let closed = try await current.finish(endNanos: endNanos)
                writer = nil; segmentStart = nil
                if let closed {
                    guard state == .freezing, !Task.isCancelled else {
                        try? FileManager.default.removeItem(at: closed.url)
                        await cancel()
                        return nil
                    }
                    do { try ring.insert(closed) }
                    catch { try? FileManager.default.removeItem(at: closed.url); throw error }
                }
            }
            guard state == .freezing, !Task.isCancelled, let dimensions else {
                await cancel()
                return nil
            }
            let export = NativeVideoExporter(directory: directory)
            exporter = export
            let artifact = try await export.export(segments: ring.drain(), dimensions: dimensions,
                anchorNanos: anchorNanos, anchorEpochMs: anchorEpochMs)
            exporter = nil
            guard state == .freezing, !Task.isCancelled else {
                artifact?.removeOwnedFile()
                await cancel()
                return nil
            }
            state = .closed
            return artifact
        } catch {
            await cancel()
            throw error
        }
    }

    /// A copy of the retained window that leaves this recording running.
    /// Closes the open segment early so it is complete, copies the retained
    /// segments into an independently owned sibling directory and exports the
    /// copies. A later snapshot or `finish` still sees the whole window.
    func snapshot(anchorNanos: UInt64, anchorEpochMs: Double, endNanos: UInt64) async throws -> NativeVideoArtifact? {
        while busy && state == .active { await withCheckedContinuation { idleWaiters.append($0) } }
        guard state == .active, !Task.isCancelled else { return nil }
        busy = true
        let staged: StagedSnapshot?
        do {
            staged = try await stageSnapshot(endNanos: endNanos)
        } catch {
            releaseBusy()
            throw error
        }
        releaseBusy()
        guard let staged else { return nil }
        // Runs after `busy` is released: frames, rollovers and a freeze proceed
        // against the originals while the independent copies export.
        return try await snapshotExport(staged.directory, staged.segments, staged.dimensions, anchorNanos, anchorEpochMs)
    }

    func cancel() async {
        state = .closed
        await writer?.cancel()
        writer = nil; segmentStart = nil
        await exporter?.cancel()
        try? ring.clear()
        NativeVideoStorage.removeIfEmpty(directory)
    }

    private func stageSnapshot(endNanos: UInt64) async throws -> StagedSnapshot? {
        if let current = writer {
            writer = nil; segmentStart = nil
            if let last = lastAppendedNanos {
                let end = max(endNanos, last + 1)
                // The snapshot's deadline cancels this task. It must never cancel
                // the recording's own segment, so the close runs in its own task.
                let closed = try await Task { try await current.finish(endNanos: end) }.value
                if let closed {
                    guard state != .closed else {
                        try? FileManager.default.removeItem(at: closed.url)
                        return nil
                    }
                    // Inserted even while a freeze waits: the report keeps it.
                    do { try ring.insert(closed) }
                    catch { try? FileManager.default.removeItem(at: closed.url); throw error }
                    resumeNanos = end
                }
            } else {
                await current.cancel()
            }
        }
        // A freeze waiting on this close owns the originals; this already-started
        // snapshot must retain its independent copy before releasing the lease.
        guard state != .closed, !Task.isCancelled, let dimensions, !ring.segments.isEmpty else { return nil }
        let target = directory.deletingLastPathComponent()
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: false,
            attributes: [.protectionKey: FileProtectionType.complete])
        var copies: [NativeVideoSegment] = []
        do {
            for segment in ring.segments {
                // An independently owned copy: the ring may evict its original meanwhile.
                let copy = target.appendingPathComponent(segment.url.lastPathComponent)
                try FileManager.default.copyItem(at: segment.url, to: copy)
                try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete],
                    ofItemAtPath: copy.path)
                copies.append(.init(url: copy, startNanos: segment.startNanos,
                    endNanos: segment.endNanos, byteCount: segment.byteCount))
            }
        } catch {
            try? FileManager.default.removeItem(at: target)
            throw error
        }
        return .init(segments: copies, dimensions: dimensions, directory: target)
    }

    private func releaseBusy() {
        busy = false
        let waiters = idleWaiters
        idleWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
        if state == .closed { NativeVideoStorage.removeIfEmpty(directory) }
    }
}

private extension NativeVideoFrame {
    func retimed(to timestampNanos: UInt64) -> NativeVideoFrame {
        .init(width: width, height: height, bytesPerRow: bytesPerRow, bgraBytes: bgraBytes,
              timestampNanos: timestampNanos)
    }
}
#endif
