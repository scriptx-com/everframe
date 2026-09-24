// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Phase 06.2-07 Task 2 — TV-side capture bridge for phone-driven reports.
// Phase 06.2-12 Task 2 + Task 4 — added per-correlation_id capture buffer
//   (with 5-min TTL) and real `report.submit` handler that composes
//   ReporterSubmission.Inputs from the WS-delivered submit + the binary
//   PNG frame that follows it, then submits via ReporterSubmission.submit
//   (the same pipeline the in-process iOS/tvOS reporter VCs use). On
//   success → `report.completed`. On failure → `report.failed`.
//
// Composes existing capture primitives (`ScreenshotCapture`,
// `LogRingBuffer`, `NetworkRingBuffer`) and emits relay frames on the phone's
// behalf. Does NOT re-implement any capture or submit logic — SPEC §
// Constraints: "Reuses existing native primitives" (Phase 04).
//
// Lifecycle:
//   1. Hosts wire it via `Everframe.shared.start(config:)` when
//      `config.enableCompanion == true` (Task 2 wiring in Everframe.swift).
//   2. Subscribes to `.everframeCompanionReportRequested`. On firing:
//        a. Captures a key-window screenshot (PNG + metadata).
//        b. Constructs `EverframeRelayMessage.reportAssembled(...)` with counts and
//           toggles and sends it through `RelayWSClient.send(…)`.
//        c. Immediately follows with `relayClient.sendBinary(pngData)` — D-05
//           protocol: binary frame follows the metadata text frame. Tap-to-
//           identify is gone (spec 2026-08-29), so there is no second
//           (gzipped UI-tree) binary frame and the assembled metadata never
//           announces one — the phone gracefully skips tap-to-identify, a
//           state the relay protocol already documents as supported.
//        d. Stashes the capture in the per-correlation_id buffer for
//           later use by the submit handler. 5-min TTL keeps the buffer
//           bounded across long sessions.
//   3. Subscribes to `.everframeCompanionReportSubmit` (text) and
//      `.everframeCompanionReportSubmitBinary` (PNG bytes). When both arrive
//      for the same correlation_id, composes `ReporterSubmission.Inputs`
//      from the stash + the wire payload, hops to @MainActor, and calls
//      `ReporterSubmission.submit(...)`. On `.submitted/.queued` emits
//      `report.completed`; on throw emits `report.failed`.
//
// Strict-concurrency: `ScreenshotCapture.captureKeyWindow()` is
// `@MainActor`. We hop to the main actor when handling the notification
// (which can arrive on any thread).
import Foundation
import EverframeProtocol
#if canImport(UIKit)
import UIKit
#endif

public final class CompanionCaptureBridge: @unchecked Sendable {
    private let captureOwnerID = UUID()
    private struct CaptureOwner {
        let bridgeID: UUID
        let correlationID: String
        let authEpoch: UInt64
        weak var companion: CompanionAPI?
    }
    @MainActor private static var captureOwner: CaptureOwner?

    /// Pair state may outlive a disconnected client. Only a current capture
    /// may keep a replacement Everframe SDK session frozen.
    @MainActor internal static var hasActiveReportCapture: Bool {
        guard let owner = captureOwner, owner.authEpoch == CompanionAuthEpoch.current else { return false }
        return owner.companion?.__ownsReport(correlationId: owner.correlationID) == true
    }

    @MainActor internal func captureAuthorization(correlationId: String, authEpoch: UInt64) -> @MainActor @Sendable () -> Bool {
        let bridgeID = captureOwnerID
        return {
            Self.hasActiveReportCapture && Self.captureOwner?.bridgeID == bridgeID &&
                Self.captureOwner?.correlationID == correlationId && Self.captureOwner?.authEpoch == authEpoch
        }
    }

    private weak var client: RelayWSClient?
    private var requestToken: NSObjectProtocol?
    private var submitToken: NSObjectProtocol?
    private var submitBinaryToken: NSObjectProtocol?
    /// Ingest's whole-request ceiling (the ingest API `MAX_TOTAL_BYTES`).
    private static let maxTotalRequestBytes = 25_000_000
    /// Room reserved for the envelope, replay and multipart framing.
    /// Flat rather than measured, and generous on purpose: one part short costs
    /// one screenshot, one byte over costs the entire report.
    private static let nonShotHeadroomBytes = 6_000_000
    /// Ceiling on bytes retained across half-assembled submits. The gate waits
    /// for every announced shot, so these live until the submit completes or a
    /// lifecycle event clears them.
    private static let maxRetainedSubmitBytes = 30_000_000

    private var shotBinaryToken: NSObjectProtocol?
    private var resetFramingToken: NSObjectProtocol?

    // MARK: - Per-correlation_id buffers (Plan 06.2-12 Task 2 + 4)

    #if canImport(UIKit)
    private struct CaptureStash {
        let capture: ScreenshotCapture.Result
        let capturedAt: Date
        /// Plan 06.2-13 Task 1 — host-attached opaque metadata drained from
        /// `Everframe.shared.__consumePendingAttachments()` at the moment of
        /// `report.request`. Mirrors the modal lifecycle: consumed ONCE at
        /// request time, NOT at submit time. A second back-to-back report
        /// without a fresh `setExtra` will see nil here, matching the
        /// in-process iOS/tvOS reporter modal contract.
        let hostExtra: String?
        /// PR-fix 1 — the companion attribution token that belonged to THIS
        /// report's `report.request`, snapshotted when that frame arrived.
        /// Same request-time-not-submit-time lifecycle as `hostExtra` above,
        /// and for a stronger reason: by submit time the live session may be
        /// serving a different dashboard user entirely. Nil on an ordinary QR
        /// bond, which must stay unattributed. SECURITY: never log.
        let companionAttribution: String?
    }
    #endif

    private struct PendingSubmit {
        let submit: EverframeReportSubmit
        let receivedAt: Date
    }

    /// 5 minutes — matches the relay's pair grace window in SPEC §4. After
    /// that, the phone has likely lost the pair anyway and the capture
    /// should not be silently reused.
    private static let stashTTL: TimeInterval = 5 * 60

    private let bufferLock = NSLock()
    #if canImport(UIKit)
    private var captureStash: [String: CaptureStash] = [:]

    #endif

    // Data-only, so OUTSIDE the UIKit guard: the NotificationCenter
    // observers that fill these are not themselves guarded, and keeping the
    // declarations inside broke the macOS slice with "has no member".
    /// Baked images for the EXTRA shots of an in-flight submit, keyed
    /// correlationId -> shotId.
    ///
    /// The phone announces them in `report.submit.shots[]` and sends each
    /// one's bytes behind a `shot.binary {shot_id}` marker. Until this
    /// existed the marker was treated as phone-bound and the bytes dropped, so
    /// a multi-shot report uploaded ONLY the primary screenshot and still
    /// reported success — silent loss of evidence the user explicitly
    /// captured, with the admin UI already able to render the extras.
    private var pendingShotBytes: [String: [String: Data]] = [:]

    /// The report's PRIMARY baked image, buffered until every announced shot
    /// has also arrived.
    ///
    /// It used to be a bare parameter on `tryRunSubmit`, which was fine while
    /// the submit fired the instant it landed. Once the gate had to WAIT for
    /// the extra shots, an un-buffered primary was discarded by that early
    /// return and every later call — driven by a shot arrival — passed nil, so
    /// a multi-shot submit could never complete and the phone sat on
    /// "submitting" forever.
    private var pendingPrimaryBytes: [String: Data] = [:]
    private var pendingSubmit: [String: PendingSubmit] = [:]

    public init(client: RelayWSClient) {
        self.client = client
        requestToken = NotificationCenter.default.addObserver(
            forName: .everframeCompanionReportRequested,
            object: nil,
            queue: nil
        ) { [weak self] note in
            guard let self else { return }
            guard let corrId = note.userInfo?["correlation_id"] as? String else { return }
            guard note.object == nil || (note.object as? RelayWSClient) === self.client else { return }
            // PR-fix 1 — snapshot the attribution token for THIS report, here
            // and not at submit time. A pair that is released and re-attached
            // by a DIFFERENT dashboard user keeps the same TV socket and so
            // the same `RelayWSClient` instance (the relay's `releasePairBond`
            // force-closes only the phone leg), and `case .pairBonded`
            // overwrites `attributionToken` on that instance. A submit reading
            // the client minutes later therefore picks up whoever is attached
            // NOW — mis-crediting this report and, since ingest consumes
            // attribution single-use, burning the token the new user's own
            // next report needed.
            //
            // Read SYNCHRONOUSLY in the observer rather than inside the Task
            // below: NotificationCenter delivers inline on the posting thread,
            // which here is the WS receive path immediately after
            // `case .reportRequest` applied this report's fresh token. The
            // detached Task runs later and would reopen the same window.
            // The token stays out of the notification's userInfo (a
            // process-wide broadcast) on purpose. SECURITY: never log it.
            let companionAttribution = self.client?.getCompanionAttribution()
            let authEpoch = CompanionAuthEpoch.current
            Task { [weak self] in
                await self?.handleReportRequest(
                    correlationId: corrId,
                    companionAttribution: companionAttribution, authEpoch: authEpoch)
            }
        }
        submitToken = NotificationCenter.default.addObserver(
            forName: .everframeCompanionReportSubmit,
            object: nil,
            queue: nil
        ) { [weak self] note in
            print("[everframe-companion] notif: report.submit fired userInfoKeys=\(Array(note.userInfo?.keys.map { "\($0)" } ?? []))")
            guard let self else { print("[everframe-companion] report.submit — self gone"); return }
            guard let corrId = note.userInfo?["correlation_id"] as? String,
                  let submit = note.userInfo?["submit"] as? EverframeReportSubmit else {
                print("[everframe-companion] report.submit — malformed userInfo, dropping")
                return
            }
            self.recordPendingSubmit(correlationId: corrId, submit: submit)
            self.tryRunSubmit(correlationId: corrId, bakedBytes: nil)
        }
        submitBinaryToken = NotificationCenter.default.addObserver(
            forName: .everframeCompanionReportSubmitBinary,
            object: nil,
            queue: nil
        ) { [weak self] note in
            print("[everframe-companion] notif: report.submit.binary fired userInfoKeys=\(Array(note.userInfo?.keys.map { "\($0)" } ?? []))")
            guard let self else { print("[everframe-companion] report.submit.binary — self gone"); return }
            guard let corrId = note.userInfo?["correlation_id"] as? String,
                  let bytes = note.userInfo?["bytes"] as? Data else {
                print("[everframe-companion] report.submit.binary — malformed userInfo, dropping")
                return
            }
            self.tryRunSubmit(correlationId: corrId, bakedBytes: bytes)
        }
        resetFramingToken = NotificationCenter.default.addObserver(
            forName: .everframeCompanionResetSubmitFraming,
            object: nil,
            queue: nil
        ) { [weak self] note in
            guard let self, note.object == nil || (note.object as? RelayWSClient) === self.client else { return }
            self.__dropPendingSubmits()
            let ownerID = self.captureOwnerID
            Task { @MainActor in
                Self.abortInvalidatedCapture(bridgeID: ownerID)
            }
        }
        shotBinaryToken = NotificationCenter.default.addObserver(
            forName: .everframeCompanionReportShotBinary,
            object: nil,
            queue: nil
        ) { [weak self] note in
            guard let self else { return }
            guard let corrId = note.userInfo?["correlation_id"] as? String,
                  let shotId = note.userInfo?["shot_id"] as? String,
                  let bytes = note.userInfo?["bytes"] as? Data else {
                print("[everframe-companion] shot.binary — malformed userInfo, dropping")
                return
            }
            // UNSOLICITED shot binaries are dropped. `shot.binary` is only
            // ever legal behind a `report.submit` that announced that shot, so
            // without a pending submit for this correlation id there is nothing
            // these bytes can belong to. Buffering them anyway let a bonded
            // phone stream unlimited marker/payload pairs under ids of its own
            // choosing into a map cleared only at teardown — a straightforward
            // way to exhaust the device's memory.
            self.bufferLock.lock()
            let announced = self.pendingSubmit[corrId]?.submit.shots?.contains { $0.shotId == shotId } ?? false
            // Budgeted AS THE BYTES ARRIVE, not once every shot is in. The
            // readiness gate retains the primary and each received shot while
            // one is outstanding, and the relay's per-frame limit is far larger
            // than the request ceiling — so buffering first and budgeting later
            // let one report hold roughly 104 MiB before anything looked at it.
            let retained = self.pendingPrimaryBytes.values.reduce(0) { $0 + $1.count }
                + self.pendingShotBytes.values.reduce(0) { $0 + $1.values.reduce(0) { $0 + $1.count } }
            let fits = retained + bytes.count <= Self.maxRetainedSubmitBytes
            if announced && fits {
                self.pendingShotBytes[corrId, default: [:]][shotId] = bytes
            }
            self.bufferLock.unlock()
            guard fits else {
                // Dropping the bytes alone left the submit waiting for a shot
                // that will never arrive — "Submitting…" forever, with no
                // failure, no cleanup and no retry. Fail it instead.
                print("[everframe-companion] shot.binary DROPPED — retained-bytes ceiling reached")
                self.sendFailed(correlationId: corrId, reason: "payload_too_large")
                self.dropEntries(correlationId: corrId)
                return
            }
            guard announced else {
                print("[everframe-companion] shot.binary DROPPED — not announced by a pending submit")
                return
            }
            self.tryRunSubmit(correlationId: corrId, bakedBytes: nil)
        }
    }

    deinit {
        let ownerID = captureOwnerID
        Task { @MainActor in
            guard Self.captureOwner?.bridgeID == ownerID else { return }
            Self.abortReportCaptureLifecycle()
        }
        if let t = requestToken { NotificationCenter.default.removeObserver(t) }
        if let t = submitToken { NotificationCenter.default.removeObserver(t) }
        if let t = submitBinaryToken { NotificationCenter.default.removeObserver(t) }
        if let t = shotBinaryToken { NotificationCenter.default.removeObserver(t) }
        if let t = resetFramingToken { NotificationCenter.default.removeObserver(t) }
    }

    // MARK: - Capture-lifecycle seams (spec 2026-07-17 §1)
    //
    // The native EFReporterPresenter freezes crumbs+replay at reporter-open
    // and discards on cancel. The companion has no on-device reporter, so
    // "reporter-open" is report.request and "cancel" is any failure exit.
    // Cancel-then-freeze: the discard drops a stale snapshot left by a
    // phone that vanished mid-report (both seams no-op when nothing is
    // frozen), so the fresh freeze can never be shadowed by old state.

    @MainActor
    internal static func beginReportCaptureLifecycle() {
        captureOwner = nil
        #if canImport(UIKit)
        Everframe.shared.__replayCancel()
        Everframe.shared.__replayFreeze()
        #endif
    }

    @MainActor
    internal static func abortReportCaptureLifecycle() {
        captureOwner = nil
        #if canImport(UIKit)
        Everframe.shared.__replayCancel()
        #endif
    }

    // MARK: - report.request → report.assembled

    /// Reset notifications may queue behind a newer report. Release only this
    /// bridge's invalidated capture, never the new owner's frozen recording.
    @MainActor private static func abortInvalidatedCapture(bridgeID: UUID) {
        guard let owner = captureOwner, owner.bridgeID == bridgeID,
              owner.authEpoch != CompanionAuthEpoch.current else { return }
        abortReportCaptureLifecycle()
    }

    @MainActor private func finishReportCapture(correlationId: String, cancelled: Bool) {
        guard let owner = Self.captureOwner, owner.bridgeID == captureOwnerID,
              owner.correlationID == correlationId else { return }
        Self.captureOwner = nil
        if cancelled {
            Self.abortReportCaptureLifecycle()
        } else {
            #if canImport(UIKit)
            Everframe.shared.__replayReporterDidClose()
            #endif
        }
    }

    @MainActor
    private func handleReportRequest(correlationId: String,
                                     companionAttribution: String?, authEpoch: UInt64) async {
        // Final whole-branch review, fix round 2, Critical 1 — this is the
        // companion path's own "reporter-open" moment (see this file's `//
        // "reporter-open" is report.request` note below): real time before
        // capture, off the capture's own critical path, same rationale as
        // `EFReporterPresenter.openAndAwait()`'s identical call. Placed
        // OUTSIDE the `canImport(UIKit)` guard below (unlike the rest of this
        // function) — `__warmIdentityToken()` has no UIKit dependency, and
        // firing it unconditionally costs nothing on a platform where the
        // capture itself would no-op.
        Everframe.shared.__warmIdentityToken()
        #if canImport(UIKit)
        // 0. Ask JS to attach any host-supplied payload BEFORE we capture
        //    native state. Bounded wait so a non-responsive JS thread can't
        //    stall capture indefinitely (DEFE-02).
        await Self.awaitJsReactTreeAttach(correlationId: correlationId)
        guard authEpoch == CompanionAuthEpoch.current,
              client?.companionForBridge?.__ownsReport(correlationId: correlationId) == true else { return }
        Self.beginReportCaptureLifecycle()
        Self.captureOwner = CaptureOwner(bridgeID: captureOwnerID,
            correlationID: correlationId, authEpoch: authEpoch, companion: client?.companionForBridge)
        // 1. Screenshot capture (existing primitive — unchanged).
        guard let shot = ScreenshotCapture.captureKeyWindow() else {
            // DEFE-02 soft-degrade: no screenshot available; send a stub
            // assembled frame with size 0 so the phone gets visibility.
            sendAssembled(correlationId: correlationId,
                          relayBytes: Data(),
                          relayMime: "image/png")
            return
        }

        // 2. Drain host-attached sticky payload NOW (Plan 06.2-13 Task 1).
        //    Consume-once semantics — matches the in-process iOS/tvOS reporter
        //    modal (EFReporterPresenter.swift:72). If two report.requests fire
        //    back-to-back and the host called setExtra only before the first,
        //    the second envelope MUST see (nil, nil) here.
        let (hostExtraRaw, _) = await Everframe.shared.__consumePendingAttachments()
        let hostExtraNormalized: String? = (hostExtraRaw?.isEmpty == true) ? nil : hostExtraRaw

        // 3. Stash capture state for the eventual submit (Plan 06.2-12 Task 2
        //    + Plan 06.2-13 Task 1 attachments).
        stashCapture(
            correlationId: correlationId,
            capture: shot,
            hostExtra: hostExtraNormalized,
            companionAttribution: companionAttribution
        )

        // 4. Re-encode screenshot for the relay hop. JPEG @ q=0.85 cuts
        //    typical 1080p PNGs by ~50-60% with no perceptible loss for
        //    screenshot content. The envelope PNG stays untouched in the
        //    stash above (used by the submit pipeline). Falls back to the
        //    original PNG when JPEG encode fails or the JPEG isn't
        //    actually smaller (rare — solid-color screenshots).
        let (relayBytes, relayMime) = reencodeScreenshotForRelay(image: shot.image, pngFallback: shot.pngData)

        // 5. Emit assembled frame, then the binary screenshot (D-05
        //    ordering). No second binary frame: tap-to-identify is gone, so
        //    no gzipped UI tree is produced OR announced. Announcing a frame
        //    that never arrives would leave the phone's binary demuxer
        //    waiting on it.
        sendAssembled(correlationId: correlationId,
                      relayBytes: relayBytes,
                      relayMime: relayMime)
        #else
        // Non-UIKit hosts: stub.
        sendAssembled(correlationId: correlationId,
                      relayBytes: Data(),
                      relayMime: "image/png")
        #endif
    }

    internal static func currentArtifactCounts() -> (logs: Int, network: Int) {
        (logs: LogRingBuffer.shared.snapshot().count,
         network: NetworkRingBuffer.shared.snapshot().count)
    }

    private func sendAssembled(correlationId: String,
                               relayBytes: Data,
                               relayMime: String) {
        // `uiTree`/`uiTreeNodes` stay on the wire because the relay message
        // types declare them non-optional, but they are now always
        // false / 0 — no tree is captured, announced or sent.
        let toggles = EverframeReportAssembledToggles(
            logs: true, metadata: true, network: true,
            screenshot: !relayBytes.isEmpty, uiTree: false)
        let artifactCounts = Self.currentArtifactCounts()
        let counts = EverframeReportAssembledCounts(
            breadcrumbs: BreadcrumbRingBuffer.shared.size,
            logs: artifactCounts.logs,
            network: artifactCounts.network,
            uiTreeNodes: 0)
        let msg = EverframeRelayMessage.reportAssembled(EverframeReportAssembled(
            correlationId: correlationId,
            counts: counts,
            mime: relayMime,
            size: relayBytes.count,
            toggles: toggles,
            tree: nil,
            type: "report.assembled"))
        client?.send(msg)
        if !relayBytes.isEmpty {
            client?.sendBinary(relayBytes)
        }
    }

    // MARK: - Relay-hop screenshot re-encode

    #if canImport(UIKit)
    /// Re-encode the captured UIImage as JPEG @ q=0.85 for the phone-bound
    /// binary frame. Returns the JPEG bytes + the matching mime; falls
    /// back to the original PNG when JPEG encode fails or doesn't actually
    /// save bytes (DEFE-02 — never block the report on a re-encode).
    @MainActor
    private func reencodeScreenshotForRelay(image: UIImage, pngFallback: Data) -> (Data, String) {
        if let jpeg = image.jpegData(compressionQuality: 0.85), jpeg.count < pngFallback.count {
            return (jpeg, "image/jpeg")
        }
        return (pngFallback, "image/png")
    }
    #endif

    // MARK: - Capture buffer (Task 2)

    #if canImport(UIKit)
    @MainActor
    private func stashCapture(correlationId: String,
                              capture: ScreenshotCapture.Result,
                              hostExtra: String?,
                              companionAttribution: String?) {
        bufferLock.lock()
        defer { bufferLock.unlock() }
        let now = Date()
        // TTL sweep on every insert to keep the dict bounded across long sessions.
        let cutoff = now.addingTimeInterval(-Self.stashTTL)
        captureStash = captureStash.filter { $0.value.capturedAt > cutoff }
        captureStash[correlationId] = CaptureStash(
            capture: capture,
            capturedAt: now,
            hostExtra: hostExtra,
            companionAttribution: companionAttribution
        )
    }

    /// Test seam — inspect the current stash count without exposing the dict.
    public func __stashCountForTesting() -> Int {
        bufferLock.lock(); defer { bufferLock.unlock() }
        return captureStash.count
    }

    /// Plan 06.2-13 Task 1 test seam — return whether a stash entry exists
    /// for a correlation id, and surface the host-attached payload so the
    /// unit test can assert it was drained at request time. The dict itself
    /// stays private; tests get a flat tuple.
    public func __stashHostAttachmentsForTesting(correlationId: String)
        -> (present: Bool, hostExtra: String?)
    {
        bufferLock.lock(); defer { bufferLock.unlock() }
        guard let s = captureStash[correlationId] else {
            return (false, nil)
        }
        return (true, s.hostExtra)
    }

    /// Plan 06.2-13 Task 1 test seam — directly populate a stash entry from a
    /// unit test that cannot construct a real ScreenshotCapture.Result (no
    /// UIWindow on the SwiftPM-on-macOS host). Lets the test exercise the
    /// drain-once invariant without driving the @MainActor capture path.
    public func __seedStashForTesting(
        correlationId: String,
        hostExtra: String?,
        companionAttribution: String? = nil
    ) {
        bufferLock.lock()
        defer { bufferLock.unlock() }
        // Build a minimal Result — only the fields that ReporterSubmission
        // reads are filled. The test never invokes submit; it only inspects
        // the stash via __stashHostAttachmentsForTesting.
        let placeholder = ScreenshotCapture.Result(
            image: UIImage(),
            widthPoints: 0,
            heightPoints: 0,
            scale: 1,
            pngData: Data()
        )
        captureStash[correlationId] = CaptureStash(
            capture: placeholder,
            capturedAt: Date(),
            hostExtra: hostExtra,
            companionAttribution: companionAttribution
        )
    }
    #endif

    // MARK: - report.submit → submit envelope (Task 4)

    private func recordPendingSubmit(correlationId: String, submit: EverframeReportSubmit) {
        // DEV-ONLY trace — REMOVE BEFORE PROD
        print("[everframe-companion] recordPendingSubmit corrId=\(correlationId) title=\"\(submit.title)\" descLen=\(submit.description.text.count) includes.logs=\(submit.includes.logs) includes.network=\(submit.includes.network)")
        bufferLock.lock()
        defer { bufferLock.unlock() }
        let now = Date()
        let cutoff = now.addingTimeInterval(-Self.stashTTL)
        pendingSubmit = pendingSubmit.filter { $0.value.receivedAt > cutoff }
        pendingSubmit[correlationId] = PendingSubmit(submit: submit, receivedAt: now)
    }

    /// Called both when the submit text frame arrives (bakedBytes == nil) and
    /// when the binary PNG frame arrives (bakedBytes != nil). Only runs the
    /// real submit pipeline when BOTH parts are present.
    private func tryRunSubmit(correlationId: String, bakedBytes: Data?) {
        // DEV-ONLY trace — REMOVE BEFORE PROD
        print("[everframe-companion] tryRunSubmit corrId=\(correlationId) bakedBytes=\(bakedBytes?.count ?? -1)")
        #if canImport(UIKit)
        // We can only proceed once the binary arrives — the text frame alone
        // has no PNG. Note that the binary frame can arrive before the text
        // frame handler completes (URLSession delegate queue is serial but
        // NotificationCenter posts can interleave with the buffer write),
        // so we tolerate either ordering: each call rechecks both buffers.
        bufferLock.lock()
        if let bakedBytes { pendingPrimaryBytes[correlationId] = bakedBytes }
        let bufferedPrimary = pendingPrimaryBytes[correlationId]
        let pending = pendingSubmit[correlationId]
        let stash = captureStash[correlationId]
        bufferLock.unlock()

        // The text frame alone has no PNG. Either ordering is tolerated: each
        // call rechecks every buffer.
        guard let bytes = bufferedPrimary else {
            print("[everframe-companion] tryRunSubmit corrId=\(correlationId) — waiting on binary frame")
            return
        }
        print("[everframe-companion] tryRunSubmit corrId=\(correlationId) pending=\(pending != nil) stash=\(stash != nil)")

        guard let pending = pending else {
            // Binary arrived without a matching submit text frame — drop.
            // No way to compose Inputs without title/description/includes.
            print("[everframe-companion] tryRunSubmit DROPPED — no pending submit for corrId=\(correlationId)")
            return
        }
        guard let stash = stash else {
            // No capture stash — phone shouldn't have submitted without an
            // assembled frame, but defend anyway.
            print("[everframe-companion] tryRunSubmit FAILED — no_capture corrId=\(correlationId)")
            sendFailed(correlationId: correlationId, reason: "no_capture")
            dropEntries(correlationId: correlationId)
            return
        }

        // Every part the phone announced must be present before composing.
        // The old shape fired as soon as the primary binary landed, which is
        // why the extra shots — whose bytes arrive AFTER it — could never be
        // part of the upload no matter how they were routed.
        let announcedShotIds = pending.submit.shots?.map(\.shotId) ?? []
        bufferLock.lock()
        let arrivedShots = pendingShotBytes[correlationId] ?? [:]
        bufferLock.unlock()
        if announcedShotIds.contains(where: { arrivedShots[$0] == nil }) {
            print("[everframe-companion] tryRunSubmit corrId=\(correlationId) — waiting on \(announcedShotIds.count - arrivedShots.count) shot binaries")
            return
        }
        // Ordered by the ANNOUNCED order, not arrival order — the envelope's
        // `screenshot-N` suffixes have to line up with the phone's `shots[]`
        // array or annotations pair to the wrong image.
        let extraShotPngs: [Data] = announcedShotIds.compactMap { arrivedShots[$0] }

        let submit = pending.submit
        // CONSUMED here, at launch — not after the upload finishes. Cleanup used
        // to run only on completion, so a phone repeating the same
        // `report.submit` during that window (uploads take seconds to minutes)
        // launched another concurrent upload from the SAME received image set:
        // duplicate reports, duplicated bandwidth and duplicated ingest cost
        // from one user action. The failure paths below still call
        // `dropEntries`, which is idempotent.
        bufferLock.lock()
        pendingSubmit.removeValue(forKey: correlationId)
        #if canImport(UIKit)
        pendingPrimaryBytes.removeValue(forKey: correlationId)
        pendingShotBytes.removeValue(forKey: correlationId)
        #endif
        bufferLock.unlock()
        // External review, finding 3 (Serious) — THE SUBMIT BOUNDARY for the
        // companion path: both frames have arrived and this report is now
        // definitely being submitted. Captured HERE, synchronously, before the
        // `Task` hop below and everything inside it (image decode, target
        // re-resolution, then `submit(_:)`'s own baking/encoding/hashing) —
        // exactly the window an account switch had to land in to repoint the
        // report. Sibling of `stash.companionAttribution`, which is
        // snapshotted at `report.request` for the same class of reason and
        // must never be re-read from the live client either. `EFUser` is a
        // value type, so this is a snapshot by construction.
        //
        // External review, finding 1 (Serious) — `captureUserSnapshot()`, not
        // `currentUser`: the snapshot carries the session epoch it was taken
        // in, so `submit(_:)` can discard it (degrade to anonymous) if a
        // `start()`/`kill()` lands before it reads the config that decides
        // which project's Everframe SDK key the upload goes out under. See
        // `EFCapturedUser.swift`.
        let capturedSession = Everframe.shared.captureSessionSnapshot()
        let captureEpoch = CompanionAuthEpoch.current
        Task { @MainActor [weak self] in
            guard let self else { return }
            guard let bakedImage = UIImage(data: bytes) else {
                self.sendFailed(correlationId: correlationId, reason: "bad_image")
                self.dropEntries(correlationId: correlationId)
                return
            }
            // Description redactions integration is a follow-up — reporter
            // SPA currently always sends `redactions: []` (Plan 06.2-06
            // removed the redaction UI). Take description.text verbatim.
            // TODO(Plan 06.2-13+): apply submit.description.redactions byte
            // ranges by replacing those slices with U+2588 before envelope
            // build, mirroring iOS/tvOS in-process reporter semantics.
            // Plan 06.2-13 Task 1 — thread the host-attached payload that was
            // drained at `report.request` time into the submit envelope. The
            // drain itself already happened inside `handleReportRequest` (the
            // companion's equivalent of the modal's `openReporter` moment),
            // so this is just a pass-through; no second consume.
            // Tap-to-identify was removed (spec 2026-08-29). A phone running
            // an older reporter SPA may still send `submit.reportTarget`; it
            // is ignored rather than rejected, and nothing is resolved from it.

            // Single-shot submission: the phone companion has no annotation
            // UI of its own — the image arriving over the WS binary frame is
            // already whatever the phone composited. Preserve the pre-Task-10
            // wire behavior (kind always `.annotatedScreenshot`, bare
            // "screenshot" part name, no payload.annotations/redactions) by
            // marking the one shot `annotated: true` with empty wire arrays.
            // The extra shots of a multi-shot submit ride the SAME `shots`
            // array the in-process reporter uses, so they get the identical
            // `screenshot-N` part naming the admin payload card already parses.
            // A phone that sent none leaves this exactly as it was, keeping a
            // single-shot envelope byte-identical to the pre-multi-shot shape.
            // Ingest caps the WHOLE request at 25 MB — a running total across
            // every part, not a per-file limit. Report-grade PNGs are megabytes
            // apiece, so three extras plus the primary and a session replay can
            // exceed it, and the server rejects the ENTIRE submission rather
            // than trimming. Dropping an extra screenshot is far better than
            // losing the report and every artefact with it. Mirrors
            // `CompanionSubmissionComposer`'s budget on Android.
            let extraBudget = Self.maxTotalRequestBytes - bytes.count - Self.nonShotHeadroomBytes
            var extraUsed = 0
            let extraShots = extraShotPngs.compactMap { data -> ReporterSubmission.Inputs.Shot? in
                guard extraUsed + data.count <= extraBudget else {
                    print("[everframe-companion] extra shot dropped — request byte budget exhausted")
                    return nil
                }
                guard let image = UIImage(data: data) else { return nil }
                extraUsed += data.count
                return ReporterSubmission.Inputs.Shot(image: image, annotated: true)
            }
            var inputs = ReporterSubmission.Inputs(
                captureResult: stash.capture,
                shots: [ReporterSubmission.Inputs.Shot(image: bakedImage, annotated: true)] + extraShots,
                title: submit.title,
                description: submit.description.text,
                includeLogs: submit.includes.logs,
                includeNetwork: submit.includes.network,
                includeMetadata: submit.includes.metadata,
                extraOverrides: [:],
                hostExtra: stash.hostExtra,
                // Pinned to the snapshot taken at the submit boundary above —
                // MUST NOT be re-read from `Everframe.shared` here, for the
                // same reason `companionAttribution` must not be re-read from
                // `self.client` (see its note below).
                capturedSession: capturedSession,
                // Companion attribution (spec 2026-08-07) — the token minted
                // for THIS report's `report.request`, snapshotted when that
                // frame arrived (see the observer in `init`). Nil on an
                // ordinary QR bond. Rides the ingest POST as
                // `X-Everframe-Companion-Attribution`.
                //
                // MUST NOT be re-read from `self.client` here (PR-fix 1): this
                // runs seconds-to-minutes after the report was requested, and
                // the same client instance serves whichever dashboard user is
                // attached NOW — a release + re-attach re-bonds the same TV
                // socket with the new user's token. SECURITY: never log.
                companionAttribution: stash.companionAttribution
            )
            inputs.captureIsCurrent = self.captureAuthorization(correlationId: correlationId, authEpoch: captureEpoch)
            print("[everframe-companion] calling ReporterSubmission.submit corrId=\(correlationId) bakedImageSize=\(bakedImage.size) hostExtra=\(stash.hostExtra != nil)")
            do {
                let result = try await ReporterSubmission.submit(inputs)
                switch result {
                case .submitted(let reportId), .queued(let reportId):
                    self.sendCompleted(correlationId: correlationId,
                                       eventId: reportId.uuidString)
                case .cancelled:
                    self.sendFailed(correlationId: correlationId,
                                    reason: "cancelled")
                }
            } catch {
                NSLog("[Everframe] companion submit threw (\(type(of: error)): \(error.localizedDescription))")
                self.sendFailed(correlationId: correlationId,
                                reason: "ingest_error")
            }
            self.dropEntries(correlationId: correlationId)
        }
        #else
        _ = bakedBytes
        sendFailed(correlationId: correlationId, reason: "no_uikit")
        dropEntries(correlationId: correlationId)
        #endif
    }

    // MARK: - Terminal frames (PR-fix 7 — a completion ends only ITS report)
    //
    // Both of these used to flip the shared state to `.paired` unconditionally.
    // A submit runs for seconds-to-minutes and deliberately outlives the bond
    // that started it: the pair can be released and re-attached to a DIFFERENT
    // dashboard user in that window (`releasePairBond` force-closes only the
    // phone leg, so this same client keeps serving), the re-bond flips the pair
    // to `.paired`, and the new user's `report.request` is accepted and enters
    // `.reportInProgress`. The older upload then finished and cleared the NEW
    // report's state — after which a third request was accepted over the second
    // and re-froze the replay/breadcrumb snapshot its composer was about to
    // consume.
    //
    // `__finishReport(correlationId:)` is therefore the only way back to
    // `.paired`: it acts only when this report is the one that currently owns
    // `.reportInProgress`. The frame itself is sent EITHER WAY — the phone that
    // submitted a superseded report is still waiting for an answer, and leaving
    // it waiting is a different bug.

    @MainActor private func sendCompleted(correlationId: String, eventId: String) {
        client?.send(.reportCompleted(EverframeReportCompleted(
            correlationId: correlationId,
            eventId: eventId,
            type: "report.completed")))
        // Parity with Android's `Companion.__finishReport(correlationId)` in
        // CompanionCaptureBridge.launchSubmit.
        let owned = client?.companionForBridge?.__finishReport(correlationId: correlationId) {
            self.finishReportCapture(correlationId: correlationId, cancelled: false)
        } ?? false
        if !owned { finishReportCapture(correlationId: correlationId, cancelled: false) }
    }

    private func sendFailed(correlationId: String, reason: String) {
        let frame = EverframeRelayMessage.reportFailed(EverframeReportFailed(
            correlationId: correlationId,
            reason: reason,
            type: "report.failed"))
        Task { @MainActor [weak self] in
            guard let self else { return }
            // Ordering inside the claim is intentional and unchanged — the
            // discard must complete before the phone can be prompted to start
            // the next report. What IS new is that a superseded report's
            // failure discards nothing: by then the frozen snapshot belongs to
            // whichever report is live now, and dropping it is the same
            // corruption as clearing that report's state.
            let owned = self.client?.companionForBridge?.__finishReport(
                correlationId: correlationId
            ) {
                self.finishReportCapture(correlationId: correlationId, cancelled: true)
                self.client?.send(frame)
            } ?? false
            if !owned {
                self.finishReportCapture(correlationId: correlationId, cancelled: true)
                self.client?.send(frame)
            }
        }
    }

    /// Drops every half-assembled submit.
    ///
    /// Called when the phone leg ends (disconnect, pair expiry, backgrounding,
    /// client teardown): those buffers belong to a submit that can no longer
    /// complete, and leaving them means the NEXT report inherits a partially
    /// filled slot — its own parts merge with a dead one and it never
    /// satisfies the readiness gate. An in-flight submit Task already holds its
    /// own copies, so this cannot truncate an upload that started.
    internal func __dropPendingSubmits() {
        bufferLock.lock()
        defer { bufferLock.unlock() }
        pendingSubmit.removeAll()
        // Outside the UIKit guard, matching the declarations: the observers
        // that fill these are unguarded, so guarding only the cleanup leaked
        // them on the macOS slice.
        pendingShotBytes.removeAll()
        pendingPrimaryBytes.removeAll()
        #if canImport(UIKit)
        captureStash.removeAll()
        #endif
    }

    private func dropEntries(correlationId: String) {
        bufferLock.lock()
        defer { bufferLock.unlock() }
        #if canImport(UIKit)
        captureStash.removeValue(forKey: correlationId)
        #endif
        pendingShotBytes.removeValue(forKey: correlationId)
        pendingPrimaryBytes.removeValue(forKey: correlationId)
        pendingSubmit.removeValue(forKey: correlationId)
    }

    // MARK: - JS React-tree attach handshake (companion-flow only)

    /// `Notification.Name` posted by `awaitJsReactTreeAttach`. The RN bridge
    /// subscribes and forwards to the JS-side
    /// `everframe.companion.reportRequested` event so the companion module can walk the React
    /// fiber tree and call `attachReactTree` before native capture starts.
    /// Non-RN hosts simply ignore the post — the bounded wait expires and
    /// capture proceeds with no reactTree, matching pre-fix behavior.
    public static let shouldAttachReactTreeNotification =
        Notification.Name("everframeCompanionShouldAttachReactTree")

    /// Per-correlation_id continuation map. `signalReactTreeAttached`
    /// resumes the matching continuation; the scheduled timeout resumes
    /// the continuation as a fallback if JS never calls back.
    /// `nonisolated(unsafe)` because access is fully serialized by
    /// `pendingAttachLock` — the Swift 6 concurrency checker can't see
    /// the manual lock contract.
    nonisolated(unsafe) private static var pendingAttachContinuations: [String: CheckedContinuation<Void, Never>] = [:]
    private static let pendingAttachLock = NSLock()

    /// Bounded wait for JS to call `signalReactTreeAttached(correlationId:)`.
    /// Returns after at most 250ms even if JS never responds — capture
    /// must not be blocked by a silent JS-side failure (DEFE-02).
    private static func awaitJsReactTreeAttach(correlationId: String) async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            pendingAttachLock.lock()
            pendingAttachContinuations[correlationId] = cont
            pendingAttachLock.unlock()
            // Post the notification so the RN bridge (if linked) can
            // forward to JS. Posted AFTER registering the continuation
            // so a fast JS callback can't lose the race.
            NotificationCenter.default.post(
                name: shouldAttachReactTreeNotification,
                object: nil,
                userInfo: ["correlation_id": correlationId]
            )
            // 250ms bounded fallback — resume the continuation if JS
            // hasn't called back by then.
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.25) {
                resumeAndDropPending(correlationId: correlationId)
            }
        }
    }

    /// Called from the RN bridge's `signalCompanionReportRequestReady`
    /// after JS finishes walking the React tree and calling
    /// `attachReactTree`. Idempotent — a late call after the 250ms
    /// fallback already fired is a harmless no-op.
    @objc public static func signalReactTreeAttached(correlationId: String) {
        resumeAndDropPending(correlationId: correlationId)
    }

    private static func resumeAndDropPending(correlationId: String) {
        pendingAttachLock.lock()
        let cont = pendingAttachContinuations.removeValue(forKey: correlationId)
        pendingAttachLock.unlock()
        cont?.resume()
    }
}
