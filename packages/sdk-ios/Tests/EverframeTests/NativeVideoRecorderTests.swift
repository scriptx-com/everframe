// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import Foundation
@preconcurrency import AVFoundation
import Testing
@testable import EverframeKit

actor SnapshotTestGate {
    private var released = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func wait() async {
        if released { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func release() {
        released = true
        let pending = waiters; waiters.removeAll()
        for waiter in pending { waiter.resume() }
    }
}

private final class SegmentRemovalProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var counts: [URL: Int] = [:]
    func remove(_ url: URL) {
        lock.lock(); counts[url, default: 0] += 1; lock.unlock()
        try? FileManager.default.removeItem(at: url)
    }
    var removals: [URL: Int] { lock.lock(); defer { lock.unlock() }; return counts }
}

struct NativeVideoRecorderTests {
    @Test(arguments: [1, 2, 5, 10])
    func everyConfiguredRateStartsARecorder(fps: Int) throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        _ = try NativeVideoRecorder(directory: dir, framesPerSecond: fps)
    }
    @Test(arguments: [0, 3, 7, 30])
    func unsupportedRatesAreRefused(fps: Int) throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        #expect(throws: NativeVideoWriterError.invalidFrame) {
            try NativeVideoRecorder(directory: dir, framesPerSecond: fps)
        }
    }
    @Test func oneFrameASecondRollsOverEveryTwoSecondsAndExportsTheWindow() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let recorder = try NativeVideoRecorder(directory: dir, framesPerSecond: 1, durationNanos: 15_000_000_000)
        for second: UInt64 in 0...4 {
            #expect(try await recorder.append(frame(second * 1_000_000_000)))
        }
        let artifact = try #require(await recorder.finish(anchorNanos: 0, anchorEpochMs: 10_000,
            endNanos: 5_000_000_000))
        defer { artifact.removeOwnedFile() }
        #expect(artifact.startEpochMs == 10_000)
        #expect(abs(artifact.durationMs - 5000) < 2)
    }

    @MainActor @Test func storageSweepsOrphansOnlyOnceAndPreservesTransferredMovie() throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let old = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: old, withIntermediateDirectories: false)
        try Data([1]).write(to: old.appendingPathComponent("orphan.mp4"))
        let unrelated = root.appendingPathComponent("keep.txt")
        try Data([2]).write(to: unrelated)
        let storage = NativeVideoStorage(root: root)
        let first = try storage.makeDirectory()
        #expect(!FileManager.default.fileExists(atPath: old.path))
        let movie = first.appendingPathComponent("transferred.mp4")
        try Data([3]).write(to: movie)
        _ = try storage.makeDirectory()
        #expect(FileManager.default.fileExists(atPath: movie.path))
        #expect(FileManager.default.fileExists(atPath: unrelated.path))
        NativeVideoStorage.removeIfEmpty(first)
        #expect(FileManager.default.fileExists(atPath: movie.path))
    }
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    private func frame(_ timestamp: UInt64, width: Int = 64) -> NativeVideoFrame {
        var bytes = Data(repeating: 0, count: width * 64 * 4)
        for i in stride(from: 3, to: bytes.count, by: 4) { bytes[i] = 255 }
        return .init(width: width, height: 64, bytesPerRow: width * 4, bgraBytes: bytes, timestampNanos: timestamp)
    }
    @Test func rollingWindowRetainsNewestIndependentSegments() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let recorder = try NativeVideoRecorder(directory: dir, framesPerSecond: 5, durationNanos: 4_000_000_000)
        for timestamp: UInt64 in [0, 1_950_000_000, 2_000_000_000, 3_950_000_000, 4_000_000_000, 5_800_000_000] {
            #expect(try await recorder.append(frame(timestamp)))
        }
        let artifact = try #require(await recorder.finish(anchorNanos: 0, anchorEpochMs: 10_000))
        #expect(artifact.startEpochMs == 12_000)
        #expect(abs(artifact.durationMs - 4000) < 2)
        #expect(try FileManager.default.contentsOfDirectory(atPath: dir.path) == [artifact.url.lastPathComponent])
        await recorder.cancel()
        #expect(FileManager.default.fileExists(atPath: artifact.url.path))
        artifact.removeOwnedFile()
        #expect(!FileManager.default.fileExists(atPath: dir.path))
    }
    @Test func rotationDiscardsPreviousDimensionEpoch() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let recorder = try NativeVideoRecorder(directory: dir, framesPerSecond: 10)
        #expect(try await recorder.append(frame(0)))
        #expect(try await recorder.append(frame(2_000_000_000)))
        #expect(try await recorder.append(frame(3_000_000_000, width: 32)))
        let artifact = try #require(await recorder.finish(anchorNanos: 0, anchorEpochMs: 0))
        #expect(artifact.width == 32)
        #expect(artifact.startEpochMs == 3000)
        #expect(abs(artifact.durationMs - 100) < 2)
        #expect(try FileManager.default.contentsOfDirectory(atPath: dir.path) == [artifact.url.lastPathComponent])
    }
    @Test func cancellationRemovesClosedAndOpenSegments() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let recorder = try NativeVideoRecorder(directory: dir, framesPerSecond: 5)
        #expect(try await recorder.append(frame(0)))
        #expect(try await recorder.append(frame(2_000_000_000)))
        await recorder.cancel(); await recorder.cancel()
        #expect(!FileManager.default.fileExists(atPath: dir.path))
        #expect(try await recorder.append(frame(4_000_000_000)) == false)
        #expect(try await recorder.finish(anchorNanos: 0, anchorEpochMs: 0) == nil)
    }
    @Test func snapshotLeavesRecordingRunningAndFreezeKeepsTheWholeWindow() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let recorder = try NativeVideoRecorder(directory: dir, framesPerSecond: 5, durationNanos: 30_000_000_000)
        for timestamp: UInt64 in [0, 400_000_000, 800_000_000, 1_200_000_000, 1_600_000_000, 2_000_000_000, 2_400_000_000] {
            #expect(try await recorder.append(frame(timestamp)))
        }
        let copy = try #require(await recorder.snapshot(anchorNanos: 0, anchorEpochMs: 10_000, endNanos: 2_500_000_000))
        defer { copy.removeOwnedFile() }
        #expect(copy.startEpochMs == 10_000)
        #expect(abs(copy.durationMs - 2500) < 2)
        #expect(copy.url.deletingLastPathComponent().standardizedFileURL != dir.standardizedFileURL)
        #expect(try await frameTimes(copy.url) == [0, 400, 800, 1200, 1600, 2000, 2400])
        // The ring still owns both closed segments.
        #expect(try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasSuffix(".mp4") }.count == 2)
        for timestamp: UInt64 in [2_700_000_000, 3_100_000_000] {
            #expect(try await recorder.append(frame(timestamp)))
        }
        let frozen = try #require(await recorder.finish(anchorNanos: 0, anchorEpochMs: 10_000, endNanos: 3_300_000_000))
        defer { frozen.removeOwnedFile() }
        #expect(frozen.startEpochMs == 10_000)
        #expect(abs(frozen.durationMs - 3300) < 2)
        // The prior sample holds across the boundary; new pixels keep their
        // real capture time, with no decoded black frame in between.
        #expect(try await frameTimes(frozen.url) == [0, 400, 800, 1200, 1600, 2000, 2400, 2700, 3100])
    }
    @Test func delayedSnapshotTrimsPostErrorFramesButReportRetainsThem() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let recorder = try NativeVideoRecorder(directory: dir, framesPerSecond: 5)
        for timestamp: UInt64 in [0, 200_000_000, 400_000_000, 800_000_000] {
            #expect(try await recorder.append(frame(timestamp)))
        }
        let copy = try #require(await recorder.snapshot(anchorNanos: 0, anchorEpochMs: 0, endNanos: 500_000_000))
        defer { copy.removeOwnedFile() }
        #expect(abs(copy.durationMs - 500) < 2)
        #expect(try await frameTimes(copy.url) == [0, 200, 400])
        let report = try #require(await recorder.finish(anchorNanos: 0, anchorEpochMs: 0, endNanos: 1_000_000_000))
        defer { report.removeOwnedFile() }
        #expect(try await frameTimes(report.url) == [0, 200, 400, 800])
    }

    @Test func freezeRacingASnapshotStillExportsTheWholeWindow() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let recorder = try NativeVideoRecorder(directory: dir, framesPerSecond: 10)
        for timestamp: UInt64 in [0, 100_000_000, 200_000_000] {
            #expect(try await recorder.append(frame(timestamp)))
        }
        async let copy = recorder.snapshot(anchorNanos: 0, anchorEpochMs: 0, endNanos: 300_000_000)
        async let frozen = recorder.finish(anchorNanos: 0, anchorEpochMs: 0, endNanos: 300_000_000)
        let (snapshot, report) = try await (copy, frozen)
        defer { snapshot?.removeOwnedFile(); report?.removeOwnedFile() }
        let whole = try #require(report)
        #expect(abs(whole.durationMs - 300) < 2)
        if let snapshot { #expect(abs(snapshot.durationMs - 300) < 2) }
    }
    @Test func emptySnapshotIsNilAndRecordingContinues() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let recorder = try NativeVideoRecorder(directory: dir, framesPerSecond: 2)
        #expect(try await recorder.snapshot(anchorNanos: 0, anchorEpochMs: 0, endNanos: 1) == nil)
        #expect(try await recorder.append(frame(0)))
        await recorder.cancel()
    }
    @Test(.timeLimit(.minutes(1)))
    func reportFinishesWhileStartedSnapshotExportsItsIndependentCopy() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let exporting = SnapshotTestGate(), releaseExport = SnapshotTestGate()
        let recorder = try NativeVideoRecorder(directory: dir, framesPerSecond: 5,
            snapshotExport: { directory, segments, dimensions, anchor, epoch, cutoff in
                await exporting.release()
                await releaseExport.wait()
                return try await NativeVideoExporter(directory: directory).export(segments: segments,
                    dimensions: dimensions, anchorNanos: anchor, anchorEpochMs: epoch, endNanos: cutoff)
            })
        for timestamp: UInt64 in [0, 400_000_000, 2_000_000_000, 2_400_000_000] {
            #expect(try await recorder.append(frame(timestamp)))
        }
        let snapshot = Task { try await recorder.snapshot(anchorNanos: 0, anchorEpochMs: 10_000, endNanos: 2_500_000_000) }
        await exporting.wait()
        #expect(try await recorder.append(frame(2_700_000_000)))
        let report = try #require(await recorder.finish(anchorNanos: 0, anchorEpochMs: 10_000, endNanos: 3_000_000_000))
        #expect(try await frameTimes(report.url) == [0, 400, 2000, 2400, 2700])
        report.removeOwnedFile()
        #expect(!FileManager.default.fileExists(atPath: dir.path))
        await releaseExport.release()
        let copy = try #require(await snapshot.value)
        #expect(try await frameTimes(copy.url) == [0, 400, 2000, 2400])
        #expect(abs(copy.durationMs - 2500) < 2)
        #expect(copy.startEpochMs == 10_000)
        let copyDirectory = try #require(copy.ownedDirectory)
        copy.removeOwnedFile()
        #expect(!FileManager.default.fileExists(atPath: copyDirectory.path))
    }

    @Test(.timeLimit(.minutes(1)))
    func freezeDuringSuspendedWriterFinishPreservesBothOwnedExports() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let cleanup = SegmentRemovalProbe()
        let finishing = SnapshotTestGate(), releaseFinish = SnapshotTestGate()
        let recorder = try NativeVideoRecorder(directory: dir, framesPerSecond: 5,
            finishSnapshotWriter: { writer, end in
                await finishing.release()
                await releaseFinish.wait()
                return try await writer.finish(endNanos: end)
            }, makeExporter: { NativeVideoExporter(directory: $0, removeSegment: cleanup.remove) })
        for timestamp: UInt64 in [0, 200_000_000, 400_000_000] {
            #expect(try await recorder.append(frame(timestamp)))
        }
        let copy = Task { try await recorder.snapshot(anchorNanos: 0, anchorEpochMs: 0, endNanos: 500_000_000) }
        await finishing.wait()
        let report = Task { try await recorder.finish(anchorNanos: 0, anchorEpochMs: 0, endNanos: 500_000_000) }
        while await recorder.state != .freezing { await Task.yield() }
        await releaseFinish.release()
        let error = try #require(await copy.value)
        let frozen = try #require(await report.value)
        #expect(error.url != frozen.url)
        #expect(cleanup.removals.count == 2) // original closed segment and its independent copy
        #expect(cleanup.removals.values.allSatisfy { $0 == 1 })
        #expect(cleanup.removals.keys.allSatisfy { !FileManager.default.fileExists(atPath: $0.path) })
        #expect(try await frameTimes(error.url) == [0, 200, 400])
        #expect(try await frameTimes(frozen.url) == [0, 200, 400])
        let copyDirectory = try #require(error.ownedDirectory)
        #expect(try FileManager.default.contentsOfDirectory(atPath: dir.path) == [frozen.url.lastPathComponent])
        #expect(try FileManager.default.contentsOfDirectory(atPath: copyDirectory.path) == [error.url.lastPathComponent])
        error.removeOwnedFile()
        #expect(!FileManager.default.fileExists(atPath: copyDirectory.path))
        #expect(FileManager.default.fileExists(atPath: frozen.url.path))
        frozen.removeOwnedFile()
        #expect(!FileManager.default.fileExists(atPath: dir.path))
    }

    @Test(.timeLimit(.minutes(1)))
    func cancelledSnapshotCloseDoesNotBlockAppendAndStopOwnsClosingWriter() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let finishing = SnapshotTestGate(), releaseFinish = SnapshotTestGate()
        let recorder = try NativeVideoRecorder(directory: dir, framesPerSecond: 5,
            finishSnapshotWriter: { writer, end in
                await finishing.release()
                await releaseFinish.wait()
                return try await writer.finish(endNanos: end)
            })
        #expect(try await recorder.append(frame(0)))
        let snapshot = Task { try await recorder.snapshot(anchorNanos: 0, anchorEpochMs: 0, endNanos: 500_000_000) }
        await finishing.wait()
        snapshot.cancel()
        #expect(try await snapshot.value == nil) // returns before the injected close is released
        #expect(try await recorder.append(frame(600_000_000)))
        // No unbounded replacement close tasks; another optional snapshot declines.
        await recorder.cancel()
        #expect(!FileManager.default.fileExists(atPath: dir.path))
        await releaseFinish.release()
        _ = try? await snapshot.value
        #expect(!FileManager.default.fileExists(atPath: dir.path))
    }

    @Test(.timeLimit(.minutes(1)))
    func delayedCancelledCloseRetainsOriginalAcrossLaterRollovers() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let finishing = SnapshotTestGate(), releaseFinish = SnapshotTestGate()
        let recorder = try NativeVideoRecorder(directory: dir, framesPerSecond: 5,
            finishSnapshotWriter: { writer, end in
                await finishing.release(); await releaseFinish.wait()
                return try await writer.finish(endNanos: end)
            })
        #expect(try await recorder.append(frame(0)))
        let snapshot = Task { try await recorder.snapshot(anchorNanos: 0, anchorEpochMs: 0, endNanos: 500_000_000) }
        await finishing.wait(); snapshot.cancel()
        #expect(try await snapshot.value == nil)
        #expect(try await recorder.append(frame(600_000_000)))
        #expect(try await recorder.append(frame(2_600_000_000)))
        #expect(try await recorder.snapshot(anchorNanos: 0, anchorEpochMs: 0, endNanos: 3_000_000_000) == nil)
        await releaseFinish.release()
        let report = try #require(await recorder.finish(anchorNanos: 0, anchorEpochMs: 0, endNanos: 3_000_000_000))
        defer { report.removeOwnedFile() }
        #expect(try await frameTimes(report.url) == [0, 600, 2600])
    }

    @Test(.timeLimit(.minutes(1)))
    func dimensionChangeInvalidatesAnOutstandingSnapshotClose() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let finishing = SnapshotTestGate(), releaseFinish = SnapshotTestGate()
        let recorder = try NativeVideoRecorder(directory: dir, framesPerSecond: 5,
            finishSnapshotWriter: { writer, end in
                await finishing.release(); await releaseFinish.wait()
                return try await writer.finish(endNanos: end)
            })
        #expect(try await recorder.append(frame(0)))
        let snapshot = Task { try await recorder.snapshot(anchorNanos: 0, anchorEpochMs: 0, endNanos: 500_000_000) }
        await finishing.wait()
        #expect(try await recorder.append(frame(600_000_000, width: 32)))
        #expect(try await snapshot.value == nil)
        await releaseFinish.release()
        let report = try #require(await recorder.finish(anchorNanos: 0, anchorEpochMs: 0, endNanos: 1_000_000_000))
        defer { report.removeOwnedFile() }
        #expect(report.width == 32)
        #expect(report.startEpochMs == 600)
        #expect(try await frameTimes(report.url) == [0])
    }

    @Test func firstSnapshotAfterLongFrameGapPreservesHeldFrameAndLaterReport() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let recorder = try NativeVideoRecorder(directory: dir, framesPerSecond: 2, durationNanos: 30_000_000_000)
        #expect(try await recorder.append(frame(0)))
        let copy = try #require(await recorder.snapshot(anchorNanos: 0, anchorEpochMs: 10_000, endNanos: 35_000_000_000))
        defer { copy.removeOwnedFile() }
        #expect(copy.startEpochMs == 15_000)
        #expect(abs(copy.durationMs - 30_000) < 2)
        #expect(try await frameTimes(copy.url) == [0])
        #expect(try await recorder.append(frame(35_500_000_000)))
        let report = try #require(await recorder.finish(anchorNanos: 0, anchorEpochMs: 10_000, endNanos: 36_000_000_000))
        defer { report.removeOwnedFile() }
        #expect(report.startEpochMs == 16_000)
        #expect(abs(report.durationMs - 30_000) < 2)
        #expect(try await frameTimes(report.url) == [0, 29_500])
    }

    private func frameTimes(_ url: URL) async throws -> [Int] {
        let asset = AVURLAsset(url: url)
        let track = try #require(await asset.loadTracks(withMediaType: .video).first)
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track,
            outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        reader.add(output)
        #expect(reader.startReading())
        var times: [Int] = []
        while let sample = output.copyNextSampleBuffer() {
            guard CMSampleBufferGetNumSamples(sample) > 0 else { continue }
            let seconds = CMSampleBufferGetPresentationTimeStamp(sample).seconds
            try #require(seconds.isFinite)
            times.append(Int((seconds * 1000).rounded()))
        }
        #expect(reader.status == .completed)
        return times
    }

}
#endif
