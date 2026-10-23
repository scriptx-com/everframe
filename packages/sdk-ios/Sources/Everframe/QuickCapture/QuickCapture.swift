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
//
// A host that renders its own pixels (Flutter, which starts the SDK with
// `capture.screenshot = false` and masks in Dart) installs an evidence provider
// through `Everframe.__setQuickCaptureEvidenceProvider`. With a provider the
// capture ships the host's masked image and replay and never takes the native
// screenshot. Without one, a session whose `capture.screenshot` is false is
// ignored (`screenshot_disabled`): it never uploads an unmasked native screenshot.
#if canImport(UIKit)
import UIKit

/// Host-rendered evidence for one quick capture: an already masked screenshot
/// and, optionally, the host's masked replay timeline (the same bytes the
/// reporter takes as `hostReplayVTree`). SDK seam for host plugins; see
/// `Everframe.__setQuickCaptureEvidenceProvider`.
public struct QuickCaptureHostEvidence: Sendable {
    public let image: UIImage
    public let hostReplayVTree: Data?

    public init(image: UIImage, hostReplayVTree: Data?) {
        self.image = image
        self.hostReplayVTree = hostReplayVTree
    }
}

/// Supplies host evidence at capture time. nil means the host could not produce
/// safe evidence, and the capture fails.
typealias QuickCaptureEvidenceProvider = @MainActor () async -> QuickCaptureHostEvidence?

/// Resumes the evidence wait exactly once: with the provider's answer, or with
/// nil when the timeout fires first.
@MainActor
private final class QuickCaptureEvidenceWait {
    private var continuation: CheckedContinuation<QuickCaptureHostEvidence?, Never>?
    var timer: Task<Void, Never>?
    var work: Task<Void, Never>?

    init(_ continuation: CheckedContinuation<QuickCaptureHostEvidence?, Never>) {
        self.continuation = continuation
    }

    func finish(_ evidence: QuickCaptureHostEvidence?) {
        guard let continuation else { return }
        self.continuation = nil
        timer?.cancel()
        work?.cancel()
        continuation.resume(returning: evidence)
    }
}

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
    private var screenshot = true

    func reset(localEnabled: Bool, debug: Bool, screenshot: Bool = true) {
        lock.lock(); defer { lock.unlock() }
        self.localEnabled = localEnabled
        self.debug = debug
        self.screenshot = screenshot
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

    /// The session's `capture.screenshot`.
    var screenshotEnabled: Bool {
        lock.lock(); defer { lock.unlock() }
        return screenshot
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
    /// The native screenshot. Never called while a host evidence provider is installed.
    var screenshotter: @MainActor () -> ScreenshotCapture.Result? = { ScreenshotCapture.captureKeyWindow() }
    /// How long a host evidence provider may take before the capture fails.
    var evidenceTimeout: TimeInterval = 5
    /// Replaces the task `handle` and the Darwin notification start on a trigger.
    var triggerOverride: (@MainActor () -> Void)?
    /// The double-Shift window. The key-delivery proof widens it, because
    /// XCTest spaces synthesized key presses seconds apart.
    var doubleShiftWindow: TimeInterval = CaptureHotkeyMatcher.defaultWindow

    // MARK: State

    private let stateLock = NSLock()
    private let gate = QuickCaptureGate()
    private var matcher: CaptureHotkeyMatcher?
    private var presses = CapturePressDeduplicator()
    private var inFlight = false
    /// Guarded by `stateLock`. Written from any thread, called on the main actor.
    nonisolated(unsafe) private var evidenceProvider: QuickCaptureEvidenceProvider?

    nonisolated static let darwinCaptureNotification = "com.everframe.capture"
    nonisolated(unsafe) private var darwinObserverInstalled = false

    nonisolated init() {}

    deinit {
        #if targetEnvironment(simulator)
        CFNotificationCenterRemoveEveryObserver(
            CFNotificationCenterGetDarwinNotifyCenter(), Unmanaged.passUnretained(self).toOpaque())
        #endif
    }

    nonisolated private static var runningOnSimulator: Bool {
        #if targetEnvironment(simulator)
        return true
        #else
        return false
        #endif
    }

    // MARK: Session wiring (any thread)

    /// A new session starts disarmed until its own config names a `captureHotkey` block.
    /// `screenshot` is the session's `capture.screenshot`.
    nonisolated func beginSession(
        localEnabled: Bool, debug: Bool, screenshot: Bool = true, ifCurrent: () -> Bool = { true }
    ) {
        stateLock.lock(); defer { stateLock.unlock() }
        guard ifCurrent() else { return }
        gate.reset(localEnabled: localEnabled, debug: debug, screenshot: screenshot)
        installDarwinObserver()
    }

    /// Listens for `xcrun simctl spawn <udid> notifyutil -p com.everframe.capture`.
    /// Installed once, kept for the process lifetime; callers hold `stateLock`.
    nonisolated private func installDarwinObserver() {
        #if targetEnvironment(simulator)
        guard !darwinObserverInstalled else { return }
        darwinObserverInstalled = true
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            Unmanaged.passUnretained(self).toOpaque(),
            { _, observer, _, _, _ in
                guard let observer else { return }
                let capture = Unmanaged<QuickCapture>.fromOpaque(observer).takeUnretainedValue()
                Task { @MainActor in capture.darwinNotificationReceived() }
            },
            Self.darwinCaptureNotification as CFString,
            nil,
            .deliverImmediately
        )
        #endif
    }

    func darwinNotificationReceived() {
        guard isArmed else { return }
        startCapture()
    }

    private func startCapture() {
        if let triggerOverride { triggerOverride(); return }
        Task { @MainActor in _ = await self.capture() }
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
        evidenceProvider = nil
    }

    /// Installs (or with nil, removes) the host evidence provider. `teardown`
    /// (from `kill()`) clears it; `beginSession` keeps it.
    nonisolated func setEvidenceProvider(_ provider: QuickCaptureEvidenceProvider?) {
        stateLock.lock(); defer { stateLock.unlock() }
        evidenceProvider = provider
    }

    nonisolated var hasEvidenceProvider: Bool { currentEvidenceProvider() != nil }

    /// The session's `capture.screenshot`.
    nonisolated var sessionScreenshotEnabled: Bool { gate.screenshotEnabled }

    nonisolated private func currentEvidenceProvider() -> QuickCaptureEvidenceProvider? {
        stateLock.lock(); defer { stateLock.unlock() }
        return evidenceProvider
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
        startCapture()
    }

    // MARK: Pipeline

    /// The provider's answer, or nil after `evidenceTimeout`. Returns at the
    /// timeout even when the provider never does; the provider's task is
    /// cancelled and its late answer dropped.
    private func awaitEvidence(_ provider: @escaping QuickCaptureEvidenceProvider) async -> QuickCaptureHostEvidence? {
        let timeout = UInt64(max(0, evidenceTimeout) * 1_000_000_000)
        return await withCheckedContinuation { continuation in
            let wait = QuickCaptureEvidenceWait(continuation)
            wait.work = Task { @MainActor in
                let evidence = await provider()
                wait.finish(evidence)
            }
            wait.timer = Task { @MainActor in
                try? await Task.sleep(nanoseconds: timeout)
                wait.finish(nil)
            }
        }
    }

    func capture() async -> QuickCaptureOutcome {
        // Read once: the gate and the pipeline must agree on the provider.
        let provider = currentEvidenceProvider()
        if let reason = ignoreReason(hasProvider: provider != nil) { return .ignored(reason: reason) }
        inFlight = true
        defer { inFlight = false }
        let outcome = await runPipeline(provider: provider)
        let deviceName = environment["SIMULATOR_DEVICE_NAME"] ?? UIDevice.current.name
        if let text = QuickCaptureToast.text(for: outcome, deviceName: deviceName) { showToast(text) }
        return outcome
    }

    private func ignoreReason(hasProvider: Bool) -> String? {
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
        // The host masks its own pixels (Flutter) and installed no provider: the
        // native screenshot would be unmasked, so there is nothing safe to send.
        guard hasProvider || gate.screenshotEnabled else { return "screenshot_disabled" }
        return nil
    }

    /// `EFReporterPresenter.openAndAwait` minus the UI: screenshot first, then
    /// the reporter-open boundary and freeze, then submit and release.
    private func runPipeline(provider: QuickCaptureEvidenceProvider?) async -> QuickCaptureOutcome {
        let shot: ScreenshotCapture.Result
        let hostReplayVTree: Data?
        if let provider {
            // The host's masked evidence replaces the native screenshot entirely;
            // a nil answer, or none within the timeout, fails without a fallback.
            let epoch = Everframe.shared.currentStartEpoch
            guard let evidence = await awaitEvidence(provider),
                  evidence.image.size.width > 0, evidence.image.size.height > 0 else { return .failed }
            // The host rendered asynchronously. A kill() in that window means
            // nothing may freeze or ship; a kill() then start() means the image
            // belongs to the previous session; a reporter that opened (or froze)
            // meanwhile owns the evidence this capture would freeze over; and an
            // app that left the foreground is no longer what the host rendered.
            guard Everframe.captureGate, Everframe.shared.currentStartEpoch == epoch,
                  isApplicationActive(), !Everframe.shared.report.isPresenting,
                  !Everframe.shared.__replayHasReporterOwner else { return .failed }
            let image = evidence.image
            shot = ScreenshotCapture.Result(
                image: image,
                widthPoints: image.size.width,
                heightPoints: image.size.height,
                scale: image.scale,
                pngData: image.pngData() ?? Data())
            // As `EFReporterPresenter.openWithMaskedPng`: host evidence owns
            // replay, and an empty value keeps the native video fallback off.
            hostReplayVTree = evidence.hostReplayVTree ?? Data()
        } else {
            guard let native = screenshotter() else { return .failed }
            shot = native
            hostReplayVTree = nil
        }
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
            hostReplayVTree: hostReplayVTree,
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
