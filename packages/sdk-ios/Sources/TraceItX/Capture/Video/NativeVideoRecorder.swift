// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import Foundation

protocol NativeVideoRecording: Sendable {
    func append(_ frame: NativeVideoFrame) async throws -> Bool
    func finish(anchorNanos: UInt64, anchorEpochMs: Double, endNanos: UInt64?) async throws -> NativeVideoArtifact?
    func cancel() async
}

/// One recording epoch: bounded complete segments plus one active encoder.
/// Capture/session scheduling remains outside this actor. Concurrent appends are
/// dropped while a frame/rollover is in flight; they never build a raw-frame queue.
actor NativeVideoRecorder: NativeVideoRecording {
    private let directory: URL
    private let framesPerSecond: Int
    private var ring: NativeVideoRing
    private var writer: NativeVideoSegmentWriter?
    private var exporter: NativeVideoExporter?
    private var dimensions: NativeVideoDimensions?
    private var segmentStart: UInt64?
    private var busy = false
    private var idleWaiter: CheckedContinuation<Void, Never>?
    private enum State { case active, freezing, closed }
    private var state = State.active

    init(directory: URL, framesPerSecond: Int, durationNanos: UInt64 = 30_000_000_000,
         byteLimit: Int = 8 * 1024 * 1024) throws {
        guard framesPerSecond == 5 || framesPerSecond == 10 else { throw NativeVideoWriterError.invalidFrame }
        self.directory = directory
        self.framesPerSecond = framesPerSecond
        ring = NativeVideoRing(directory: directory, durationNanos: min(30_000_000_000, durationNanos),
            byteLimit: min(8 * 1024 * 1024, byteLimit))
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete])
    }

    func append(_ frame: NativeVideoFrame) async throws -> Bool {
        guard state == .active, !busy else { return false }
        busy = true
        defer {
            busy = false
            idleWaiter?.resume(); idleWaiter = nil
            if state == .closed { NativeVideoStorage.removeIfEmpty(directory) }
        }
        do {
            if let dimensions, dimensions.width != frame.width || dimensions.height != frame.height {
                await writer?.cancel()
                writer = nil; segmentStart = nil
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
            let current = writer ?? NativeVideoSegmentWriter(directory: directory,
                dimensions: .init(width: frame.width, height: frame.height), framesPerSecond: framesPerSecond)
            writer = current
            let accepted = try await current.append(frame)
            guard state != .closed else { await current.cancel(); return false }
            if accepted && segmentStart == nil { segmentStart = frame.timestampNanos }
            return accepted
        } catch {
            await cancel()
            throw error
        }
    }

    func finish(anchorNanos: UInt64, anchorEpochMs: Double, endNanos: UInt64? = nil) async throws -> NativeVideoArtifact? {
        guard state == .active else { return nil }
        state = .freezing
        if busy { await withCheckedContinuation { idleWaiter = $0 } }
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

    func cancel() async {
        state = .closed
        await writer?.cancel()
        writer = nil; segmentStart = nil
        await exporter?.cancel()
        try? ring.clear()
        NativeVideoStorage.removeIfEmpty(directory)
    }
}
#endif
