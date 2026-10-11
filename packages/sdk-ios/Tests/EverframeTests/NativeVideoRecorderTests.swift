// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import Foundation
import Testing
@testable import EverframeKit

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
}
#endif
