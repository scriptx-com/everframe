// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// CompanionPreviewSession — the loop, the cap, and the stash.
//
// Every capture seam is injected, so these never need a foreground scene (a
// SwiftPM test bundle has none). The sharing indicator that used to gate this
// session (`SharingIndicatorGate`, `CompanionSharingIndicator.show()`) was
// removed — see task 13 of the companion-window-polish plan: the gate used to
// refuse the preview outright when the indicator could not be shown, and
// deleting the pill without deleting the gate would have broken live preview
// entirely. What is proven here now is that nothing stands between
// `start(correlationId:)` / `handleShotRequest` and the capture seams below.
#if canImport(UIKit)
import Testing
import Foundation
import TraceItXProtocol
@testable import TraceItXKit

@Suite(.serialized)
@MainActor
struct CompanionPreviewSessionTests {

    /// The DEFE-03 capture gate defaults CLOSED and is opened by
    /// `TraceItX.start()`. These tests drive the session directly, so they
    /// model a started SDK — otherwise every capture is (correctly) refused by
    /// the kill-switch check.
    init() { TraceItX.captureGate = true }

    /// `RelayMessage` is an ENUM wrapping the per-message structs, so these
    /// accessors pattern-match rather than cast — `headers.contains { $0 is
    /// PreviewFrame }` does not compile, there is no such subtype relationship.
    final class Spy {
        enum Event { case header(RelayMessage); case binary(Data) }
        var events: [Event] = []
        func send(_ m: RelayMessage) { events.append(.header(m)) }
        func sendBinary(_ d: Data) { events.append(.binary(d)) }

        var binaryCount: Int {
            events.filter { if case .binary = $0 { return true } else { return false } }.count
        }
        var headers: [RelayMessage] {
            events.compactMap { if case .header(let m) = $0 { return m } else { return nil } }
        }
        var stopReasons: [String] {
            headers.compactMap { if case .previewStop(let m) = $0 { return m.reason } else { return nil } }
        }
        var previewFrames: [PreviewFrame] {
            headers.compactMap { if case .previewFrame(let m) = $0 { return m } else { return nil } }
        }
        var shotAssembled: [ShotAssembled] {
            headers.compactMap { if case .shotAssembled(let m) = $0 { return m } else { return nil } }
        }
        var shotFailed: [ShotFailed] {
            headers.compactMap { if case .shotFailed(let m) = $0 { return m } else { return nil } }
        }
        var reportFailed: [ReportFailed] {
            headers.compactMap { if case .reportFailed(let m) = $0 { return m } else { return nil } }
        }
        /// True when every binary-bearing header is immediately followed by a binary.
        var everyHeaderIsFollowedByItsBinary: Bool {
            for (i, event) in events.enumerated() {
                guard case .header(let m) = event else { continue }
                switch m {
                case .previewFrame, .shotAssembled:
                    guard i + 1 < events.count, case .binary = events[i + 1] else { return false }
                default: continue
                }
            }
            return true
        }
    }

    private func jpeg(_ w: Int = 8, _ h: Int = 4) -> PreviewCapture {
        PreviewCapture(bytes: Data([0xFF, 0xD8, 0x00, 0x01]), width: w, height: h, mime: "image/jpeg")
    }

    private func png(_ w: Int = 1000, _ h: Int = 500) -> PreviewCapture {
        PreviewCapture(bytes: Data([0x89, 0x50, 0x4E, 0x47]), width: w, height: h, mime: "image/png")
    }

    /// Waits until `predicate` holds or the budget runs out. Keeps the
    /// real-time loop tests from being a fixed sleep tuned to this machine.
    private func waitUntil(_ label: String,
                           timeoutMs: UInt64 = 3000,
                           _ predicate: () -> Bool) async {
        var waited: UInt64 = 0
        while waited < timeoutMs {
            if predicate() { return }
            try? await Task.sleep(nanoseconds: 10_000_000)
            waited += 10
        }
    }

    // ---- Live preview declined by default (product call 2026-08-27). Every
    // loop test below injects `livePreviewEnabled: true`; production uses the
    // default (OFF): each frame is a full screen capture, a continuous CPU
    // tax for a nice-to-have viewfinder. ----

    @Test("declines preview.start with capture_unavailable by default")
    func declinesPreviewStartByDefault() async throws {
        let spy = Spy()
        var previewCalls = 0
        let session = CompanionPreviewSession(
            send: spy.send, sendBinary: spy.sendBinary,
            capturePreview: { previewCalls += 1; return self.jpeg() },
            captureShot: { self.png() },
            intervalMs: 20, maxDurationMs: 120_000)
        session.start(correlationId: "c1")
        try? await Task.sleep(nanoseconds: 100_000_000)

        #expect(!session.isRunning)
        #expect(previewCalls == 0)
        #expect(spy.previewFrames.isEmpty)
        #expect(spy.stopReasons == ["capture_unavailable"])
    }

    @Test("a declined preview still authorizes single-shot capture")
    func declinedPreviewStillAuthorizesShot() async throws {
        let spy = Spy()
        let session = CompanionPreviewSession(
            send: spy.send, sendBinary: spy.sendBinary,
            capturePreview: { self.jpeg() },
            captureShot: { self.png() },
            intervalMs: 20, maxDurationMs: 120_000)
        session.start(correlationId: "c1")
        session.requestShot(correlationId: "c1", shotId: "s1", rect: nil)
        await waitUntil("shot assembled") { !spy.shotAssembled.isEmpty }

        #expect(spy.shotAssembled.count == 1)
        #expect(spy.previewFrames.isEmpty)
    }

    // ---- No gate. The sharing indicator used to refuse the preview outright
    // when it could not be shown; it is gone, and nothing replaces it. ----

    @Test("start runs the capture loop with nothing standing in front of it")
    func startRunsWithNoGateInTheWay() async throws {
        // The indicator used to be a GATE: `show()` returning false refused
        // the preview outright. With the pill gone there is no longer any
        // gate parameter to inject at all — this proves the loop actually
        // reaches a capture instead of merely reporting `isRunning`.
        let spy = Spy()
        var previewCalls = 0
        let session = CompanionPreviewSession(
            send: spy.send, sendBinary: spy.sendBinary,
            capturePreview: { previewCalls += 1; return self.jpeg() },
            captureShot: { self.png() },
            intervalMs: 20, maxDurationMs: 120_000, livePreviewEnabled: true)

        session.start(correlationId: "corr-1")
        await waitUntil("first frame") { previewCalls >= 1 }

        #expect(session.isRunning)
        #expect(previewCalls >= 1,
                "the capture loop must actually run — nothing may refuse it now that the indicator gate is gone")
        session.stop(reason: .user)
    }

    // ---- The loop ----

    @Test("the loop emits a header immediately followed by its own binary")
    func headerAndBinaryAreAtomic() async throws {
        let spy = Spy()
        let session = CompanionPreviewSession(
            send: spy.send, sendBinary: spy.sendBinary,
            capturePreview: { self.jpeg() }, captureShot: { self.png() },
            intervalMs: 20, maxDurationMs: 120_000, livePreviewEnabled: true)

        session.start(correlationId: "c1")
        await waitUntil("two frames") { spy.previewFrames.count >= 2 }
        session.stop(reason: .user)

        #expect(spy.everyHeaderIsFollowedByItsBinary,
                "a header whose binary is not the very next event can deliver preview bytes into the phone's await-shot slot")
        #expect(spy.previewFrames.count >= 2, "the loop must actually have emitted frames")
    }

    @Test("frames carry the correlation id and an increasing seq")
    func framesAreIdentified() async throws {
        let spy = Spy()
        let session = CompanionPreviewSession(
            send: spy.send, sendBinary: spy.sendBinary,
            capturePreview: { self.jpeg() }, captureShot: { self.png() },
            intervalMs: 20, maxDurationMs: 120_000, livePreviewEnabled: true)

        session.start(correlationId: "c1")
        await waitUntil("three frames") { spy.previewFrames.count >= 3 }
        session.stop(reason: .user)

        let frames = spy.previewFrames
        #expect(frames.allSatisfy { $0.correlationId == "c1" })
        #expect(Array(frames.prefix(3).map(\.seq)) == [0, 1, 2],
                "a phone filtering on seq needs it to start at 0 and increase by one")
        #expect(frames.allSatisfy { $0.mime == "image/jpeg" })
    }

    @Test("an explicit stop announces its reason")
    func explicitStopAnnounces() async throws {
        let spy = Spy()
        let session = CompanionPreviewSession(
            send: spy.send, sendBinary: spy.sendBinary,
            capturePreview: { self.jpeg() }, captureShot: { self.png() },
            intervalMs: 20, maxDurationMs: 120_000, livePreviewEnabled: true)
        session.start(correlationId: "c1")
        await waitUntil("running") { spy.previewFrames.count >= 1 }

        session.stop(reason: .user)

        #expect(spy.stopReasons == ["user"])
        #expect(!session.isRunning)
    }

    @Test("stopSilently does not echo a stop at the peer that sent one")
    func stopSilentlyIsQuiet() async throws {
        let spy = Spy()
        let session = CompanionPreviewSession(
            send: spy.send, sendBinary: spy.sendBinary,
            capturePreview: { self.jpeg() }, captureShot: { self.png() },
            intervalMs: 20, maxDurationMs: 120_000, livePreviewEnabled: true)
        session.start(correlationId: "c1")
        await waitUntil("running") { spy.previewFrames.count >= 1 }

        session.stopSilently()

        #expect(spy.stopReasons.isEmpty, "echoing a stop back at the peer that just sent one is nonsensical")
        #expect(!session.isRunning)
    }

    @Test("the loop stops at the wall-clock cap and announces it")
    func stopsAtTheCap() async throws {
        let spy = Spy()
        // Injected clock: the cap is 2 minutes in production, and this drives
        // it without waiting. Each read advances 40ms of virtual time, so the
        // 100ms cap is crossed after a few ticks.
        var virtualNow = Date(timeIntervalSince1970: 0)
        let session = CompanionPreviewSession(
            send: spy.send, sendBinary: spy.sendBinary,
            capturePreview: { self.jpeg() }, captureShot: { self.png() },
            intervalMs: 10, maxDurationMs: 100, livePreviewEnabled: true,
            now: { virtualNow.addTimeInterval(0.04); return virtualNow })

        session.start(correlationId: "c1")
        await waitUntil("cap reached") { spy.stopReasons.contains("time_cap") }

        #expect(!session.isRunning)
        #expect(spy.stopReasons == ["time_cap"],
                "a preview that outlives its cap is exactly the failure this feature exists to prevent")
    }

    @Test("the loop announces capture_unavailable when the preview seam returns nothing")
    func stopsWithCaptureUnavailableWhenTheSeamFails() async throws {
        // The web client (`ReporterSurface`) keys on exactly this reason,
        // combined with a no-frame heuristic, to tell "this device has no
        // preview implementation" apart from "transient loss — offer Resume".
        // Deleting the old sharing-indicator tests took the only coverage of
        // this branch with them; a native change that stops emitting
        // `capture_unavailable`, or emits some other reason, would ship green
        // and strand the companion panel on an empty stage with no Resume.
        let spy = Spy()
        let session = CompanionPreviewSession(
            send: spy.send, sendBinary: spy.sendBinary,
            capturePreview: { nil }, captureShot: { self.png() },
            intervalMs: 20, maxDurationMs: 120_000, livePreviewEnabled: true)

        session.start(correlationId: "c1")
        await waitUntil("stopped") { spy.stopReasons.contains("capture_unavailable") }

        #expect(!session.isRunning)
        #expect(spy.stopReasons == ["capture_unavailable"])
    }

    // ---- Shots ----

    @Test("a shot uses the shot seam, never the preview seam, and keeps its own mime")
    func shotUsesItsOwnSeam() async throws {
        let spy = Spy()
        var previewCalls = 0
        var shotCalls = 0
        let session = CompanionPreviewSession(
            send: spy.send, sendBinary: spy.sendBinary,
            capturePreview: { previewCalls += 1; return self.jpeg() },
            captureShot: { shotCalls += 1; return self.png() },
            intervalMs: 20, maxDurationMs: 120_000, livePreviewEnabled: true)

        // Finding A: a FRESH capture requires the correlation id to have been
        // authorised via start() first — see previewAuthorizedForStash.
        session.start(correlationId: "c1")
        session.stop(reason: .user)
        await session.handleShotRequest(correlationId: "c1", shotId: "s1", rect: nil)

        #expect(shotCalls == 1)
        #expect(previewCalls == 0, "a shot must never be served by the preview seam")
        let assembled = try #require(spy.shotAssembled.first)
        #expect(assembled.mime == "image/png", "the announced mime must be what the seam produced, not a hardcoded value")
        #expect(assembled.shotId == "s1")
        #expect(assembled.correlationId == "c1")
        #expect(spy.everyHeaderIsFollowedByItsBinary)
    }

    @Test("a shot answers the id on the request, not the session's own state")
    func shotUsesTheMessageCorrelationId() async throws {
        // Android's CRITICAL 1: the session read its OWN correlation id (with a
        // never-assigned fallback) instead of the one on the incoming frame,
        // and the phone's snapshot flow — shot.request immediately followed by
        // preview.stop — nulled it first, dropping every shot silently.
        //
        // An earlier version of this test ran against a never-started
        // session, so a `self.correlationId ?? requested` implementation fell
        // through to the right answer and the test passed under the very
        // defect it existed to catch.
        //
        // Finding A (companion-window-polish codex review round 2): a FRESH
        // capture now also requires the exact correlation id on the request
        // to have been authorised via start() at some point — see
        // `previewAuthorizedForStash`. So unlike the original version of this
        // test (which requested "c2" against a session that had never started
        // anything under that id), "c2" is explicitly started here too, then
        // immediately stopped — mirroring the phone's own snap-then-stop
        // ordering, which leaves the session's internal `correlationId` nil.
        // That keeps this test proving the same thing: the answered id comes
        // from the request, not from internal state, which by the time of the
        // request is nil either way.
        let spy = Spy()
        let session = CompanionPreviewSession(
            send: spy.send, sendBinary: spy.sendBinary,
            capturePreview: { self.jpeg() }, captureShot: { self.png() },
            intervalMs: 20, maxDurationMs: 120_000, livePreviewEnabled: true)
        session.start(correlationId: "c1")
        await waitUntil("running") { spy.previewFrames.count >= 1 }
        session.stop(reason: .user)

        session.start(correlationId: "c2")
        await waitUntil("running under c2") { spy.previewFrames.contains { $0.correlationId == "c2" } }
        session.stop(reason: .user)

        await session.handleShotRequest(correlationId: "c2", shotId: "s1", rect: nil)

        let assembled = try #require(spy.shotAssembled.first)
        #expect(assembled.correlationId == "c2",
                "the id must come from the request frame, not from internal state (nil, after stop)")
    }

    @Test("a shot still answers after the preview has been stopped")
    func shotSurvivesAStopRace() async throws {
        // The exact ordering the phone produces: shot.request, then
        // preview.stop. If the stop is processed first the session's own id is
        // already nil, so anything reading session state answers nothing at
        // all — no shot.assembled, no shot.failed, the phone stranded.
        let spy = Spy()
        let session = CompanionPreviewSession(
            send: spy.send, sendBinary: spy.sendBinary,
            capturePreview: { self.jpeg() }, captureShot: { self.png() },
            intervalMs: 20, maxDurationMs: 120_000, livePreviewEnabled: true)
        session.start(correlationId: "c1")
        await waitUntil("running") { spy.previewFrames.count >= 1 }

        session.stopSilently()
        await session.handleShotRequest(correlationId: "c1", shotId: "s1", rect: nil)

        let assembled = try #require(spy.shotAssembled.first,
                                     "a shot arriving after the stop must still be answered")
        #expect(assembled.correlationId == "c1")
    }

    @Test("a failed shot fails only that shot")
    func aFailedShotDoesNotFailTheReport() async throws {
        let spy = Spy()
        let session = CompanionPreviewSession(
            send: spy.send, sendBinary: spy.sendBinary,
            capturePreview: { self.jpeg() },
            captureShot: { nil },
            intervalMs: 20, maxDurationMs: 120_000, livePreviewEnabled: true)

        // Finding A: authorise "c1" first so the request reaches captureShot()
        // (and fails THERE, which is what this test is about) instead of
        // being refused earlier by the new authorisation gate.
        session.start(correlationId: "c1")
        session.stop(reason: .user)
        await session.handleShotRequest(correlationId: "c1", shotId: "s1", rect: nil)

        #expect(!spy.shotFailed.isEmpty, "the shot must fail explicitly, never silently")
        #expect(spy.reportFailed.isEmpty, "a failed shot must never fail the whole report")
        #expect(spy.shotAssembled.isEmpty)
    }

    // ---- The stash ----

    @Test("a preview stop keeps the stash, so a re-crop is not a fresh capture")
    func stashSurvivesAPreviewStop() async throws {
        let spy = Spy()
        var shotCalls = 0
        let session = CompanionPreviewSession(
            send: spy.send, sendBinary: spy.sendBinary,
            capturePreview: { self.jpeg() },
            captureShot: { shotCalls += 1; return self.png() },
            crop: { src, _ in PreviewCapture(bytes: src.bytes, width: 500, height: 250, mime: src.mime) },
            intervalMs: 20, maxDurationMs: 120_000, livePreviewEnabled: true)

        session.start(correlationId: "c1")
        await session.handleShotRequest(correlationId: "c1", shotId: "s1", rect: nil)
        #expect(shotCalls == 1)

        // Exactly what the phone does after every snap.
        session.stopSilently()
        await session.handleShotRequest(correlationId: "c1", shotId: "s1",
                                        rect: NormalizedRect(x: 0, y: 0, w: 0.5, h: 0.5))

        #expect(shotCalls == 1,
                "a re-crop must come from the stash; re-capturing would announce the CURRENT screen under the original shot's id")
        #expect(spy.shotAssembled.count == 2)
    }

    @Test("a new report cycle drops the previous cycle's stash")
    func stashIsScopedToTheCorrelationId() async throws {
        let spy = Spy()
        var shotCalls = 0
        let session = CompanionPreviewSession(
            send: spy.send, sendBinary: spy.sendBinary,
            capturePreview: { self.jpeg() },
            captureShot: { shotCalls += 1; return self.png() },
            intervalMs: 20, maxDurationMs: 120_000, livePreviewEnabled: true)

        // Finding A: authorise each correlation id before requesting under
        // it — a fresh capture with no active/ever-authorised preview is
        // exactly what this branch's fix now refuses.
        session.start(correlationId: "c1")
        session.stop(reason: .user)
        await session.handleShotRequest(correlationId: "c1", shotId: "s1", rect: nil)
        session.start(correlationId: "c2")
        session.stop(reason: .user)
        await session.handleShotRequest(correlationId: "c2", shotId: "s1", rect: nil)

        #expect(shotCalls == 2, "the same shot_id under a new correlation id must capture afresh")
    }

    @Test("the stash is bounded — a peer looping over fresh shot ids cannot grow it without limit")
    func stashIsBounded() async throws {
        // `report.submit`'s `shots` array is capped at 8 by the protocol, so a
        // ninth capture could never be submitted anyway — but nothing capped
        // the stash itself, and `shot_id` is phone-chosen. Each entry is a
        // report-grade PNG of the user's screen.
        let spy = Spy()
        var shotCalls = 0
        let session = CompanionPreviewSession(
            send: spy.send, sendBinary: spy.sendBinary,
            capturePreview: { self.jpeg() },
            captureShot: { shotCalls += 1; return self.png() },
            intervalMs: 20, maxDurationMs: 120_000, livePreviewEnabled: true)

        // Finding A: authorise "c1" once — every request below reuses it, so
        // this exercises the CAP, not the new authorisation gate.
        session.start(correlationId: "c1")
        session.stop(reason: .user)
        for i in 0..<12 {
            await session.handleShotRequest(correlationId: "c1", shotId: "s\(i)", rect: nil)
        }

        #expect(shotCalls == 8, "the ninth distinct shot must not be captured")
        #expect(spy.shotAssembled.count == 8)
        #expect(spy.shotFailed.count == 4, "the phone must be told, not silently ignored")
        #expect(spy.shotFailed.allSatisfy { $0.reason == "too_many_shots" })
    }

    @Test("a known shot id still re-crops once the cap is reached")
    func capDoesNotBlockRecrop() async throws {
        // The cap governs how many distinct captures are HELD, not how often
        // each is re-cropped — otherwise reaching the cap would break the crop
        // flow for shots already taken.
        let spy = Spy()
        var shotCalls = 0
        let session = CompanionPreviewSession(
            send: spy.send, sendBinary: spy.sendBinary,
            capturePreview: { self.jpeg() },
            captureShot: { shotCalls += 1; return self.png() },
            crop: { src, _ in PreviewCapture(bytes: src.bytes, width: 5, height: 5, mime: src.mime) },
            intervalMs: 20, maxDurationMs: 120_000, livePreviewEnabled: true)
        // Finding A: authorise "c1" once — see the stash-bound test's comment.
        session.start(correlationId: "c1")
        session.stop(reason: .user)
        for i in 0..<8 {
            await session.handleShotRequest(correlationId: "c1", shotId: "s\(i)", rect: nil)
        }
        #expect(shotCalls == 8)

        await session.handleShotRequest(correlationId: "c1", shotId: "s0",
                                        rect: NormalizedRect(x: 0, y: 0, w: 0.5, h: 0.5))

        #expect(shotCalls == 8, "a re-crop must not capture again")
        #expect(spy.shotFailed.isEmpty, "and must not be refused by the cap")
        #expect(spy.shotAssembled.count == 9)
    }

    @Test("clearStash drops it — the pair-loss path the client calls explicitly")
    func clearStashDrops() async throws {
        let spy = Spy()
        var shotCalls = 0
        let session = CompanionPreviewSession(
            send: spy.send, sendBinary: spy.sendBinary,
            capturePreview: { self.jpeg() },
            captureShot: { shotCalls += 1; return self.png() },
            intervalMs: 20, maxDurationMs: 120_000, livePreviewEnabled: true)
        // Finding A: authorise "c1" before each request. clearStash() (below)
        // resets that authorisation along with everything else — a NEW
        // pairing means a NEW preview.start, same as production.
        session.start(correlationId: "c1")
        session.stop(reason: .user)
        await session.handleShotRequest(correlationId: "c1", shotId: "s1", rect: nil)

        session.clearStash()
        session.start(correlationId: "c1")
        session.stop(reason: .user)
        await session.handleShotRequest(correlationId: "c1", shotId: "s1", rect: nil)

        #expect(shotCalls == 2, "a shot captured before the pair was lost must never be reachable after it")
    }

    @Test("teardown drops the stash permanently")
    func teardownDropsTheStash() async throws {
        let spy = Spy()
        var shotCalls = 0
        let session = CompanionPreviewSession(
            send: spy.send, sendBinary: spy.sendBinary,
            capturePreview: { self.jpeg() },
            captureShot: { shotCalls += 1; return self.png() },
            intervalMs: 20, maxDurationMs: 120_000, livePreviewEnabled: true)
        // Finding A: authorise "c1" first.
        session.start(correlationId: "c1")
        session.stop(reason: .user)
        await session.handleShotRequest(correlationId: "c1", shotId: "s1", rect: nil)

        session.teardown()
        await session.handleShotRequest(correlationId: "c1", shotId: "s1", rect: nil)

        // Teardown is terminal, so the second request is refused outright
        // rather than served from a stash — which is strictly stronger than the
        // old assertion that it re-captured. Either way the point holds:
        // report-grade pixels must not outlive the client authorised to hold
        // them.
        #expect(shotCalls == 1, "a post-teardown request must not capture at all")
        #expect(spy.shotAssembled.count == 1, "and must not be answered from the dropped stash")
    }

    // ---- Lifecycle ----

    @Test("a same-id restart is idempotent, a new id restarts under the new identity")
    func restartSemantics() async throws {
        let spy = Spy()
        let session = CompanionPreviewSession(
            send: spy.send, sendBinary: spy.sendBinary,
            capturePreview: { self.jpeg() }, captureShot: { self.png() },
            intervalMs: 20, maxDurationMs: 120_000, livePreviewEnabled: true)

        session.start(correlationId: "c1")
        await waitUntil("running") { spy.previewFrames.count >= 1 }
        session.start(correlationId: "c1") // idempotent
        #expect(session.isRunning)

        session.start(correlationId: "c2")
        await waitUntil("frames under c2") { spy.previewFrames.contains { $0.correlationId == "c2" } }
        session.stop(reason: .user)

        #expect(spy.previewFrames.contains { $0.correlationId == "c2" },
                "a new report cycle must restart under the new id, or every frame fails the phone's filter")
    }

    @Test("teardown is terminal — nothing may capture after it")
    func teardownIsTerminal() async throws {
        // Android gets this from cancelling its whole coroutine scope. Here
        // teardown only cancelled the CURRENT work, so a later start() or
        // requestShot() captured normally — and relay routing is queued onto
        // the main actor, so a frame already in that queue could land after
        // `disconnect()` and restart capture with authorisation already gone.
        let spy = Spy()
        var previewCalls = 0
        var shotCalls = 0
        let session = CompanionPreviewSession(
            send: spy.send, sendBinary: spy.sendBinary,
            capturePreview: { previewCalls += 1; return self.jpeg() },
            captureShot: { shotCalls += 1; return self.png() },
            intervalMs: 20, maxDurationMs: 120_000, livePreviewEnabled: true)

        session.teardown()
        session.start(correlationId: "c1")
        await session.handleShotRequest(correlationId: "c1", shotId: "s1", rect: nil)
        try? await Task.sleep(nanoseconds: 120_000_000)

        #expect(!session.isRunning)
        #expect(previewCalls == 0, "no preview frame may be captured after teardown")
        #expect(shotCalls == 0, "no shot may be captured after teardown")
        #expect(!spy.shotFailed.isEmpty, "and the phone is told rather than left pending")
    }

    @Test("stopping immediately after start never captures a frame")
    func stoppingImmediatelyAfterStartCapturesNothing() async throws {
        // `preview.start` immediately followed by `preview.stop` cancels the
        // task before it produces a frame. This is a regression guard for the
        // loop's cancellation handling AS A WHOLE — the pre-loop
        // `guard !Task.isCancelled` plus the in-loop check right after
        // `Task.sleep` — not a test that isolates the pre-loop guard alone.
        //
        // HONEST LIMIT: verified, not assumed. For an already-cancelled task
        // `try? await Task.sleep` returns almost immediately (it swallows the
        // `CancellationError`), so the in-loop `if Task.isCancelled { return }`
        // that follows it catches this case before `capturePreview()` is ever
        // called — before the pre-loop guard's absence could matter. Deleting
        // the pre-loop guard alone (measured) leaves this test passing
        // unchanged. It stays anyway: the reasoning for having it holds
        // independent of this test, and it costs nothing. See
        // `cancelledShotDoesNotTransmit` for the same caveat on the shot side.
        let spy = Spy()
        var previewCalls = 0
        let session = CompanionPreviewSession(
            send: spy.send, sendBinary: spy.sendBinary,
            capturePreview: { previewCalls += 1; return self.jpeg() },
            captureShot: { self.png() },
            intervalMs: 50, maxDurationMs: 120_000, livePreviewEnabled: true)

        session.start(correlationId: "c1")
        session.stop(reason: .user)
        try? await Task.sleep(nanoseconds: 250_000_000)

        #expect(!session.isRunning)
        #expect(previewCalls == 0,
                "a start cancelled before its body ran must not go on to capture a frame")
    }

    @Test("a cancelled shot capture does not transmit its pixels")
    func cancelledShotDoesNotTransmit() async throws {
        // `Task.cancel()` cannot interrupt a capture already running, so
        // without a check after the await the full-resolution image could still
        // be stashed AND sent, after phone disconnect / pair expiry /
        // backgrounding / teardown had already ended the authorisation.
        //
        // HONEST LIMIT: this assertion passes with the post-capture
        // `Task.isCancelled` guard removed — measured, not assumed. Something
        // upstream already stops this particular path, so the test is a
        // regression guard for the observable property rather than proof the
        // guard is load-bearing. The guard stays because the reasoning holds
        // and it costs nothing; do not read a green run as licence to drop it.
        let spy = Spy()
        let session = CompanionPreviewSession(
            send: spy.send, sendBinary: spy.sendBinary,
            capturePreview: { self.jpeg() },
            captureShot: {
                try? await Task.sleep(nanoseconds: 150_000_000)
                return self.png()
            },
            intervalMs: 50, maxDurationMs: 120_000, livePreviewEnabled: true)

        // Finding A: authorise "c1" first so the request actually reaches
        // captureShot() — the mid-capture pair loss this test exists to
        // prove — instead of being refused earlier by the new gate.
        session.start(correlationId: "c1")
        session.stop(reason: .user)
        session.requestShot(correlationId: "c1", shotId: "s1", rect: nil)
        try? await Task.sleep(nanoseconds: 30_000_000)
        session.clearStash() // pair loss: authorisation gone, mid-capture
        try? await Task.sleep(nanoseconds: 300_000_000)

        #expect(spy.shotAssembled.isEmpty,
                "a capture cancelled mid-flight must not reach the wire")
    }

    // ---- inFlightShotIds bookkeeping ----
    //
    // The sharing indicator used to make a pruning regression here visible as
    // a stranded pill (task 13 of companion-window-polish removed it). The
    // invariant it was guarding did not go away: if `inFlightShotIds` stops
    // being pruned, it grows without bound for the life of the session and
    // every later request for the same shot id is wrongly refused
    // `shot_in_flight` forever. `__inFlightShotCountForTesting()` is the test
    // seam for that, mirroring `CompanionCaptureBridge.__stashCountForTesting()`.

    @Test("a shot id is reserved before capture and pruned exactly once it finishes")
    func inFlightShotIdIsTrackedAndPruned() async throws {
        let spy = Spy()
        let session = CompanionPreviewSession(
            send: spy.send, sendBinary: spy.sendBinary,
            capturePreview: { self.jpeg() },
            captureShot: {
                try? await Task.sleep(nanoseconds: 150_000_000)
                return self.png()
            },
            intervalMs: 20, maxDurationMs: 120_000, livePreviewEnabled: true)

        // Finding A: authorise "c1" first so the request actually reaches
        // captureShot() instead of being refused earlier by the new gate.
        session.start(correlationId: "c1")
        session.stop(reason: .user)
        session.requestShot(correlationId: "c1", shotId: "s1", rect: nil)
        try? await Task.sleep(nanoseconds: 30_000_000) // let it enter captureShot
        #expect(session.__inFlightShotCountForTesting() == 1,
                "the id must be reserved before captureShot() suspends")

        await waitUntil("shot finished") { spy.shotAssembled.count >= 1 }
        #expect(session.__inFlightShotCountForTesting() == 0,
                "a finished shot must be pruned, not left stranded")
    }

    @Test("two concurrent shots are pruned independently, not by clearing the whole set or the wrong entry")
    func concurrentInFlightShotIdsArePrunedIndependently() async throws {
        // A same-duration pair (the first version of this test) can only
        // observe count == 2 mid-flight and count == 0 at the end — and
        // `.removeAll()` instead of `.remove(shotId)` produces that SAME
        // final 0, so the bug ships with a green test. Durations are
        // deliberately staggered by 10x here so "s-short" finishes and is
        // pruned while "s-long" is still reserved, giving a genuine
        // intermediate state: count == 1 with a SPECIFIC id remaining. That
        // is what discriminates all three of: clear-the-whole-set (would
        // read 0, not 1, at the checkpoint), remove-the-wrong-entry (would
        // read 1, but the WRONG id — caught only by naming it, not by count
        // alone), and correct behaviour.
        //
        // callCount assigns the short duration to the request that reaches
        // captureShot() first. requestShot() enqueues an unstructured
        // @MainActor Task per call with no `await` between the two calls
        // here, so both are queued in the order requested and — since
        // nothing else is runnable on this actor in between — the first
        // queued Task runs its synchronous prefix (through the
        // `inFlightShotIds.insert` and up to the `await captureShot()` call)
        // before the second gets a turn. This ordering assumption is already
        // relied on elsewhere in this file (see `queuedShotUsesEnqueueTimeEpoch`'s
        // "the task above has not started yet" comment) rather than
        // introduced fresh here.
        let spy = Spy()
        var callCount = 0
        let session = CompanionPreviewSession(
            send: spy.send, sendBinary: spy.sendBinary,
            capturePreview: { self.jpeg() },
            captureShot: {
                callCount += 1
                let isFirstToStart = (callCount == 1)
                try? await Task.sleep(nanoseconds: isFirstToStart ? 40_000_000 : 500_000_000)
                return self.png()
            },
            intervalMs: 20, maxDurationMs: 120_000, livePreviewEnabled: true)

        // Finding A: authorise "c1" first — see the sibling test's comment.
        session.start(correlationId: "c1")
        session.stop(reason: .user)
        session.requestShot(correlationId: "c1", shotId: "s-short", rect: nil)
        session.requestShot(correlationId: "c1", shotId: "s-long", rect: nil)
        try? await Task.sleep(nanoseconds: 10_000_000) // let both enter captureShot

        #expect(session.__inFlightShotCountForTesting() == 2,
                "both concurrent captures must be reserved, or a burst of requests could overrun the cap unnoticed")

        // s-short (40ms) finishes well before s-long (500ms) — a 12x margin,
        // chosen to stay clear of simulator scheduling jitter.
        await waitUntil("the short shot finished") { spy.shotAssembled.count >= 1 }
        #expect(spy.shotAssembled.count == 1,
                "the long shot must not have finished yet — the margin between durations must hold")
        #expect(session.__inFlightShotCountForTesting() == 1,
                "exactly the finished id must be pruned while the still-running one stays reserved — a `.removeAll()` bug reads 0 here")
        #expect(session.__inFlightShotIdsForTesting() == ["s-long"],
                "the id STILL reserved must be the one still capturing, not the one that just finished — a wrong-entry-removed bug reads a count of 1 too, but names the wrong id")

        await waitUntil("the long shot finished") { spy.shotAssembled.count >= 2 }
        #expect(session.__inFlightShotCountForTesting() == 0)
    }

    @Test("a shot captured across a pair loss is not transmitted to the re-attached phone")
    func shotAcrossPairLossIsNotTransmitted() async throws {
        // `Task.isCancelled` cannot catch this on iOS: `captureShot()` runs
        // synchronously on the main actor and the cancellation is queued onto
        // that same actor, so it is only observable AFTER the capture and its
        // send have finished. The authorisation epoch is bumped off-actor for
        // exactly this reason.
        let spy = Spy()
        let session = CompanionPreviewSession(
            send: spy.send, sendBinary: spy.sendBinary,
            capturePreview: { self.jpeg() },
            captureShot: {
                // The phone leg drops while this capture is running — as the
                // socket thread would do, without touching the main actor.
                CompanionAuthEpoch.invalidate()
                return self.png()
            },
            intervalMs: 20, maxDurationMs: 120_000, livePreviewEnabled: true)

        // Finding A: authorise "c1" first so the request actually reaches
        // captureShot() — the mid-capture pair loss this test exists to prove
        // — instead of being refused earlier by the new gate (which would
        // also leave shotAssembled empty, but for the wrong reason).
        session.start(correlationId: "c1")
        session.stop(reason: .user)
        await session.handleShotRequest(correlationId: "c1", shotId: "s1", rect: nil)

        #expect(spy.shotAssembled.isEmpty,
                "a capture whose authorisation ended mid-flight must not reach whoever re-attached")
        #expect(spy.binaryCount == 0, "and its bytes must not either")
    }

    @Test("a queued shot reads the epoch from when the phone asked, not from when it runs")
    func queuedShotUsesEnqueueTimeEpoch() async throws {
        // `requestShot` enqueues an unstructured task. If the epoch were read
        // INSIDE that task, a pair loss landing between enqueue and start would
        // be recorded as the baseline — and the task's own final comparison
        // would then trivially succeed, letting the old capture reach whoever
        // re-attached. The question is "was authorisation live when the phone
        // ASKED", so it must be read at enqueue.
        let spy = Spy()
        let session = CompanionPreviewSession(
            send: spy.send, sendBinary: spy.sendBinary,
            capturePreview: { self.jpeg() }, captureShot: { self.png() },
            intervalMs: 20, maxDurationMs: 120_000, livePreviewEnabled: true)

        // Finding A: authorise "c1" first so the request actually reaches
        // the epoch check this test exists to prove, instead of being
        // refused earlier by the new gate.
        session.start(correlationId: "c1")
        session.stop(reason: .user)
        session.requestShot(correlationId: "c1", shotId: "s1", rect: nil)
        // Still on the main actor, so the task above has not started yet — this
        // is exactly the window the defect lived in.
        CompanionAuthEpoch.invalidate()
        try? await Task.sleep(nanoseconds: 200_000_000)

        #expect(spy.shotAssembled.isEmpty,
                "authorisation ended before the queued task ran; its capture must not be transmitted")
    }

    @Test("a session that never started is harmless to stop")
    func stoppingAnUnstartedSessionIsSafe() async throws {
        let spy = Spy()
        let session = CompanionPreviewSession(
            send: spy.send, sendBinary: spy.sendBinary,
            capturePreview: { self.jpeg() }, captureShot: { self.png() },
            intervalMs: 20, maxDurationMs: 120_000, livePreviewEnabled: true)

        session.stopSilently()
        session.stop(reason: .user)

        #expect(!session.isRunning)
        #expect(spy.stopReasons.isEmpty, "a no-op stop must not announce anything")
    }

    // ---- Finding A (companion-window-polish codex review round 2) ----
    //
    // `handleShotRequest` used to accept a shot request with no active or
    // ever-authorised preview at all. Combined with the stash being keyed by
    // a peer-chosen correlation id, rotating that id reset the eight-shot
    // ceiling every time — an attached peer could pull unlimited
    // report-grade screenshots. This was made SILENT (not created) by this
    // branch removing the on-device sharing indicator that used to sit in
    // this path; the fix below does NOT reintroduce that indicator, and
    // closes the limit itself.

    @Test("Finding A — rotating the correlation id without ever starting a preview captures nothing, however many ids are tried")
    func rotatingUnauthorisedIdsCapturesNothing() async throws {
        // The exact bypass the reviewer described: a peer that never sends
        // `preview.start` at all, just a stream of `shot.request` frames each
        // under a brand-new correlation id, to keep resetting the per-id
        // stash ceiling.
        let spy = Spy()
        var shotCalls = 0
        let session = CompanionPreviewSession(
            send: spy.send, sendBinary: spy.sendBinary,
            capturePreview: { self.jpeg() },
            captureShot: { shotCalls += 1; return self.png() },
            intervalMs: 20, maxDurationMs: 120_000, livePreviewEnabled: true)

        for i in 0..<20 {
            await session.handleShotRequest(correlationId: "id-\(i)", shotId: "s\(i)", rect: nil)
        }

        #expect(shotCalls == 0,
                "no preview was ever started for ANY of these ids — none may capture, however many are tried")
        #expect(spy.shotFailed.count == 20)
        #expect(spy.shotFailed.allSatisfy { $0.reason == "no_active_session" },
                "the phone must be told why, not left to guess")
    }

    @Test("Finding A — the normal snap-then-stop sequence still captures a fresh shot")
    func snapThenStopStillCaptures() async throws {
        // Exactly what the web client's `snapShot` does (ReporterSurface.tsx):
        // it sends `shot.request` and then IMMEDIATELY closes the preview —
        // so a legitimate FRESH capture can run its check after
        // `preview.stop` has already cancelled the loop and nilled the
        // session's internal `correlationId`. The fix must not reject this.
        let spy = Spy()
        var shotCalls = 0
        let session = CompanionPreviewSession(
            send: spy.send, sendBinary: spy.sendBinary,
            capturePreview: { self.jpeg() },
            captureShot: { shotCalls += 1; return self.png() },
            intervalMs: 20, maxDurationMs: 120_000, livePreviewEnabled: true)

        session.start(correlationId: "c1")
        session.stop(reason: .user) // preview already stopping, as the finding describes
        await session.handleShotRequest(correlationId: "c1", shotId: "s1", rect: nil) // FRESH — not a re-crop

        #expect(shotCalls == 1, "a legitimate snap-then-stop request must still capture")
        #expect(spy.shotAssembled.count == 1)
        #expect(spy.shotFailed.isEmpty)
    }

    @Test("Finding A — a re-crop of a known shot_id succeeds without the preview still running")
    func recropSucceedsAfterPreviewStopped() async throws {
        // The documented re-crop contract must survive the new gate: it is
        // not a NEW capture, so it must not require the preview to still be
        // RUNNING (as opposed to merely having been authorised at some
        // point) at re-crop time. Complements `stashSurvivesAPreviewStop`
        // above with an explicit Finding-A framing: `previewAuthorizedForStash`
        // persists across an ordinary `stop()` (only `clearStash()`/
        // `teardown()` reset it), so this is the realistic "authorisation
        // lapsed, running-wise, but the id is still known" state — not an
        // artificial one.
        let spy = Spy()
        var shotCalls = 0
        let session = CompanionPreviewSession(
            send: spy.send, sendBinary: spy.sendBinary,
            capturePreview: { self.jpeg() },
            captureShot: { shotCalls += 1; return self.png() },
            crop: { src, _ in PreviewCapture(bytes: src.bytes, width: 5, height: 5, mime: src.mime) },
            intervalMs: 20, maxDurationMs: 120_000, livePreviewEnabled: true)

        session.start(correlationId: "c1")
        await session.handleShotRequest(correlationId: "c1", shotId: "s1", rect: nil) // fresh
        session.stop(reason: .user) // preview no longer running; authorisation persists
        #expect(shotCalls == 1)
        #expect(!session.isRunning)

        await session.handleShotRequest(correlationId: "c1", shotId: "s1",
                                        rect: NormalizedRect(x: 0, y: 0, w: 0.5, h: 0.5))

        #expect(shotCalls == 1, "a re-crop of a KNOWN id must not require captureShot() at all")
        #expect(spy.shotFailed.isEmpty)
        #expect(spy.shotAssembled.count == 2)
    }
}
#endif
