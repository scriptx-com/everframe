// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Live preview + shot stash for companion (spec 2026-07-17 §3).
// The Swift twin of `CompanionPreviewSession.kt`.
//
// THE RULE THAT MATTERS MOST: a preview must never outlive the thing that
// authorised it. The triggers that stop it — explicit `preview.stop` from the
// peer (never echoed back), the 2-minute wall-clock cap, `capture_unavailable`,
// phone disconnect, pair expiry, process backgrounding, and the client's own
// teardown. A device that keeps reading the user's screen after the session
// ended is the failure this feature's privacy budget exists to prevent.
//
// Four invariants carried from Android, each of which was a defect there first:
//
//  1. The correlation id comes from the MESSAGE, never from session state.
//     Android's `lastCorrelationId` fallback was never assigned in production,
//     and since the phone sends `shot.request` then immediately `preview.stop`,
//     the stop nulled the id first and every shot was silently dropped.
//  2. Two capture seams. The loop never touches the shot seam.
//  3. The stash is scoped to a correlation id, not to the loop's lifetime.
//  4. No suspension between a header and its binary.
import Foundation

// These three carry no UIKit types, so they live OUTSIDE the platform guard.
// `RelayWSClient` compiles on the macOS test slice while the session itself
// does not, and its routing signatures name them — keeping them behind the
// guard broke the macOS build with "cannot find type in scope".

/// Authorisation epoch for companion capture.
///
/// `Task.isCancelled` is not sufficient on iOS. `captureShot()` runs
/// `captureKeyWindow()` + PNG encode SYNCHRONOUSLY on the main actor, and
/// pair-loss cancellation is itself queued onto the main actor — so the
/// cancellation cannot be observed until after the capture AND its send have
/// already finished. Across a disconnect/re-attach that shipped the old
/// full-resolution capture to whichever phone is now attached to the pair.
///
/// This counter is deliberately NOT actor-isolated: `RelayWSClient` bumps it
/// straight from the socket thread the moment authorisation ends, so a capture
/// blocking the main actor can still see it and refuse to transmit.
public enum CompanionAuthEpoch {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var value: UInt64 = 0

    /// Called off the main actor when the pair, the phone leg or the client ends.
    public static func invalidate() {
        lock.lock(); value &+= 1; lock.unlock()
    }

    public static var current: UInt64 {
        lock.lock(); defer { lock.unlock() }
        return value
    }
}

/// Wire values for `preview.stop`'s `reason`. The protocol schema is
/// `z.enum(['user', 'time_cap', 'capture_unavailable'])`; an off-enum reason is
/// a malformed frame and the relay closes the socket 4006 for it.
public enum PreviewStopReason: String, Sendable {
    case user
    case timeCap = "time_cap"
    case captureUnavailable = "capture_unavailable"
}

public struct NormalizedRect: Sendable, Equatable {
    public let x: Double, y: Double, w: Double, h: Double
    public init(x: Double, y: Double, w: Double, h: Double) {
        self.x = x; self.y = y; self.w = w; self.h = h
    }
}

/// The subset of `CompanionPreviewSession` that `RelayWSClient` depends on.
///
/// Extracted so the routing tests can inject a recording double and assert
/// WHICH frame calls WHICH method with WHICH arguments, without driving the
/// real capture loop's timing. Every defect Android's review found lived in
/// exactly this seam — the client/session boundary — which is precisely the
/// part that had gone untested.
@MainActor
public protocol CompanionPreviewSessionApi: AnyObject {
    var isRunning: Bool { get }
    func start(correlationId: String)
    func stop(reason: PreviewStopReason)
    func stopSilently()
    func clearStash()
    func clearStashFor(correlationId: String)
    /// `authAtRequest` is the epoch as of when the FRAME ARRIVED, read by the
    /// client on the socket thread — see `RelayWSClient.routeShotRequest`.
    /// Anything later snapshots an already-invalidated epoch.
    func requestShot(correlationId: String, shotId: String, rect: NormalizedRect?, authAtRequest: UInt64)
    /// Permanent shutdown. Only for a client being torn down for good; the
    /// resumable background case uses `stopSilently()` + `clearStash()`,
    /// because the SAME client reconnects on foreground.
    func teardown()
}

#if canImport(UIKit)
import Foundation
import UIKit
import TraceItXProtocol

@MainActor
public final class CompanionPreviewSession: CompanionPreviewSessionApi {

    private let send: (RelayMessage) -> Void
    private let sendBinary: (Data) -> Void
    /// 2 fps loop capture — preview grade, never used for a shot.
    private let capturePreview: () async -> PreviewCapture?
    /// Shot-stash capture — REPORT grade: the same shaping as the report's own
    /// screenshot (PNG, longest edge capped at `ScreenshotCapture.MAX_EDGE_PT`).
    ///
    /// NOT "full resolution". Every path here is capped, and the Android twin's
    /// comment claimed otherwise for long enough to mislead this port.
    private let captureShot: () async -> PreviewCapture?
    private let crop: (PreviewCapture, NormalizedRect) -> PreviewCapture
    private let intervalMs: UInt64
    private let maxDurationMs: Double
    private let livePreviewEnabled: Bool
    /// Injectable clock so the 2-minute cap can be driven in a test without
    /// actually waiting two minutes.
    private let now: () -> Date

    private var task: Task<Void, Never>?
    private var correlationId: String?
    private var seq: Int = 0

    /// Report-grade captures keyed by shot_id; a known id is re-cropped, never
    /// re-captured.
    private var stash: [String: PreviewCapture] = [:]

    /// Hard ceiling on distinct shot_ids held for one report cycle — a bound on
    /// DEVICE MEMORY, deliberately NOT the same number as the submit ceiling.
    ///
    /// `report.submit.shots` is capped at 3 (what ingest accepts: envelope + 5
    /// file slots, minus the primary screenshot and the session replay). Making
    /// the stash 3 as well looked tidy and was wrong: the phone can capture
    /// three, DELETE one and capture a replacement, which is four distinct ids
    /// for three submitted shots. Every replacement was then refused
    /// `too_many_shots` with no way to recover, because a removal is
    /// phone-local and no protocol frame releases a device-side slot.
    ///
    /// Eight leaves room for that churn while still bounding the dictionary —
    /// without it a peer looping over fresh ids grew it without limit, each
    /// entry a report-grade PNG of the user's screen.
    private let maxStashedShots = 8

    /// Shot ids whose capture is in flight right now.
    ///
    /// Reserved BEFORE `captureShot()` suspends, so the cap counts work in
    /// progress as well as work already stashed, and released once the shot
    /// finishes.
    private var inFlightShotIds: Set<String> = []

    /// Test seam — inspect the in-flight shot count without exposing the set.
    /// Mirrors `CompanionCaptureBridge.__stashCountForTesting()`: an internal
    /// collection whose SIZE is the thing worth asserting, with no other
    /// observable surface now that the sharing indicator (which used to make
    /// pruning failures visible as a stranded pill) is gone — see task 13 of
    /// the companion-window-polish plan. If this stops being pruned, it grows
    /// without bound for the life of the session and every later request for
    /// the same shot id is wrongly refused `shot_in_flight` forever.
    public func __inFlightShotCountForTesting() -> Int {
        inFlightShotIds.count
    }

    /// Test seam — inspect WHICH ids are in flight, not just how many.
    /// `__inFlightShotCountForTesting()` alone cannot tell "the right entry
    /// was pruned" from "the wrong entry was pruned and the right one leaked"
    /// when both land on the same count; a test that needs to name which id
    /// remains needs the set itself.
    public func __inFlightShotIdsForTesting() -> Set<String> {
        inFlightShotIds
    }

    /// Which report cycle the stash belongs to.
    ///
    /// This reconciles two findings that pull in opposite directions. The stash
    /// must not survive into a later, UNRELATED session and be re-croppable
    /// there — but clearing it whenever the preview loop stopped meant no shot
    /// ever outlived the preview that produced it, because the phone sends
    /// `preview.stop` immediately after EVERY snap. A later re-crop would then
    /// miss, silently re-capture the CURRENT screen, and announce those pixels
    /// under the original shot's id.
    ///
    /// Both hold once "unrelated" is read the way the wire expresses it: a new
    /// report cycle carries a NEW correlation id.
    private var stashCorrelationId: String?

    /// Set by `teardown()`. Android gets this for free — its teardown cancels
    /// the whole coroutine scope, so nothing can launch on it again — but here
    /// `teardown()` only cancelled the CURRENT work, and a later `start()` or
    /// `requestShot()` captured normally. Relay routing is queued onto the main
    /// actor, so a control frame already in that queue could land after
    /// `disconnect()` and restart capture with the authorisation already gone.
    private var isTornDown = false

    /// Live-preview master switch, default OFF (product call 2026-08-27),
    /// matching the web SDK's `capture-profile.ts` `livePreview` and
    /// Android's `LIVE_PREVIEW_ENABLED`: every frame is a full screen capture
    /// — a continuous CPU tax for a nice-to-have viewfinder. `start()` still
    /// authorizes the shot stash, then declines with `capture_unavailable`;
    /// the phone shows its "live view unavailable" fallback and single-shot
    /// capture keeps working.
    public static let livePreviewEnabledDefault = false

    public init(send: @escaping (RelayMessage) -> Void,
                sendBinary: @escaping (Data) -> Void,
                capturePreview: @escaping () async -> PreviewCapture?,
                captureShot: @escaping () async -> PreviewCapture?,
                crop: @escaping (PreviewCapture, NormalizedRect) -> PreviewCapture = defaultCrop,
                intervalMs: UInt64 = 500,
                maxDurationMs: Double = 120_000,
                livePreviewEnabled: Bool = CompanionPreviewSession.livePreviewEnabledDefault,
                now: @escaping () -> Date = { Date() }) {
        self.send = send
        self.sendBinary = sendBinary
        self.capturePreview = capturePreview
        self.captureShot = captureShot
        self.crop = crop
        self.intervalMs = intervalMs
        self.maxDurationMs = maxDurationMs
        self.livePreviewEnabled = livePreviewEnabled
        self.now = now
    }

    public var isRunning: Bool {
        guard let task else { return false }
        return !task.isCancelled
    }

    private func adoptStashCorrelation(_ id: String) {
        if let existing = stashCorrelationId, existing != id {
            stash.removeAll()
            previewAuthorizedForStash = false
        }
        stashCorrelationId = id
    }

    /// Whether `start()` has been called for `stashCorrelationId` at some
    /// point since it was last adopted — irrespective of whether that preview
    /// is still RUNNING right now. Gates a FRESH capture (an unknown
    /// `shot_id`) in `handleShotRequest`: a re-crop of a KNOWN id is exempt
    /// (see the `stash[shotId]` lookup there), since that is the documented
    /// re-crop contract, not a new capture.
    ///
    /// Finding A (companion-window-polish codex review round 2): round-1
    /// shape of this fix accepted `shot.request` unconditionally — no preview
    /// or report needed at all. Combined with the stash being scoped to a
    /// peer-chosen correlation id (see `stashCorrelationId`), rotating the id
    /// cleared the stash and reset the eight-shot ceiling every time, and
    /// because the on-device "Sharing screen" indicator that used to sit in
    /// this exact path was deliberately removed (see the
    /// companion-window-polish CHANGELOG entry — NOT reintroduced here), that
    /// unlimited pull was also silent.
    ///
    /// Deliberately NOT `isRunning` at check-time: the web client's
    /// `snapShot` sends `shot.request` and then IMMEDIATELY `preview.stop`
    /// under the same correlation id (see `ReporterSurface.tsx`'s
    /// `snapShot`/`closePreview`), both routed onto this same main actor — so
    /// a real, legitimate request can run its check after `preview.stop` has
    /// already cancelled the task and nilled `correlationId`. Gating on "was
    /// this id EVER started", not "is it running THIS INSTANT", is what
    /// survives that ordering. Cleared only where `stashCorrelationId` itself
    /// resets — an id change (above), `clearStash()` (pair loss /
    /// backgrounding), and `teardown()` — so a NEW pairing must send a fresh
    /// `preview.start` before it can pull a fresh capture, exactly like a
    /// legitimate client already does.
    private var previewAuthorizedForStash = false

    public func start(correlationId: String) {
        guard !isTornDown else {
            print("[traceitx-companion] preview.start after teardown — refused")
            return
        }
        adoptStashCorrelation(correlationId)
        // Starting IS the authorization event a fresh capture is gated on —
        // see `previewAuthorizedForStash`. Set unconditionally (even on the
        // idempotent same-id branch below), so a repeat `preview.start` for
        // an id already authorized is a harmless no-op here too.
        previewAuthorizedForStash = true
        if !livePreviewEnabled {
            // Declined AFTER the stash authorization above — the phone's
            // add-shot flow still gets single-shot captures, just no stream.
            send(.previewStop(PreviewStop(correlationId: correlationId,
                                          reason: PreviewStopReason.captureUnavailable.rawValue,
                                          type: "preview.stop")))
            return
        }
        if isRunning {
            // Same id: already running this exact preview — idempotent. A
            // DIFFERENT id means a new report cycle began while an old one was
            // live; keeping the old loop under the old id would make every
            // frame fail the phone's correlation filter, so restart instead.
            if self.correlationId == correlationId { return }
            cancelInternal()
        }
        self.correlationId = correlationId
        seq = 0
        let startedAt = now()
        // The loop is bound to the epoch as of when the phone asked, not just
        // to the boolean gate: kill() lowers the gate and a later start()
        // raises it again, so a tick suspended across both never observes
        // `false`. The epoch is monotonic and cannot be resurrected.
        let authAtStart = CompanionAuthEpoch.current

        task = Task { @MainActor [weak self] in
            guard let self else { return }
            // Cancelled before the body ever ran — `preview.start` immediately
            // followed by `preview.stop` does exactly this.
            guard !Task.isCancelled else { return }
            while self.now().timeIntervalSince(startedAt) * 1000 < self.maxDurationMs {
                try? await Task.sleep(nanoseconds: self.intervalMs * 1_000_000)
                if Task.isCancelled { return }
                // DEFE-03 kill switch. `kill()` closes the capture gate but
                // leaves this client and session alive, so without this the
                // loop kept reading the user's screen for up to two minutes
                // AFTER the host invoked the emergency stop — the one control
                // that must beat everything else.
                guard TraceItX.captureGate, CompanionAuthEpoch.current == authAtStart else {
                    self.stop(reason: .captureUnavailable)
                    return
                }
                guard let frame = await self.capturePreview() else {
                    self.stop(reason: .captureUnavailable)
                    return
                }
                // Re-checked AFTER the capture: `capturePreview()` suspends, and
                // a kill() landing inside that window would otherwise still put
                // the bytes it produced on the wire.
                guard TraceItX.captureGate, CompanionAuthEpoch.current == authAtStart else {
                    self.stop(reason: .captureUnavailable)
                    return
                }
                if Task.isCancelled { return }
                guard let corrId = self.correlationId else { return }
                // NO await between these two calls — that is what makes the
                // header and its binary atomic on this actor. Anything that
                // suspends here can deliver preview bytes into the phone's
                // await-shot slot.
                self.send(.previewFrame(PreviewFrame(correlationId: corrId,
                                                     height: frame.height,
                                                     mime: frame.mime,
                                                     seq: self.seq,
                                                     type: "preview.frame",
                                                     width: frame.width)))
                self.seq += 1
                self.sendBinary(frame.bytes)
            }
            self.stop(reason: .timeCap)
        }
    }

    /// Explicit stop — announces `preview.stop` with `reason` to the peer.
    public func stop(reason: PreviewStopReason) {
        let corrId = correlationId
        guard cancelInternal() else { return }
        if let corrId {
            send(.previewStop(PreviewStop(correlationId: corrId,
                                          reason: reason.rawValue,
                                          type: "preview.stop")))
        }
    }

    /// Same body as `stop`, without the outbound frame — for when the stop
    /// ITSELF came from the peer (echoing one back is nonsensical) or when
    /// nobody is left to receive frames at all.
    public func stopSilently() {
        _ = cancelInternal()
    }

    /// Cancels the loop and clears live session state. Deliberately does NOT
    /// clear the stash — see `stashCorrelationId`.
    @discardableResult
    private func cancelInternal() -> Bool {
        let wasRunning = task != nil
        task?.cancel()
        task = nil
        // Shots are NOT cancelled here. The phone's snap flow sends
        // `shot.request` and then `preview.stop` immediately — so cancelling
        // in-flight shots on an ordinary stop cancels the very capture the user
        // just asked for, and an ordinary snap never produces `shot.assembled`
        // at all. Authorisation-loss paths (`teardown`, pair loss) cancel them
        // via `cancelShots()`; a preview ending does not.
        correlationId = nil
        return wasRunning
    }

    /// Cancels in-flight shot captures — for authorisation loss only.
    private func cancelShots() {
        inFlightShots.values.forEach { $0.cancel() }
        inFlightShots.removeAll()
    }

    public func clearStash() {
        // Pair loss / backgrounding routes here: the authorisation is gone, so
        // any capture still running must stop with it.
        cancelShots()
        stash.removeAll()
        stashCorrelationId = nil
        previewAuthorizedForStash = false
    }

    /// Clears the stash only if it belongs to `correlationId`.
    ///
    /// Correlation-scoped on purpose: a submit deliberately outlives the bond
    /// that started it, so a SUPERSEDED report can finish while a newer one is
    /// already live. An unconditional clear there would drop the live report's
    /// captures.
    public func clearStashFor(correlationId: String) {
        if stashCorrelationId == correlationId { clearStash() }
    }

    /// Fire-and-forget entry point for `RelayWSClient`.
    /// In-flight shot captures, keyed so a finished one can be pruned.
    ///
    /// A dictionary rather than an append-only array: entries are removed on
    /// completion (see the `defer` in `requestShot`), so `cancelShots()` only
    /// ever cancels capture work that is still actually running.
    private var inFlightShots: [UUID: Task<Void, Never>] = [:]

    public func requestShot(correlationId: String, shotId: String, rect: NormalizedRect?) {
        requestShot(correlationId: correlationId, shotId: shotId, rect: rect,
                    authAtRequest: CompanionAuthEpoch.current)
    }

    public func requestShot(correlationId: String,
                            shotId: String,
                            rect: NormalizedRect?,
                            authAtRequest: UInt64) {
        // Tracked, so a stop actually stops it. `cancelInternal()` used to
        // cancel only the preview task; a shot launched here outlived it and
        // kept capturing after the preview stopped. The phone's own flow —
        // `shot.request` immediately followed by `preview.stop` — hits that
        // ordering every single time.
        // `authAtRequest` arrives from the socket thread — see
        // `RelayWSClient.routeShotRequest`. Reading it any later (here, or
        // inside the task) would snapshot an already-invalidated epoch and the
        // final comparison would trivially pass.
        let id = UUID()
        let task = Task { @MainActor [weak self] in
            defer { self?.inFlightShots.removeValue(forKey: id) }
            guard !Task.isCancelled else { return }
            await self?.handleShotRequest(correlationId: correlationId,
                                          shotId: shotId,
                                          rect: rect,
                                          authAtRequest: authAtRequest)
        }
        inFlightShots[id] = task
    }

    /// `correlationId` is the id carried on the INCOMING `shot.request` frame,
    /// never read back off session state. The Android twin read
    /// `self.correlationId ?? lastCorrelationId` — and a `shot.request`
    /// immediately followed by `preview.stop` (which is exactly what the
    /// phone's snapshot flow sends) nulled the id first, dropping every shot
    /// silently: no `shot.assembled`, no `shot.failed`, nothing to retry.
    public func handleShotRequest(correlationId: String, shotId: String, rect: NormalizedRect?) async {
        await handleShotRequest(correlationId: correlationId, shotId: shotId, rect: rect,
                                authAtRequest: CompanionAuthEpoch.current)
    }

    /// - Parameter authAtRequest: the authorisation epoch as of when the phone
    ///   asked, captured by the caller — see `requestShot`.
    public func handleShotRequest(correlationId: String,
                                  shotId: String,
                                  rect: NormalizedRect?,
                                  authAtRequest: UInt64) async {
        guard !isTornDown else {
            send(.shotFailed(ShotFailed(correlationId: correlationId,
                                        reason: "capture_unavailable",
                                        shotId: shotId,
                                        type: "shot.failed")))
            return
        }
        // DEFE-03 kill switch — see the loop above. A shot is the most
        // sensitive capture this session takes; it must not survive kill().
        guard TraceItX.captureGate else {
            send(.shotFailed(ShotFailed(correlationId: correlationId,
                                        reason: "capture_unavailable",
                                        shotId: shotId,
                                        type: "shot.failed")))
            return
        }
        adoptStashCorrelation(correlationId)
        let source: PreviewCapture
        if let stashed = stash[shotId] {
            source = stashed
        } else {
            // A KNOWN id re-crops from the stash and is always allowed — the cap
            // governs how many distinct captures are held, not how often each
            // is re-cropped.
            // The cap counts captures ALREADY held plus those being taken right
            // now. `captureShot()` suspends and the stash is only written
            // afterwards, so counting `stash.count` alone let a burst of
            // requests all read the same empty stash and launch an unbounded
            // number of report-grade captures.
            // A DUPLICATE id already being captured is refused outright — see
            // the Kotlin twin: two concurrent requests for one id both passed
            // the cap, each launched its own capture, and the first to finish
            // removed the shared id while the other was still reading the
            // screen.
            guard !inFlightShotIds.contains(shotId) else {
                send(.shotFailed(ShotFailed(correlationId: correlationId,
                                            reason: "shot_in_flight",
                                            shotId: shotId,
                                            type: "shot.failed")))
                return
            }
            // Finding A: a FRESH capture (unknown shot_id, reached this far
            // because `stash[shotId]` missed above) must not proceed unless a
            // preview was authorised for this exact correlation id at some
            // point — see `previewAuthorizedForStash` for what "authorised"
            // means and why it does not require the preview to still be
            // running right now. A known id re-crops from the stash (the
            // `if let stashed = ...` branch above) and is exempt: that is the
            // documented contract, not a new capture.
            guard previewAuthorizedForStash else {
                send(.shotFailed(ShotFailed(correlationId: correlationId,
                                            reason: "no_active_session",
                                            shotId: shotId,
                                            type: "shot.failed")))
                return
            }
            guard stash.count + inFlightShotIds.count < maxStashedShots else {
                send(.shotFailed(ShotFailed(correlationId: correlationId,
                                            reason: "too_many_shots",
                                            shotId: shotId,
                                            type: "shot.failed")))
                return
            }
            inFlightShotIds.insert(shotId)
            defer { inFlightShotIds.remove(shotId) }
            guard let fresh = await captureShot() else {
                send(.shotFailed(ShotFailed(correlationId: correlationId,
                                            reason: "capture_unavailable",
                                            shotId: shotId,
                                            type: "shot.failed")))
                return
            }
            // Cancellation between the request and the capture completing
            // means authorisation is gone — phone disconnect, pair expiry,
            // backgrounding, teardown. `Task.cancel()` cannot interrupt an
            // already-running capture, so without this check the
            // full-resolution image was still stashed AND sent afterwards.
            guard !Task.isCancelled else { return }
            // Re-checked AFTER the capture, for the same reason as the loop.
            guard TraceItX.captureGate else {
                send(.shotFailed(ShotFailed(correlationId: correlationId,
                                            reason: "capture_unavailable",
                                            shotId: shotId,
                                            type: "shot.failed")))
                return
            }
            stash[shotId] = fresh
            source = fresh
        }
        guard !Task.isCancelled else { return }
        // The authorising phone leg is gone — and because the capture ran
        // synchronously on this actor, this is the FIRST point at which that
        // could be observed. Sending now would hand a full-resolution capture
        // to whoever re-attached to the pair.
        guard CompanionAuthEpoch.current == authAtRequest else {
            stash.removeValue(forKey: shotId)
            return
        }
        let out = rect.map { crop(source, $0) } ?? source
        // Again: no await between the header and its binary.
        send(.shotAssembled(ShotAssembled(correlationId: correlationId,
                                          height: out.height,
                                          mime: out.mime,
                                          shotId: shotId,
                                          size: out.bytes.count,
                                          type: "shot.assembled",
                                          width: out.width)))
        sendBinary(out.bytes)
    }

    /// Permanent shutdown. Only for a `RelayWSClient` being torn down for good;
    /// the resumable background case uses `stopSilently()` + `clearStash()`,
    /// because the SAME client reconnects on foreground.
    public func teardown() {
        isTornDown = true
        cancelShots()
        _ = cancelInternal()
        stash.removeAll()
        stashCorrelationId = nil
        previewAuthorizedForStash = false
    }
}

/// Denormalizes `rect` against `source`'s own pixel dimensions, re-encodes, and
/// PRESERVES `source`'s mime rather than forcing a fixed output format — a
/// stash capture may be PNG or JPEG depending on which seam produced it, and a
/// crop of it must not silently relabel it.
@MainActor
public func defaultCrop(_ source: PreviewCapture, _ rect: NormalizedRect) -> PreviewCapture {
    guard let image = UIImage(data: source.bytes), let cg = image.cgImage else { return source }
    let x = clampInt(Int((rect.x * Double(cg.width)).rounded()), 0, max(0, cg.width - 1))
    let y = clampInt(Int((rect.y * Double(cg.height)).rounded()), 0, max(0, cg.height - 1))
    let w = clampInt(Int((rect.w * Double(cg.width)).rounded()), 1, max(1, cg.width - x))
    let h = clampInt(Int((rect.h * Double(cg.height)).rounded()), 1, max(1, cg.height - y))
    guard let cropped = cg.cropping(to: CGRect(x: x, y: y, width: w, height: h)) else { return source }
    let out = UIImage(cgImage: cropped)
    let bytes: Data? = source.mime == "image/png" ? out.pngData() : out.jpegData(compressionQuality: 0.9)
    guard let bytes else { return source }
    return PreviewCapture(bytes: bytes, width: cropped.width, height: cropped.height, mime: source.mime)
}

private func clampInt(_ value: Int, _ low: Int, _ high: Int) -> Int {
    min(max(value, low), high)
}
#endif
