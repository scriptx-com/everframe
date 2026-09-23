// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Phase 06.2-07 Task 2 — TV-side WebSocket client for the phone companion relay.
//
// Wraps `URLSessionWebSocketTask` (Foundation built-in; zero SPM deps —
// RESEARCH Pitfall 2 / D-02). Sole writer of `CompanionAPI.state` and
// `CompanionAPI.pairUrl` via the `__setState` / `__setPairUrl` seams.
//
// Companion discovery (spec 2026-08-07): when the host supplies an `sdkKey`,
// EVERY connect attempt first announces over HTTPS (`CompanionAnnounce`) and
// opens `wss://<endpoint>/relay/tv/<ticket>` with the single-use ticket it
// gets back. Tickets are single-use with a 60s TTL, so nothing here may cache
// one across two attempts — there is deliberately no ticket-holding property.
// Announce failure of any kind falls back to plain `/relay/tv`: the device
// drops out of the dashboard's device list and keeps reporting exactly as it
// did before this feature existed.
//
// Lifecycle:
//   • `connect()` opens `wss://<endpoint>/relay/tv` (or `/relay/tv/<ticket>`).
//   • Receive loop is recursive — every successful `task.receive { … }`
//     callback re-arms (RESEARCH Pitfall 3). One-shot receive is a known
//     URLSessionWebSocketTask footgun.
//   • Close codes 4001..4004 transition state to `.unpaired` and drop the
//     stored `device_token` (token revoked). 4005+ schedules reconnect with
//     exponential backoff (1/2/4/8/10 s, then 10 s forever).
//
//     THERE IS NO WALL-CLOCK BUDGET HERE. An earlier revision of this header
//     claimed a "total budget 5 min per SPEC § Pair timeout"; no such budget
//     was ever implemented in this file, and `scheduleReconnect()` retries at
//     the 10 s ceiling indefinitely against a relay that may never return.
//     This DIVERGES from the web reference — `packages/sdk-react/src/companion/
//     ws-client.ts` (see `TOTAL_RECONNECT_BUDGET_MS`) drops to `unpaired` and
//     clears pairUrl/code/attachedUserName once the budget lapses, so a browser
//     stops showing a dead code while a TV keeps showing one. Deliberately left
//     as-is for now: a lobby TV has no user present to re-arm it, so retrying
//     forever is the safer default until the product decides otherwise. Tracked
//     as a cross-platform follow-up, NOT as something this comment describes as
//     already done.
//   • Every UIKit platform, tvOS INCLUDED:
//     `UIApplication.didEnterBackgroundNotification` triggers proactive
//     `.phoneDisconnected`, cancels the socket, AND supersedes the in-flight
//     connect attempt (see `handleDidEnterBackground`). The supersede half is
//     not optional: the announce is an awaited HTTP call in front of every
//     socket open, so this handler routinely runs while the client owns no
//     task at all, and without the generation bump that continuation opens a
//     socket with the app in the background.
//     `willEnterForegroundNotification` starts a FRESH attempt — never a
//     resumed one; the superseded ticket is single-use with a 60 s TTL.
//
//     The signal is the BACKGROUND transition, not resign-active: a banner,
//     Control Center or a tvOS system overlay makes an app `.inactive` while
//     it is still fully alive, and tearing a long-lived companion session down
//     there would swap the QR out from under whoever is scanning it. See
//     `init` for the full argument, including why `willEnterForeground` also
//     removes a spurious cold-launch reconnect that `didBecomeActive` caused.
//   • Those notifications fire only on TRANSITIONS, so `connect()` additionally
//     reads `UIApplication.applicationState` once and supersedes itself if the
//     process is already in the background — a fresh client built by a host
//     that restarts companion while backgrounded would otherwise announce and
//     dial with no transition ever arriving to stop it.
//
// Strict-concurrency: `URLSessionWebSocketDelegate` callbacks arrive on the
// URLSession's delegate queue (a serial dispatch queue). The CompanionAPI
// writes go through @MainActor only because `CompanionAPI` is not isolated
// to the main actor — it's `@unchecked Sendable`. State coordination uses
// `NSLock` to mirror the precedent in `Everframe.swift:33` ("@unchecked
// Sendable because we manage concurrent access via NSLock"). This is the
// repo-local idiom; switching to an actor would force async on every public
// surface.
//
// Threat model (06.2-07 §T-06.2-07-01): NEVER log `pair_token`,
// `device_token`, the announce `ticket`, or the companion
// `attribution_token`. Pair IDs (already opaque) are loggable. The
// annotations `// SECURITY: do not log` mark every token-touching site.
import Foundation
import EverframeProtocol
#if canImport(UIKit)
import UIKit
#endif

/// How this device advertises attach-PIN support at announce time (spec
/// 2026-08-19). `.builtin` (the default) advertises `supportsAttachPin` only
/// when `EverframeReporterUI`'s `CompanionPinPresenter` is actually linked and
/// installed (`CompanionAPI.__builtinPinUiInstalled`) — a host that links
/// only `EverframeKit` degrades honestly to the legacy no-PIN announce rather
/// than claiming support it cannot render. `.custom` is for a host (or the RN
/// bridge) rendering its own PIN UI off `CompanionAPI.attachChallenge`.
/// `.off` never advertises the capability even if a presenter is installed.
public enum AttachPinUi: String, Sendable {
    case builtin
    case custom
    case off
}

public final class RelayWSClient: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {

    // MARK: - Public surface (test seam)

    /// Per-attempt reconnect delay, plateauing at the 10 s ceiling
    /// (RESEARCH §Pattern 2 backoff schedule).
    ///
    /// This schedule is the WHOLE reconnect policy — there is no wall-clock
    /// budget wrapped around it, so the client retries at 10 s forever. An
    /// earlier revision of this doc comment claimed the "total wall-clock
    /// budget mirrors the 5-min server-side pair grace window in SPEC §4";
    /// no such budget was ever implemented here, and repeating the claim at
    /// two points in one file is how it survived a correction. See the file
    /// header for the full note, including the divergence from
    /// `sdk-react/src/companion/ws-client.ts`, which DOES enforce one.
    public static let backoffSchedule: [TimeInterval] = [1, 2, 4, 8, 10]

    /// Test seam: set this to non-nil to override `DispatchQueue.global().asyncAfter`
    /// scheduling. Production code leaves it nil. Closure receives the computed
    /// delay; tests record the schedule without sleeping.
    public nonisolated(unsafe) var __scheduleReconnectHook: ((TimeInterval) -> Void)?

    /// Test seam: set this to non-nil to intercept socket creation. The hook
    /// receives the fully-composed WS URL for the attempt and NO real
    /// `URLSessionWebSocketTask` is created. Production code leaves it nil.
    /// Lets tests observe which URL each connect attempt resolves to —
    /// ticketed vs ticketless, and that consecutive attempts carry different
    /// tickets — without a live relay.
    internal nonisolated(unsafe) var __openSocketHook: ((URL) -> Void)?

    /// Test seam: set this to non-nil to intercept every outbound text frame
    /// instead of writing it to the socket. Production code leaves it nil.
    ///
    /// `send(_:)` silently drops when no task is installed, and every
    /// frame-level test in this file drives `handleControl` with no socket at
    /// all — so without this seam "the client REPLIED" is unobservable and a
    /// reply that was never sent looks identical to one that was. That is the
    /// exact shape of bug this branch keeps producing, so the reply gets a
    /// seam rather than an assumption.
    internal nonisolated(unsafe) var __sendHook: ((EverframeRelayMessage) -> Void)?

    /// Test seam: set this to non-nil to override device-identity resolution
    /// (naming spec 2026-08-24) instead of the real
    /// `CompanionDeviceFacts.current(explicit:)`. Production code leaves it
    /// nil.
    ///
    /// Real device resolution touches Keychain, and whether Keychain is
    /// reachable from an unsigned `swift test` binary genuinely varies by
    /// host — unlike `DeviceKeyTests.swift`'s probe-and-skip pattern (fine
    /// for a test that's ABOUT Keychain behaviour), a body-bytes assertion
    /// that has nothing to do with the `device` block must not flip between
    /// "device present" and "device absent" depending on which machine runs
    /// it. Tests that only care about `label`/`supportsAttachPin` set this to
    /// `{ nil }` for a deterministic "no device" body; tests about the
    /// `device` block itself belong in `CompanionAnnounceTests.swift`, which
    /// drives `CompanionAnnounce.body(...)` directly and never touches this.
    internal nonisolated(unsafe) var __deviceResolverOverride: (@Sendable () async -> AnnounceDevice?)?

    /// Reads whether the host process is in the BACKGROUND right now, and
    /// calls back with the answer. Non-nil on every platform that has such a
    /// state to read — all of UIKit, tvOS included — where `init` installs a
    /// reader that hops to the main thread
    /// (`UIApplication.shared.applicationState` is main-thread-only) and
    /// answers there. nil only where there is no UIKit at all, i.e. the macOS
    /// slice `swift test` runs on.
    ///
    /// A stored closure rather than an `#if` inline in `connect()` so the
    /// DECISION — "already backgrounded at connect time ⇒ supersede" — is
    /// compiled and gated on every platform, including the macOS test slice.
    /// The same reasoning as the two lifecycle handlers at the bottom of this
    /// file: the only thing left uncovered is the one-line UIKit read itself.
    /// The callback is `@Sendable` because the production reader answers from
    /// the main queue, i.e. on a different thread from the `connect()` that
    /// asked. (Without it the UIKit build warns, and Swift 6 rejects, the hop.)
    internal nonisolated(unsafe) var __readApplicationBackgroundState:
        ((@escaping @Sendable (Bool) -> Void) -> Void)?

    /// Test seam (read-only): the socket this client currently owns. Lets a
    /// test drive the delegate with the REAL installed task — which is the
    /// only way `isCurrentTask` and `openSocket`'s cancel-before-overwrite are
    /// observable, since `__openSocketHook` returns before either happens.
    /// Production code never reads this.
    internal var __currentTaskForTesting: URLSessionWebSocketTask? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return task
    }

    // MARK: - State (NSLock-protected)

    private let endpoint: URL
    /// Optional human label sent with each announce (e.g. "Lobby TV").
    /// Length-capped server-side.
    private let deviceLabel: String?
    /// Non-nil exactly when the host supplied an Everframe SDK key. Its presence is what
    /// turns the ticketed path on; nil means "never make an HTTP call, connect
    /// to plain `/relay/tv`", byte-identical to pre-companion behaviour.
    /// Holds no ticket — `announce(label:)` is called fresh per attempt.
    private let announcer: CompanionAnnounce?
    /// Governs the `supportsAttachPin` capability computed at every announce
    /// call site (spec 2026-08-19) — see `AttachPinUi`'s doc comment for the
    /// rule per case.
    private let attachPinUi: AttachPinUi
    /// Explicit device-identity override (naming spec 2026-08-24) — an MDM id
    /// or provisioning serial the host already trusts. Hashed by
    /// `CompanionDeviceId.resolve(explicit:)` before it ever reaches the
    /// wire; nil (the default) falls through to the Keychain-stored id.
    private let companionDeviceId: String?
    private weak var companion: CompanionAPI?
    // Module-internal accessor so `CompanionCaptureBridge` can end the report
    // it just submitted — `__finishReport(correlationId:)`, which returns
    // `.reportInProgress` → `.paired` only when that report still owns the
    // state (parity with Android's `Companion.__finishReport` in launchSubmit).
    internal var companionForBridge: CompanionAPI? { companion }

#if canImport(UIKit)
    // MARK: - Companion name badge (naming spec 2026-08-24 Task 5)

    /// Always constructed on UIKit platforms (plan 2026-08-25) — an inline
    /// `companionBadge.enabled == false` no longer skips construction,
    /// because the dashboard-configured server block can force-enable the
    /// badge, and that precedence (`CompanionBadgeResolution.enabled`) is
    /// only resolvable if the badge instance exists to resolve it. Nil only
    /// on platforms where this file is compiled without UIKit (host `swift
    /// test`). Owns its own Combine subscription to `companion` — nothing
    /// else here needs to drive show/hide. See `CompanionBadge.swift`'s
    /// header: identification only, never a privacy mitigation. Torn down
    /// from `disconnect()` via `CompanionBadge.teardown()` — the badge dies
    /// with the client that owns it, exactly like `previewSession` above.
    private var badge: CompanionBadge?

    /// Test-only accessor for wire-verifying that `disconnect()` actually
    /// reaches THIS instance's badge, rather than only exercising
    /// `CompanionBadge.teardown()` in isolation. Mirrors the read-only style
    /// of `companionForBridge` above — no setter, since nothing outside this
    /// file should ever substitute a badge instance.
    internal var __badgeForTesting: CompanionBadge? { badge }

    // MARK: - Live preview (companion multi-shot, spec 2026-07-17 §3)

    /// Built lazily on first use, so a client that never previews never touches
    /// the capture stack.
    ///
    /// iOS needs no host-installed provider seam here — `ScreenshotCapture`
    /// resolves the foreground window itself through
    /// `UIApplication.shared.connectedScenes`, unlike the Android core AAR,
    /// which cannot find an Activity and must be handed one by the RN module.
    ///
    /// `internal var` rather than `let` so the routing tests can substitute a
    /// recording double — see `CompanionPreviewSessionApi`.
    internal var __previewSessionOverride: CompanionPreviewSessionApi?

    @MainActor
    private var previewSessionStorage: CompanionPreviewSessionApi?

    @MainActor
    internal func previewSession() -> CompanionPreviewSessionApi {
        if let override = __previewSessionOverride { return override }
        if let existing = previewSessionStorage { return existing }
        let built = CompanionPreviewSession(
            send: { [weak self] message in self?.send(message) },
            sendBinary: { [weak self] data in self?.sendBinary(data) },
            capturePreview: {
                await ScreenshotCapture.capturePreviewFrame()
            },
            captureShot: {
                guard let result = ScreenshotCapture.captureKeyWindow(),
                      let cg = result.image.cgImage
                else { return nil }
                // The announced dimensions must be the PIXEL dimensions of the
                // bytes, not `widthPoints`/`heightPoints`. Those are points;
                // the PNG is points x scale, so announcing them on a 3x device
                // tells the phone the image is a third of its real size and the
                // preview renders at the wrong scale.
                return PreviewCapture(bytes: result.pngData,
                                      width: cg.width,
                                      height: cg.height,
                                      mime: "image/png")
            })
        previewSessionStorage = built
        return built
    }

    /// Serialises main-actor hops in the order `handleControl` made them.
    ///
    /// `handleControl` runs on the WS reader thread and the session is
    /// main-actor isolated, so every routed call has to hop. Unstructured
    /// `Task { @MainActor in ... }` carries NO documented ordering guarantee
    /// between separately created tasks, and the one reordering that matters
    /// here is `preview.start` overtaking `preview.stop` — which leaves the
    /// device reading the user's screen with nothing left to stop it. That is
    /// the single failure this feature's privacy budget exists to prevent, so
    /// the hops are chained rather than left to the scheduler.
    private var routingChain: Task<Void, Never>?

    internal func enqueueOnMain(_ body: @escaping @MainActor () -> Void) {
        stateLock.lock()
        let previous = routingChain
        routingChain = Task { @MainActor in
            await previous?.value
            body()
        }
        stateLock.unlock()
    }

    // MARK: Routing helpers
    //
    // `handleControl` and the lifecycle handlers call these rather than
    // `enqueueOnMain` directly, so the switch itself stays free of `#if` and
    // the macOS test slice — which compiles this file but NOT the session —
    // gets no-op twins below.

    internal func routePreviewStart(correlationId: String) {
        enqueueOnMain { [weak self] in self?.previewSession().start(correlationId: correlationId) }
    }

    internal func routePreviewStop() {
        enqueueOnMain { [weak self] in self?.previewSession().stopSilently() }
    }

    internal func routeShotRequest(correlationId: String, shotId: String, rect: NormalizedRect?) {
        // Read HERE, on the socket thread, BEFORE the main-actor hop. A phone
        // disconnect can invalidate the epoch while both this shot and the
        // pair-loss cancellation are still queued; reading it any later would
        // snapshot the ALREADY-INVALIDATED value and the final comparison would
        // trivially pass. The question is "was authorisation live when the
        // frame arrived", so it must be read where the frame arrives.
        let authAtRequest = CompanionAuthEpoch.current
        enqueueOnMain { [weak self] in
            self?.previewSession().requestShot(correlationId: correlationId,
                                               shotId: shotId,
                                               rect: rect,
                                               authAtRequest: authAtRequest)
        }
    }

    /// Pair loss and backgrounding: stop reading the screen and drop the
    /// stashed report-grade captures. Resumable — the same client reconnects.
    internal func routePreviewPairLoss() {
        enqueueOnMain { [weak self] in
            self?.previewSession().stopSilently()
            self?.previewSession().clearStash()
        }
    }

    /// Permanent: this client is done for good.
    internal func routePreviewTeardown() {
        enqueueOnMain { [weak self] in self?.previewSession().teardown() }
    }

    /// The report is over — drop the stash but leave any live preview alone.
    internal func routePreviewStashClear() {
        enqueueOnMain { [weak self] in self?.previewSession().clearStash() }
    }

    /// Drops the stash only if it belongs to `correlationId`.
    internal func routePreviewStashClearFor(correlationId: String) {
        enqueueOnMain { [weak self] in
            self?.previewSession().clearStashFor(correlationId: correlationId)
        }
    }
#else
    // macOS test slice: the session is UIKit-only, so routing is inert. The
    // signatures still exist so `handleControl` needs no conditional compilation.
    internal func routePreviewStart(correlationId: String) {}
    internal func routePreviewStop() {}
    internal func routeShotRequest(correlationId: String, shotId: String, rect: NormalizedRect?) {}
    internal func routePreviewPairLoss() {}
    internal func routePreviewTeardown() {}
    internal func routePreviewStashClear() {}
    internal func routePreviewStashClearFor(correlationId: String) {}
#endif

    private let stateLock = NSLock()
    private var session: URLSession!
    private var task: URLSessionWebSocketTask?
    /// `taskDescription` written onto the task we currently own, and nil while
    /// we own none. See `isCurrentTask` for why the stamp lives on the task
    /// rather than being inferred from `task`'s identity.
    private var currentTaskStamp: String?
    /// SECURITY: do not log — opaque token, single-use, dies on phone bond.
    private var deviceToken: String?
    private var reconnectAttempt = 0
    /// The `connectGeneration` a reconnect timer is currently armed for, or
    /// nil when none is.
    ///
    /// A single socket drop signals TWICE within ~ms — `receiveLoop`'s
    /// `.failure` branch and the delegate's `didCloseWith` — and both signals
    /// describe the SAME generation, so the second is deduped. That is what
    /// stops one drop from announcing twice, spending two single-use tickets
    /// and listing the same device in the dashboard twice.
    ///
    /// It is scoped to a generation rather than a bare flag because the two
    /// are not the same thing once anything else can supersede the attempt.
    /// With a bare flag, a host `connect()` (the `willEnterForeground` hook
    /// does exactly this) landing between arming and firing would leave the
    /// flag stuck: a genuine drop of the NEW socket would find it set and
    /// silently arm nothing at all, and the stale timer would then fire into
    /// `beginConnect()` and replace a perfectly healthy connection.
    private var reconnectArmedForGeneration: UInt64?
    private var isClosed = false
    /// True between `handleDidEnterBackground()` and `handleWillEnterForeground()`.
    ///
    /// Backgrounding must SUPERSEDE whatever connect attempt is in flight, not
    /// merely cancel an installed socket. The announce hop is an awaited HTTP
    /// call sitting in front of every socket open, so for seconds at a time the
    /// client owns no task for a background handler to cancel — and the
    /// continuation would sail past the generation guard and open a socket
    /// while the process sat in the background, leaving the device visible in
    /// the dashboard and able to receive capture requests with no UI to serve
    /// them. `handleDidEnterBackground()` therefore bumps `connectGeneration`
    /// exactly as `disconnect()` does, and this flag keeps any LATER attempt
    /// (a host `connect()`) from composing a new one while the state persists.
    /// Foregrounding clears it and starts a FRESH announce — the ticket it
    /// superseded is single-use with a 60s TTL, so there is nothing to resume.
    private var isBackgrounded = false
    /// Monotonic connect-attempt counter. Every entry into `beginConnect()`
    /// claims the next value; `disconnect()` bumps it too. An announce whose
    /// generation is no longer current lost the race (a newer `connect()` /
    /// reconnect superseded it, or the host closed the client) and must drop
    /// silently rather than open a second socket — the announce hop is up to
    /// 5s wide, so the window is real.
    private var connectGeneration: UInt64 = 0
    /// Plan 06.2-12: D-05 wire ordering says a `report.submit` text frame is
    /// IMMEDIATELY followed by ONE binary frame (the baked annotated PNG).
    /// We remember the most-recent submit's correlation_id so when the next
    /// binary frame arrives we can route it to the capture bridge with the
    /// correct key. Cleared on consume. Only ONE in-flight submit→binary
    /// pair is supported per pair (matches SPEC: one report at a time).
    private var pendingSubmitCorrelationId: String?

    /// Set by a `shot.binary {shot_id}` marker: the NEXT binary frame carries
    /// that shot's baked image rather than the report's primary screenshot.
    ///
    /// The protocol chose an explicit marker over positional counting so the
    /// device never has to infer which image belongs to which id.
    private var pendingShotBinary: (correlationId: String, shotId: String)?

    /// Forgets every partially-received submit: the pending-submit binding, the
    /// `shot.binary` binding, and the bridge's half-filled part buffers.
    ///
    /// The `shot.binary` binding is the dangerous one. It says "the NEXT binary
    /// belongs to shot X", and it outlives the phone leg — so a phone that
    /// dropped between the marker and its payload left the binding armed, and
    /// the next report's PRIMARY binary was routed into that dead shot instead.
    /// That report then waits forever for a primary that already arrived.
    private func resetSubmitFraming() {
        // Bumped SYNCHRONOUSLY, off the main actor: a capture already running
        // there blocks every queued cancellation, so this counter is the only
        // signal that can reach it in time. See `CompanionAuthEpoch`.
        CompanionAuthEpoch.invalidate()
        stateLock.lock()
        pendingSubmitCorrelationId = nil
        pendingShotBinary = nil
        stateLock.unlock()
        // The bridge observes rather than being held: this file already
        // couples to it exclusively through NotificationCenter.
        NotificationCenter.default.post(
            name: .everframeCompanionResetSubmitFraming, object: self)
    }
    /// Companion attribution (spec 2026-08-07) — captured off `pair.bonded`
    /// when the relay populated it (dashboard-initiated attach only), then
    /// overwritten by any fresher token riding a `report.request`. Rides the
    /// ingest POST as `X-Everframe-Companion-Attribution` and goes nowhere else.
    /// SECURITY: never log.
    private var attributionToken: String?

    /// EverframeDevice identity (naming spec 2026-08-24) resolved ONCE, lazily, at the
    /// first announce — see `resolveDeviceOnce()`. `deviceResolved` is the
    /// "have we computed it yet" flag; `resolvedDevice` is nil both before
    /// that (not yet computed) and after (Keychain unavailable, no explicit
    /// override) — the flag is what disambiguates the two, so a client that
    /// genuinely has no device to send doesn't re-attempt Keychain access on
    /// every reconnect.
    private var deviceResolved = false
    private var resolvedDevice: AnnounceDevice?

    /// - Parameters:
    ///   - sdkKey: The host's Everframe key (`EverframeConfig.appId`). Supply it
    ///     to make this device discoverable from the dashboard; omit it and no
    ///     HTTP call is made at all. Companion discovery is opt-in — reporting
    ///     never depends on it.
    ///   - deviceLabel: Optional human name for the dashboard's device list.
    ///   - attachPinUi: How this device advertises attach-PIN support at
    ///     announce time (spec 2026-08-19). Defaults to `.builtin`.
    ///   - companionDeviceId: Explicit device-identity override (naming spec
    ///     2026-08-24) — an MDM id or provisioning serial the host already
    ///     trusts. Hashed before it ever reaches the wire. Defaults to nil,
    ///     which falls through to a Keychain-stored random id.
    ///   - companionBadge: Config for the capture-excluded name badge
    ///     (`CompanionBadge.swift`, naming spec 2026-08-24 Task 5) —
    ///     identification only, never a privacy mitigation. Captured ONCE
    ///     here (first-client-wins, mirroring web): change it by building a
    ///     fresh `RelayWSClient`, not by mutating a running one.
    public convenience init(
        endpoint: URL = IngestEndpoint.url,
        companion: CompanionAPI,
        sdkKey: String? = nil,
        deviceLabel: String? = nil,
        attachPinUi: AttachPinUi = .builtin,
        companionDeviceId: String? = nil,
        companionBadge: CompanionBadgeOptions = CompanionBadgeOptions()
    ) {
        self.init(endpoint: endpoint,
                  companion: companion,
                  sdkKey: sdkKey,
                  deviceLabel: deviceLabel,
                  attachPinUi: attachPinUi,
                  companionDeviceId: companionDeviceId,
                  companionBadge: companionBadge,
                  announceTransport: nil)
    }

    /// Designated initializer. `announceTransport` is a test seam — pass nil
    /// (the public initializer always does) for the real `URLSession` hop.
    internal init(
        endpoint: URL = IngestEndpoint.url,
        companion: CompanionAPI,
        sdkKey: String?,
        deviceLabel: String?,
        attachPinUi: AttachPinUi = .builtin,
        companionDeviceId: String? = nil,
        companionBadge: CompanionBadgeOptions = CompanionBadgeOptions(),
        announceTransport: AnnounceTransport?
    ) {
        self.endpoint = endpoint
        self.companion = companion
        self.deviceLabel = deviceLabel
        self.attachPinUi = attachPinUi
        self.companionDeviceId = companionDeviceId
        if let sdkKey = sdkKey {
            self.announcer = announceTransport.map {
                CompanionAnnounce(endpoint: endpoint, sdkKey: sdkKey, transport: $0)
            } ?? CompanionAnnounce(endpoint: endpoint, sdkKey: sdkKey)
        } else {
            self.announcer = nil
        }
        super.init()
        // Capture-excluded companion name badge (naming spec 2026-08-24 Task
        // 5) — identification only, see `CompanionBadge.swift`'s header.
        // `CompanionBadge` owns its own Combine subscription to `companion`,
        // so construction here is fire-and-forget: nothing else in this file
        // needs to drive it.
        #if canImport(UIKit)
        // Always constructed (plan 2026-08-25): the dashboard block can
        // force-enable over an inline enabled: false, so the badge must
        // exist to resolve precedence at show time.
        self.badge = CompanionBadge(companion: companion, options: companionBadge)
        #endif
        let cfg = URLSessionConfiguration.default
        self.session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
        // EVERY UIKit platform, tvOS included. Apple TV is the primary target
        // of companion, and both of these notifications exist there; excluding
        // it left the one device class that matters most with no lifecycle
        // protection at all — a TV backgrounded mid-announce would open a
        // socket while inactive, and coming back would never re-announce.
        //
        // `didEnterBackground` / `willEnterForeground`, NOT
        // `willResignActive` / `didBecomeActive`. Resign-active is not
        // backgrounding: it fires for a notification banner, Control Center,
        // an incoming call, a tvOS system overlay. A companion session is
        // long-lived and often mid-report, and tearing it down there is a
        // VISIBLE regression — the socket dies, state drops to
        // `.phoneDisconnected`, and the return trip announces afresh, so the
        // QR on screen is replaced by a different one mid-scan. Nothing is
        // lost by waiting: `didEnterBackground` is delivered before the
        // process is suspended, so the invariant "no socket open while
        // genuinely backgrounded" still holds. It also removes a spurious
        // connect — `didBecomeActive` fires at cold launch, right after a host
        // that started companion in `didFinishLaunchingWithOptions`, which
        // announced a second ticket to supersede the socket it had just
        // opened. `willEnterForeground` is not sent at launch.
        #if canImport(UIKit)
        NotificationCenter.default.addObserver(
            self, selector: #selector(onDidEnterBackground),
            name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(onWillEnterForeground),
            name: UIApplication.willEnterForegroundNotification, object: nil)
        // The read is main-thread-only, hence the hop; the DECISION it applies
        // lives in `__isAlreadyBackgrounded` below (including why `.background`
        // rather than `!= .active`).
        __readApplicationBackgroundState = { answer in
            DispatchQueue.main.async {
                answer(Self.__isAlreadyBackgrounded(UIApplication.shared.applicationState))
            }
        }
        #endif
    }

    #if canImport(UIKit)
    /// The production answer to "is the process already in the background?",
    /// lifted out of the reader closure above so it is a named thing a test can
    /// apply to a state value it chooses.
    ///
    /// This is what lets a test ask the REAL question with the state UIKit
    /// actually reports at a given lifecycle moment — notably `.background`,
    /// which is what `applicationState` still holds when
    /// `willEnterForeground` is delivered. A simulator's test host is always
    /// `.active`, so a test that called the live reader could only ever
    /// observe the harmless answer, which is precisely how the foreground
    /// wedge stayed invisible behind a stub hard-coded to `false`.
    ///
    /// `.background`, not `!= .active`: `.inactive` is the ordinary cold-start
    /// state (an app is `.inactive` throughout `didFinishLaunchingWithOptions`,
    /// where hosts commonly start companion), so treating it as "away" would
    /// burn a single-use ticket on every launch to gain nothing.
    internal static func __isAlreadyBackgrounded(_ state: UIApplication.State) -> Bool {
        state == .background
    }
    #endif

    deinit {
        NotificationCenter.default.removeObserver(self)
        stateLock.lock()
        task?.cancel(with: .goingAway, reason: nil)
        stateLock.unlock()
    }

    // MARK: - Connect / disconnect

    /// Opens the relay socket and starts the receive loop. Idempotent:
    /// subsequent calls cancel any in-flight task and re-open. With an
    /// `sdkKey` configured the open is asynchronous — it waits on the
    /// announce hop first (bounded by `CompanionAnnounce`'s request timeout).
    public func connect() {
        connect(probeAlreadyBackgrounded: true)
    }

    /// - Parameter probeAlreadyBackgrounded: whether to ask UIKit, after the
    ///   attempt is composed, if the process is in the background right now.
    ///   True for every caller EXCEPT the foreground transition — see
    ///   `handleWillEnterForeground()` for why that read is not merely
    ///   redundant there but actively wrong.
    private func connect(probeAlreadyBackgrounded: Bool) {
        stateLock.lock()
        isClosed = false
        stateLock.unlock()
        // Cancelling and disowning the predecessor lives in `beginConnect()`,
        // under the same lock hold that claims the generation — one description
        // of "a new attempt supersedes the old socket", shared with the
        // reconnect entry point rather than duplicated here. We own no socket
        // until the (possibly seconds-long) announce hop resolves, and the
        // dropped stamp is what makes the task just cancelled recognisable as a
        // predecessor for that whole window.
        beginConnect()
        if probeAlreadyBackgrounded { supersedeIfAlreadyBackgrounded() }
    }

    /// PR-fix 3 — a client CONNECTED while the process is already in the
    /// background.
    ///
    /// `isBackgrounded` only ever flips on a TRANSITION, and a host that
    /// connects while already backgrounded never sees one. This
    /// is the ordinary RN path, not an exotic one: `stopCompanion()` drops the
    /// client and `startCompanion()` builds a FRESH `RelayWSClient` whose
    /// `isBackgrounded` initialises to `false`, so every session started from a
    /// backgrounded process would announce and open a socket in violation of
    /// the invariant, with nothing to correct it until a full
    /// background/foreground cycle.
    ///
    /// Runs AFTER `beginConnect()` rather than before it, because the read is
    /// asynchronous (UIKit main-thread rule) and `connect()` must stay
    /// synchronous. That ordering is safe in both directions: superseding is
    /// generation-based plus a task cancel, so it works whether the attempt is
    /// still awaiting its announce or has already installed a socket.
    /// `handleDidEnterBackground()` is reused verbatim so there is exactly one
    /// description of what "the process is away" does to this client.
    ///
    /// NOT reached from `handleWillEnterForeground()`, which passes
    /// `probeAlreadyBackgrounded: false`. That exclusion is load-bearing, not
    /// an optimisation — see the comment there.
    private func supersedeIfAlreadyBackgrounded() {
        guard let read = __readApplicationBackgroundState else { return }
        read { [weak self] backgrounded in
            guard let self, backgrounded else { return }
            self.handleDidEnterBackground()
        }
    }

    /// The ONE place a connect attempt is composed for the TV leg. Both entry
    /// points call it: cold-start `connect()` and every `scheduleReconnect()`
    /// retry that has no `device_token`. Keeping them on one path is
    /// load-bearing — the announce ticket is single-use, so a reconnect that
    /// skipped the announce would open a ticketless socket and the device
    /// would silently vanish from the dashboard after its first drop, never to
    /// return.
    ///
    /// `connectWithDeviceToken(_:)` is the one other composer in this file. It
    /// is unreachable on this leg (the relay never sends `device_token` to the
    /// TV) and is kept only for the phone-side shape — but it opens a socket,
    /// so it carries its own copy of the `isBackgrounded` guard below. "No
    /// socket may open while the process is backgrounded" has to hold for
    /// every path that installs one, not just the common one.
    private func beginConnect() {
        stateLock.lock()
        // Nothing may compose a connect attempt while the process is
        // backgrounded. Every INTERNAL path here is already stopped by the
        // generation bump in `handleDidEnterBackground()`; this closes the
        // remaining one, a host calling `connect()` between the background and
        // foreground transitions. Refusing costs nothing: `handleWillEnterForeground()`
        // connects unconditionally, so the client is never left wedged.
        guard !isBackgrounded else {
            stateLock.unlock()
            return
        }
        connectGeneration &+= 1
        let generation = connectGeneration
        // PR-fix 7 — claiming the generation and DISOWNING the predecessor are
        // one act, under one lock hold.
        //
        // The generation alone does not supersede a task: `isCurrentTask`
        // compares the stamp on the task against `currentTaskStamp`, and
        // bumping the generation leaves that field naming the predecessor. Its
        // delayed `didCloseWith` — the second of the two signals every drop
        // produces, ~ms after the `receiveLoop` failure that armed the timer
        // that brought us here — therefore still read as current for the WHOLE
        // announce window, arming another reconnect under the NEW generation.
        // Nothing can catch that timer afterwards (its generation IS current),
        // so it later cancelled the socket this attempt opened cleanly and
        // announced again: reconnect churn, a wasted single-use ticket, and a
        // second dashboard row for one device.
        //
        // `disconnect()` and `handleDidEnterBackground()` already do exactly
        // this; the reconnect entry point was the one that did not, and it is
        // the one every drop goes through. Cancelling — not merely dropping the
        // reference — is required for the same reason `openSocket` cancels:
        // URLSession keeps an unreferenced task alive and connected.
        let doomed = task
        task = nil
        currentTaskStamp = nil
        stateLock.unlock()
        doomed?.cancel(with: .goingAway, reason: nil)

        guard let announcer = announcer else {
            // No Everframe SDK key — no HTTP call at all, exactly as before companion.
            openSocket(Self.wsURLForTV(endpoint: endpoint), generation: generation)
            return
        }
        Task { [weak self] in
            guard let self = self else { return }
            // Capability rule (spec 2026-08-19): `.custom` always advertises
            // support (a custom UI, or the RN bridge, owns rendering it);
            // `.builtin` advertises it only when the reporter-UI module is
            // actually linked and installed — builtin without that module
            // degrades honestly to the legacy no-PIN announce; `.off` never
            // advertises it.
            let supportsAttachPin = self.attachPinUi == .custom
                || (self.attachPinUi == .builtin && (self.companion?.__builtinPinUiInstalled ?? false))
            // Resolved once per client and cached — see `resolveDeviceOnce()`.
            // nil (Keychain unavailable, no explicit override) simply omits
            // the `device` key from the announce body.
            let device = await self.resolveDeviceOnce()
            // Fresh ticket per attempt. Nothing retains `result` past this
            // scope; the next attempt announces again.
            let result = await announcer.announce(
                label: self.deviceLabel, supportsAttachPin: supportsAttachPin, device: device)
            // `disconnect()`, or a newer attempt, may have superseded this one
            // while the request was in flight — never resurrect a socket the
            // host closed, and never open a second one alongside the winner.
            // Checked BEFORE `__setCode` so a losing attempt cannot publish
            // its (already dead) display code either.
            guard self.isAttemptCurrent(generation) else { return }
            guard let result = result else {
                // Announce failed for ANY reason (offline, revoked key, 404
                // on an older server, timeout). Fall through to the plain,
                // ticketless path: discovery is allowed to fail, reporting
                // is not.
                self.companion?.__setCode(nil)
                // resolvedName shares code's lifecycle — nulled on the same
                // failure path; there is no successful announce to read one
                // off.
                self.companion?.__setResolvedName(nil)
                self.openSocket(Self.wsURLForTV(endpoint: self.endpoint), generation: generation)
                return
            }
            self.companion?.__setCode(result.code)
            self.companion?.__setResolvedName(result.resolvedName)
            // SECURITY: the ticket rides the socket URL and is never logged.
            self.openSocket(Self.wsURLForTicket(endpoint: self.endpoint, ticket: result.ticket),
                            generation: generation)
        }
    }

    /// Whether the attempt that claimed `generation` still owns the client.
    /// A plain synchronous accessor because `NSLock.lock()` is unavailable
    /// directly inside an async context (`beginConnect`'s announce Task).
    private func isAttemptCurrent(_ generation: UInt64) -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return !isClosed && generation == connectGeneration
    }

    /// Synchronous peek at the device cache — mirrors `isAttemptCurrent`'s
    /// reasoning: `NSLock.lock()`/`unlock()` are unavailable directly inside
    /// an `async func` body (a warning today, an error under the Swift 6
    /// language mode), so the lock hold has to live in an ordinary
    /// synchronous function that an async caller merely CALLS, not `await`s.
    private func cachedDevice() -> (resolved: Bool, device: AnnounceDevice?) {
        stateLock.lock()
        defer { stateLock.unlock() }
        return (deviceResolved, resolvedDevice)
    }

    /// Stores the resolved device, first-write-wins. Same synchronous-only
    /// reasoning as `cachedDevice()`.
    private func storeCachedDevice(_ device: AnnounceDevice?) {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard !deviceResolved else { return }
        resolvedDevice = device
        deviceResolved = true
    }

    /// Resolves `AnnounceDevice` once, lazily, and caches it for every later
    /// announce this client makes — Keychain access and UIDevice reads cost
    /// nothing per se, but there's no reason to repeat them on every
    /// reconnect when the answer cannot change within a client's lifetime.
    ///
    /// The read-then-maybe-compute-then-store shape (rather than a single
    /// lock hold spanning the `await`, which `NSLock` cannot do) means two
    /// concurrent first announces CAN both compute — first-write-wins in
    /// `storeCachedDevice`. That benign race is acceptable:
    /// `CompanionDeviceFacts.current(explicit:)` is idempotent (the Keychain
    /// id, once created, is simply read back the second time), so both
    /// computations agree.
    private func resolveDeviceOnce() async -> AnnounceDevice? {
        let cached = cachedDevice()
        if cached.resolved { return cached.device }
        let device: AnnounceDevice?
        if let override = __deviceResolverOverride {
            device = await override()
        } else {
            device = await CompanionDeviceFacts.current(explicit: companionDeviceId)
        }
        storeCachedDevice(device)
        return device
    }

    /// Whether `t` is the socket this client currently owns. Callbacks from a
    /// superseded task — one we cancelled in order to replace it — must be
    /// ignored, or our own supersede-cancel reads as a drop: it schedules a
    /// reconnect that cancels the socket it just opened, forever.
    ///
    /// Compared by the stamp we write onto the task rather than by object
    /// identity against `task`, because `task` is nil for the WHOLE announce
    /// hop on every reconnect (`connect()` clears it, and the ticket can take
    /// seconds to arrive) — and identity cannot tell "a predecessor we just
    /// cancelled" from "nothing installed yet" while it is nil. Treating the
    /// former as current is exactly the defect: its close arms a reconnect
    /// under the NEW generation, which the generation guard cannot catch, and
    /// that timer later cancels a socket that opened cleanly. The stamp
    /// travels WITH the task, so a predecessor stays identifiable no matter
    /// what we are or are not currently holding.
    ///
    /// Both nil (no stamp on the task, none installed here) means the task was
    /// never created by `openSocket` — impossible in production, where every
    /// task this delegate hears about came from there; it is the shape the
    /// `__openSocketHook` tests fabricate, and they are treated as before.
    private func isCurrentTask(_ t: URLSessionWebSocketTask) -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return t.taskDescription == currentTaskStamp
    }

    /// Creates the socket for an already-resolved URL and arms the receive
    /// loop. Split out so the ticketed (async) and ticketless (sync) paths
    /// share one place that touches `task`. `generation` is re-checked here,
    /// under the same lock that installs the task, so the check and the
    /// install cannot be interleaved by a competing attempt.
    private func openSocket(_ url: URL, generation: UInt64) {
        stateLock.lock()
        guard !isClosed, generation == connectGeneration else {
            stateLock.unlock()
            return
        }
        if let hook = __openSocketHook {
            stateLock.unlock()
            hook(url)
            return
        }
        // Never leave an orphan: URLSession keeps a task we merely stop
        // referencing alive and connected, which on this leg means a second
        // live `/relay/tv` socket and a duplicate row in the dashboard.
        task?.cancel(with: .goingAway, reason: nil)
        let newTask = session.webSocketTask(with: url)
        // A phone returns the baked TV screenshot as one binary message. At
        // 1080p/4K it can exceed Foundation's default receive buffer even when
        // it fits ingest. Match the relay's bounded MAX_PAYLOAD_BYTES (25 MiB
        // report budget + 1 MiB framing headroom), before the first receive.
        newTask.maximumMessageSize = 26 * 1024 * 1024
        // Stamp it so its delegate callbacks stay attributable after we stop
        // referencing it — see `isCurrentTask`. Nothing else in this Everframe SDK reads
        // or writes `taskDescription`, and these tasks belong to a session we
        // own exclusively.
        let stamp = "everframe-relay-\(generation)"
        newTask.taskDescription = stamp
        task = newTask
        currentTaskStamp = stamp
        stateLock.unlock()
        newTask.resume()
        receiveLoop()
    }

    /// Closes the relay connection cleanly. After disconnect(), `state`
    /// stays at its last value — hosts typically don't need this; relay
    /// auto-closes on app termination.
    public func disconnect() {
        // Permanent: this client is done, so the session is torn down rather
        // than merely stopped, and the stash goes with it. Report-grade pixels
        // of the user's screen must not outlive the client authorised to hold
        // them.
        //
        // The socket is dying here regardless of whether it was ever open —
        // same "no cleared frame can ever arrive" reasoning as
        // `scheduleReconnect()` (spec 2026-08-19 review finding 2).
        companion?.__setAttachChallenge(nil)
        // External review, finding N2 — a disconnected client's pair no
        // longer exists, so any dashboard attach it carried ends with it.
        // Mirrors the `pair.expired`/`pair.created` handlers above (and the
        // web ws-client's own three attachedUserName-clearing boundaries):
        // resolvedName is deliberately left alone — it's device identity,
        // not attach state.
        companion?.__setAttachedUserName(nil)
        routePreviewTeardown()
        resetSubmitFraming()
        #if canImport(UIKit)
        // The badge dies with the client that owns it, exactly like
        // previewSession above — see CompanionBadge.teardown()'s doc. Without
        // this, `attachedUserName` is only ever cleared on the (separate)
        // terminal-close branch elsewhere, so a plain disconnect() while
        // attached left the badge on screen indefinitely, and because the
        // URLSession delegate retain keeps this client alive, each
        // start/stop cycle piled up another live overlay window.
        badge?.teardown()
        #endif
        stateLock.lock()
        isClosed = true
        // Supersede any in-flight announce: its continuation drops instead of
        // opening a socket the host just closed.
        connectGeneration &+= 1
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        currentTaskStamp = nil
        stateLock.unlock()
    }

    // MARK: - Companion attribution (read by the submit path)

    /// Companion attribution token for the pair this client is currently
    /// serving — from the newest frame that carried one (`report.request`
    /// preferred over `pair.bonded`), or nil on an ordinary QR bond. The
    /// capture-bridge submit path sends it as the `X-Everframe-Companion-Attribution`
    /// header and nothing else reads it. Named after the web client's
    /// `getCompanionAttribution()` so the three Everframe SDK legs stay greppable
    /// together. SECURITY: never log the return value.
    internal func getCompanionAttribution() -> String? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return attributionToken
    }

    // MARK: - Send (text + binary) — used by CompanionCaptureBridge

    /// Encode a `EverframeRelayMessage` as JSON text and send as a WS text frame.
    /// No-op if the task isn't open (silent drop — relay will be reconnected
    /// by the scheduler).
    public func send(_ msg: EverframeRelayMessage) {
        // The device is the sender of every terminal report frame, so this is
        // the one choke point that sees a report end however it ended. The shot
        // stash exists only for the report being assembled; holding
        // report-grade screenshots of the user's screen past that point is the
        // same failure the preview's own time cap exists to prevent, and
        // nothing else cleared it (pair-loss and backgrounding only).
        // Correlation-SCOPED, for the same reason the cancel path is: a submit
        // deliberately outlives the bond that started it, so report A's LATE
        // completion can land while report B is already live. An unconditional
        // clear there erased B's captures and cancelled B's in-flight shot,
        // leaving it pending forever.
        switch msg {
        case .reportCompleted(let m):
            routePreviewStashClearFor(correlationId: m.correlationId)
        case .reportFailed(let m):
            routePreviewStashClearFor(correlationId: m.correlationId)
        case .reportRejected(let m):
            if let corrId = m.correlationId { routePreviewStashClearFor(correlationId: corrId) }
        default:
            break
        }
        guard let data = try? JSONEncoder().encode(msg),
              let text = String(data: data, encoding: .utf8) else { return }
        // Encoding happens first even under the hook, so a message that cannot
        // be serialised fails a test the same way it fails in production.
        if let hook = __sendHook {
            hook(msg)
            return
        }
        stateLock.lock()
        let t = task
        stateLock.unlock()
        t?.send(.string(text)) { _ in }
    }

    /// Send a raw binary frame (used for PNG payload after `report.assembled`
    /// per protocol D-05 — binary follows metadata).
    public func sendBinary(_ bytes: Data) {
        stateLock.lock()
        let t = task
        stateLock.unlock()
        t?.send(.data(bytes)) { _ in }
    }

    // MARK: - Receive loop (must re-arm — RESEARCH Pitfall 3)

    private func receiveLoop() {
        stateLock.lock()
        let t = task
        stateLock.unlock()
        guard let t = t else { return }
        t.receive { [weak self] result in
            guard let self else { return }
            // Frames from (and failures of) a socket we have already replaced
            // must not touch state or schedule anything — see `isCurrentTask`.
            guard self.isCurrentTask(t) else { return }
            switch result {
            case .success(let message):
                switch message {
                case .data(let bytes):
                    self.handleBinary(bytes)
                case .string(let s):
                    self.handleControl(s)
                @unknown default:
                    break
                }
                // CRITICAL: re-arm. URLSessionWebSocketTask.receive is one-shot.
                self.receiveLoop()
            case .failure:
                // Don't auto-reconnect from here — the delegate's didCloseWith
                // is the canonical close-handling site. .failure here is
                // typically followed by a delegate callback within ~ms.
                self.stateLock.lock()
                let closed = self.isClosed
                self.stateLock.unlock()
                if !closed {
                    self.scheduleReconnect()
                }
            }
        }
    }

    // MARK: - Message handlers

    // `internal` (not `private`) so @testable tests can drive control-frame
    // decoding without spinning up a real WS server. Production callers
    // remain inside this file (`receiveLoop` only).
    internal func handleControl(_ text: String) {
        guard let data = text.data(using: .utf8) else { return }
        guard let msg = try? JSONDecoder().decode(EverframeRelayMessage.self, from: data) else {
            // Defense-in-depth: server already Zod-validated; malformed text
            // frames are silently dropped (T-06.2-07-03).
            return
        }
        switch msg {
        case .pairCreated(let p):
            // Compose pair URL from endpoint + pair_token per SPEC §3 (URL shape `/r/<pair_token>`).
            // SECURITY: do not log p.pairToken — it's a single-use credential.
            let url = Self.pairURL(endpoint: endpoint, pairToken: p.pairToken)
            companion?.__setPairUrl(url)
            // External review, finding N2 — mirrors the web ws-client's
            // `pair.created` handler: the server destroys the pair record on
            // ANY TV-socket close (terminal or not), so a `pair.created`
            // reaching us here is by construction an UNBONDED pair — a
            // rebond, if any, arrives as its own `pair.bonded`. Any attach
            // state retained from a previous bond on an earlier connection is
            // therefore stale and must not survive: without this, a
            // non-terminal close that silently killed the bond leaves the
            // badge claiming the old user is still attached indefinitely.
            // resolvedName is deliberately left alone — it's device
            // identity, not attach state.
            companion?.__setAttachedUserName(nil)
            companion?.__setState(.unpaired)
        case .pairBonded(let p):
            // A replacement bond abandons the old report and its frozen replay.
            if companion?.state == .reportInProgress { resetSubmitFraming() }
            stateLock.lock()
            // SECURITY: do not log p.deviceToken.
            deviceToken = p.deviceToken
            // Companion attach (spec 2026-08-07): both `attribution_token` and
            // `companion_user` are OPTIONAL and both ABSENT on an ordinary QR
            // bond. Assign unconditionally — resetting to nil when the frame
            // does not carry them is what stops a later ordinary bond on the
            // same session from inheriting a stale companion identity from an
            // earlier dashboard attach. SECURITY: never log p.attributionToken.
            attributionToken = p.attributionToken
            stateLock.unlock()
            companion?.__setAttachedUserName(p.companionUser?.displayName)
            // Keep pairUrl intact on bond — it's nulled only on socket close
            // (didCloseWith terminal codes below). The pair token is single-use
            // server-side so a retained URL is harmless; hosts drive QR teardown
            // off `state == .paired`.
            companion?.__setState(.paired)
        case .pairExpired:
            stateLock.lock()
            deviceToken = nil
            stateLock.unlock()
            // The pair is gone: stop reading the screen, and drop the stashed
            // report-grade captures with it.
            routePreviewPairLoss()
            resetSubmitFraming()
            // External review, finding N2 — mirrors the web ws-client's
            // `pair.expired` handler: a released bond ends the attach — the
            // badge (gated on attachedUserName) must not survive a detach.
            // resolvedName is deliberately kept: it's device identity, not
            // attach state.
            companion?.__setAttachedUserName(nil)
            companion?.__setState(.unpaired)
        case .phoneDisconnected:
            // Phone WS closed (browser tab close, network drop, app
            // backgrounded). Keep device_token + pairUrl intact — server
            // holds the pair record open for 5 minutes; if the phone
            // reconnects we'll get a fresh `pair.bonded` and flip back to
            // .paired. If the grace window elapses we'll get `pair.expired`
            // and fully reset.
            //
            // Nobody is left to receive frames, so the preview stops and the
            // stash goes with it — a reconnecting phone starts a new report
            // cycle and must never be able to re-crop the old one's pixels.
            routePreviewPairLoss()
            resetSubmitFraming()
            companion?.__setState(.phoneDisconnected)
        case .reportRequest(let r):
            // Serial-report invariant (SPEC: "one report at a time per pair"),
            // mirroring Android's `is EverframeReportRequest` branch. Read the state
            // BEFORE writing it: a second `report.request` arriving mid-report
            // used to re-enter `.reportInProgress` unconditionally, which
            // re-freezes the replay/breadcrumb snapshot the in-flight composer
            // is about to consume, and lets whichever report finishes first
            // flip the OTHER one's pair to `.paired`. Reject instead — no state
            // change, no dispatch, and nothing sent to the capture bridge.
            if companion?.state == .reportInProgress {
                // No token write above this line, and that placement is the
                // point: the branch's invariant is that a report carries the
                // token minted FOR it. Storing a rejected request's token would
                // hand it to the report already running (which has its own) or
                // to the next one (which will get its own), and the token is
                // single-use — so writing it here spends a credential on a
                // report that will never exist. SECURITY: never log.
                send(.reportRejected(EverframeReportRejected(
                    correlationId: r.correlationId,
                    reason: "in_flight",
                    type: "report.rejected")))
                return
            }
            // The relay mints a FRESH attribution token on every
            // `report.request` for an attached (companion) pair — a bond-time
            // token goes stale after 10 minutes while a companion session can
            // stay attached for hours. Always prefer the newest token seen: an
            // older server, or an ordinary QR pair (which never gets one),
            // sends none, and the bond-time value — possibly nil — is simply
            // left in place. SECURITY: never log.
            if let fresh = r.attributionToken {
                stateLock.lock()
                attributionToken = fresh
                stateLock.unlock()
            }
            // `__beginReport`, not `__setState(.reportInProgress)`: the state
            // is claimed BY this correlation_id, and only a completion carrying
            // the same one may give it back (PR-fix 7).
            companion?.__beginReport(correlationId: r.correlationId)
            NotificationCenter.default.post(
                name: .everframeCompanionReportRequested,
                object: self,
                userInfo: ["correlation_id": r.correlationId])
        case .reportSubmit(let r):
            print("[everframe-companion] WS recv report.submit corrId=\(r.correlationId)")
            // D-05: the phone follows this text frame with ONE binary frame
            // (the baked annotated PNG). Remember the correlation_id so
            // handleBinary(...) can post the bytes to the bridge keyed to
            // this submit. Cleared on binary arrival.
            stateLock.lock()
            pendingSubmitCorrelationId = r.correlationId
            stateLock.unlock()
            // Forwarded to the capture bridge; bridge applies includes/redactions
            // and submits via the existing JSONLOutbox pipeline.
            NotificationCenter.default.post(
                name: .everframeCompanionReportSubmit,
                object: self,
                userInfo: [
                    "correlation_id": r.correlationId,
                    "submit": r,
                ])
        case .reportCompleted(let r):
            // Only THIS report's completion may hand `.reportInProgress` back
            // (PR-fix 7) — a completion echoed for a report a re-bond already
            // superseded would otherwise clear the live one's state.
            companion?.__finishReport(correlationId: r.correlationId)
            NotificationCenter.default.post(
                name: .everframeCompanionReportCompleted,
                object: self,
                userInfo: ["correlation_id": r.correlationId, "event_id": r.eventId])
        case .reportFailed(let r):
            // Same rule as `.reportCompleted` — a stale FAILURE clearing a live
            // report is the identical bug.
            companion?.__finishReport(correlationId: r.correlationId)
            NotificationCenter.default.post(
                name: .everframeCompanionReportFailed,
                object: self,
                userInfo: ["correlation_id": r.correlationId, "reason": r.reason])
        case .reportRejected:
            // Relay's "another report already in flight" notice — no state change.
            break
        case .reportCancelled(let r):
            // Phone-side cancel: reporter SPA user tapped Discard after
            // report.request was sent. Clear any pending submit binding
            // for the same correlation_id and return to .paired so the
            // host UI clears its "report in progress" indicator.
            //
            // The report this stash was captured for is over, so the
            // report-grade pixels go with it. Correlation-scoped: a DELAYED
            // cancellation from an older report must not delete the CURRENT
            // report's captures, or a later re-crop silently captures the
            // current screen under the old shot id.
            routePreviewStashClearFor(correlationId: r.correlationId)
            stateLock.lock()
            if pendingSubmitCorrelationId == r.correlationId {
                pendingSubmitCorrelationId = nil
            }
            stateLock.unlock()
            // Ordering is intentional — discard must complete before the phone
            // can be prompted to start the next report, which is why it runs
            // inside `__finishReport`'s claim rather than ahead of it. A cancel
            // for a report a re-bond already superseded must discard NOTHING:
            // the frozen snapshot now belongs to the live report (PR-fix 7).
            Task { @MainActor [weak self] in
                self?.companion?.__finishReport(correlationId: r.correlationId) {
                    CompanionCaptureBridge.abortReportCaptureLifecycle()
                }
            }
        case .reportAssembled, .reportDraftUpdate:
            // TV doesn't receive these from itself (TV is the producer).
            break
        case .previewStart(let msg):
            print("[everframe-companion] preview.start corrId=\(msg.correlationId)")
            routePreviewStart(correlationId: msg.correlationId)

        case .previewStop(let msg):
            // Phone-initiated stop: go quiet without echoing a stop frame back
            // at the peer that just sent us one.
            print("[everframe-companion] preview.stop corrId=\(msg.correlationId) reason=\(msg.reason)")
            routePreviewStop()

        case .shotRequest(let msg):
            // `msg.correlationId` — the id carried on THIS frame — not read
            // back off session state. Android's task-11 CRITICAL 1: the old
            // shape read the session's own (possibly already-nulled) id, and a
            // `shot.request` immediately followed by `preview.stop` — exactly
            // what the phone's snapshot flow sends — dropped the shot silently:
            // no `shot.assembled`, no `shot.failed`, no retry affordance.
            let rect = msg.rect.map { NormalizedRect(x: $0.x, y: $0.y, w: $0.w, h: $0.h) }
            routeShotRequest(correlationId: msg.correlationId, shotId: msg.shotId, rect: rect)

        case .shotBinary(let msg):
            // Phone -> device, at SUBMIT time: binds the next binary frame to
            // this shot_id. An earlier revision of this switch lumped
            // `shot.binary` in with the device-sent frames below and called it
            // a protocol violation — wrong: the device is the RECEIVER, and
            // treating it as unhandled meant every extra shot's bytes were
            // dropped, so a multi-shot report uploaded only the primary
            // screenshot and still reported success.
            stateLock.lock()
            pendingShotBinary = (correlationId: msg.correlationId, shotId: msg.shotId)
            stateLock.unlock()

        case .previewFrame, .shotAssembled, .shotFailed:
            // Genuinely phone-bound: the device is the sole sender of these, so
            // receiving one is a protocol violation rather than a case to
            // handle. Terminal on purpose.
            break

        case .attachChallenge(let c):
            // Dashboard member requested attach (spec 2026-08-19). SECURITY:
            // never log `c.code` — it authenticates the attach.
            companion?.__setAttachChallenge(CompanionAttachChallenge(
                code: c.code, requestedByName: c.requestedByName, ttlMs: c.ttlMs))

        case .attachChallengeCleared:
            // reason is expired|attached|burned|superseded — every reason
            // means "this PIN is no longer live", so all of them just clear
            // it. Nothing here distinguishes them; a host wanting to react
            // differently reads the frame's own `reason` off the relay layer
            // (out of scope for this surface, which is display-only).
            companion?.__setAttachChallenge(nil)

        case .companionName(let n):
            // EverframeDevice naming (spec 2026-08-24): resolved display name pushed
            // after a dashboard rename. Mirror the web client's guard
            // (ws-client.ts:318-327) — the generated struct accepts any
            // string, so re-check 1...80 here rather than trust the wire.
            // Out-of-range is silently ignored (defense-in-depth, matching
            // the malformed-frame handling above): the server already
            // validates length, so this only guards a stale/misbehaving peer.
            if (1...80).contains(n.name.count) {
                companion?.__setResolvedName(n.name)
            }
        }
    }

    /// Test seam — `handleBinary` is private and driven by the receive loop,
    /// which the routing tests deliberately never start.
    internal func __handleBinaryForTesting(_ bytes: Data) { handleBinary(bytes) }

    private func handleBinary(_ bytes: Data) {
        // Plan 06.2-12: route binary frames that follow a `report.submit` text
        // frame to the capture bridge. The phone sends submit→binary in
        // strict D-05 order (reporter EverframeApp.tsx handleSubmit). If no submit is
        // pending, the frame is dropped (forward compatibility — v1 protocol
        // doesn't define other phone→TV binary frames).
        stateLock.lock()
        // A `shot.binary` marker takes precedence: it was sent immediately
        // before these bytes and names the shot they belong to.
        let shotBinding = pendingShotBinary
        pendingShotBinary = nil
        let corrId = shotBinding == nil ? pendingSubmitCorrelationId : nil
        if shotBinding == nil { pendingSubmitCorrelationId = nil }
        stateLock.unlock()
        if let shotBinding {
            NotificationCenter.default.post(
                name: .everframeCompanionReportShotBinary,
                object: self,
                userInfo: [
                    "correlation_id": shotBinding.correlationId,
                    "shot_id": shotBinding.shotId,
                    "bytes": bytes,
                ])
            return
        }
        print("[everframe-companion] WS recv binary bytes=\(bytes.count) corrId=\(corrId ?? "<none>")")
        guard let corrId = corrId else {
            print("[everframe-companion] WS binary DROPPED — no pending submit corrId")
            return
        }
        NotificationCenter.default.post(
            name: .everframeCompanionReportSubmitBinary,
            object: self,
            userInfo: [
                "correlation_id": corrId,
                "bytes": bytes,
            ])
    }

    // MARK: - URLSessionWebSocketDelegate

    public func urlSession(_ session: URLSession,
                           webSocketTask: URLSessionWebSocketTask,
                           didOpenWithProtocol protocolName: String?) {
        guard isCurrentTask(webSocketTask) else { return }
        stateLock.lock()
        reconnectAttempt = 0
        stateLock.unlock()
    }

    public func urlSession(_ session: URLSession,
                           webSocketTask: URLSessionWebSocketTask,
                           didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
                           reason: Data?) {
        // A close we caused by superseding this task is not a drop — see
        // `isCurrentTask`. Without this the cancel inside `openSocket` would
        // schedule a reconnect that cancels the socket it just opened.
        guard isCurrentTask(webSocketTask) else { return }
        // Close-code catalog (authority: the relay threat model).
        // 4001..4004 are terminal for the pair — the TV must re-pair from a
        // fresh `pair.created`; 4005+ are transient and just get a backoff.
        //   4001 = already_bonded        — terminal, full re-pair.
        //   4002 = pair_expired          — terminal, full re-pair.
        //   4003 = grace_exceeded        — phone never came back inside the
        //                                  grace window; terminal, full re-pair.
        //   4004 = token_not_found       — pair token (or announce ticket)
        //                                  never existed / already spent;
        //                                  terminal, full re-pair.
        //   4005 = server_shutdown       — reconnect with a new pair.
        //   4006 = malformed_frame       — transport; backoff + reconnect.
        //   4007 = oversize_binary_frame — transport; backoff + reconnect.
        //   4008 = tv_announce_backlog   — relay is shedding announce load;
        //                                  retryable, backoff + reconnect.
        let raw = closeCode.rawValue
        switch raw {
        case 4001, 4002, 4003, 4004:
            stateLock.lock()
            deviceToken = nil
            // SECURITY: never log. The companion identity dies with the pair.
            attributionToken = nil
            isClosed = false  // we'll reconnect with a fresh pair
            stateLock.unlock()
            companion?.__setState(.unpaired)
            companion?.__setPairUrl(nil)
            // `code`, `attachedUserName`, and `resolvedName` share `pairUrl`'s
            // lifecycle — cleared wherever it is. A stale display code (or
            // name) would send the dashboard user chasing a row that no
            // longer exists.
            companion?.__setCode(nil)
            companion?.__setAttachedUserName(nil)
            companion?.__setResolvedName(nil)
            // A dead pair leaves no bond for a pending attach PIN to attach
            // to — clear it rather than let a stale code linger on screen
            // (spec 2026-08-19).
            companion?.__setAttachChallenge(nil)
            scheduleReconnect()
        default:
            // 4005 / 4006 / 4007 / 4008 / normal — reconnect.
            stateLock.lock()
            let closed = isClosed
            stateLock.unlock()
            if !closed { scheduleReconnect() }
        }
    }

    // MARK: - Reconnect with exponential backoff (cap 10 s)

    private func scheduleReconnect() {
        // The socket that authorised any live preview is gone. Stop reading the
        // user's screen NOW rather than letting the loop run out its two-minute
        // cap against a dead socket — and, worse, resume emitting frames under
        // a stale correlation id once the replacement socket opens. THE RULE
        // THAT MATTERS MOST in CompanionPreviewSession's own header: a preview
        // must never outlive the thing that authorised it. Every drop funnels
        // through here, which is why the stop lives here rather than at each
        // individual failure site.
        //
        // Same reasoning extends to attachChallenge (spec 2026-08-19 review
        // finding 2): the server deletes the pair on ANY TV-socket close, not
        // only the terminal-close-code cases — so no `attachChallengeCleared`
        // frame can ever arrive once we're here, and a retained challenge
        // would be permanently stale. `didCloseWith`'s terminal branch already
        // clears it explicitly before calling this function (redundant with
        // the line below, harmless); this is what covers the NON-terminal
        // `didCloseWith` branch and `receiveLoop`'s `.failure` branch, both of
        // which call this function directly without clearing first.
        companion?.__setAttachChallenge(nil)
        routePreviewPairLoss()
        resetSubmitFraming()
        stateLock.lock()
        let hook = __scheduleReconnectHook
        // One drop, one reconnect: a timer already armed for THIS attempt makes
        // the drop's second signal redundant. Scoped to the generation, so a
        // superseded attempt's marker never suppresses a genuinely new drop.
        // The `__scheduleReconnectHook` path is exempt because it only records
        // the computed delay and never reconnects — nothing would clear the
        // marker.
        if hook == nil && reconnectArmedForGeneration == connectGeneration {
            stateLock.unlock()
            return
        }
        let idx = min(reconnectAttempt, Self.backoffSchedule.count - 1)
        let delay = Self.backoffSchedule[idx]
        reconnectAttempt += 1
        let token = deviceToken
        let armedGeneration = connectGeneration
        if hook == nil { reconnectArmedForGeneration = armedGeneration }
        stateLock.unlock()

        // Test seam: record delay without actually sleeping.
        if let hook = hook {
            hook(delay)
            return
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self else { return }
            self.stateLock.lock()
            // Fire only if this timer's attempt still owns the client. A
            // direct `connect()`, a `disconnect()`, or a newer reconnect
            // superseded it otherwise — firing anyway would cancel and
            // replace a connection that is already healthy, spending another
            // single-use ticket to do it. The marker is left alone in that
            // case: it belongs to whoever armed most recently.
            guard !self.isClosed, armedGeneration == self.connectGeneration else {
                self.stateLock.unlock()
                return
            }
            self.reconnectArmedForGeneration = nil
            self.stateLock.unlock()
            if let dt = token {
                self.connectWithDeviceToken(dt)
                return
            }
            // Same path as cold start — announces again with a fresh ticket.
            self.beginConnect()
        }
    }

    /// Reconnect straight to `/relay/phone/reconnect/<device_token>`, skipping
    /// the announce.
    ///
    /// Dead in practice on this leg: the server deliberately never sends
    /// `device_token` to the TV (the relay service — "Don't leak the
    /// device_token to the TV"), so the caller's `token` is always nil here and
    /// every real reconnect takes `beginConnect()`. Left in place for the
    /// phone-side shape.
    ///
    /// It still carries the background guard, because it composes a connect
    /// attempt WITHOUT going through `beginConnect()` — the one place that
    /// guard used to live. The generation check in the timer above is not a
    /// substitute: it releases the lock before this call, so backgrounding in
    /// between would find a freshly claimed, perfectly current generation here
    /// and dial. Claiming the generation under the SAME lock hold that reads
    /// `isBackgrounded` is what closes that window.
    ///
    /// `internal` so a test can reach it: that race cannot be staged
    /// deterministically through the public surface (see
    /// `deviceTokenReconnect_opensNoSocketWhileBackgrounded`).
    internal func connectWithDeviceToken(_ deviceToken: String) {
        stateLock.lock()
        guard !isClosed, !isBackgrounded else {
            stateLock.unlock()
            return
        }
        connectGeneration &+= 1
        let generation = connectGeneration
        stateLock.unlock()
        // SECURITY: device_token rides the URL path — TLS protects it on the
        // wire. Never logged.
        openSocket(Self.wsURLForPhoneReconnect(endpoint: endpoint, deviceToken: deviceToken),
                   generation: generation)
    }

    // MARK: - URL composition

    static func wsURLForTV(endpoint: URL) -> URL {
        var c = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)!
        c.scheme = wsScheme(for: c.scheme)
        c.path = "/relay/tv"
        return c.url!
    }

    /// `wss://<endpoint>/relay/tv/<ticket>` — the ticketed handshake. The
    /// ticket is single-use and spent by the server on this handshake.
    /// SECURITY: the resulting URL contains a credential; never log it.
    static func wsURLForTicket(endpoint: URL, ticket: String) -> URL {
        var c = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)!
        c.scheme = wsScheme(for: c.scheme)
        // RFC-3986 unreserved set — the `encodeURIComponent` equivalent the
        // web client uses, so a ticket containing `/` or `?` can never
        // restructure the URL.
        let unreserved = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        let encoded = ticket.addingPercentEncoding(withAllowedCharacters: unreserved) ?? ticket
        c.percentEncodedPath = "/relay/tv/\(encoded)"
        return c.url!
    }

    static func wsURLForPhoneReconnect(endpoint: URL, deviceToken: String) -> URL {
        var c = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)!
        c.scheme = wsScheme(for: c.scheme)
        c.path = "/relay/phone/reconnect/\(deviceToken)"
        return c.url!
    }

    /// Public pair URL the host renders as a QR. Always `https://` over the wire
    /// (matches the relay's TLS posture per SPEC threat model T-06.2-07-04;
    /// dev/localhost exemption inherited from ATS rules in ConfigValidator).
    static func pairURL(endpoint: URL, pairToken: String) -> String {
        var c = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)!
        // pairUrl is opened in the phone's browser, not a WS — keep http(s)//.
        c.path = "/r/\(pairToken)"
        return c.url?.absoluteString ?? "\(endpoint.absoluteString)/r/\(pairToken)"
    }

    private static func wsScheme(for scheme: String?) -> String {
        switch (scheme ?? "").lowercased() {
        case "http":  return "ws"
        case "https": return "wss"
        case "ws":    return "ws"
        case "wss":   return "wss"
        default:      return "wss"
        }
    }

    // MARK: - EverframeApp lifecycle (Pitfall 4 — backgrounding kills WS)
    //
    // The two handlers are compiled on EVERY platform; only the `@objc`
    // notification hooks that call them are conditional, on `canImport(UIKit)`
    // alone. That split is deliberate and load-bearing for coverage: the
    // widest slice CI runs these suites on is `swift test` on macOS, where
    // `canImport(UIKit)` is false — so a handler buried behind the conditional
    // could never be gated there at all. What that macOS slice CANNOT prove is
    // that the notifications are observed on a given platform, which is the
    // whole of the tvOS defect; `CompanionLifecycleNotificationTests` covers
    // that by posting the real notifications, and CI runs it on a tvOS
    // simulator (`.github/workflows/swift.yml`, `lifecycle-tests-tvOS`).

    /// The process has entered the background. Supersede whatever connect
    /// attempt is in flight and own no socket, so nothing can open one until
    /// the app comes back.
    ///
    /// Bound to `didEnterBackground`, not `willResignActive` — see `init` for
    /// why a transient interruption must NOT land here.
    ///
    /// Cancelling the installed task is NOT sufficient, and is not even the
    /// main case: with announce in front of every attempt (including every
    /// reconnect) the client frequently owns no task at all here, and the
    /// awaited announce would resolve minutes later — in the background — and
    /// open a socket that passes every guard. Three things have to happen
    /// together, under one lock:
    ///
    ///   • bump `connectGeneration`. This is the enforcing line, and it covers
    ///     BOTH internal routes: the in-flight announce's continuation drops at
    ///     `isAttemptCurrent` / `openSocket`, and a reconnect timer armed by an
    ///     earlier drop finds its `armedGeneration` stale and never reaches
    ///     `beginConnect()`. (`reconnectArmedForGeneration = nil` below is
    ///     hygiene only — the generation is monotonic, so the stale marker can
    ///     never match again. It mirrors what `stop()` does on Android; do not
    ///     read it as the thing doing the work. Measured: removing it alone
    ///     fails no test.)
    ///   • clear `task` AND `currentTaskStamp` before cancelling, so the close
    ///     callback our own cancel provokes is recognised as stale by
    ///     `isCurrentTask` and does not arm a reconnect. Leaving the stamp in
    ///     place is a resurrection path in its own right, independent of the
    ///     announce race: the cancel reads as a drop, arms a 1 s timer, and
    ///     that timer announces and connects with the app still backgrounded.
    internal func handleDidEnterBackground() {
        // Resumable, so `stopSilently()` + `clearStash()` rather than
        // `teardown()`: the SAME client reconnects on foreground, and a
        // permanently cancelled session would leave the preview dead for the
        // rest of the process.
        //
        // The `doomed?.cancel(...)` below tears the socket down WITHOUT going
        // through `didCloseWith` (the cancel clears `currentTaskStamp` first,
        // so `isCurrentTask` drops the resulting delegate callback) or
        // `scheduleReconnect()` — this is the supersession path those two
        // don't cover. Same "server deletes the pair on any TV-socket close"
        // reasoning as there (spec 2026-08-19 review finding 2).
        companion?.__setAttachChallenge(nil)
        routePreviewPairLoss()
        resetSubmitFraming()
        companion?.__setState(.phoneDisconnected)
        stateLock.lock()
        isBackgrounded = true
        connectGeneration &+= 1
        reconnectArmedForGeneration = nil
        let doomed = task
        task = nil
        currentTaskStamp = nil
        stateLock.unlock()
        doomed?.cancel(with: .goingAway, reason: nil)
    }

    /// Returning to the foreground: start over. `connect()` claims a brand-new
    /// generation and announces again — the superseded ticket was single-use
    /// with a 60 s TTL, so there is nothing to resume even if we wanted to.
    /// Exactly one attempt results: the superseded announce drops on its
    /// generation, and any timer armed before backgrounding finds its own
    /// generation stale and never reaches `beginConnect()`.
    ///
    /// Bound to `willEnterForeground`, which — unlike `didBecomeActive` — is
    /// sent only when coming back from the background, never at launch and
    /// never after a banner is dismissed. A session that was never torn down
    /// must not be re-announced.
    internal func handleWillEnterForeground() {
        stateLock.lock()
        isBackgrounded = false
        let closed = isClosed
        stateLock.unlock()
        // A host `disconnect()` outranks the lifecycle. Without this, an app
        // that stopped companion while backgrounded would find it running
        // again the moment the user came back.
        guard !closed else { return }
        // `probeAlreadyBackgrounded: false` — the ONE caller that must not ask.
        //
        // The probe exists for a host that calls `connect()` out of the blue
        // while the process happens to be away; the question "am I already
        // backgrounded?" is meaningful only when the caller has no idea. Here
        // we do: a foreground transition is by definition not "already
        // backgrounded", so the read carries no information — and it does not
        // merely add nothing, it answers WRONG. `applicationState` is still
        // `.background` when `willEnterForeground` is delivered and only
        // advances later in the same transition, while the probe is a deferred
        // `DispatchQueue.main.async` read. Land that block before the advance
        // and it says `true`, `handleDidEnterBackground()` runs on the way IN,
        // and the client is left with `isBackgrounded = true`, no socket and no
        // timer — `beginConnect()`'s guard then refuses every later attempt.
        // Wedged until a full background/foreground cycle happens to land the
        // block the other way.
        //
        // (Under the previous `didBecomeActive` binding the read was
        // unambiguously `.active`, which is why this survived the re-binding
        // review: the defect was introduced by the notification change, not by
        // the probe.)
        connect(probeAlreadyBackgrounded: false)
    }

    #if canImport(UIKit)
    @objc private func onDidEnterBackground() {
        handleDidEnterBackground()
    }

    @objc private func onWillEnterForeground() {
        handleWillEnterForeground()
    }
    #endif
}

// MARK: - Notification surface

public extension Notification.Name {
    /// Posted when the TV runtime receives a `report.request` frame from the
    /// phone. userInfo: `["correlation_id": String]`. Subscribers (typically
    /// `CompanionCaptureBridge`) run the capture pipeline and respond with
    /// `report.assembled` + binary PNG frame.
    static let everframeCompanionReportRequested =
        Notification.Name("dev.everframe.companionReportRequested")

    /// Posted when the TV runtime receives a `report.submit` frame from the
    /// phone. userInfo: `["correlation_id": String, "submit": EverframeReportSubmit]`.
    /// Subscribers apply `includes` + `description.redactions` to the
    /// in-memory draft and submit via the existing JSONLOutbox.
    static let everframeCompanionReportSubmit =
        Notification.Name("dev.everframe.companionReportSubmit")

    /// Posted when the TV runtime receives the binary PNG frame that follows
    /// a `report.submit` text frame (D-05 wire ordering). userInfo:
    /// `["correlation_id": String, "bytes": Data]`. The correlation_id keys
    /// the bytes to the most-recent submit text frame.
    static let everframeCompanionReportSubmitBinary =
        Notification.Name("dev.everframe.companionReportSubmitBinary")

    /// Posted when a binary frame arrives behind a `shot.binary {shot_id}`
    /// marker — the baked image of one EXTRA shot of a multi-shot submit.
    /// userInfo: `["correlation_id": String, "shot_id": String, "bytes": Data]`.
    static let everframeCompanionReportShotBinary =
        Notification.Name("dev.everframe.companionReportShotBinary")

    /// Posted when the phone leg ends and every half-assembled submit must be
    /// forgotten. No userInfo.
    static let everframeCompanionResetSubmitFraming =
        Notification.Name("dev.everframe.companionResetSubmitFraming")

    /// Posted on `report.completed`. userInfo: `["correlation_id": String, "event_id": String]`.
    static let everframeCompanionReportCompleted =
        Notification.Name("dev.everframe.companionReportCompleted")

    /// Posted on `report.failed`. userInfo: `["correlation_id": String, "reason": String]`.
    static let everframeCompanionReportFailed =
        Notification.Name("dev.everframe.companionReportFailed")
}
