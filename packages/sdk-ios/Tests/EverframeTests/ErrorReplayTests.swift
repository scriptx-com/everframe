// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import CryptoKit
import EverframeProtocol
import Foundation
import XCTest
#if canImport(UIKit)
@preconcurrency import AVFoundation
#endif
@testable import EverframeKit

private final class ScheduledWork: @unchecked Sendable {
    private let lock = NSLock()
    private var work: [@Sendable () async -> Void] = []
    private var drainCount = 0
    func addWork(_ item: @escaping @Sendable () async -> Void) { lock.lock(); work.append(item); lock.unlock() }
    func addDrain() { lock.lock(); drainCount += 1; lock.unlock() }
    var drains: Int { lock.lock(); defer { lock.unlock() }; return drainCount }
    func takeWork() -> [@Sendable () async -> Void] {
        lock.lock(); defer { work = []; lock.unlock() }
        return work
    }
}

private final class EpochProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var seen: [Int] = []
    func record(_ epoch: Int) { lock.lock(); seen.append(epoch); lock.unlock() }
    var epochs: [Int] { lock.lock(); defer { lock.unlock() }; return seen }
}

final class ErrorReplayTests: XCTestCase {
    private var tempDir: URL!
    private var scheduled: ScheduledWork!

    private static let movie = Data("fake-mp4-bytes".utf8)

    override func setUpWithError() throws {
        try super.setUpWithError()
        Everframe.shared.kill()
        let scheduled = ScheduledWork()
        self.scheduled = scheduled
        CrashReporter.__scheduleDrainForTesting = { _ in scheduled.addDrain() }
        CrashReporter.__scheduleErrorReplayForTesting = { work in scheduled.addWork(work) }
        CrashReporter.__errorReplayProviderForTesting = nil
        CrashReporter.__closeNativeCaptureForTesting = {}
        ErrorReplayGate.shared.__resetForTesting()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("everframe-error-replay-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        Everframe.__setConfigForTesting(EverframeConfig(sdkKey: "ios-error-replay-test"))
        Everframe.captureGate = true
    }

    override func tearDownWithError() throws {
        CrashReporter.__scheduleDrainForTesting = nil
        CrashReporter.__scheduleErrorReplayForTesting = nil
        CrashReporter.__errorReplayProviderForTesting = nil
        CrashReporter.__closeNativeCaptureForTesting = nil
        ErrorReplayGate.shared.__resetForTesting()
        Everframe.shared.kill()
        Everframe.__setConfigForTesting(nil)
        try? FileManager.default.removeItem(at: tempDir)
        try super.tearDownWithError()
    }

    private var epoch: Int { Everframe.shared.currentStartEpoch }

    private func outbox() -> JSONLOutbox {
        JSONLOutbox(testFileURL: tempDir.appendingPathComponent("outbox.jsonl"))
    }

    private func envelope(_ entry: OutboxEntry) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: entry.envelopeBytes) as? [String: Any])
    }

    private func heldEntry(until: Date?) -> OutboxEntry {
        OutboxEntry(reportId: UUID(), createdAt: Date(), envelopeBytes: Data(#"{"attachments":[]}"#.utf8),
            idempotencyKey: "held", attachmentRefs: [], sdkKey: "ios-error-replay-test",
            endpoint: "https://ingest.example.invalid/api/ingest", heldUntil: until)
    }

    private static func sha(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func attachedOutcome() -> ErrorReplayOutcome {
        let hash = sha(movie)
        let reference = try! EnvelopeBuilder.makeJSONEncoder().encode(EverframeAttachment(
            byteLength: Double(movie.count), contentType: "video/mp4", durationMS: 2000,
            format: .everframeVideoV1, height: 640, kind: .sessionReplay, partName: "replay",
            replayStartEpochMS: 1_000, sha256: hash, width: 360))
        return .attached(reference: reference, part: .init(name: "replay", filename: "replay.mp4",
            contentType: "video/mp4", dataBase64: movie.base64EncodedString(), sha256Hex: hash),
            byteCount: movie.count)
    }

    func testErrorsAreHeldForFiveSeconds() {
        XCTAssertEqual(ErrorReplayPolicy.holdSeconds, 5)
    }

    func testGateAllowsTwoReplaysPerSessionAndOnlyWhileRecording() {
        let gate = ErrorReplayGate()
        XCTAssertFalse(gate.reserve(epoch: 1))
        gate.publish(recording: true, epoch: 1)
        XCTAssertTrue(gate.reserve(epoch: 1))
        XCTAssertTrue(gate.reserve(epoch: 1))
        XCTAssertFalse(gate.reserve(epoch: 1))
        gate.release(epoch: 1)
        XCTAssertTrue(gate.reserve(epoch: 1))
        gate.release(epoch: 1)
        gate.publish(recording: false, epoch: 1) // a bug report froze the buffer, or capture paused
        XCTAssertFalse(gate.reserve(epoch: 1))
        gate.publish(recording: true, epoch: 2) // a new start() gets a fresh budget
        XCTAssertFalse(gate.reserve(epoch: 1))
        XCTAssertTrue(gate.reserve(epoch: 2))
        XCTAssertTrue(gate.reserve(epoch: 2))
        gate.release(epoch: 2)
        gate.publish(recording: false, epoch: 1) // the torn-down predecessor cannot close it
        XCTAssertTrue(gate.reserve(epoch: 2))
    }

    func testEnvelopeGainsOneReplayReferenceOrItsOmissionReason() throws {
        let baseControl: [String: Any] = ["degradedReason": "crash-capture", "included": [String](), "excluded": [String]()]
        let object: [String: Any] = ["attachments": [Any](), "captureControl": baseControl]
        let base = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        guard case let .attached(reference, _, _) = Self.attachedOutcome() else { return XCTFail("fixture") }
        let attached = try XCTUnwrap(ErrorReplayEnvelope.attaching(reference, to: base))
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: attached) as? [String: Any])
        let refs = try XCTUnwrap(root["attachments"] as? [[String: Any]])
        XCTAssertEqual(refs.count, 1)
        XCTAssertEqual(refs.first?["kind"] as? String, "session-replay")
        XCTAssertEqual(refs.first?["format"] as? String, "everframe-video-v1")
        XCTAssertEqual(refs.first?["partName"] as? String, "replay")
        XCTAssertNil(ErrorReplayEnvelope.attaching(reference, to: attached)) // never a second attachment
        let flagged = try XCTUnwrap(ErrorReplayEnvelope.flagging("finalization_timeout", in: base))
        let control = try XCTUnwrap((JSONSerialization.jsonObject(with: flagged) as? [String: Any])?["captureControl"] as? [String: Any])
        XCTAssertEqual(control["degradedReason"] as? String, "crash-capture;finalization_timeout")
    }

    func testHeldEntryCanOnlyBeSwappedWhileItsHoldIsLive() throws {
        let box = outbox()
        let live = heldEntry(until: Date().addingTimeInterval(ErrorReplayPolicy.holdSeconds))
        let lapsed = heldEntry(until: Date().addingTimeInterval(-1))
        try box.enqueue(live)
        try box.enqueue(lapsed)
        let swapped = live.releasingHold(envelopeBytes: Data(#"{"final":true}"#.utf8), attachmentRefs: [])
        XCTAssertTrue(try box.replaceHeld(swapped, now: Date()))
        XCTAssertFalse(try box.replaceHeld(lapsed.releasingHold(envelopeBytes: Data("{}".utf8), attachmentRefs: []), now: Date()))
        XCTAssertFalse(try box.replaceHeld(swapped, now: Date())) // a swapped entry is no longer held
        // The caller's clock may have been read before waiting for the storage
        // queue; it must not reopen a hold that expired before replacement.
        XCTAssertFalse(try box.replaceHeld(lapsed.releasingHold(envelopeBytes: Data("{}".utf8), attachmentRefs: []),
            now: try XCTUnwrap(lapsed.heldUntil).addingTimeInterval(-1)))
        let stored = try box.hydrate()
        XCTAssertEqual(stored.map(\.reportId), [lapsed.reportId, live.reportId])
        XCTAssertNil(stored[1].heldUntil)
        XCTAssertEqual(stored[1].envelopeBytes, Data(#"{"final":true}"#.utf8))
        XCTAssertEqual(stored[1].idempotencyKey, Self.sha(stored[1].envelopeBytes))
        // Entries that were never held encode exactly as before.
        let plain = OutboxEntry(reportId: UUID(), createdAt: Date(), envelopeBytes: Data("{}".utf8),
            idempotencyKey: "plain", attachmentRefs: [], sdkKey: "k", endpoint: "https://e.invalid")
        XCTAssertFalse(String(decoding: try JSONEncoder().encode(plain), as: UTF8.self).contains("heldUntil"))
    }

    func testDrainLeavesAHeldErrorToItsCaptureAndSendsOneWhoseHoldLapsed() async throws {
        RecordingURLProtocol.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RecordingURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel(); RecordingURLProtocol.reset() }
        let box = outbox()
        let held = heldEntry(until: Date().addingTimeInterval(ErrorReplayPolicy.holdSeconds))
        let lapsed = heldEntry(until: Date().addingTimeInterval(-1))
        try box.enqueue(held)
        try box.enqueue(lapsed)
        let submitter = ReportSubmitter(config: EverframeConfig(sdkKey: "ios-error-replay-test"), outbox: box, session: session)
        await submitter.drainOutbox(identityHolder: IdentityTokenHolder(), currentReplayConfig: { .off },
            epochAtInitiation: 0, currentEpoch: { 0 })
        XCTAssertEqual(RecordingURLProtocol.recorded.count, 1)
        XCTAssertEqual(try box.hydrate().map(\.reportId), [held.reportId])
    }

    func testCaptureClaimCannotReserveOrOwnAResumedRecording() throws {
        let gate = ErrorReplayGate()
        gate.publish(recording: true, epoch: 1)
        let capture = try XCTUnwrap(gate.capture(epoch: 1))
        gate.publish(recording: false, epoch: 1)
        XCTAssertFalse(gate.reserve(capture: capture))
        gate.publish(recording: true, epoch: 1)
        XCTAssertFalse(gate.owns(capture))
        XCTAssertFalse(gate.reserve(capture: capture))
        let resumed = try XCTUnwrap(gate.capture(epoch: 1))
        XCTAssertTrue(gate.reserve(capture: resumed))
        XCTAssertTrue(gate.reserve(capture: resumed)) // rejected old claim consumed no quota
    }

    func testQualifyingHandledErrorWaitsForItsReplayThenDrainsWithIt() async throws {
        ErrorReplayGate.shared.publish(recording: true, epoch: epoch)
        let requested = EpochProbe()
        CrashReporter.__errorReplayProviderForTesting = { startEpoch in
            requested.record(startEpoch.startEpoch)
            return ErrorReplayTests.attachedOutcome()
        }
        let box = outbox()
        XCTAssertTrue(CrashReporter.captureHandledError(NSError(domain: "ReplayFailure", code: 1), outbox: box))
        let queued = try XCTUnwrap(try box.hydrate().first)
        let hold = try XCTUnwrap(queued.heldUntil).timeIntervalSinceNow
        XCTAssertGreaterThan(hold, 0)
        XCTAssertLessThanOrEqual(hold, ErrorReplayPolicy.holdSeconds)
        XCTAssertTrue(queued.attachmentRefs.isEmpty)
        XCTAssertEqual((try envelope(queued)["captureControl"] as? [String: Any])?["degradedReason"] as? String, "crash-capture;replay_unavailable")
        XCTAssertEqual(scheduled.drains, 0) // its own drain waits for the replay
        for work in scheduled.takeWork() { await work() }
        XCTAssertEqual(requested.epochs, [epoch])
        XCTAssertEqual(scheduled.drains, 1)
        let final = try XCTUnwrap(try box.hydrate().first)
        XCTAssertEqual(final.reportId, queued.reportId)
        XCTAssertNil(final.heldUntil)
        XCTAssertEqual(final.attachmentRefs.map(\.name), ["replay"])
        XCTAssertEqual(Data(base64Encoded: final.attachmentRefs[0].dataBase64), Self.movie)
        XCTAssertEqual(try envelope(final)["source"] as? String, "error")
        let refs = try XCTUnwrap(try envelope(final)["attachments"] as? [[String: Any]])
        XCTAssertEqual(refs.map { $0["kind"] as? String }, ["session-replay"])
        XCTAssertEqual(final.idempotencyKey, Self.sha(final.envelopeBytes))
        XCTAssertEqual((try envelope(final)["captureControl"] as? [String: Any])?["degradedReason"] as? String, "crash-capture")
    }

    #if canImport(UIKit)
    func testCaptureBoundaryCutoffSurvivesDelayedReplayEntryAndKeepsLaterBlueFrameForReport() async throws {
        let dir = tempDir.appendingPathComponent("video")
        let recorder = try NativeVideoRecorder(directory: dir, framesPerSecond: 2)
        let anchor = DispatchTime.now().uptimeNanoseconds - 600_000_000
        let first = try await recorder.append(Self.coloredFrame(anchor, blue: false)); XCTAssertTrue(first)
        let second = try await recorder.append(Self.coloredFrame(anchor + 200_000_000, blue: false)); XCTAssertTrue(second)
        ErrorReplayGate.shared.publish(recording: true, epoch: epoch)
        let beforeCapture = DispatchTime.now().uptimeNanoseconds
        CrashReporter.__errorReplayProviderForTesting = { capture in
            do {
                XCTAssertGreaterThanOrEqual(capture.cutoffNanos, beforeCapture)
                let snapshot = try await recorder.snapshot(anchorNanos: anchor, anchorEpochMs: 0, endNanos: capture.cutoffNanos)
                let movie = try XCTUnwrap(snapshot)
                defer { movie.removeOwnedFile() }
                XCTAssertEqual(movie.durationMs, Double(capture.cutoffNanos - anchor) / 1_000_000, accuracy: 2)
                XCTAssertEqual(try Self.colors(movie.url), [false, false])
                let built = await ReporterSubmission.buildReplayAttachment(artifact: movie, byteBudget: ErrorReplayPolicy.maxReplayBytes)
                let part = try XCTUnwrap(built)
                let reference = try EnvelopeBuilder.makeJSONEncoder().encode(part.envelope)
                return .attached(reference: reference, part: .init(name: part.multipart.name,
                    filename: part.multipart.filename, contentType: part.multipart.contentType,
                    dataBase64: part.multipart.data.base64EncodedString(), sha256Hex: part.multipart.sha256Hex),
                    byteCount: part.multipart.data.count)
            } catch { XCTFail("Delayed real replay failed: \(error)"); return .omitted("replay_unavailable") }
        }
        let box = outbox()
        XCTAssertTrue(CrashReporter.captureHandledError(NSError(domain: "DelayedReplay", code: 1), outbox: box))
        // Work has been captured but deliberately not entered; later pixels reach the real writer.
        let later = DispatchTime.now().uptimeNanoseconds + 400_000_000
        let postError = try await recorder.append(Self.coloredFrame(later, blue: true)); XCTAssertTrue(postError)
        let work = scheduled.takeWork()
        XCTAssertEqual(work.count, 1)
        for task in work { await task() }
        XCTAssertEqual(try box.hydrate().first?.attachmentRefs.count, 1)
        let frozen = try await recorder.finish(anchorNanos: anchor, anchorEpochMs: 0, endNanos: later + 500_000_000)
        let report = try XCTUnwrap(frozen)
        defer { report.removeOwnedFile() }
        XCTAssertEqual(try Self.colors(report.url), [false, false, true])
    }

    func testSecondCaptureDuringIdleExtendsTheRealMovieToItsOwnCutoff() async throws {
        try await repeatedCapture(postErrorFrameBeforeEntry: false)
    }

    func testSecondCaptureExcludesReplacementPixelsAppendedBeforeReplayEntry() async throws {
        try await repeatedCapture(postErrorFrameBeforeEntry: true)
    }

    private func repeatedCapture(postErrorFrameBeforeEntry: Bool) async throws {
        let dir = tempDir.appendingPathComponent("repeated-video")
        let recorder = try NativeVideoRecorder(directory: dir, framesPerSecond: 2)
        let anchor = DispatchTime.now().uptimeNanoseconds - 600_000_000
        let first = try await recorder.append(Self.coloredFrame(anchor, blue: false)); XCTAssertTrue(first)
        let second = try await recorder.append(Self.coloredFrame(anchor + 200_000_000, blue: false)); XCTAssertTrue(second)
        ErrorReplayGate.shared.publish(recording: true, epoch: epoch)
        CrashReporter.__errorReplayProviderForTesting = { capture in
            do {
                let snapshot = try await recorder.snapshot(anchorNanos: anchor, anchorEpochMs: 0, endNanos: capture.cutoffNanos)
                let movie = try XCTUnwrap(snapshot)
                defer { movie.removeOwnedFile() }
                let actualDuration = AVURLAsset(url: movie.url).duration.seconds * 1000
                let expectedDuration = Double(capture.cutoffNanos - anchor) / 1_000_000
                XCTAssertEqual(actualDuration, expectedDuration, accuracy: 2)
                XCTAssertEqual(movie.durationMs, actualDuration, accuracy: 0.001)
                XCTAssertEqual(try Self.sampleEndMs(movie.url), expectedDuration, accuracy: 2)
                XCTAssertEqual(try Self.colors(movie.url), [false, false])
                print("Repeated capture media: expected=\(expectedDuration)ms actual=\(actualDuration)ms colors=\(try Self.colors(movie.url))")
                let built = await ReporterSubmission.buildReplayAttachment(artifact: movie, byteBudget: ErrorReplayPolicy.maxReplayBytes)
                let part = try XCTUnwrap(built)
                let reference = try EnvelopeBuilder.makeJSONEncoder().encode(part.envelope)
                return .attached(reference: reference, part: .init(name: part.multipart.name,
                    filename: part.multipart.filename, contentType: part.multipart.contentType,
                    dataBase64: part.multipart.data.base64EncodedString(), sha256Hex: part.multipart.sha256Hex),
                    byteCount: part.multipart.data.count)
            } catch { XCTFail("Repeated real replay failed: \(error)"); return .omitted("replay_unavailable") }
        }
        let box = outbox()
        XCTAssertTrue(CrashReporter.captureHandledError(NSError(domain: "RepeatedReplay", code: 1), outbox: box))
        let firstWork = scheduled.takeWork(); XCTAssertEqual(firstWork.count, 1)
        for task in firstWork { await task() }
        let firstEntry = try XCTUnwrap(try box.hydrate().first)
        XCTAssertEqual(firstEntry.attachmentRefs.count, 1)
        let firstBytes = firstEntry.attachmentRefs.first?.dataBase64
        // The first snapshot has fully completed before the second SDK call.
        XCTAssertTrue(CrashReporter.captureHandledError(NSError(domain: "RepeatedReplay", code: 2), outbox: box))
        let later = DispatchTime.now().uptimeNanoseconds + 400_000_000
        if postErrorFrameBeforeEntry {
            let accepted = try await recorder.append(Self.coloredFrame(later, blue: true)); XCTAssertTrue(accepted)
        }
        let secondWork = scheduled.takeWork(); XCTAssertEqual(secondWork.count, 1)
        for task in secondWork { await task() }
        let entries = try box.hydrate()
        XCTAssertEqual(entries.count, 2)
        XCTAssertTrue(entries.allSatisfy { $0.attachmentRefs.count == 1 && $0.heldUntil == nil })
        XCTAssertEqual(entries.first?.attachmentRefs.first?.dataBase64, firstBytes)
        if !postErrorFrameBeforeEntry {
            let accepted = try await recorder.append(Self.coloredFrame(later, blue: true)); XCTAssertTrue(accepted)
        }
        let frozen = try await recorder.finish(anchorNanos: anchor, anchorEpochMs: 0, endNanos: later + 500_000_000)
        let report = try XCTUnwrap(frozen)
        XCTAssertEqual(try Self.colors(report.url), [false, false, true])
        let reportTimes = try Self.frameTimes(report.url)
        XCTAssertEqual(Array(reportTimes.prefix(2)), [0, 200])
        XCTAssertEqual(Double(try XCTUnwrap(reportTimes.last)), Double(later - anchor) / 1_000_000, accuracy: 2)
        report.removeOwnedFile()
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.path))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: tempDir.path).filter {
            (try? tempDir.appendingPathComponent($0).resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
        }, [])
    }

    func testLongIdleBeforeSecondSDKCaptureRetainsRedWhenBlueArrivesBeforeEntry() async throws {
        try await idleDelayedCapture(rolloverBeforeEntry: false)
    }

    func testLongIdleBeforeSecondSDKCaptureRetainsRedAcrossPostErrorRollover() async throws {
        try await idleDelayedCapture(rolloverBeforeEntry: true)
    }

    private func idleDelayedCapture(rolloverBeforeEntry: Bool) async throws {
        let dir = tempDir.appendingPathComponent("idle-delayed-video")
        let recorder = try NativeVideoRecorder(directory: dir, framesPerSecond: 2)
        let anchor = DispatchTime.now().uptimeNanoseconds - 60_000_000_000
        let accepted = try await recorder.append(Self.coloredFrame(anchor, blue: false)); XCTAssertTrue(accepted)
        // Complete a real first snapshot at a historical capture time, without
        // making the test wait a minute for the acquisition gap that follows.
        let initial = try await recorder.snapshot(anchorNanos: anchor, anchorEpochMs: 0, endNanos: anchor + 200_000_000)
        let first = try XCTUnwrap(initial)
        defer { first.removeOwnedFile() }
        XCTAssertEqual(try Self.colors(first.url), [false])
        ErrorReplayGate.shared.publish(recording: true, epoch: epoch)
        XCTAssertTrue(ErrorReplayGate.shared.reserve(epoch: epoch)) // first completed error used one slot
        let beforeCapture = DispatchTime.now().uptimeNanoseconds
        CrashReporter.__errorReplayProviderForTesting = { capture in
            do {
                XCTAssertGreaterThanOrEqual(capture.cutoffNanos, beforeCapture)
                let result = try await recorder.snapshot(anchorNanos: anchor, anchorEpochMs: 0, endNanos: capture.cutoffNanos)
                let movie = try XCTUnwrap(result, "The prior red frame must survive the later blue segment's insertion")
                defer { movie.removeOwnedFile() }
                let expectedEnd = Double(capture.cutoffNanos - anchor) / 1_000_000
                XCTAssertEqual(movie.startEpochMs, expectedEnd - 30_000, accuracy: 2)
                XCTAssertEqual(AVURLAsset(url: movie.url).duration.seconds * 1000, 30_000, accuracy: 2)
                XCTAssertEqual(movie.startEpochMs + movie.durationMs, expectedEnd, accuracy: 2)
                XCTAssertEqual(try Self.colors(movie.url), [false])
                print("Idle delayed SDK media: cutoff=\(expectedEnd)ms start=\(movie.startEpochMs)ms duration=\(movie.durationMs)ms colors=\(try Self.colors(movie.url))")
                let built = await ReporterSubmission.buildReplayAttachment(artifact: movie,
                    byteBudget: ErrorReplayPolicy.maxReplayBytes)
                let part = try XCTUnwrap(built)
                let reference = try EnvelopeBuilder.makeJSONEncoder().encode(part.envelope)
                return .attached(reference: reference, part: .init(name: part.multipart.name,
                    filename: part.multipart.filename, contentType: part.multipart.contentType,
                    dataBase64: part.multipart.data.base64EncodedString(), sha256Hex: part.multipart.sha256Hex),
                    byteCount: part.multipart.data.count)
            } catch { XCTFail("Idle delayed SDK replay failed: \(error)"); return .omitted("replay_unavailable") }
        }
        let box = outbox()
        XCTAssertTrue(CrashReporter.captureHandledError(NSError(domain: "IdleDelayedReplay", code: 2), outbox: box))
        let blueTime = DispatchTime.now().uptimeNanoseconds + 100_000_000
        let blue = try await recorder.append(Self.coloredFrame(blueTime, blue: true)); XCTAssertTrue(blue)
        let lastBlueTime = blueTime + (rolloverBeforeEntry ? 2_000_000_000 : 0)
        if rolloverBeforeEntry {
            let rollover = try await recorder.append(Self.coloredFrame(lastBlueTime, blue: true)); XCTAssertTrue(rollover)
        }
        let work = scheduled.takeWork(); XCTAssertEqual(work.count, 1)
        for task in work { await task() }
        XCTAssertEqual(try box.hydrate().first?.attachmentRefs.count, 1)
        let frozen = try await recorder.finish(anchorNanos: anchor, anchorEpochMs: 0, endNanos: lastBlueTime + 500_000_000)
        let report = try XCTUnwrap(frozen)
        defer { report.removeOwnedFile() }
        XCTAssertEqual(try Self.colors(report.url), rolloverBeforeEntry ? [false, true, true] : [false, true])
        XCTAssertEqual(report.durationMs, 30_000, accuracy: 2)
        XCTAssertEqual(try Self.frameTimes(report.url), rolloverBeforeEntry ? [0, 27_500, 29_500] : [0, 29_500])
        XCTAssertEqual(try Self.colors(first.url), [false])
        let firstDirectory = try XCTUnwrap(first.ownedDirectory)
        first.removeOwnedFile()
        XCTAssertFalse(FileManager.default.fileExists(atPath: firstDirectory.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: report.url.path))
        report.removeOwnedFile()
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.path))
    }

    func testReplacementBeforePreviousSampleEndKeepsItsRealCaptureTime() async throws {
        let recorder = try NativeVideoRecorder(directory: tempDir.appendingPathComponent("overlap-video"), framesPerSecond: 2)
        let first = try await recorder.append(Self.coloredFrame(0, blue: false)); XCTAssertTrue(first)
        let second = try await recorder.append(Self.coloredFrame(200_000_000, blue: false)); XCTAssertTrue(second)
        let initial = try await recorder.snapshot(anchorNanos: 0, anchorEpochMs: 0, endNanos: 100_000_000)
        let initialMovie = try XCTUnwrap(initial)
        defer { initialMovie.removeOwnedFile() }
        XCTAssertEqual(try Self.colors(initialMovie.url), [false])
        // The original's final sample extends to 700 ms. A valid new capture
        // at 300 ms must supersede that hold without moving or losing pixels.
        let replacement = try await recorder.append(Self.coloredFrame(300_000_000, blue: true)); XCTAssertTrue(replacement)
        let secondSnapshot = try await recorder.snapshot(anchorNanos: 0, anchorEpochMs: 0, endNanos: 250_000_000)
        let secondMovie = try XCTUnwrap(secondSnapshot)
        defer { secondMovie.removeOwnedFile() }
        XCTAssertEqual(AVURLAsset(url: secondMovie.url).duration.seconds * 1000, 250, accuracy: 2)
        XCTAssertEqual(try Self.colors(secondMovie.url), [false, false])
        let frozen = try await recorder.finish(anchorNanos: 0, anchorEpochMs: 0, endNanos: 800_000_000)
        let report = try XCTUnwrap(frozen)
        defer { report.removeOwnedFile() }
        XCTAssertEqual(try Self.colors(report.url), [false, false, true])
        XCTAssertEqual(try Self.frameTimes(report.url), [0, 200, 300])
    }

    func testSingleFrameIdleSnapshotsPreserveTheDecodedEndpoint() async throws {
        let recorder = try NativeVideoRecorder(directory: tempDir.appendingPathComponent("single-frame-video"), framesPerSecond: 2)
        let accepted = try await recorder.append(Self.coloredFrame(0, blue: false)); XCTAssertTrue(accepted)
        for cutoff: UInt64 in [200_000_000, 400_000_000, 1_000_000_000, 2_500_000_000, 10_000_000_000] {
            do {
                let snapshot = try await recorder.snapshot(anchorNanos: 0, anchorEpochMs: 0, endNanos: cutoff)
                let movie = try XCTUnwrap(snapshot)
                defer { movie.removeOwnedFile() }
                XCTAssertEqual(AVURLAsset(url: movie.url).duration.seconds * 1000, Double(cutoff) / 1_000_000, accuracy: 2)
                XCTAssertEqual(try Self.sampleEndMs(movie.url), Double(cutoff) / 1_000_000, accuracy: 2)
                XCTAssertEqual(try Self.colors(movie.url), [false])
            } catch { XCTFail("Single-frame cutoff \(cutoff) failed: \(error)") }
        }
        await recorder.cancel()
    }

    func testWindowBeginningInsideAGOPDecodesTheHeldFrameWithoutBlackLeadIn() async throws {
        let dir = tempDir.appendingPathComponent("gop-window")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let writer = NativeVideoSegmentWriter(directory: dir, dimensions: .init(width: 64, height: 64), framesPerSecond: 5)
        for (time, blue): (UInt64, Bool) in [(0, false), (200_000_000, false), (400_000_000, true), (600_000_000, false)] {
            let accepted = try await writer.append(Self.coloredFrame(time, blue: blue)); XCTAssertTrue(accepted)
        }
        let segment = try await writer.finish(endNanos: 1_000_000_000)
        let finished = try XCTUnwrap(segment)
        let result = try await NativeVideoExporter(directory: dir).export(segments: [finished],
            dimensions: .init(width: 64, height: 64), anchorNanos: 0, anchorEpochMs: 0,
            endNanos: 1_000_000_000, durationNanos: 500_000_000)
        let movie = try XCTUnwrap(result)
        defer { movie.removeOwnedFile() }
        XCTAssertEqual(movie.startEpochMs, 500, accuracy: 2)
        XCTAssertEqual(AVURLAsset(url: movie.url).duration.seconds * 1000, 500, accuracy: 2)
        XCTAssertEqual(try Self.colors(movie.url), [true, false])
        XCTAssertEqual(try Self.frameTimes(movie.url), [0, 100])
    }

    func testIdleSecondSnapshotKeepsTheConfiguredDurationBound() async throws {
        let recorder = try NativeVideoRecorder(directory: tempDir.appendingPathComponent("bounded-video"),
            framesPerSecond: 2, durationNanos: 1_000_000_000)
        let accepted = try await recorder.append(Self.coloredFrame(0, blue: false)); XCTAssertTrue(accepted)
        let initial = try await recorder.snapshot(anchorNanos: 0, anchorEpochMs: 10_000, endNanos: 200_000_000)
        let first = try XCTUnwrap(initial)
        defer { first.removeOwnedFile() }
        let idle = try await recorder.snapshot(anchorNanos: 0, anchorEpochMs: 10_000, endNanos: 2_500_000_000)
        let second = try XCTUnwrap(idle)
        defer { second.removeOwnedFile() }
        XCTAssertEqual(second.startEpochMs, 11_500, accuracy: 2)
        XCTAssertEqual(AVURLAsset(url: second.url).duration.seconds * 1000, 1000, accuracy: 2)
        XCTAssertEqual(try Self.colors(second.url), [false])
        // Acquisition may remain unavailable for much longer than a frame
        // interval. Export only the configured window, however old its pixels.
        let longIdle = try await recorder.snapshot(anchorNanos: 0, anchorEpochMs: 10_000, endNanos: 7_200_000_000_000)
        let last = try XCTUnwrap(longIdle)
        defer { last.removeOwnedFile() }
        XCTAssertEqual(last.startEpochMs, 7_209_000, accuracy: 2)
        XCTAssertEqual(AVURLAsset(url: last.url).duration.seconds * 1000, 1000, accuracy: 2)
        XCTAssertEqual(try Self.colors(last.url), [false])
        await recorder.cancel()
        let revoked = try await recorder.snapshot(anchorNanos: 0, anchorEpochMs: 10_000, endNanos: 7_201_000_000_000)
        XCTAssertNil(revoked)
        XCTAssertEqual(try Self.colors(first.url), [false])
        XCTAssertEqual(try Self.colors(second.url), [false])
    }

    private static func sampleEndMs(_ url: URL) throws -> Double {
        let asset = AVURLAsset(url: url)
        let track = try XCTUnwrap(asset.tracks(withMediaType: .video).first)
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
        reader.add(output); XCTAssertTrue(reader.startReading())
        var end: Double = 0
        while let sample = output.copyNextSampleBuffer() {
            guard CMSampleBufferGetNumSamples(sample) > 0 else { continue }
            let sampleEnd = CMSampleBufferGetPresentationTimeStamp(sample) + CMSampleBufferGetDuration(sample)
            XCTAssertTrue(sampleEnd.seconds.isFinite)
            end = max(end, sampleEnd.seconds * 1000)
        }
        XCTAssertEqual(reader.status, .completed)
        return end
    }

    private static func frameTimes(_ url: URL) throws -> [Int] {
        let asset = AVURLAsset(url: url)
        let track = try XCTUnwrap(asset.tracks(withMediaType: .video).first)
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track,
            outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        reader.add(output); XCTAssertTrue(reader.startReading())
        var times: [Int] = []
        while let sample = output.copyNextSampleBuffer() {
            guard CMSampleBufferGetNumSamples(sample) > 0 else { continue }
            let seconds = CMSampleBufferGetPresentationTimeStamp(sample).seconds
            XCTAssertTrue(seconds.isFinite)
            guard seconds.isFinite else { continue }
            times.append(Int((seconds * 1000).rounded()))
        }
        XCTAssertEqual(reader.status, .completed)
        return times
    }

    private static func coloredFrame(_ time: UInt64, blue: Bool) -> NativeVideoFrame {
        var bytes = Data(repeating: 0, count: 64 * 64 * 4)
        for i in stride(from: 0, to: bytes.count, by: 4) { bytes[i + (blue ? 0 : 2)] = 255; bytes[i + 3] = 255 }
        return .init(width: 64, height: 64, bytesPerRow: 256, bgraBytes: bytes, timestampNanos: time)
    }

    private static func colors(_ url: URL) throws -> [Bool] {
        let asset = AVURLAsset(url: url)
        let track = try XCTUnwrap(asset.tracks(withMediaType: .video).first)
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track,
            outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        reader.add(output); XCTAssertTrue(reader.startReading())
        var blue: [Bool] = []
        while let sample = output.copyNextSampleBuffer() {
            guard let buffer = CMSampleBufferGetImageBuffer(sample) else { continue }
            CVPixelBufferLockBaseAddress(buffer, .readOnly)
            let bytes = try XCTUnwrap(CVPixelBufferGetBaseAddress(buffer)).assumingMemoryBound(to: UInt8.self)
            XCTAssertGreaterThan(max(bytes[0], bytes[2]), 200, "Expected red or blue pixels, never black padding")
            XCTAssertLessThan(bytes[1], 50)
            blue.append(bytes[0] > bytes[2])
            CVPixelBufferUnlockBaseAddress(buffer, .readOnly)
        }
        XCTAssertEqual(reader.status, .completed)
        return blue
    }
    #endif

    func testOnlyTwoErrorsPerSessionWaitAndTheThirdDrainsAtOnce() throws {
        ErrorReplayGate.shared.publish(recording: true, epoch: epoch)
        CrashReporter.__errorReplayProviderForTesting = { _ in ErrorReplayTests.attachedOutcome() }
        let box = outbox()
        for code in 1...3 {
            XCTAssertTrue(CrashReporter.captureHandledError(NSError(domain: "Cap", code: code), outbox: box))
        }
        XCTAssertEqual(try box.hydrate().map { $0.heldUntil != nil }, [true, true, false])
        XCTAssertEqual(scheduled.takeWork().count, 2)
        XCTAssertEqual(scheduled.drains, 1)
    }

    func testOmittedReplayIsRecordedOnTheErrorAndFreesTheSlot() async throws {
        ErrorReplayGate.shared.publish(recording: true, epoch: epoch)
        CrashReporter.__errorReplayProviderForTesting = { _ in .omitted("finalization_timeout") }
        let box = outbox()
        XCTAssertTrue(CrashReporter.captureHandledError(NSError(domain: "Slow", code: 1), outbox: box))
        XCTAssertTrue(CrashReporter.captureHandledError(NSError(domain: "Slow", code: 2), outbox: box))
        for work in scheduled.takeWork() { await work() }
        let entries = try box.hydrate()
        XCTAssertEqual(entries.count, 2)
        for entry in entries {
            XCTAssertNil(entry.heldUntil)
            XCTAssertTrue(entry.attachmentRefs.isEmpty)
            XCTAssertEqual((try envelope(entry)["attachments"] as? [Any])?.count, 0)
            XCTAssertEqual((try envelope(entry)["captureControl"] as? [String: Any])?["degradedReason"] as? String,
                           "crash-capture;finalization_timeout")
        }
        XCTAssertTrue(ErrorReplayGate.shared.reserve(epoch: epoch)) // failed replays do not use the budget
        XCTAssertTrue(ErrorReplayGate.shared.reserve(epoch: epoch))
    }

    func testNoWaitWhileTheReporterOwnsTheBufferOrForFlutterErrors() throws {
        let box = outbox()
        ErrorReplayGate.shared.publish(recording: false, epoch: epoch) // frozen for a bug report
        XCTAssertTrue(CrashReporter.captureHandledError(NSError(domain: "Frozen", code: 1), outbox: box))
        ErrorReplayGate.shared.publish(recording: true, epoch: epoch)
        XCTAssertTrue(CrashReporter.captureHandledError(NSError(domain: "Flutter", code: 1),
            sdkName: "everframe-flutter", outbox: box))
        XCTAssertEqual(try box.hydrate().map(\.heldUntil), [nil, nil])
        XCTAssertTrue(scheduled.takeWork().isEmpty)
        XCTAssertEqual(scheduled.drains, 2)
    }

    func testReactNativeOptsInAndFatalErrorsNeverWait() throws {
        ErrorReplayGate.shared.publish(recording: true, epoch: epoch)
        let box = outbox()
        let nonFatal = #"{"exceptionType":"TypeError","message":"js","framesRaw":["at a (index.bundle:1:1)"],"fatal":false}"#
        let fatal = #"{"exceptionType":"TypeError","message":"js fatal","framesRaw":["at b (index.bundle:2:2)"],"fatal":true}"#
        XCTAssertTrue(CrashReporter.captureFacts(json: nonFatal, sdkName: "everframe-react-native", outbox: box))
        XCTAssertTrue(CrashReporter.captureFacts(json: fatal, sdkName: "everframe-react-native", outbox: box, attachReplay: true))
        XCTAssertTrue(CrashReporter.captureHandledFacts(json: nonFatal, sdkName: "everframe-react-native", outbox: box, attachReplay: true))
        XCTAssertTrue(CrashReporter.captureFacts(json: nonFatal, sdkName: "everframe-react-native", outbox: box, attachReplay: true))
        XCTAssertEqual(try box.hydrate().map { $0.heldUntil != nil }, [false, false, true, true])
        XCTAssertEqual(scheduled.takeWork().count, 2)
    }

    func testKillWhileWaitingLeavesTheQueuedErrorUntouched() async throws {
        ErrorReplayGate.shared.publish(recording: true, epoch: epoch)
        CrashReporter.__errorReplayProviderForTesting = { _ in ErrorReplayTests.attachedOutcome() }
        let box = outbox()
        XCTAssertTrue(CrashReporter.captureHandledError(NSError(domain: "Killed", code: 1), outbox: box))
        let queued = try XCTUnwrap(try box.hydrate().first)
        Everframe.shared.kill()
        for work in scheduled.takeWork() { await work() }
        XCTAssertEqual(try box.hydrate(), [queued])
    }
    func testExpiredReopenedErrorRemainsFlaggedAndLateWorkCannotReplaceIt() async throws {
        ErrorReplayGate.shared.publish(recording: true, epoch: epoch)
        let box = outbox()
        XCTAssertTrue(CrashReporter.captureHandledError(NSError(domain: "Restart", code: 1), outbox: box))
        let queued = try XCTUnwrap(try outbox().hydrate().first)
        XCTAssertEqual((try envelope(queued)["captureControl"] as? [String: Any])?["degradedReason"] as? String,
                       "crash-capture;replay_unavailable")
        let expired = OutboxEntry(reportId: queued.reportId, createdAt: queued.createdAt,
            envelopeBytes: queued.envelopeBytes, idempotencyKey: queued.idempotencyKey,
            attachmentRefs: [], sdkKey: queued.sdkKey, endpoint: queued.endpoint,
            heldUntil: Date().addingTimeInterval(-1))
        try box.enqueue(expired)
        let storedExpired = try outbox().hydrate()
        await ErrorReplayCompletion.run(entry: queued, capture: .init(startEpoch: epoch, cutoffNanos: DispatchTime.now().uptimeNanoseconds, recordingGeneration: 0), stillOwned: { true },
            outbox: outbox(), provider: { _ in Self.attachedOutcome() })
        XCTAssertEqual(try outbox().hydrate(), storedExpired)
        RecordingURLProtocol.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RecordingURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel(); RecordingURLProtocol.reset() }
        let submitter = ReportSubmitter(config: EverframeConfig(sdkKey: "ios-error-replay-test"), outbox: outbox(), session: session)
        await submitter.drainOutbox(identityHolder: IdentityTokenHolder(), currentReplayConfig: { .off },
            epochAtInitiation: epoch, currentEpoch: { self.epoch })
        XCTAssertEqual(RecordingURLProtocol.recorded.count, 1)
        XCTAssertTrue(try outbox().hydrate().isEmpty)
    }

    func testOversizeReplayLeavesDurableErrorWithOneOmissionReason() async throws {
        ErrorReplayGate.shared.publish(recording: true, epoch: epoch)
        CrashReporter.__errorReplayProviderForTesting = { _ in
            guard case let .attached(reference, part, _) = Self.attachedOutcome() else { fatalError() }
            return .attached(reference: reference, part: part, byteCount: 8_000_001)
        }
        let box = outbox()
        XCTAssertTrue(CrashReporter.captureHandledError(NSError(domain: "Large", code: 1), outbox: box))
        let queued = try XCTUnwrap(try box.hydrate().first)
        for work in scheduled.takeWork() { await work() }
        let final = try XCTUnwrap(try box.hydrate().first)
        XCTAssertEqual(final.reportId, queued.reportId)
        XCTAssertNil(final.heldUntil)
        XCTAssertTrue(final.attachmentRefs.isEmpty)
        XCTAssertEqual((try envelope(final)["captureControl"] as? [String: Any])?["degradedReason"] as? String,
                       "crash-capture;replay_omitted")
    }

    func testDrainRevokesReplayForDisabledConsentOrDifferentProjectOrEndpoint() async throws {
        for mode in ["disabled", "project", "endpoint"] {
            RecordingURLProtocol.reset()
            RecordingURLProtocol.responseStatus = 503
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [RecordingURLProtocol.self]
            let session = URLSession(configuration: configuration)
            defer { session.invalidateAndCancel(); RecordingURLProtocol.reset() }
            let box = JSONLOutbox(testFileURL: tempDir.appendingPathComponent(mode))
            guard case let .attached(ref, part, _) = Self.attachedOutcome() else { return XCTFail("fixture") }
            let base = Data(#"{"source":"error","attachments":[],"captureControl":{"degradedReason":"crash-capture"}}"#.utf8)
            let bytes = try XCTUnwrap(ErrorReplayEnvelope.attaching(ref, to: base))
            let endpoint = mode == "endpoint" ? "https://original.example.invalid" : IngestEndpoint.url.absoluteString
            let entry = OutboxEntry(reportId: UUID(), createdAt: Date(), envelopeBytes: bytes,
                idempotencyKey: Self.sha(bytes), attachmentRefs: [part], sdkKey: "original", endpoint: endpoint)
            try box.enqueue(entry)
            let submitter = ReportSubmitter(config: EverframeConfig(sdkKey: mode == "project" ? "other" : "original"), outbox: box, session: session)
            let replay = ReplayConfig(replayEnabled: mode != "disabled", replayDurationSec: 30, samplingRate: 1)
            await submitter.drainOutbox(identityHolder: IdentityTokenHolder(), currentReplayConfig: { replay },
                epochAtInitiation: 0, currentEpoch: { 0 })
            let retained = try XCTUnwrap(try box.hydrate().first)
            XCTAssertEqual(retained.reportId, entry.reportId)
            XCTAssertTrue(retained.attachmentRefs.isEmpty)
            XCTAssertEqual((try envelope(retained)["captureControl"] as? [String: Any])?["degradedReason"] as? String,
                           "crash-capture;replay_revoked")
            XCTAssertEqual(RecordingURLProtocol.recorded.first?.host, URL(string: endpoint)?.host)
            XCTAssertEqual(RecordingURLProtocol.recorded.first?.authorization, "Bearer original")
        }
    }

    func testHoldMetadataCannotPreventOriginalDurableAdmissionAtCapacity() throws {
        let facts = #"{"exceptionType":"Capacity","message":"same","framesRaw":[],"fatal":false,"occurredAt":"2026-10-11T00:00:00Z"}"#
        let baseline = outbox()
        XCTAssertTrue(CrashReporter.captureHandledFacts(json: facts, outbox: baseline))
        let originalSize = try Data(contentsOf: baseline.resolvedFileURL).count
        let tight = JSONLOutbox(fileURL: tempDir.appendingPathComponent("tight"), maxTotalBytes: originalSize + 16,
            keyProvider: { Data(repeating: 7, count: 32) })
        ErrorReplayGate.shared.publish(recording: true, epoch: epoch)
        XCTAssertTrue(CrashReporter.captureHandledFacts(json: facts, outbox: tight, attachReplay: true))
        let stored = try XCTUnwrap(try tight.hydrate().first)
        XCTAssertNil(stored.heldUntil)
        let original = try XCTUnwrap(try baseline.hydrate().first)
        XCTAssertEqual(try envelope(stored)["source"] as? String, "error")
        XCTAssertEqual(try envelope(stored)["captureControl"] as? NSDictionary,
                       try envelope(original)["captureControl"] as? NSDictionary)
        XCTAssertEqual(try envelope(stored)["payload"] as? NSDictionary,
                       try envelope(original)["payload"] as? NSDictionary)
        XCTAssertEqual(stored.idempotencyKey, Self.sha(stored.envelopeBytes))
        XCTAssertTrue(scheduled.takeWork().isEmpty)
        XCTAssertTrue(ErrorReplayGate.shared.reserve(epoch: epoch))
        XCTAssertTrue(ErrorReplayGate.shared.reserve(epoch: epoch))
    }

    func testSuccessfulReplaysKeepTheirSessionBudgetAfterCompletion() async throws {
        ErrorReplayGate.shared.publish(recording: true, epoch: epoch)
        CrashReporter.__errorReplayProviderForTesting = { _ in Self.attachedOutcome() }
        let box = outbox()
        for code in 1...2 {
            XCTAssertTrue(CrashReporter.captureHandledError(NSError(domain: "CompleteCap", code: code), outbox: box))
        }
        for work in scheduled.takeWork() { await work() }
        XCTAssertEqual(try box.hydrate().filter { !$0.attachmentRefs.isEmpty }.count, 2)
        XCTAssertTrue(CrashReporter.captureHandledError(NSError(domain: "CompleteCap", code: 3), outbox: box))
        XCTAssertTrue(scheduled.takeWork().isEmpty)
        XCTAssertEqual(try box.hydrate().filter { $0.heldUntil != nil }.count, 0)
    }

    func testReplacementOverQueueCapacityPreservesErrorAndReleasesReplaySlot() async throws {
        let box = JSONLOutbox(fileURL: tempDir.appendingPathComponent("swap-capacity"), maxTotalBytes: 12_000,
            keyProvider: { Data(repeating: 7, count: 32) })
        ErrorReplayGate.shared.publish(recording: true, epoch: epoch)
        CrashReporter.__errorReplayProviderForTesting = { _ in
            guard case let .attached(reference, _, _) = Self.attachedOutcome() else { fatalError() }
            let data = Data(repeating: 1, count: 15_000)
            return .attached(reference: reference, part: .init(name: "replay", filename: "replay.mp4",
                contentType: "video/mp4", dataBase64: data.base64EncodedString(), sha256Hex: Self.sha(data)), byteCount: data.count)
        }
        XCTAssertTrue(CrashReporter.captureHandledError(NSError(domain: "SwapCapacity", code: 1), outbox: box))
        let queued = try XCTUnwrap(try box.hydrate().first)
        for work in scheduled.takeWork() { await work() }
        let final = try XCTUnwrap(try box.hydrate().first)
        XCTAssertEqual(final.reportId, queued.reportId)
        XCTAssertTrue(final.attachmentRefs.isEmpty)
        XCTAssertNil(final.heldUntil)
        XCTAssertEqual((try envelope(final)["captureControl"] as? [String: Any])?["degradedReason"] as? String,
                       "crash-capture;replay_omitted")
        XCTAssertTrue(ErrorReplayGate.shared.reserve(epoch: epoch))
        XCTAssertTrue(ErrorReplayGate.shared.reserve(epoch: epoch))
    }

}
