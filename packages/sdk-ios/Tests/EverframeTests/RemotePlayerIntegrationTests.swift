// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import EverframeKit

final class RemotePlayerIntegrationTests: XCTestCase {
    private final class Ctx: PlayerIntegrationContext {
        var emitted: [(String, [String: Any?]?, Int64?)] = []
        var admit = true
        func emit(_ type: String, data: [String: Any?]?, t: Int64?) -> Bool { emitted.append((type, data, t)); return admit }
        func now() -> Int64 { 1_757_000_000_000 }
        var types: [String] { emitted.map { $0.0 } }
    }
    /// The clock is PINNED, and to an instant BEFORE the `1_757_000_000_1xx` host timestamps
    /// these tests feed. It used to be the default wall clock, which since codex round-3's E1
    /// reseed floor is load-bearing: `attach()` records its seed instant, and a host event
    /// stamped before it is emitted AT the seed. With the real clock (now well past
    /// 1_757_000_000_000) every span event below would be floored to "now" and
    /// `testForwardsWithJSTimestampOnceAttached` would assert the wrong thing on a machine
    /// whose date is not the one the test was written on.
    private func integration(keepQuery: Bool = false) -> RemotePlayerIntegration {
        RemotePlayerIntegration(library: "react-native-video", version: "7.0.0", captureSourceQuery: { keepQuery },
                                now: { 1_757_000_000_000 })
    }

    func testForwardsWithJSTimestampOnceAttached() {
        let i = integration(); let ctx = Ctx(); XCTAssertTrue(i.attach(ctx)); ctx.emitted.removeAll()
        i.record("play", t: 1_757_000_000_100, data: nil)
        XCTAssertEqual(ctx.types, ["play"]); XCTAssertEqual(ctx.emitted[0].2, 1_757_000_000_100)
    }
    func testSourceChangeSanitisedQueryStrippedByDefault() {
        let i = integration(); let ctx = Ctx(); _ = i.attach(ctx); ctx.emitted.removeAll()
        i.record("source_change", t: 1, data: ["src": "https://cdn.example/a.m3u8?token=secret", "live": true])
        let data = ctx.emitted[0].1!
        XCTAssertEqual(data["src"] as? String, "https://cdn.example/a.m3u8"); XCTAssertEqual(data["protocol"] as? String, "hls"); XCTAssertEqual(data["live"] as? Bool, true)
    }
    func testCaptureSourceQueryKeepsQuery() {
        let i = integration(keepQuery: true); let ctx = Ctx(); _ = i.attach(ctx); ctx.emitted.removeAll()
        i.record("source_change", t: 1, data: ["src": "https://cdn.example/a.mpd?x=1"])
        XCTAssertEqual(ctx.emitted[0].1?["src"] as? String, "https://cdn.example/a.mpd?x=1")
    }
    func testPreAttachEventsModelOnlyThenAttachSeeds() {
        let i = integration()
        i.record("source_change", t: 1, data: ["src": "https://c/a.m3u8"]); i.record("drm", t: 2, data: ["keySystem": "fairplay"])
        i.record("play", t: 3, data: nil); i.record("buffer_start", t: 4, data: nil)
        let ctx = Ctx(); _ = i.attach(ctx)
        XCTAssertEqual(ctx.types, ["source_change", "drm", "play", "buffer_start"])
    }
    func testClosedSpansAreNotSeeded() {
        let i = integration(); i.record("play", t: 1, data: nil); i.record("pause", t: 2, data: nil)
        i.record("buffer_start", t: 3, data: nil); i.record("buffer_end", t: 4, data: ["durationMs": 100])
        let ctx = Ctx(); _ = i.attach(ctx); XCTAssertEqual(ctx.types, [])
    }
    func testDescribeReemitsIdentityAndOpenSpans() {
        let i = integration(); _ = i.attach(Ctx())
        i.record("source_change", t: 1, data: ["src": "https://c/a.m3u8"]); i.record("play", t: 2, data: nil)
        let rotated = Ctx(); i.describe(rotated); XCTAssertEqual(rotated.types, ["source_change", "play"])
    }
    func testSnapshotServesFreshStatsOnceThenIdles() {
        let i = integration(); _ = i.attach(Ctx())
        i.updateStats(["bufferAheadMs": 1500.0, "bitrate": 3_000_000.0, "width": 1920.0, "height": 1080.0])
        var got: PlayerSnapshot?; i.snapshot { got = $0; return true }
        XCTAssertEqual(got, PlayerSnapshot(bufferAheadMs: 1500, bandwidthEstimate: nil, bitrate: 3_000_000, width: 1920, height: 1080, droppedFramesDelta: 0))
        var second: PlayerSnapshot? = PlayerSnapshot(); i.snapshot { second = $0; return true }; XCTAssertNil(second)
    }
    func testDroppedFramesDeltaCommitsOnlyOnAcceptedSnapshot() {
        let i = integration(); _ = i.attach(Ctx())
        i.updateStats(["bufferAheadMs": 1.0, "droppedFrames": 10.0]); i.snapshot { XCTAssertEqual($0?.droppedFramesDelta, 10); return false }
        i.updateStats(["bufferAheadMs": 1.0, "droppedFrames": 14.0]); i.snapshot { XCTAssertEqual($0?.droppedFramesDelta, 14); return true }
        i.updateStats(["bufferAheadMs": 1.0, "droppedFrames": 15.0]); i.snapshot { XCTAssertEqual($0?.droppedFramesDelta, 1); return true }
    }
    func testNonFiniteAndNegativeStatsFieldsDropped() {
        let i = integration(); _ = i.attach(Ctx())
        i.updateStats(["bufferAheadMs": Double.nan, "bitrate": -5.0, "width": Double.infinity])
        var got: PlayerSnapshot?; i.snapshot { got = $0; return true }
        XCTAssertEqual(got, PlayerSnapshot(droppedFramesDelta: 0))
    }
    func testStartupTimingsNilAndDetachNoop() {
        let i = integration(); XCTAssertNil(i.startupTimings()); i.detach()
        let ctx = Ctx(); _ = i.attach(ctx); ctx.emitted.removeAll(); i.detach()
        i.record("play", t: 1, data: nil); XCTAssertTrue(ctx.emitted.isEmpty)
    }
    func testLibraryAndVersion() {
        let i = integration(); XCTAssertEqual(i.library, "react-native-video"); XCTAssertEqual(i.version, "7.0.0")
    }

    // MARK: - Codex round-1 rulings (C1 detach, C2 outbox, C8/C12 cache reset, C13 hygiene)

    /// C1 — `player_detach` is not a closer at the accumulator: only `pause` closes a play
    /// span and only `buffer_end` closes a buffer span. A host that navigates away
    /// mid-playback therefore left a span accruing to the end of the SESSION. `buffer_end`
    /// first (the rebuffer is nested inside the play span), then `pause`.
    func testDetachClosesBufferThenPlaySpanExactlyOnce() {
        let i = RemotePlayerIntegration(library: "rnv", version: nil, captureSourceQuery: { false }, now: { 9_000 })
        let ctx = Ctx(); _ = i.attach(ctx)
        i.record("play", t: 1, data: nil); i.record("buffer_start", t: 2, data: nil)
        ctx.emitted.removeAll()
        i.detach()
        XCTAssertEqual(ctx.types, ["buffer_end", "pause"])
        XCTAssertEqual(ctx.emitted.map { $0.2 }, [9_000, 9_000])
        ctx.emitted.removeAll()
        i.detach()                                  // idempotent: the latches are cleared
        XCTAssertTrue(ctx.emitted.isEmpty)
    }

    func testDetachOnNeverAttachedIntegrationEmitsNothing() {
        let i = RemotePlayerIntegration(library: "rnv", version: nil, captureSourceQuery: { false }, now: { 9_000 })
        i.record("play", t: 1, data: nil); i.record("buffer_start", t: 2, data: nil)
        i.detach()                                  // no ctx: nothing to emit into
        let ctx = Ctx(); _ = i.attach(ctx)
        // Round-4, F1 changed the second half of this expectation. It used to assert
        // `ctx.emitted.isEmpty` — "detach really cleared the model" — because `detach()` reset
        // `playing`/`buffering`. It now clears only the ANNOUNCED state, so HOST truth (the
        // player is playing and stalled; nobody said otherwise) survives and the attach seeds
        // it. The first half is unchanged: a detach with no bound ctx emits nothing.
        XCTAssertEqual(ctx.types, ["play", "buffer_start"])
    }

    /// C2 — the ORDERED OUTBOX. The seed used to copy the model, unlock and emit; a
    /// `record("pause")` landing in that window emitted FIRST and left the stale seed to
    /// emit `play` LAST, opening a play span for a paused player that nothing would ever
    /// close. This drives that interleaving deterministically: the context re-enters
    /// `record("pause")` from inside the seed's own `emit`.
    private final class RacingCtx: PlayerIntegrationContext {
        var order: [String] = []
        weak var target: RemotePlayerIntegration?
        private var raced = false
        func emit(_ type: String, data: [String: Any?]?, t: Int64?) -> Bool {
            if type == "play", !raced { raced = true; target?.record("pause", t: 5, data: nil) }
            order.append(type)
            return true
        }
        func now() -> Int64 { 0 }
    }
    func testSeedCannotOvertakeALiveTransition() {
        let i = RemotePlayerIntegration(library: "rnv", version: nil, captureSourceQuery: { false }, now: { 9_000 })
        let racing = RacingCtx(); racing.target = i
        i.record("play", t: 1, data: nil)           // model only — not attached yet
        _ = i.attach(racing)                        // the seed emits `play`; emit re-enters record("pause")
        XCTAssertEqual(racing.order, ["play", "pause"])
        let after = Ctx(); i.describe(after)
        XCTAssertTrue(after.emitted.isEmpty)        // the model really is paused
    }

    /// C8/C12 — a new source's `drm` arrives AFTER its own `source_change` if it arrives at
    /// all, and the host-fed stats describe the OUTGOING source.
    func testSourceChangeClearsCachedDrmAndStats() {
        let i = integration(); let ctx = Ctx(); _ = i.attach(ctx)
        i.record("source_change", t: 1, data: ["src": "https://c/a.m3u8"])
        i.record("drm", t: 2, data: ["keySystem": "widevine"])
        i.updateStats(["bufferAheadMs": 4000.0])
        i.record("source_change", t: 3, data: ["src": "https://c/b.mpd"])
        let rotated = Ctx(); i.describe(rotated)
        XCTAssertEqual(rotated.types, ["source_change"])
        XCTAssertEqual(rotated.emitted[0].1?["src"] as? String, "https://c/b.mpd")
        var got: PlayerSnapshot? = PlayerSnapshot(); i.snapshot { got = $0; return true }
        XCTAssertNil(got)
    }

    /// C13 — a boolean is not a number (an ObjC bool bridges to `NSNumber`, whose
    /// `doubleValue` is 1.0, so `{ width: true }` used to be admitted as a 1 px
    /// resolution); Kotlin's `as? Number` refuses one already. Same 9.2e18 bound on both.
    func testBooleansAndOutOfRangeMagnitudesAreNotNumbers() {
        let i = integration(); _ = i.attach(Ctx())
        i.updateStats(["width": true, "height": 9.21e18, "bitrate": -5.0, "bufferAheadMs": Double.nan, "droppedFrames": 3.0])
        var got: PlayerSnapshot?; i.snapshot { got = $0; return true }
        XCTAssertEqual(got, PlayerSnapshot(droppedFramesDelta: 3))
        XCTAssertNil(RemotePlayerIntegration.nonNegInt64(true))
        XCTAssertNil(RemotePlayerIntegration.nonNegInt64(NSNumber(value: true)))
        XCTAssertEqual(RemotePlayerIntegration.nonNegInt64(NSNumber(value: 1)), 1)
    }

    // MARK: - Codex round-2, D1 (detach completion is an ordered outbox barrier)

    /// The context records what it is given and REFUSES everything once `detached` is set —
    /// the fake controller. `VitalsController` sets exactly that flag from the completion
    /// callback (and records `player_detach` there), so anything this integration still owed
    /// the timeline after the completion fires is lost, and the play span it should have
    /// closed accrues to the end of the session.
    private final class DetachRaceCtx: PlayerIntegrationContext {
        private let l = NSLock()
        private var _order: [String] = []
        private var detached = false
        /// Run from inside `emit("play")`, once, to drive the race deterministically.
        var onPlay: (() -> Void)?
        var order: [String] { l.lock(); defer { l.unlock() }; return _order }
        func markDetached() { l.lock(); _order.append("complete"); detached = true; l.unlock() }
        func emit(_ type: String, data: [String: Any?]?, t: Int64?) -> Bool {
            l.lock()
            if detached { l.unlock(); return false }        // the controller refuses it: reg.detached
            _order.append(type)
            l.unlock()
            if type == "play", let h = onPlay { onPlay = nil; h() }
            return true
        }
        func now() -> Int64 { 0 }
    }

    private func racingIntegration() -> RemotePlayerIntegration {
        RemotePlayerIntegration(library: "rnv", version: nil, captureSourceQuery: { false }, now: { 9_000 })
    }

    /// Re-entrant variant: the detach is requested from INSIDE the drain, on the drainer's
    /// own thread. The completion must still land behind the `pause` this teardown queued.
    func testDetachCompletionRunsAfterTheClosingSpansReentrantly() {
        let i = racingIntegration()
        let ctx = DetachRaceCtx()
        var completions = 0
        ctx.onPlay = { i.detach(onComplete: { completions += 1; ctx.markDetached() }) }
        i.record("play", t: 1, data: nil)                   // model only — not attached yet
        _ = i.attach(ctx)                                   // the seed emits `play`; emit re-enters detach
        XCTAssertEqual(ctx.order, ["play", "pause", "complete"])
        XCTAssertEqual(completions, 1)
    }

    /// Cross-thread variant: thread A owns the drain (parked inside `emit("play")`), thread B
    /// calls `detach(onComplete:)`. B must not block — the latch it signals AFTER `detach`
    /// returns is what A is waiting on, so a teardown that waited on the drain would deadlock
    /// — and the completion must still be run by A, after the `pause`, which must be ADMITTED.
    func testDetachCompletionIsOrderedBehindClosersAcrossThreads() {
        let i = racingIntegration()
        let ctx = DetachRaceCtx()
        let detachReturned = DispatchSemaphore(value: 0)
        let completed = DispatchSemaphore(value: 0)
        var completions = 0
        let lock = NSLock()
        ctx.onPlay = {
            DispatchQueue.global().async {
                i.detach(onComplete: {
                    lock.lock(); completions += 1; lock.unlock()
                    ctx.markDetached(); completed.signal()
                })
                detachReturned.signal()                     // detach never blocks on the drain
            }
            XCTAssertEqual(detachReturned.wait(timeout: .now() + 5), .success)
        }
        i.record("play", t: 1, data: nil)
        _ = i.attach(ctx)                                   // this thread owns the drain throughout
        XCTAssertEqual(completed.wait(timeout: .now() + 5), .success)
        XCTAssertEqual(ctx.order, ["play", "pause", "complete"])
        lock.lock(); XCTAssertEqual(completions, 1); lock.unlock()
    }

    /// The synchronous `detach()` is unchanged: closers, no completion, still idempotent.
    func testSynchronousDetachStillQueuesClosersWithNoCompletion() {
        let i = racingIntegration()
        let ctx = Ctx(); _ = i.attach(ctx)
        i.record("play", t: 1, data: nil); i.record("buffer_start", t: 2, data: nil)
        ctx.emitted.removeAll()
        i.detach()
        XCTAssertEqual(ctx.types, ["buffer_end", "pause"])
        // …and the async form on an integration with nothing open still completes exactly once.
        var completions = 0
        i.detach(onComplete: { completions += 1 })
        XCTAssertEqual(completions, 1)
        XCTAssertEqual(ctx.types, ["buffer_end", "pause"])
    }

    // MARK: - Codex round-3, E1 (the reseed floor) and E2 (attachment rollback)

    /// A movable clock, so one integration can be seeded across a rotation.
    private func clocked(_ read: @escaping () -> Int64) -> RemotePlayerIntegration {
        RemotePlayerIntegration(library: "rnv", version: nil, captureSourceQuery: { false }, now: read)
    }

    /// E1 — the bridge is asynchronous. A JS `pause` stamped at 1900 can still be in flight when
    /// the native side rotates at 2000 and `describe()` re-opens the play span there. Delivered
    /// with its own 1900 the collector DROPS it (it predates the session), the reseeded play span
    /// never closes, and `detach()` closes nothing either because the model is already paused —
    /// the session accrues playtime for a player that has been paused throughout. Stamped at the
    /// seed it closes the span it was meant to close, as a zero-length one.
    func testSpanTransitionPredatingTheReseedIsStampedAtTheSeed() {
        var clock: Int64 = 1_000
        let i = clocked { clock }
        // `describe` seeds into the ROTATION's context; the attach-time one stays live and is
        // where every later host event goes (the controller routes it to the current session).
        let live = Ctx(); _ = i.attach(live)
        i.record("play", t: 1_500, data: nil)
        live.emitted.removeAll()
        clock = 2_000
        let rotated = Ctx(); i.describe(rotated)
        XCTAssertEqual(rotated.types, ["play"])
        XCTAssertEqual(rotated.emitted[0].2, 2_000)             // the seed itself

        i.record("pause", t: 1_900, data: nil)                  // bridge-delayed, predates the seed
        XCTAssertEqual(live.types, ["pause"])
        XCTAssertEqual(live.emitted[0].2, 2_000)                // …stamped at the seed, not dropped
    }

    /// Only the four SPAN types are floored. A `seek` is a point in time, and moving it would
    /// misreport when it happened for no gain.
    func testNonSpanEventsKeepTheHostTimestampAcrossAReseed() {
        var clock: Int64 = 1_000
        let i = clocked { clock }
        let live = Ctx(); _ = i.attach(live)
        clock = 2_000
        i.describe(Ctx())
        i.record("seek", t: 1_900, data: ["fromMs": 10, "toMs": 20])
        XCTAssertEqual(live.types, ["seek"])
        XCTAssertEqual(live.emitted[0].2, 1_900)
    }

    /// A span transition at or after the seed is untouched — the floor is a floor, not a stamp.
    func testSpanTransitionAtOrAfterTheSeedKeepsItsOwnTimestamp() {
        var clock: Int64 = 1_000
        let i = clocked { clock }
        let live = Ctx(); _ = i.attach(live)
        clock = 2_000
        i.describe(Ctx())
        i.record("play", t: 2_000, data: nil)                   // exactly at the seed
        i.record("pause", t: 2_500, data: nil)                  // after it
        XCTAssertEqual(live.types, ["play", "pause"])
        XCTAssertEqual(live.emitted.map { $0.2 }, [2_000, 2_500])
    }

    /// E2 — an attachment rollback is not a teardown. The controller attaches BEFORE it
    /// publishes; a superseding `start()` refuses the publication and `VitalsRuntime` retries
    /// THIS SAME integration against the next controller. A terminal `detach()` there cleared
    /// `playing`/`buffering`, so the retry announced a playing player with no open spans and its
    /// uninterrupted playback was never measured.
    func testRollbackAttachKeepsTheHostModelAndEmitsNothing() {
        let i = clocked { 9_000 }
        i.record("source_change", t: 1, data: ["src": "https://c/a.m3u8"])
        i.record("play", t: 2, data: nil)
        i.record("buffer_start", t: 3, data: nil)

        let a = Ctx(); _ = i.attach(a)                          // controller A: seeded
        XCTAssertEqual(a.types, ["source_change", "play", "buffer_start"])
        a.emitted.removeAll()

        i.rollbackAttach()                                      // the publication was refused
        XCTAssertTrue(a.emitted.isEmpty)                        // no pause, no buffer_end, nothing

        let b = Ctx(); _ = i.attach(b)                          // the runtime retries against B
        XCTAssertEqual(b.types, ["source_change", "play", "buffer_start"])
        XCTAssertTrue(a.emitted.isEmpty)                        // A heard nothing after the rollback
        // …and no closer was fabricated for either context at any point.
        XCTAssertFalse((a.types + b.types).contains("pause"))
        XCTAssertFalse((a.types + b.types).contains("buffer_end"))
    }

    /// Codex round-4, F1 — HOST TRUTH vs the ANNOUNCED span state, and the reason the split
    /// exists: a `detach()` unbinds the announcement without stopping the player, and THIS
    /// SAME object is bound again on every re-attach path (a deferred registration retried
    /// after a rollback, a controller re-announcing the player against a new session). If
    /// `detach()` still cleared the model, that re-attached registration would announce a
    /// playing player with no open span — and for uninterrupted playback no later transition
    /// ever comes to open one.
    ///
    /// This test replaces `testTerminalDetachStillClearsTheModelUnlikeARollback`, whose second
    /// assertion (`b` hears nothing) is exactly the behaviour the ruling reverses. What still
    /// separates a detach from a rollback is the FIRST half — the detach closes the announced
    /// span, the rollback (see above) emits nothing at all.
    func testDetachClosesTheAnnouncedSpanButHostTruthSurvivesIntoTheNextAttach() {
        let i = clocked { 9_000 }
        i.record("play", t: 1, data: nil)
        let a = Ctx(); _ = i.attach(a); a.emitted.removeAll()
        i.detach()
        XCTAssertEqual(a.types, ["pause"])                      // the announced span is closed
        let b = Ctx(); _ = i.attach(b)
        XCTAssertEqual(b.types, ["play"])                       // …and host truth survived it
        XCTAssertEqual(a.types, ["pause"])                      // A heard nothing more
    }

    /// The announced state is what `detach()` closes, and it is per-ATTACHMENT: a transition
    /// recorded while nothing is bound moves host truth only, so the next detach must not
    /// fabricate a closer for a span the bound ctx never heard open.
    func testDetachClosesNothingForASpanTheBoundContextNeverHeardOpen() {
        let i = clocked { 9_000 }
        let a = Ctx(); _ = i.attach(a)                          // attached with nothing playing
        i.detach()                                              // unbinds; announced state empty
        i.record("play", t: 1, data: nil)                       // host truth only — no ctx bound
        a.emitted.removeAll()
        let b = Ctx(); _ = i.attach(b)
        XCTAssertEqual(b.types, ["play"])                       // seeded from host truth
        b.emitted.removeAll()
        i.record("pause", t: 2, data: nil)
        i.detach()
        XCTAssertEqual(b.types, ["pause"])                      // the pause itself, and no second one
    }

    // MARK: - Android-parity additions (host allowlist + mime-derived protocol)

    func testHostReservedAndUnknownEventTypesAreSilentlyDropped() {
        let i = integration(); let ctx = Ctx(); _ = i.attach(ctx); ctx.emitted.removeAll()
        i.record("player_attach", t: 1, data: nil)
        i.record("player_detach", t: 2, data: nil)
        i.record("bogus", t: 3, data: ["src": "https://c/a.m3u8"])
        XCTAssertTrue(ctx.emitted.isEmpty)
        // A following attach/describe seeds nothing — the bogus "source_change"-shaped data
        // never reached the model because `record` returned before the model was touched.
        let rotated = Ctx(); i.describe(rotated)
        XCTAssertTrue(rotated.emitted.isEmpty)
    }
    func testMimeWinsOverExtensionForProtocolIncludingExtensionlessUrls() {
        let i = integration(); let ctx = Ctx(); _ = i.attach(ctx); ctx.emitted.removeAll()
        i.record("source_change", t: 1, data: ["src": "https://cdn/live/master", "mime": "application/x-mpegurl"])
        XCTAssertEqual(ctx.emitted[0].1?["protocol"] as? String, "hls")
    }
    func testNoMimeExtensionStillDecidesProtocol() {
        let i = integration(); let ctx = Ctx(); _ = i.attach(ctx); ctx.emitted.removeAll()
        i.record("source_change", t: 1, data: ["src": "https://cdn.example/a.mpd"])
        XCTAssertEqual(ctx.emitted[0].1?["protocol"] as? String, "dash")
    }
}
