// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Simulator quick capture: a hotkey (double Shift by default) pressed in a
// debug simulator files a report with no UI. The SDK takes the screenshot,
// freezes replay and evidence exactly as the reporter does at open, submits
// with `quickCapture: true` plus the developer's capture token, then shows a
// short toast. Title and description stay empty: the dashboard fills them in.
//
// Inert unless every gate holds: a simulator, a debug build, the local
// `quickCaptureEnabled` and `reporterEnabled` options, the dashboard's
// `captureHotkey` block, an open capture gate, an active app, no reporter on
// screen and no capture already in flight. The `UIWindow.sendEvent` hook reads
// `isArmed` before it builds a single key event, so a disarmed session costs
// one lock read per press event and nothing per touch.
//
// The block's `replay` flag also records session replay while the session is
// armed, whatever the app's `replayEnabled` (`forcesReplay`).
#if canImport(UIKit)
import UIKit

enum QuickCaptureOutcome: Equatable {
    case ignored(reason: String)
    case sent
    case queued
    case failed
}

/// Session configuration, written from `start()`/`kill()` (any thread) and
/// config refreshes, read on the main thread per key press.
private final class QuickCaptureGate: @unchecked Sendable {
    private let lock = NSLock()
    private var localEnabled = false
    private var debug = false
    private var remoteEnabled = false
    private var binding: CaptureHotkeyBinding = .doubleShift
    private var replay = false

    func reset(localEnabled: Bool, debug: Bool) {
        lock.lock(); defer { lock.unlock() }
        self.localEnabled = localEnabled
        self.debug = debug
        remoteEnabled = false
        binding = .doubleShift
        replay = false
    }

    func setRemote(_ remote: CaptureHotkeyConfigWire?) {
        let parsed = CaptureHotkeyBinding.parse(remote?.binding)
        lock.lock(); defer { lock.unlock() }
        remoteEnabled = remote?.enabled == true
        binding = parsed
        replay = remote?.replay == true
    }

    /// The first failing configuration gate (nil when armed), the active binding
    /// and the block's `replay` flag, read together.
    var evaluation: (reason: String?, binding: CaptureHotkeyBinding, replay: Bool) {
        lock.lock(); defer { lock.unlock() }
        if !debug { return ("not_debug", binding, replay) }
        if !localEnabled { return ("disabled", binding, replay) }
        if !remoteEnabled { return ("remote_disabled", binding, replay) }
        return (nil, binding, replay)
    }
}

@MainActor
final class QuickCapture {
    nonisolated static let shared = QuickCapture()

    /// The reporter-open / close / cancel seams, stubbed in tests so a run
    /// never leaves the shared breadcrumb and replay buffers frozen.
    struct Lifecycle {
        var open: @MainActor () -> UUID
        var didClose: @MainActor (UUID) -> Void
        var cancel: @MainActor (UUID) -> Void

        static var live: Lifecycle { Lifecycle(
            open: {
                Everframe.shared.report.markOpened(trigger: .quickCapture)
                return Everframe.shared.__replayFreeze()
            },
            didClose: { Everframe.shared.__replayReporterDidClose(owner: $0) },
            cancel: { Everframe.shared.__replayCancel(owner: $0) }
        ) }
    }

    // MARK: Test seams

    var submit: @MainActor (ReporterSubmission.Inputs) async throws -> ReportResult = {
        try await ReporterSubmission.submit($0)
    }
    /// Passed to `CaptureTokenReader.read`; also names the device in the toast.
    var environment: [String: String] = ProcessInfo.processInfo.environment
    var isSimulator: Bool = QuickCapture.runningOnSimulator
    var isApplicationActive: @MainActor () -> Bool = { UIApplication.shared.applicationState == .active }
    var lifecycle: Lifecycle = .live
    var showToast: @MainActor (String) -> Void = { QuickCaptureToast.show(text: $0) }
    /// The double-Shift window. The key-delivery proof widens it, because
    /// XCTest spaces synthesized key presses seconds apart.
    var doubleShiftWindow: TimeInterval = CaptureHotkeyMatcher.defaultWindow

    // MARK: State

    private let stateLock = NSLock()
    private let gate = QuickCaptureGate()
    private var matcher: CaptureHotkeyMatcher?
    private var presses = CapturePressDeduplicator()
    private var inFlight = false

    nonisolated init() {}

    nonisolated private static var runningOnSimulator: Bool {
        #if targetEnvironment(simulator)
        return true
        #else
        return false
        #endif
    }

    // MARK: Session wiring (any thread)

    /// A new session starts disarmed until its own config names a `captureHotkey` block.
    nonisolated func beginSession(localEnabled: Bool, debug: Bool, ifCurrent: () -> Bool = { true }) {
        stateLock.lock(); defer { stateLock.unlock() }
        guard ifCurrent() else { return }
        gate.reset(localEnabled: localEnabled, debug: debug)
    }

    nonisolated func publish(remote: CaptureHotkeyConfigWire?, ifCurrent: () -> Bool = { true }) {
        stateLock.lock(); defer { stateLock.unlock() }
        guard ifCurrent() else { return }
        gate.setRemote(remote)
    }

    nonisolated func teardown(ifCurrent: () -> Bool = { true }) {
        stateLock.lock(); defer { stateLock.unlock() }
        guard ifCurrent() else { return }
        gate.reset(localEnabled: false, debug: false)
    }

    /// True from the gate check to the toast. Shake-to-report stands down while
    /// it is set. An explicit `report.open()` does not check it: a reporter opened
    /// mid-capture freezes over this capture's evidence, and this capture's own
    /// close then no-ops on the owner mismatch.
    var isCapturing: Bool { inFlight }

    /// The first failing session gate, nil when the session is armed. Ignores `isSimulator`.
    nonisolated var configurationGateReason: String? { gate.evaluation.reason }

    // MARK: Trigger

    /// True when a key press could fire a capture. Cheap: one lock read.
    var isArmed: Bool { isSimulator && gate.evaluation.reason == nil }

    /// True while quick capture is armed with an open kill switch and the
    /// dashboard's `captureHotkey.replay` flag is set. `ReplaySession` then
    /// records replay even when `replayEnabled` is false; this never turns
    /// replay off. Devices and release builds never arm, so it is always false
    /// there. `ReplaySession` reads it at every config apply, right after
    /// publishing that config's block, so a disarm stops a forced recording at
    /// the next apply, and `kill()` tears the replay session down with it.
    var forcesReplay: Bool {
        guard isSimulator, Everframe.captureGate else { return false }
        let evaluation = gate.evaluation
        return evaluation.reason == nil && evaluation.replay
    }

    /// Feeds one key-down. Never blocks: a match starts `capture()` on its own task.
    /// `press` names the physical press; one already fed is dropped (see
    /// `CapturePressDeduplicator`).
    func handle(_ event: CaptureKeyEvent, press: CapturePressID? = nil) {
        guard isSimulator else { return }
        let (reason, binding, _) = gate.evaluation
        guard reason == nil else { matcher = nil; return }
        if let press, !presses.admit(press) { return }
        if matcher?.binding != binding || matcher?.window != doubleShiftWindow {
            matcher = CaptureHotkeyMatcher(binding: binding, window: doubleShiftWindow)
        }
        guard matcher?.feed(event) == true else { return }
        Task { @MainActor in _ = await self.capture() }
    }

    // MARK: Pipeline

    func capture() async -> QuickCaptureOutcome {
        if let reason = ignoreReason() { return .ignored(reason: reason) }
        inFlight = true
        defer { inFlight = false }
        let outcome = await runPipeline()
        let deviceName = environment["SIMULATOR_DEVICE_NAME"] ?? UIDevice.current.name
        if let text = QuickCaptureToast.text(for: outcome, deviceName: deviceName) { showToast(text) }
        return outcome
    }

    private func ignoreReason() -> String? {
        guard isSimulator else { return "not_simulator" }
        if let reason = gate.evaluation.reason { return reason }
        // The kill switch: closed before `start()` and after `kill()`.
        guard Everframe.captureGate else { return "kill_switch" }
        guard isApplicationActive() else { return "inactive" }
        // The same flag `ShakeToReportTrigger` hands `ShakeToReportGate.tryBegin(presenting:)`.
        guard !Everframe.shared.report.isPresenting else { return "reporter_presenting" }
        guard !inFlight else { return "in_flight" }
        // The reporter freezes before it sets `isPresenting`, and the companion
        // never sets it: a held owner means another capture's frozen evidence,
        // which this capture must not freeze over or consume.
        guard !Everframe.shared.__replayHasReporterOwner else { return "capture_frozen" }
        return nil
    }

    /// `EFReporterPresenter.openAndAwait` minus the UI: screenshot first, then
    /// the reporter-open boundary and freeze, then submit and release.
    private func runPipeline() async -> QuickCaptureOutcome {
        guard let shot = ScreenshotCapture.captureKeyWindow() else { return .failed }
        let owner = lifecycle.open()
        let capturedSession = Everframe.shared.captureSessionSnapshot()
        // Consume-once host payload, as the reporter drains it at open.
        let hostExtra = await Everframe.shared.__consumePendingAttachments()
        let inputs = ReporterSubmission.Inputs(
            captureResult: shot,
            shots: [ReporterSubmission.Inputs.Shot(image: shot.image, annotated: false)],
            title: "",
            description: "",
            includeLogs: true,
            includeNetwork: true,
            includeMetadata: true,
            extraOverrides: [:],
            hostExtra: hostExtra?.isEmpty == true ? nil : hostExtra,
            capturedSession: capturedSession,
            quickCapture: true,
            // Read fresh per capture. SECURITY: never log.
            captureToken: CaptureTokenReader.read(environment: environment)
        )
        do {
            switch try await submit(inputs) {
            case .submitted:
                lifecycle.didClose(owner)
                return .sent
            case .queued:
                lifecycle.didClose(owner)
                return .queued
            case .cancelled:
                lifecycle.cancel(owner)
                return .failed
            }
        } catch {
            lifecycle.cancel(owner)
            return .failed
        }
    }
}
#endif
