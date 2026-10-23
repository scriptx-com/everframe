// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Quick capture: a hotkey (the dashboard's binding, Shift+B by default)
// pressed in a debug simulator, or a shake on a real iPhone or iPad that is
// linked to a teammate or runs a debug build, files a report with no UI. The SDK takes the screenshot,
// freezes replay and evidence exactly as the reporter does at open, shows a
// short `Captured` toast as soon as the frozen capture is handed to the
// submission, then submits with `quickCapture: true` plus the developer's
// capture token. Only an upload that is rejected and not queued shows a
// second toast. Title and description stay empty: the dashboard fills them in.
//
// On a real device (`QuickCaptureHostMode.device`) a linked capture carries the
// device-link token instead of the simulator's CLI token, plus a fresh link
// nonce so the ingest reply can start a takeover (`linkPending`). Its toast
// names the owner ("Captured · Aurimas", "Captured · team device"). A
// `403 device_unlinked` shows "This device was unlinked" and drops the token.
//
// Inert unless every gate holds: a simulator or a real iPhone/iPad, a debug
// build or a linked device, the local
// `quickCaptureEnabled` and `reporterEnabled` options, the dashboard's
// `captureHotkey` block, an open capture gate, an active app, no reporter on
// screen and no capture already in flight. The `UIWindow.sendEvent` hook reads
// `isArmed` before it builds a single key event, so a disarmed session costs
// one lock read per press event and nothing per touch.
//
// A binding that is also ordinary typing (a key alone or with Shift only, such
// as Shift+B) does nothing while an editable text input is first responder, so
// typing a capital B into a field never files a report. Double Shift and
// chords with ⌘, ⌃ or ⌥ fire whatever has focus.
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
/// reporter takes as `hostReplayVTree`). `sdkName` is the host SDK's identity
/// for `sdk.name`, as the host passes it to `openWithMaskedPng`; nil keeps
/// `everframe-ios`. SDK seam for host plugins; see
/// `Everframe.__setQuickCaptureEvidenceProvider`.
public struct QuickCaptureHostEvidence: Sendable {
    public let image: UIImage
    public let hostReplayVTree: Data?
    public let sdkName: String?

    public init(image: UIImage, hostReplayVTree: Data?, sdkName: String? = nil) {
        self.image = image
        self.hostReplayVTree = hostReplayVTree
        self.sdkName = sdkName
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

/// What fired the capture. A shake that cannot capture safely (no host
/// evidence) says so; a hotkey stays silent, as it always has.
enum QuickCaptureTrigger: Equatable, Sendable {
    case hotkey, shake
}

enum QuickCaptureOutcome: Equatable {
    case ignored(reason: String)
    case sent
    case queued
    /// No capture was handed to the submission: the evidence could not be
    /// taken or frozen. No `Captured` toast.
    case failed
    /// The capture was handed off and confirmed, then the submission was
    /// cancelled or threw, so nothing was sent and nothing is queued.
    case rejected
    /// Ingest refused the device-link token (`403 device_unlinked`). Nothing
    /// is stored or queued, and the token is dropped.
    case unlinked
}

/// Session configuration, written from `start()`/`kill()` (any thread) and
/// config refreshes, read on the main thread per key press.
private final class QuickCaptureGate: @unchecked Sendable {
    private let lock = NSLock()
    private var localEnabled = false
    private var debug = false
    private var linked = false
    private var remoteEnabled = false
    private var binding: CaptureHotkeyBinding = .doubleShift
    private var replay = false
    private var screenshot = true

    func reset(localEnabled: Bool, debug: Bool, screenshot: Bool = true) {
        lock.lock(); defer { lock.unlock() }
        self.localEnabled = localEnabled
        self.debug = debug
        self.screenshot = screenshot
        linked = false
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

    /// Whether this real device holds a device link.
    func setLinked(_ value: Bool) {
        lock.lock(); defer { lock.unlock() }
        linked = value
    }

    /// The session's `capture.screenshot`.
    var screenshotEnabled: Bool {
        lock.lock(); defer { lock.unlock() }
        return screenshot
    }

    /// The local options and the dashboard's block, without the debug/linked gate.
    var isConfigured: Bool {
        lock.lock(); defer { lock.unlock() }
        return localEnabled && remoteEnabled
    }

    var isDebug: Bool {
        lock.lock(); defer { lock.unlock() }
        return debug
    }

    var isLinked: Bool {
        lock.lock(); defer { lock.unlock() }
        return linked
    }

    /// The first failing configuration gate (nil when armed), the active binding
    /// and the block's `replay` flag, read together.
    var evaluation: (reason: String?, binding: CaptureHotkeyBinding, replay: Bool) {
        lock.lock(); defer { lock.unlock() }
        if !(debug || linked) { return ("not_debug", binding, replay) }
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
    /// Simulator, real iPhone/iPad, or a host where quick capture never arms.
    var hostMode: QuickCaptureHostMode = .current
    /// The real device's link, read once per capture. SECURITY: never log the token.
    var deviceLink: @MainActor () -> DeviceLink? = { DeviceLinkCoordinator.shared.currentLink }
    /// A fresh takeover nonce per linked upload. SECURITY: never log it.
    var makeLinkNonce: () -> String = { DeviceLinkNonce.make() }
    /// An ingest reply said a teammate is taking this device over.
    var linkPendingReceived: @MainActor (DeviceLinkPending, String) -> Void = {
        DeviceLinkCoordinator.shared.followIngestPending($0, nonce: $1)
    }
    /// Ingest refused the token this capture was sent with.
    var deviceUnlinked: @MainActor (String) -> Void = {
        DeviceLinkCoordinator.shared.handleDeviceUnlinked(sentToken: $0)
    }
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
    /// True while an editable text input is first responder. Asked only when a
    /// key reaches `handle` without a pre-delivery answer.
    var isEditingText: @MainActor () -> Bool = { QuickCaptureTextInput.firstResponderIsEditable() }

    // MARK: State

    private let stateLock = NSLock()
    private let gate = QuickCaptureGate()
    private var matcher: CaptureHotkeyMatcher?
    private var presses = CapturePressDeduplicator()
    private var inFlight = false
    /// Guarded by `stateLock`. Written from any thread, called on the main actor.
    nonisolated(unsafe) private var evidenceProvider: QuickCaptureEvidenceProvider?

    nonisolated static let darwinCaptureNotification = "com.everframe.capture"

    nonisolated static let nativeSDKName = "everframe-ios"
    /// The identities `EFReporterPresenter.openAndAwait` accepts.
    nonisolated static let hostSDKNames: Set<String> = [nativeSDKName, "everframe-flutter", "everframe-kmp"]
    nonisolated(unsafe) private var darwinObserverInstalled = false

    nonisolated init() {}

    deinit {
        #if targetEnvironment(simulator)
        CFNotificationCenterRemoveEveryObserver(
            CFNotificationCenterGetDarwinNotifyCenter(), Unmanaged.passUnretained(self).toOpaque())
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

    /// The simulator's capture notification goes through the mode rule, the
    /// same as a shake: quick capture while armed, and on a simulator running
    /// as a real device (`EVERFRAME_SIMULATE_DEVICE=1`) a link hello as well.
    func darwinNotificationReceived() {
        CaptureGestureRouter.make(for: self, coordinator: .shared).handle(.simulatorNotification)
    }

    /// Starts `capture(trigger:)` on its own task, or the test override.
    func startCapture(trigger: QuickCaptureTrigger = .hotkey) {
        if let triggerOverride { triggerOverride(); return }
        Task { @MainActor in _ = await self.capture(trigger: trigger) }
    }

    nonisolated func publish(remote: CaptureHotkeyConfigWire?, ifCurrent: () -> Bool = { true }) {
        stateLock.lock(); defer { stateLock.unlock() }
        guard ifCurrent() else { return }
        gate.setRemote(remote)
    }

    /// Whether this real device holds a device link: a linked device arms
    /// even in a release build. `beginSession` and `teardown` clear it.
    /// `ifCurrent` is checked under the same lock as `beginSession`'s reset,
    /// so a change from a replaced session never lands after the new one's.
    nonisolated func setLinked(_ linked: Bool, ifCurrent: () -> Bool = { true }) {
        stateLock.lock(); defer { stateLock.unlock() }
        guard ifCurrent() else { return }
        gate.setLinked(linked)
    }

    /// The local options (`quickCaptureEnabled`, `reporterEnabled`) and the
    /// dashboard's `captureHotkey.enabled`, without the debug/linked gate.
    nonisolated var isConfigured: Bool { gate.isConfigured }

    /// The session's debug-build answer.
    nonisolated var isDebug: Bool { gate.isDebug }

    /// Whether the session's device holds a link (`setLinked`).
    nonisolated var isLinked: Bool { gate.isLinked }

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

    /// The first failing session gate, nil when the session is armed. Ignores `hostMode`.
    nonisolated var configurationGateReason: String? { gate.evaluation.reason }

    // MARK: Trigger

    /// True when a key press could fire a capture. Cheap: one lock read.
    var isArmed: Bool { hostMode != .unsupported && gate.evaluation.reason == nil }

    /// True while quick capture is armed with an open kill switch and the
    /// dashboard's `captureHotkey.replay` flag is set. `ReplaySession` then
    /// records replay even when `replayEnabled` is false; this never turns
    /// replay off. Linked devices and debug builds on real devices force it too;
    /// unlinked release builds never arm, so it is always false for end users. `ReplaySession` reads it at every config apply, right after
    /// publishing that config's block, so a disarm stops a forced recording at
    /// the next apply, and `kill()` tears the replay session down with it.
    var forcesReplay: Bool {
        guard hostMode != .unsupported, Everframe.captureGate else { return false }
        let evaluation = gate.evaluation
        return evaluation.reason == nil && evaluation.replay
    }

    /// Feeds one key-down. Never blocks: a match starts `capture()` on its own task.
    /// `press` names the physical press; one already fed is dropped (see
    /// `CapturePressDeduplicator`).
    ///
    /// `editingText` is whether an editable text input was first responder
    /// before UIKit delivered this key (see `prepareKeyDelivery`). nil asks
    /// `isEditingText` now, after delivery.
    func handle(_ event: CaptureKeyEvent, press: CapturePressID? = nil, editingText: Bool? = nil) {
        // The hotkey is a simulator feature; real devices capture on shake.
        guard hostMode == .simulator else { return }
        let (reason, binding, _) = gate.evaluation
        guard reason == nil else { matcher = nil; return }
        if let press, !presses.admit(press) { return }
        if matcher?.binding != binding || matcher?.window != doubleShiftWindow {
            matcher = CaptureHotkeyMatcher(binding: binding, window: doubleShiftWindow)
        }
        guard matcher?.feed(event) == true else { return }
        // Shift+B in a text field is a capital B, not a capture.
        if binding.yieldsToTextInput, editingText ?? isEditingText() { return }
        startCapture()
    }

    /// One key event's pending quick-capture work, read before UIKit delivers it.
    struct KeyDelivery {
        fileprivate var keys: [(event: CaptureKeyEvent, press: CapturePressID?, editingText: Bool?)]

        /// Per key: whether the focus was probed before delivery.
        var probedForTesting: [Bool] { keys.map { $0.editingText != nil } }
    }

    /// Called from the `UIWindow.sendEvent` hook BEFORE the event is delivered,
    /// only while armed. For a key that completes a typing chord (such as
    /// Shift+B) it records whether an editable text input is first responder
    /// now: a field can resign in its own editing callback, and the guard must
    /// judge the focus the key was typed into. Other keys cost nothing more.
    func prepareKeyDelivery(_ keys: [(CaptureKeyEvent, CapturePressID?)], window: UIWindow?) -> KeyDelivery {
        let binding = gate.evaluation.binding
        let guarded = binding.yieldsToTextInput
        return KeyDelivery(keys: keys.map { event, press in
            let editing: Bool? = guarded && binding.chordMatches(event)
                ? QuickCaptureTextInput.firstResponderIsEditable(preferring: window)
                : nil
            return (event, press, editing)
        })
    }

    /// Called from the hook AFTER the event was delivered unchanged.
    func completeKeyDelivery(_ delivery: KeyDelivery) {
        for key in delivery.keys { handle(key.event, press: key.press, editingText: key.editingText) }
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

    /// Who a capture is filed for, read once per capture.
    private struct Attribution {
        /// `X-Everframe-Capture-Token`. SECURITY: never log.
        let captureToken: String?
        /// `X-Everframe-Link-Nonce`, linked devices only. SECURITY: never log.
        let linkNonce: String?
        /// The device token this capture was sent with, linked devices only.
        let deviceToken: String?
        let confirmText: String
    }

    func capture(trigger: QuickCaptureTrigger = .hotkey) async -> QuickCaptureOutcome {
        // Read once: the gate and the pipeline must agree on the provider.
        let provider = currentEvidenceProvider()
        if let reason = ignoreReason(hasProvider: provider != nil) {
            // A shake on a host that masks its own pixels but installed no
            // provider says so; a hotkey stays silent, as it always has.
            if trigger == .shake, reason == "screenshot_disabled", let text = QuickCaptureToast.text(for: .failed) {
                showToast(text)
            }
            return .ignored(reason: reason)
        }
        guard let attribution = attribution() else { return .ignored(reason: "not_debug") }
        inFlight = true
        defer { inFlight = false }
        // Confirmed once the capture is handed off, before the upload finishes:
        // the upload either succeeds or queues the report, so only a rejection
        // needs a second word.
        let outcome = await runPipeline(provider: provider, attribution: attribution) { [showToast] in
            showToast(attribution.confirmText)
        }
        if let text = QuickCaptureToast.text(for: outcome) { showToast(text) }
        return outcome
    }

    /// nil when a real device has neither a link nor a debug build: the gate
    /// still said linked, but the token is gone, and an end user's device must
    /// never file a silent shared capture.
    private func attribution() -> Attribution? {
        let deviceName = environment["SIMULATOR_DEVICE_NAME"] ?? UIDevice.current.name
        switch hostMode {
        case .simulator:
            // Read fresh per capture, only for the origin that issued it: the
            // submission posts to `IngestEndpoint.url`. SECURITY: never log.
            return Attribution(
                captureToken: CaptureTokenReader.read(environment: environment, ingestEndpoint: IngestEndpoint.url),
                linkNonce: nil, deviceToken: nil,
                confirmText: QuickCaptureToast.confirmedText(deviceName: deviceName))
        case .device:
            if let link = deviceLink(), DeviceLinkToken.isValid(link.token) {
                return Attribution(captureToken: link.token, linkNonce: makeLinkNonce(), deviceToken: link.token,
                                   confirmText: link.owner.capturedToastText)
            }
            guard gate.isDebug else { return nil }
            return Attribution(captureToken: nil, linkNonce: nil, deviceToken: nil,
                               confirmText: QuickCaptureToast.confirmedText(deviceName: deviceName))
        case .unsupported:
            return nil
        }
    }

    private func ignoreReason(hasProvider: Bool) -> String? {
        guard hostMode != .unsupported else { return "unsupported_host" }
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

    /// The kill switch is open and no `start()` or `kill()` has run since
    /// `capturedSession` was taken.
    private func isCurrent(_ capturedSession: EFCapturedSession) -> Bool {
        isCurrent(startEpoch: capturedSession.user.startEpoch)
    }

    private func isCurrent(startEpoch: Int) -> Bool {
        Everframe.captureGate && Everframe.shared.currentStartEpoch == startEpoch
    }

    /// `EFReporterPresenter.openAndAwait` minus the UI: screenshot first, then
    /// the reporter-open boundary and freeze, then submit and release.
    private func runPipeline(
        provider: QuickCaptureEvidenceProvider?, attribution: Attribution, confirm: @MainActor () -> Void
    ) async -> QuickCaptureOutcome {
        let shot: ScreenshotCapture.Result
        let hostReplayVTree: Data?
        let sdkName: String
        // The session this capture belongs to, taken once before any evidence
        // and carried to the submission. Its epoch is read in the same critical
        // section as its config, so the check below and the routing agree on
        // one session; nothing after the screenshot reads the session again.
        let capturedSession = Everframe.shared.captureSessionSnapshot()
        if let provider {
            // The host's masked evidence replaces the native screenshot entirely;
            // a nil answer, or none within the timeout, fails without a fallback.
            guard let evidence = await awaitEvidence(provider),
                  evidence.image.size.width > 0, evidence.image.size.height > 0 else { return .failed }
            // As `openAndAwait`: an identity outside the known SDKs is refused.
            sdkName = evidence.sdkName ?? Self.nativeSDKName
            guard Self.hostSDKNames.contains(sdkName) else { return .failed }
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
            sdkName = Self.nativeSDKName
        }
        // Either screenshot took time (the host's render, or the native render
        // and PNG encode), and `start()`/`kill()` may run on another thread
        // meanwhile. A kill() in that window means nothing may freeze or ship; a
        // kill() then start() means the image belongs to the previous session; a
        // reporter that opened (or froze) meanwhile owns the evidence this
        // capture would freeze over; and an app that left the foreground is no
        // longer what was captured.
        guard isCurrent(capturedSession), isApplicationActive(), !Everframe.shared.report.isPresenting,
              !Everframe.shared.__replayHasReporterOwner else { return .failed }
        let owner = lifecycle.open()
        // Consume-once host payload, as the reporter drains it at open.
        let hostExtra = await Everframe.shared.__consumePendingAttachments()
        // The host's extra resolver (React Native's) can be pending: a start()
        // meanwhile may have handed back the new session's metadata. The
        // consumed value is dropped with the capture.
        guard isCurrent(capturedSession) else {
            lifecycle.cancel(owner)
            return .failed
        }
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
            sdkName: sdkName,
            capturedSession: capturedSession,
            quickCapture: true,
            // SECURITY: never log.
            captureToken: attribution.captureToken,
            linkNonce: attribution.linkNonce,
            onIngestAccepted: attribution.linkNonce.map { [startEpoch = capturedSession.user.startEpoch] nonce in
                { @Sendable [weak self] body in
                    guard let pending = DeviceLinkPending.fromIngestBody(body) else { return }
                    Task { @MainActor in
                        // The reply can land after `start()` or `kill()` replaced
                        // the session this upload was taken in: drop it then,
                        // rather than follow it with this upload's nonce.
                        guard let self, self.isCurrent(startEpoch: startEpoch) else { return }
                        self.linkPendingReceived(pending, nonce)
                    }
                }
            }
        )
        confirm()
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
                return .rejected
            }
        } catch DeviceLinkRejection.deviceUnlinked {
            // Nothing was stored. Forget the token this capture was sent with.
            lifecycle.cancel(owner)
            if let token = attribution.deviceToken { deviceUnlinked(token) }
            return .unlinked
        } catch {
            // A terminal upload error: `ReporterSubmission` queues only retryable ones.
            lifecycle.cancel(owner)
            return .rejected
        }
    }
}
/// Finds the first responder and decides whether it takes typing. It walks the
/// window's view hierarchy for the view that `isFirstResponder`, rather than
/// sending a nil-targeted action: the SDK's own `sendAction` instrumentation
/// would record that action as a tap breadcrumb. Runs only for a key that
/// completes a typing chord.
@MainActor
enum QuickCaptureTextInput {
    /// `preferring` is searched first (the window the key was sent to), then
    /// the app's other visible windows.
    static func firstResponderIsEditable(preferring window: UIWindow? = nil) -> Bool {
        isEditable(currentFirstResponder(preferring: window))
    }

    static func currentFirstResponder(preferring window: UIWindow? = nil) -> UIResponder? {
        if let window, let found = firstResponder(in: window) { return found }
        for candidate in candidateWindows() where candidate !== window {
            if let found = firstResponder(in: candidate) { return found }
        }
        return nil
    }

    /// The first responder among `view` and its descendants.
    static func firstResponder(in view: UIView) -> UIView? {
        if view.isFirstResponder { return view }
        for subview in view.subviews {
            if let found = firstResponder(in: subview) { return found }
        }
        return nil
    }

    /// Visible windows of the foreground scene, key window first; the
    /// screenshot test override when one is set (a SwiftPM test bundle has no
    /// scenes).
    private static func candidateWindows() -> [UIWindow] {
        let windows: [UIWindow]
        if let override = ScreenshotCapture.__windowsOverrideForTesting {
            windows = override
        } else {
            windows = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .filter { $0.activationState == .foregroundActive }
                .flatMap(\.windows)
        }
        return windows.filter { !$0.isHidden }.sorted { $0.isKeyWindow && !$1.isKeyWindow }
    }

    /// An enabled `UITextField`, an editable `UITextView`, or any other
    /// responder that accepts key input (`UIKeyInput`, which `UITextInput`
    /// extends): React Native and Flutter text inputs, SwiftUI text fields and
    /// custom editors. A read-only, selectable text view does not count on
    /// iOS; tvOS has no `isEditable`, so a first-responder text view counts
    /// there.
    static func isEditable(_ responder: UIResponder?) -> Bool {
        guard let responder else { return false }
        #if os(tvOS)
        if responder is UITextView { return true }
        #else
        if let textView = responder as? UITextView { return textView.isEditable }
        #endif
        if let textField = responder as? UITextField { return textField.isEnabled }
        return responder is UIKeyInput
    }
}

#endif
