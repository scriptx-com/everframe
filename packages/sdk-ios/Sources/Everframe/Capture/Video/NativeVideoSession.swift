// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import Foundation
import UIKit

/// Ownership of bytes does not grant permission to upload them indefinitely.
/// The caller revalidates after packing/identity awaits, immediately before send.
@MainActor struct NativeVideoClaim {
    let artifact: NativeVideoArtifact?
    let omissionReason: String?
    let validate: @MainActor () -> Bool
    var isValid: Bool { validate() }
}

@MainActor protocol NativeVideoScheduling: AnyObject {
    func start(framesPerSecond: Int, tick: @escaping @MainActor @Sendable () -> Void)
    func stop()
}

@MainActor private final class NativeVideoTimer: NativeVideoScheduling {
    private var task: Task<Void, Never>?
    func start(framesPerSecond: Int, tick: @escaping @MainActor @Sendable () -> Void) {
        stop()
        let interval = UInt64(1_000_000_000 / framesPerSecond)
        task = Task {
            var deadline = DispatchTime.now().uptimeNanoseconds + interval
            while !Task.isCancelled {
                let now = DispatchTime.now().uptimeNanoseconds
                do { try await Task.sleep(nanoseconds: deadline > now ? deadline - now : 1) }
                catch { return }
                guard !Task.isCancelled else { return }
                tick()
                deadline += interval
                let after = DispatchTime.now().uptimeNanoseconds
                // Never issue a burst of catch-up captures after main was busy.
                if deadline <= after { deadline = after + interval }
            }
        }
    }
    func stop() { task?.cancel(); task = nil }
    deinit { task?.cancel() }
}

/// Which replay coverage a session samples against (crash-only sessions spec 2026-10-12).
enum ReplayCoverage: Hashable, Sendable {
    /// A session that can file a report: `samplingRate`.
    case report
    /// A crash-only session before any companion bond: `crashOnlySamplingRate`, 0 when absent.
    case crashOnly
    /// A crash-only session after a companion bond: the higher of the two rates. It also
    /// inherits an admission the crash-only coverage already made, so an upgrade never stops
    /// a recording.
    case upgraded

    /// The rate this coverage samples against.
    func samplingRate(report: Double, crashOnly: Double?) -> Double {
        switch self {
        case .report: return report
        case .crashOnly: return crashOnly ?? 0
        case .upgraded: return max(report, crashOnly ?? 0)
        }
    }
}

/// Policy and reporter ownership around the capture/recording workers. Freeze
/// is synchronous; finalization never blocks mounting or dismissing reporter UI.
@MainActor final class NativeVideoSession {
    private let scheduler: any NativeVideoScheduling
    private let capture: @MainActor (UInt64) async throws -> NativeVideoFrame?
    private let clearCapture: @MainActor () -> Void
    private let makeRecorder: @MainActor (Int, UInt64) throws -> any NativeVideoRecording
    private let now: @MainActor () -> UInt64
    private let epochMs: @MainActor () -> Double
    private let random: @MainActor () -> Double
    /// Error exports have their own deadline; report finalization stays at 5 s.
    static let errorSnapshotDeadlineNanos: UInt64 = 3_000_000_000
    private let snapshotDeadline: @Sendable () async throws -> Void
    /// Told when recording starts or stops, so a synchronous error capture can
    /// decide on a replay without MainActor.
    private let onRecordingChange: @MainActor (Bool) -> Void
    private var settings: NativeVideoSettings?
    private var durationSec = 30
    /// The session's one random draw, taken the first time settings apply. Every
    /// coverage compares this same value. An upgraded session samples at the higher
    /// of the two rates and inherits the crash-only admission, so an upgrade never
    /// stops a recording.
    private var draw: Double?
    /// One decision per coverage, made the first time that coverage applies
    /// settings and kept for the session: a later rate change never flips it.
    private var sampledIn: [ReplayCoverage: Bool] = [:]
    private var coverage = ReplayCoverage.report
    /// Simulator quick capture forces this session to record (`captureHotkey.replay`).
    /// It bypasses the sampling decision but never replaces it: the draw is
    /// still taken at the configured rate and decides again once forcing ends.
    private var forced = false
    private var suspended = false
    private var reporterOpen = false
    private var generation = 0
    /// Only ending replay consent revokes an error's independently owned copy.
    private var consentGeneration = 0
    private var recorder: (any NativeVideoRecording)?
    private var captureTask: Task<Void, Never>?
    private var finalization: NativeVideoFinalization?
    private var anchorNanos: UInt64 = 0
    private var anchorEpochMs: Double = 0
    private(set) var state: ReplayState = .idle {
        didSet {
            let recording = state == .buffering
            if recording != (oldValue == .buffering) { onRecordingChange(recording) }
        }
    }
    private(set) var omissionReason: String?

    convenience init(onRecordingChange: @escaping @MainActor (Bool) -> Void = { _ in }) {
        let capture = NativeVideoCapture()
        self.init(scheduler: NativeVideoTimer(), capture: { time in
            guard !Everframe.shared.report.isPresenting else { return nil }
            guard let window = ScreenshotCapture.activeKeyWindow() else { return nil }
            return try await capture.capture(window: window, timestampNanos: time)
        }, clearCapture: { capture.clear() }, makeRecorder: { fps, duration in
            let directory = try NativeVideoStorage.shared.makeDirectory()
            return try NativeVideoRecorder(directory: directory, framesPerSecond: fps, durationNanos: duration)
        }, onRecordingChange: onRecordingChange)
    }

    init(scheduler: any NativeVideoScheduling,
         capture: @escaping @MainActor (UInt64) async throws -> NativeVideoFrame?,
         clearCapture: @escaping @MainActor () -> Void,
         makeRecorder: @escaping @MainActor (Int, UInt64) throws -> any NativeVideoRecording,
         now: @escaping @MainActor () -> UInt64 = { DispatchTime.now().uptimeNanoseconds },
         epochMs: @escaping @MainActor () -> Double = { Date().timeIntervalSince1970 * 1000 },
         random: @escaping @MainActor () -> Double = { Double.random(in: 0..<1) },
         snapshotDeadline: @escaping @Sendable () async throws -> Void = { try await Task.sleep(nanoseconds: NativeVideoSession.errorSnapshotDeadlineNanos) },
         onRecordingChange: @escaping @MainActor (Bool) -> Void = { _ in }) {
        self.scheduler = scheduler; self.capture = capture; self.clearCapture = clearCapture
        self.makeRecorder = makeRecorder; self.now = now; self.epochMs = epochMs; self.random = random
        self.snapshotDeadline = snapshotDeadline
        self.onRecordingChange = onRecordingChange
    }

    /// `samplingRate` is the rate for `coverage`; it only matters the first time
    /// that coverage applies settings. `forced` admits the session whatever its
    /// draw: a quick-capture debug session on a simulator records regardless of
    /// `samplingRate`.
    func apply(settings: NativeVideoSettings?, durationSec: Int = 30, samplingRate: Double = 1,
               coverage: ReplayCoverage = .report, forced: Bool = false) {
        if settings == nil { consentGeneration += 1 }
        let duration = min(NativeVideoLimits.maxDurationSec, max(1, durationSec))
        self.coverage = coverage
        self.forced = forced
        if settings != nil, sampledIn[coverage] == nil {
            let draw = self.draw ?? random()
            self.draw = draw
            sampledIn[coverage] = (coverage == .upgraded && sampledIn[.crashOnly] == true)
                || (samplingRate.isFinite && draw < max(0, min(1, samplingRate)))
        }
        if self.settings != settings || self.durationSec != duration {
            invalidate()
            self.settings = settings; self.durationSec = duration
        } else if !admitted, recorder != nil {
            // The new coverage does not admit this draw. An upgrade never lands
            // here (it inherits the crash-only admission); kept so no coverage
            // can record past its own decision.
            invalidate()
        }
        startIfEligible()
    }

    func freeze() {
        guard !reporterOpen else { return }
        reporterOpen = true
        scheduler.stop()
        generation += 1
        // Let an append already accepted before freeze settle. Cancelling that
        // task would otherwise cancel the recorder and lose its earlier window.
        captureTask = nil; clearCapture()
        state = .frozen
        guard let recorder else { return }
        self.recorder = nil
        let anchor = anchorNanos, epoch = anchorEpochMs, end = now()
        finalization = NativeVideoFinalization(operation: {
            try await recorder.finish(anchorNanos: anchor, anchorEpochMs: epoch, endNanos: end)
        }, cancelOperation: { await recorder.cancel() })
    }

    func finish() async -> NativeVideoArtifact? {
        guard reporterOpen, let finalization else { return nil }
        let token = generation
        let result = await finalization.take()
        guard token == generation, reporterOpen else {
            result?.removeOwnedFile()
            return nil
        }
        omissionReason = finalization.omissionReason
        // Stay frozen until the reporter actually closes, not merely until the
        // Send handler has consumed the recording while its UI is still mounted.
        return result
    }

    func finishClaim() async -> NativeVideoClaim {
        let token = generation
        let artifact = await finish()
        return NativeVideoClaim(artifact: artifact, omissionReason: omissionReason, validate: { [weak self] in
            guard let self else { return false }
            return self.generation == token && self.reporterOpen
        })
    }

    /// One error's own copy of the current window. Capture keeps running and
    /// the reporter's freeze, finalization and claims are untouched; nothing
    /// here changes `generation`, `recorder` or `reporterOpen`. The claim is
    /// revoked only when replay consent ends. nil while nothing records.
    func snapshotClaim(endNanos: UInt64? = nil) async -> NativeVideoClaim? {
        guard settings != nil, state == .buffering, !reporterOpen, !suspended, let recorder else { return nil }
        let anchor = anchorNanos, epoch = anchorEpochMs, end = endNanos ?? now(), consent = consentGeneration
        guard end >= anchor else { return nil }
        let job = NativeVideoFinalization(operation: {
            try await recorder.snapshot(anchorNanos: anchor, anchorEpochMs: epoch, endNanos: end)
        }, cancelOperation: {}, deadline: snapshotDeadline)
        let artifact = await job.take()
        return NativeVideoClaim(artifact: artifact, omissionReason: artifact == nil ? job.omissionReason : nil,
            validate: { [weak self] in self?.consentGeneration == consent })
    }

    func reporterDidClose() {
        guard reporterOpen else { return }
        reporterOpen = false
        invalidate()
        startIfEligible()
    }

    func setSuspended(_ suspended: Bool) {
        guard self.suspended != suspended else { return }
        self.suspended = suspended
        // Freeze already stopped capture. Runtime suspension must preserve the
        // reporter's finalization and claims; config changes still revoke them.
        guard !reporterOpen else { return }
        if suspended { invalidate() } else { startIfEligible() }
    }

    func stop() { settings = nil; consentGeneration += 1; invalidate() }

    private func startIfEligible() {
        guard let settings, admitted, !suspended, !reporterOpen, recorder == nil else { return }
        do {
            anchorNanos = now(); anchorEpochMs = epochMs()
            recorder = try makeRecorder(settings.framesPerSecond, UInt64(durationSec) * 1_000_000_000)
            state = .buffering; omissionReason = nil
            scheduler.start(framesPerSecond: settings.framesPerSecond) { [weak self] in self?.sample() }
        } catch { state = .idle; omissionReason = "recorder_setup_failed" }
    }

    private func sample() {
        guard state == .buffering, !reporterOpen, captureTask == nil, let recorder else { return }
        let token = generation, timestamp = now()
        captureTask = Task { [weak self] in
            guard let self else { return }
            defer { if token == self.generation { self.captureTask = nil } }
            do {
                guard let frame = try await self.capture(timestamp), token == self.generation,
                      self.state == .buffering, !Task.isCancelled else { return }
                _ = try await recorder.append(frame)
            } catch {
                guard token == self.generation else { return }
                self.invalidate(); self.omissionReason = "capture_failed"
            }
        }
    }

    /// Whether this session may record now: forced, or sampled in for its coverage.
    private var admitted: Bool { forced || sampledIn[coverage] == true }

    private func invalidate() {
        generation += 1
        scheduler.stop(); captureTask?.cancel(); captureTask = nil
        clearCapture()
        finalization?.cancel(); finalization = nil
        if let recorder { Task { await recorder.cancel() } }
        recorder = nil
        state = reporterOpen ? .frozen : .idle
    }

    deinit {
        captureTask?.cancel()
        let recorder = self.recorder
        Task { await recorder?.cancel() }
    }
}
#endif
