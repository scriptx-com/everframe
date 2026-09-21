// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import Foundation
import Testing
@testable import TraceItXKit

@MainActor private final class VideoTestScheduler: NativeVideoScheduling {
    var fps: Int?
    var tick: (@MainActor @Sendable () -> Void)?
    func start(framesPerSecond: Int, tick: @escaping @MainActor @Sendable () -> Void) {
        fps = framesPerSecond; self.tick = tick
    }
    func stop() { fps = nil; tick = nil }
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
}
#endif
