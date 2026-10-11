// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Replays on handled errors (spec 2026-10-11). A qualifying error is queued at
// once, durably, with a short hold. Its replay snapshot is taken and packed off
// the main thread, then the held entry is swapped for one that carries the
// replay or records why it has none. Crashes, Apple diagnostics, recovered
// stalls and inferred terminations never take this path.
import Foundation
import EverframeProtocol

enum ErrorReplayPolicy {
    /// Error replays per SDK session (one `start`).
    static let maxPerSession = 2
    /// Replay byte limit for errors.
    static let maxReplayBytes = 8_000_000
    /// How long a queued error waits for its swap: the 3 s export deadline
    /// (`NativeVideoSession.errorSnapshotDeadlineNanos`) plus the main-thread
    /// hop, packing and the swap. A swap after the hold lapses is refused.
    static let holdSeconds: TimeInterval = 5
}

/// Whether this session's recorder can serve an error snapshot, and how many
/// replays it has left. Lock-only, so a synchronous capture on any thread can
/// decide without MainActor. The recorder publishes false while frozen for a
/// bug report, paused or stopped. Never nested with another lock.
final class ErrorReplayGate: @unchecked Sendable {
    static let shared = ErrorReplayGate()
    private let lock = NSLock()
    private var epoch: Int?
    private var recording = false
    private var used = 0

    func publish(recording: Bool, epoch: Int) {
        lock.lock(); defer { lock.unlock() }
        // Start epochs only increase: a torn-down predecessor never wins.
        if let current = self.epoch, epoch < current { return }
        if self.epoch != epoch { self.epoch = epoch; used = 0 }
        self.recording = recording
    }

    /// Takes one replay. `release` returns it when none was attached after all.
    func reserve(epoch: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard self.epoch == epoch, recording, used < ErrorReplayPolicy.maxPerSession else { return false }
        used += 1
        return true
    }

    func release(epoch: Int) {
        lock.lock(); defer { lock.unlock() }
        guard self.epoch == epoch, used > 0 else { return }
        used -= 1
    }

    func __resetForTesting() {
        lock.lock(); defer { lock.unlock() }
        epoch = nil; recording = false; used = 0
    }
}

/// What a held error receives: one packed replay, or why it has none.
enum ErrorReplayOutcome: Sendable {
    /// `reference` is one encoded `EverframeAttachment`; `part` carries its bytes.
    case attached(reference: Data, part: OutboxEntry.AttachmentRef, byteCount: Int)
    case omitted(String)
}

typealias ErrorReplayProvider = @Sendable (_ startEpoch: Int) async -> ErrorReplayOutcome

/// Edits to an error envelope built at capture time.
enum ErrorReplayEnvelope {
    /// Adds the one replay reference an error envelope may carry.
    static func attaching(_ reference: Data, to envelope: Data) -> Data? {
        guard var root = (try? JSONSerialization.jsonObject(with: envelope)) as? [String: Any],
              let existing = root["attachments"] as? [Any], existing.isEmpty,
              let ref = (try? JSONSerialization.jsonObject(with: reference)) as? [String: Any]
        else { return nil }
        root["attachments"] = [ref]
        clearOmission(in: &root)
        return encode(root)
    }

    /// Records why the replay is missing after the existing reason, joined
    /// with ";" as Android joins its replay budget reason.
    static func flagging(_ reason: String, in envelope: Data) -> Data? {
        guard var root = (try? JSONSerialization.jsonObject(with: envelope)) as? [String: Any] else { return nil }
        clearOmission(in: &root)
        var control = root["captureControl"] as? [String: Any] ?? [:]
        control["degradedReason"] = (control["degradedReason"] as? String).map { "\($0);\(reason)" } ?? reason
        root["captureControl"] = control
        return encode(root)
    }

    /// Replace the pending reason, retaining the envelope's other capture diagnostics.
    private static func clearOmission(in root: inout [String: Any]) {
        guard var control = root["captureControl"] as? [String: Any],
              let reason = control["degradedReason"] as? String else { return }
        let replayReasons: Set<String> = ["replay_unavailable", "replay_revoked", "empty_recording",
            "finalization_timeout", "finalization_failed", "finalization_cancelled",
            "replay_omitted", "replay_report_budget", "replay_part_limit"]
        let remaining = reason.split(separator: ";").map(String.init).filter { !replayReasons.contains($0) }
        control["degradedReason"] = remaining.isEmpty ? nil : remaining.joined(separator: ";")
        root["captureControl"] = control
    }

    private static func encode(_ root: [String: Any]) -> Data? {
        guard let bytes = try? JSONSerialization.data(withJSONObject: root, options: [.sortedKeys]),
              bytes.count <= EnvelopeBuilder.SIZE_CAP_BYTES else { return nil }
        return bytes
    }
}

/// Finishes one held error before its own drain: waits for the replay, then
/// swaps the queued entry for its final form.
enum ErrorReplayCompletion {
    static func run(entry: OutboxEntry, startEpoch: Int, stillOwned: @Sendable () -> Bool,
                    outbox: JSONLOutbox, provider: ErrorReplayProvider) async {
        let outcome = await provider(startEpoch)
        var kept = false
        defer { if !kept { ErrorReplayGate.shared.release(epoch: startEpoch) } }
        // The capture's own rule: no write begins after kill() or a new start().
        // The held entry stays as queued and is sent once its hold lapses.
        guard stillOwned() else { return }
        var replacement: OutboxEntry?
        var carriesReplay = false
        switch outcome {
        case let .attached(reference, part, byteCount):
            if byteCount > ErrorReplayPolicy.maxReplayBytes {
                replacement = flagged(entry, "replay_omitted")
            } else if let bytes = ErrorReplayEnvelope.attaching(reference, to: entry.envelopeBytes) {
                if let reason = NativeVideoReportBudget.omissionReason(envelopeBytes: bytes.count,
                                                                        attachmentBytes: [byteCount]) {
                    replacement = flagged(entry, reason)
                } else {
                    replacement = entry.releasingHold(envelopeBytes: bytes, attachmentRefs: [part])
                    carriesReplay = true
                }
            } else {
                replacement = flagged(entry, "replay_omitted")
            }
        case let .omitted(reason):
            replacement = flagged(entry, reason)
        }
        guard let replacement else { return }
        do {
            kept = try outbox.replaceHeld(replacement, now: Date()) && carriesReplay
        } catch {
            // Too large for the queue: keep the error and record the omission.
            if carriesReplay, let fallback = flagged(entry, "replay_omitted") {
                _ = try? outbox.replaceHeld(fallback, now: Date())
            }
        }
    }

    private static func flagged(_ entry: OutboxEntry, _ reason: String) -> OutboxEntry? {
        ErrorReplayEnvelope.flagging(reason, in: entry.envelopeBytes)
            .map { entry.releasingHold(envelopeBytes: $0, attachmentRefs: []) }
    }
}

#if canImport(UIKit)
/// A handled error's snapshot as the replay session hands it over.
enum ErrorReplaySnapshot: Sendable {
    case movie(NativeVideoArtifact)
    case omitted(String)
}
#endif

enum ErrorReplayLive {
    #if canImport(UIKit)
    /// Snapshot through the session (MainActor bookkeeping only), then read,
    /// hash and encode the movie away from the main thread.
    static let provider: ErrorReplayProvider = { startEpoch in
        switch await Everframe.shared.__replayErrorSnapshot(epoch: startEpoch) {
        case let .omitted(reason):
            return .omitted(reason)
        case let .movie(artifact):
            // Removes the movie file whatever it returns.
            guard let part = await ReporterSubmission.buildReplayAttachment(
                    artifact: artifact, byteBudget: ErrorReplayPolicy.maxReplayBytes),
                  let reference = try? EnvelopeBuilder.makeJSONEncoder().encode(part.envelope)
            else { return .omitted("replay_omitted") }
            return .attached(reference: reference, part: OutboxEntry.AttachmentRef(
                name: part.multipart.name, filename: part.multipart.filename,
                contentType: part.multipart.contentType,
                dataBase64: part.multipart.data.base64EncodedString(),
                sha256Hex: part.multipart.sha256Hex), byteCount: part.multipart.data.count)
        }
    }
    #else
    static let provider: ErrorReplayProvider = { _ in .omitted("replay_unavailable") }
    #endif
}
