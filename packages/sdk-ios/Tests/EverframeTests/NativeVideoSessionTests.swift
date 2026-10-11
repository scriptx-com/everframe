// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import Foundation
import Testing
@testable import EverframeKit

@MainActor private final class VideoTestScheduler: NativeVideoScheduling {
    var fps: Int?
    var tick: (@MainActor @Sendable () -> Void)?
    func start(framesPerSecond: Int, tick: @escaping @MainActor @Sendable () -> Void) {
        fps = framesPerSecond; self.tick = tick
    }
    func stop() { fps = nil; tick = nil }
}

/// A recorder whose snapshot never finishes unless cancelled.
private actor StalledSnapshotRecorder: NativeVideoRecording {
    func append(_ frame: NativeVideoFrame) async throws -> Bool { true }
    func finish(anchorNanos: UInt64, anchorEpochMs: Double, endNanos: UInt64?) async throws -> NativeVideoArtifact? { nil }
    func snapshot(anchorNanos: UInt64, anchorEpochMs: Double, endNanos: UInt64) async throws -> NativeVideoArtifact? {
        try await Task.sleep(nanoseconds: 60_000_000_000)
        return nil
    }
    func cancel() async {}
}

private actor LateSnapshotRecorder: NativeVideoRecording {
    let started = SnapshotTestGate(), release = SnapshotTestGate()
    let artifact: NativeVideoArtifact
    private(set) var cancelled = false
    init(artifact: NativeVideoArtifact) { self.artifact = artifact }
    func append(_ frame: NativeVideoFrame) async throws -> Bool { !cancelled }
    func finish(anchorNanos: UInt64, anchorEpochMs: Double, endNanos: UInt64?) async throws -> NativeVideoArtifact? { nil }
    func snapshot(anchorNanos: UInt64, anchorEpochMs: Double, endNanos: UInt64) async throws -> NativeVideoArtifact? {
        await started.release()
        await release.wait()
        return artifact
    }
    func cancel() async { cancelled = true }
}

@MainActor @Suite(.serialized) struct NativeVideoSessionTests {
    @Test func suspensionBeforeClaimPreservesFrozenMovie() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let (session, scheduler) = try await frozenRecording(directory: directory)
        defer { session.stop() }
        session.setSuspended(true)
        let claim = await session.finishClaim()
        let artifact = try #require(claim.artifact)
        defer { artifact.removeOwnedFile() }
        #expect(claim.isValid)
        #expect(try Data(contentsOf: artifact.url).count > 0)
        #expect(session.state == .frozen)
        #expect(scheduler.fps == nil)
        session.setSuspended(false)
        #expect(claim.isValid)
        #expect(scheduler.fps == nil)
    }

    @Test func suspensionAfterClaimPreservesMovieAndClosingWaitsForResume() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let (session, scheduler) = try await frozenRecording(directory: directory)
        defer { session.stop() }
        let claim = await session.finishClaim()
        let artifact = try #require(claim.artifact)
        defer { artifact.removeOwnedFile() }
        session.setSuspended(true)
        #expect(claim.isValid)
        #expect(try Data(contentsOf: artifact.url).count > 0)
        #expect(session.state == .frozen)
        #expect(scheduler.fps == nil)
        session.reporterDidClose()
        #expect(!claim.isValid)
        #expect(session.state == .idle)
        #expect(scheduler.fps == nil)
        session.setSuspended(false)
        #expect(session.state == .buffering)
        #expect(scheduler.fps == 5)
    }

    @Test(arguments: [false, true])
    func configRevocationWhileSuspendedDiscardsFrozenReplay(claimed: Bool) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let (session, scheduler) = try await frozenRecording(directory: directory)
        defer { session.stop() }
        let claim = claimed ? await session.finishClaim() : nil
        if let claim { #expect(claim.artifact != nil); #expect(claim.isValid) }
        defer { claim?.artifact?.removeOwnedFile() }
        session.setSuspended(true)
        session.apply(settings: nil)
        if let claim { #expect(!claim.isValid) }
        #expect(await session.finish() == nil)
        session.setSuspended(false)
        session.reporterDidClose()
        #expect(session.state == .idle)
        #expect(scheduler.fps == nil)
    }

    private func frozenRecording(directory: URL) async throws -> (NativeVideoSession, VideoTestScheduler) {
        let scheduler = VideoTestScheduler()
        var recorder: NativeVideoRecorder?
        var now: UInt64 = 0
        let session = NativeVideoSession(scheduler: scheduler, capture: { _ in nil }, clearCapture: {},
            makeRecorder: { fps, duration in
                let result = try NativeVideoRecorder(directory: directory.appendingPathComponent(UUID().uuidString),
                    framesPerSecond: fps, durationNanos: duration)
                recorder = result
                return result
            }, now: { now })
        session.apply(settings: try settings(5))
        let activeRecorder = try #require(recorder)
        let frame = NativeVideoFrame(width: 64, height: 64, bytesPerRow: 256,
            bgraBytes: Data(repeating: 255, count: 64 * 64 * 4), timestampNanos: 0)
        #expect(try await activeRecorder.append(frame))
        now = 200_000_000
        session.freeze()
        return (session, scheduler)
    }

    @Test(arguments: [(30, 30), (60, 60), (90, 60)])
    func recorderKeepsTheConfiguredReplayWindowUpToSixtySeconds(requested: Int, kept: Int) throws {
        let scheduler = VideoTestScheduler()
        var durations: [UInt64] = []
        let session = NativeVideoSession(scheduler: scheduler, capture: { _ in nil }, clearCapture: {},
            makeRecorder: { _, duration in
                durations.append(duration)
                throw CocoaError(.fileWriteUnknown)
            })
        defer { session.stop() }
        session.apply(settings: try settings(5), durationSec: requested)
        #expect(durations == [UInt64(kept) * 1_000_000_000])
    }

    @Test func transferredClaimRemainsRevocableAndCarriesOmissionReason() async throws {
        let scheduler = VideoTestScheduler()
        let session = NativeVideoSession(scheduler: scheduler, capture: { _ in nil }, clearCapture: {},
            makeRecorder: { _, _ in throw CocoaError(.fileWriteUnknown) })
        session.apply(settings: try settings(5))
        session.freeze()
        let claim = await session.finishClaim()
        #expect(claim.isValid)
        #expect(claim.omissionReason == "recorder_setup_failed")
        session.apply(settings: nil)
        #expect(!claim.isValid)
        session.apply(settings: try settings(5))
        #expect(!claim.isValid) // Re-enabling must not resurrect a transferred claim.
    }
    private func settings(_ fps: Int) throws -> NativeVideoSettings {
        try JSONDecoder().decode(NativeVideoSettings.self, from: Data("{\"framesPerSecond\":\(fps)}".utf8))
    }
    @Test func offDoesNotAllocateRecorderAndConfigSelectsCadence() throws {
        let scheduler = VideoTestScheduler()
        var allocations = 0
        let session = NativeVideoSession(scheduler: scheduler, capture: { _ in nil }, clearCapture: {},
            makeRecorder: { _, _ in allocations += 1; throw CocoaError(.fileWriteUnknown) })
        session.apply(settings: nil)
        #expect(allocations == 0); #expect(scheduler.fps == nil)
        #expect(session.state == .idle)
        session.apply(settings: try settings(10))
        #expect(allocations == 1)
        #expect(session.state == .idle) // allocation failure never starts a timer
        #expect(session.omissionReason == "recorder_setup_failed")
    }
    @Test func freezeAndConfigRefreshNeverRecordReporterUI() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let scheduler = VideoTestScheduler()
        let session = NativeVideoSession(scheduler: scheduler, capture: { _ in nil }, clearCapture: {},
            // Match production's directory-per-recorder ownership: cancellation
            // of the old recorder must not remove the new recorder's directory.
            makeRecorder: { fps, duration in try NativeVideoRecorder(directory: directory.appendingPathComponent(UUID().uuidString), framesPerSecond: fps, durationNanos: duration) })
        session.apply(settings: try settings(5))
        #expect(scheduler.fps == 5)
        session.freeze()
        #expect(session.state == .frozen); #expect(scheduler.fps == nil)
        session.apply(settings: try settings(10))
        #expect(scheduler.fps == nil)
        session.reporterDidClose()
        #expect(scheduler.fps == 10)
        session.stop()
    }
    @Test func failedRefreshRevokesFrozenRecordingAndBackgroundStaysPaused() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let scheduler = VideoTestScheduler()
        let session = NativeVideoSession(scheduler: scheduler, capture: { _ in nil }, clearCapture: {},
            makeRecorder: { fps, duration in try NativeVideoRecorder(directory: directory.appendingPathComponent(UUID().uuidString), framesPerSecond: fps, durationNanos: duration) })
        session.apply(settings: try settings(5)); session.freeze()
        session.apply(settings: nil)
        #expect(await session.finish() == nil)
        session.reporterDidClose()
        #expect(scheduler.fps == nil)
        session.setSuspended(true)
        session.apply(settings: try settings(10))
        #expect(scheduler.fps == nil)
        session.setSuspended(false)
        #expect(scheduler.fps == 10)
        session.stop()
    }
    @Test func sampledOutSessionDoesNotRedrawOnRefresh() {
        let scheduler = VideoTestScheduler()
        var draws = 0
        var allocations = 0
        let session = NativeVideoSession(scheduler: scheduler, capture: { _ in nil }, clearCapture: {},
            makeRecorder: { _, _ in allocations += 1; throw CocoaError(.fileWriteUnknown) },
            random: { draws += 1; return 0.9 })
        session.apply(settings: NativeVideoSettings(), samplingRate: 0.5)
        session.apply(settings: NativeVideoSettings(), samplingRate: 0.5)
        #expect(draws == 1); #expect(allocations == 0); #expect(scheduler.fps == nil)
    }
    @Test func snapshotClaimKeepsRecordingAndOnlyConsentRevokesIt() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let scheduler = VideoTestScheduler()
        var recorder: NativeVideoRecorder?
        var now: UInt64 = 0
        let session = NativeVideoSession(scheduler: scheduler, capture: { _ in nil }, clearCapture: {},
            makeRecorder: { fps, duration in
                let result = try NativeVideoRecorder(directory: directory.appendingPathComponent(UUID().uuidString),
                    framesPerSecond: fps, durationNanos: duration)
                recorder = result
                return result
            }, now: { now })
        defer { session.stop() }
        session.apply(settings: try settings(5))
        let active = try #require(recorder)
        for timestamp: UInt64 in [0, 200_000_000] {
            #expect(try await active.append(NativeVideoFrame(width: 64, height: 64, bytesPerRow: 256,
                bgraBytes: Data(repeating: 255, count: 64 * 64 * 4), timestampNanos: timestamp)))
        }
        now = 400_000_000
        let claim = try #require(await session.snapshotClaim())
        let artifact = try #require(claim.artifact)
        defer { artifact.removeOwnedFile() }
        #expect(abs(artifact.durationMs - 400) < 2)
        #expect(claim.isValid)
        #expect(session.state == .buffering)
        #expect(scheduler.fps == 5)
        session.freeze()
        #expect(claim.isValid) // a later bug report does not revoke an error's copy
        let report = await session.finishClaim()
        defer { report.artifact?.removeOwnedFile() }
        #expect(abs((report.artifact?.durationMs ?? 0) - 400) < 2) // the freeze still has the whole window
        session.apply(settings: nil)
        #expect(!claim.isValid)
    }
    @Test(arguments: [false, true])
    func snapshotTimeoutOrCancellationNeverCancelsRecorderAndRemovesLateArtifact(cancel: Bool) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("late.mp4")
        try Data([1, 2, 3]).write(to: url)
        let recorder = LateSnapshotRecorder(artifact: .init(url: url, byteCount: 3,
            startEpochMs: 0, durationMs: 200, width: 64, height: 64, ownedDirectory: directory))
        let deadline = SnapshotTestGate()
        let scheduler = VideoTestScheduler()
        let session = NativeVideoSession(scheduler: scheduler, capture: { _ in nil }, clearCapture: {},
            makeRecorder: { _, _ in recorder }, snapshotDeadline: { await deadline.wait() })
        defer { session.stop() }
        session.apply(settings: try settings(2))
        let snapshot = Task { await session.snapshotClaim() }
        await recorder.started.wait()
        if cancel { snapshot.cancel() } else { await deadline.release() }
        let claim = try #require(await snapshot.value)
        #expect(claim.artifact == nil)
        #expect(claim.omissionReason == (cancel ? "finalization_cancelled" : "finalization_timeout"))
        #expect(await recorder.cancelled == false)
        #expect(session.state == .buffering)
        #expect(scheduler.fps == 2)
        await recorder.release.release()
        await deadline.release()
        let limit = DispatchTime.now().uptimeNanoseconds + 2_000_000_000
        while FileManager.default.fileExists(atPath: directory.path), DispatchTime.now().uptimeNanoseconds < limit {
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        #expect(!FileManager.default.fileExists(atPath: directory.path))
        #expect(await recorder.cancelled == false)
    }

    @Test func errorSnapshotsGiveUpAfterThreeSeconds() {
        #expect(NativeVideoSession.errorSnapshotDeadlineNanos == 3_000_000_000)
    }
    @Test func snapshotPastItsDeadlineIsOmittedAndCaptureContinues() async throws {
        let scheduler = VideoTestScheduler()
        let session = NativeVideoSession(scheduler: scheduler, capture: { _ in nil }, clearCapture: {},
            makeRecorder: { _, _ in StalledSnapshotRecorder() }, snapshotDeadline: {})
        defer { session.stop() }
        session.apply(settings: try settings(2))
        let claim = try #require(await session.snapshotClaim())
        #expect(claim.artifact == nil)
        #expect(claim.omissionReason == "finalization_timeout")
        #expect(session.state == .buffering)
        #expect(scheduler.fps == 2)
    }
    @Test func noSnapshotWhileTheReporterOwnsTheBufferOrCaptureIsPaused() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let scheduler = VideoTestScheduler()
        let session = NativeVideoSession(scheduler: scheduler, capture: { _ in nil }, clearCapture: {},
            makeRecorder: { fps, duration in try NativeVideoRecorder(directory: directory.appendingPathComponent(UUID().uuidString), framesPerSecond: fps, durationNanos: duration) })
        defer { session.stop() }
        session.apply(settings: try settings(5))
        session.setSuspended(true)
        #expect(await session.snapshotClaim() == nil)
        session.setSuspended(false)
        session.freeze()
        #expect(await session.snapshotClaim() == nil)
        session.reporterDidClose()
        let claim = try #require(await session.snapshotClaim())
        #expect(claim.artifact == nil) // nothing recorded yet
        #expect(claim.omissionReason == "empty_recording")
    }

}
#endif
