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
    private var settings: NativeVideoSettings?
    private var durationSec = 30
    private var sampledIn: Bool?
    private var suspended = false
    private var reporterOpen = false
    private var generation = 0
    private var recorder: (any NativeVideoRecording)?
    private var captureTask: Task<Void, Never>?
    private var finalization: NativeVideoFinalization?
    private var anchorNanos: UInt64 = 0
    private var anchorEpochMs: Double = 0
    private(set) var state: ReplayState = .idle
    private(set) var omissionReason: String?

    convenience init() {
        let capture = NativeVideoCapture()
        self.init(scheduler: NativeVideoTimer(), capture: { time in
            guard !Everframe.shared.report.isPresenting else { return nil }
            guard let window = ScreenshotCapture.activeKeyWindow() else { return nil }
            return try await capture.capture(window: window, timestampNanos: time)
        }, clearCapture: { capture.clear() }, makeRecorder: { fps, duration in
            let directory = try NativeVideoStorage.shared.makeDirectory()
            return try NativeVideoRecorder(directory: directory, framesPerSecond: fps, durationNanos: duration)
        })
    }

    init(scheduler: any NativeVideoScheduling,
         capture: @escaping @MainActor (UInt64) async throws -> NativeVideoFrame?,
         clearCapture: @escaping @MainActor () -> Void,
         makeRecorder: @escaping @MainActor (Int, UInt64) throws -> any NativeVideoRecording,
         now: @escaping @MainActor () -> UInt64 = { DispatchTime.now().uptimeNanoseconds },
         epochMs: @escaping @MainActor () -> Double = { Date().timeIntervalSince1970 * 1000 },
         random: @escaping @MainActor () -> Double = { Double.random(in: 0..<1) }) {
        self.scheduler = scheduler; self.capture = capture; self.clearCapture = clearCapture
        self.makeRecorder = makeRecorder; self.now = now; self.epochMs = epochMs; self.random = random
    }

    func apply(settings: NativeVideoSettings?, durationSec: Int = 30, samplingRate: Double = 1) {
        let duration = min(30, max(1, durationSec))
        if settings != nil, sampledIn == nil {
            sampledIn = samplingRate.isFinite && random() < max(0, min(1, samplingRate))
        }
        if self.settings != settings || self.durationSec != duration {
            invalidate()
            self.settings = settings; self.durationSec = duration
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

    func stop() { settings = nil; invalidate() }

    private func startIfEligible() {
        guard let settings, sampledIn == true, !suspended, !reporterOpen, recorder == nil else { return }
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
