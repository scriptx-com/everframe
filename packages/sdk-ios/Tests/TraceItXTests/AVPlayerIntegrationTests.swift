// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Twin of the Media3Integration* suites, driven through the PlayerFacade seam.
// Host-runnable: no AVFoundation object is constructed here.
import XCTest
import TraceItXProtocol
@testable import TraceItXKit

final class FakeFacade: PlayerFacade, @unchecked Sendable {
    var alive = true
    var state = PlayerState(item: nil, isFairPlay: false, preferredPeakBitRate: 0, timeControl: .paused, rate: 0, itemStatus: .unknown,
                            presentationWidth: 0, presentationHeight: 0, currentTimeMs: 0, loadedRangesMs: [])
    var events: PlayerFacadeEvents?
    var observeCount = 0, unobserveCount = 0
    var failObserve = false
    var release: (() -> Void)?
    var isAlive: Bool { alive }
    /// Round-2, #6 — the real facade bumps this on every item registration. The fake leaves it
    /// at 0 unless a test is exercising a stale delivery, so an `AccessLogSnapshot` built with
    /// the default generation matches whatever `attach()` seeded.
    var itemGen: UInt64 = 0
    /// Codex round-6, W6-I2 — the generation an ITEM CHANGE carries. The real facade mints it in
    /// `observeItem`, so a change never carries the generation `attach()` seeded; the fake used
    /// to deliver every change under that seeded generation, which is a state the production
    /// facade cannot produce and which hid the duplicate-initialisation defect. Per-item
    /// callbacks that follow a change keep reading `itemGen`, which is now that change's.
    func nextItemGen() -> UInt64 { itemGen &+= 1; return itemGen }
    var currentItemGeneration: UInt64 { itemGen }
    func readState() -> PlayerState? { alive ? state : nil }
    /// Codex round-7, W7-I2 — the counters as the LOG has them, independent of any notification.
    /// A test raises this without firing `onAccessLogEntry` to model the case the notification
    /// cannot express: an existing entry accumulating more dropped frames. `nil` (the default)
    /// means "no log to pull", which is every test that predates the pull.
    var accessLog: AccessLogSnapshot?
    func readAccessLog() -> AccessLogSnapshot? { alive ? accessLog : nil }
    /// Codex round-1, Critical 2 — models the real hazard: `observe()` loads the weak player
    /// into a temporary strong reference, and the customer's last reference can drop while that
    /// temporary is alive, so the sentinel fires from INSIDE `attach()`'s critical section.
    var fireReleaseOnObserve = false
    func observe(_ events: PlayerFacadeEvents) -> Bool {
        if failObserve || !alive { return false }
        observeCount += 1; self.events = events
        if fireReleaseOnObserve { fireReleaseOnObserve = false; fireRelease() }
        return true
    }
    func unobserve() { unobserveCount += 1; events = nil }
    var unobserveReleaseCount = 0
    func observeRelease(_ onRelease: @escaping () -> Void) -> Bool { guard alive else { return false }; release = onRelease; return true }
    func unobserveRelease() { unobserveReleaseCount += 1; release = nil }
    func fireRelease() { alive = false; release?() }
}

final class AVPlayerIntegrationTests: XCTestCase {
    /// Codex round-6, W6-M4 — the test clock lives in its OWN box, and every clock closure
    /// captures the box rather than `self`. Those closures are stored inside objects this fixture
    /// holds (`ctx`, and the integration kept in `lastIntegration`), so capturing `self` made two
    /// unconditional cycles that no teardown broke: every test instance, its recorded emissions
    /// and its integration stayed allocated for the whole process.
    private final class ClockBox: @unchecked Sendable { var t: Int64 = 10_000 }
    private var clock = ClockBox()
    private var now: Int64 {
        get { clock.t }
        set { clock.t = newValue }
    }
    private var facade = FakeFacade()
    private var ctx = RecordingContext(clock: { 0 })
    private let hls = URL(string: "https://cdn.example.com/live/master.m3u8?token=abc")!

    override func setUp() { super.setUp(); clock = ClockBox(); facade = FakeFacade(); ctx = recorder() }
    /// W6-M4's standing guard. The cycles themselves are gone by construction — no closure this
    /// fixture stores captures `self` any more — and this asserts the property that keeps them
    /// gone: when the fixture drops its reference, nothing else is holding the integration. It
    /// already catches one live retainer, a test's own `onEmit` hook (see below).
    override func tearDown() {
        // A test's own `onEmit` hook can hold the integration (which holds `ctx` back), so it is
        // released first — the hook belongs to the test that installed it either way.
        ctx.onEmit = nil
        // Round-7, W7-M7 — drain the shared vitals queue first. The release path enqueues
        // `VitalsQueue.shared.async { self.fireReleased() }`, and that block holds the
        // integration STRONGLY for as long as it is pending, so an undrained release would fail
        // the assertion below for a reason that has nothing to do with a retain cycle. No test
        // leaves one pending today; this keeps the next one that fires a release from being
        // debugged as a leak. `sync` on the serial queue returns only once everything already
        // enqueued has run.
        VitalsQueue.shared.sync {}
        weak var released = lastIntegration
        lastIntegration = nil
        XCTAssertNil(released, "the integration outlived the fixture's last reference to it")
        super.tearDown()
    }
    /// A context whose clock reads the CURRENT box — captured by value at creation, so a later
    /// `setUp()` cannot retarget a context an earlier test still owns.
    private func recorder() -> RecordingContext { RecordingContext(clock: { [box = clock] in box.t }) }

    @discardableResult
    private func integration(keepQuery: Bool = false, attach: Bool = true) -> AVPlayerIntegration {
        let i = AVPlayerIntegration(facade: facade, captureSourceQuery: { keepQuery }, now: { [box = clock] in box.t })
        lastIntegration = i
        if attach { XCTAssertTrue(i.attach(ctx)) }
        return i
    }
    private var e: PlayerFacadeEvents { facade.events! }
    private func startPlaying() {
        e.onItemChanged?(ItemIdentity(url: hls), false, 0, facade.nextItemGen()); e.onRateChanged?(1); e.onTimeControlChanged?(.waitingToPlay(toMinimizeStalls: false))
        now += 1300; e.onTimeControlChanged?(.playing)
    }

    func testAttachEmitsNothingUntilAnEventAndObservesExactlyOnce() {
        integration()
        XCTAssertEqual(ctx.emitted.count, 0); XCTAssertEqual(facade.observeCount, 1)
    }
    func testAttachReturnsFalseWhenTheFacadeCannotObserve() {
        facade.failObserve = true
        let i = integration(attach: false)
        XCTAssertFalse(i.attach(ctx))
        i.detach()   // safe on a never-attached integration
        XCTAssertEqual(facade.unobserveCount, 0)
    }
    func testItemChangeEmitsASanitisedSourceChangeWithProtocolFromThePath() {
        integration()
        e.onItemChanged?(ItemIdentity(url: hls), false, 0, facade.nextItemGen())
        let s = ctx.last("source_change")!
        XCTAssertEqual(s.data?["src"], .string("https://cdn.example.com/live/master.m3u8"))
        XCTAssertEqual(s.data?["protocol"], .string("hls")); XCTAssertEqual(s.data?["live"], .bool(false))
    }
    func testCaptureSourceQueryKeepsTheQueryAndIsResolvedAtAttachTime() {
        var keep = false
        let i = AVPlayerIntegration(facade: facade, captureSourceQuery: { keep }, now: { [box = clock] in box.t })
        keep = true
        XCTAssertTrue(i.attach(ctx))
        e.onItemChanged?(ItemIdentity(url: hls), false, 0, facade.nextItemGen())
        XCTAssertEqual(ctx.last("source_change")?.data?["src"], .string("https://cdn.example.com/live/master.m3u8?token=abc"))
    }
    func testANilItemResetsTheLatchesWithoutAnnouncingASource() {
        integration(); startPlaying()
        e.onItemChanged?(nil, false, 0, facade.nextItemGen())
        XCTAssertEqual(ctx.emitted.filter { $0.type == "source_change" }.count, 1)
    }
    /// Codex round-7, W7-I3 — an item the SDK cannot NAME is still an item. Replace a URL-backed
    /// item with one built on an `AVMutableComposition` (no `AVURLAsset`, so the facade has no
    /// URL to give) and the integration used to take the early return meant for a playlist end,
    /// leaving item A's source cached as B's identity — which the next rotation re-announced.
    func testAnItemWithNoURLAnnouncesUnknownRatherThanKeepingThePreviousSource() {
        let i = integration(); startPlaying()
        e.onItemChanged?(ItemIdentity(url: nil), false, 0, facade.nextItemGen())
        let s = ctx.last("source_change")!
        XCTAssertEqual(s.data?["src"], .string("unknown"))
        XCTAssertEqual(s.data?["protocol"], .string("unknown"))
        let before = ctx.emitted.count
        i.describe(ctx)
        let reseeded = ctx.emitted.dropFirst(before).filter { $0.type == "source_change" }
        XCTAssertEqual(reseeded.first?.data?["src"], .string("unknown"), "the rotation reseed must not resurrect A's URL")
    }
    /// The other half of W7-I3: an ABSENT item leaves no cached source at all, so a rotation
    /// after a playlist end announces a source for a player that has no item.
    func testAPlaylistEndLeavesNoSourceForALaterDescribeToAnnounce() {
        let i = integration(); startPlaying()
        e.onItemChanged?(nil, false, 0, facade.nextItemGen())
        let before = ctx.emitted.count
        i.describe(ctx)
        XCTAssertTrue(ctx.emitted.dropFirst(before).allSatisfy { $0.type != "source_change" }, "an empty player has no source to announce")
    }
    /// Attaching to a player already showing a non-URL item takes the same route: presence, not
    /// a URL, decides whether there is anything to announce (Android's `currentMediaItem ?: return`
    /// followed by `sanitizeSource(cfg?.uri?.toString())`).
    func testAttachToAnItemWithNoURLSeedsAnUnknownSource() {
        facade.state.item = ItemIdentity(url: nil); facade.state.timeControl = .playing; facade.state.itemStatus = .readyToPlay
        integration()
        XCTAssertEqual(ctx.last("source_change")?.data?["src"], .string("unknown"))
    }
    func testStartupIsMeasuredFromThePlayIntentOncePerItemWithTheAccessLogStartup() {
        integration()
        e.onItemChanged?(ItemIdentity(url: hls), false, 0, facade.nextItemGen())
        e.onAccessLogEntry?(AccessLogSnapshot(indicatedBitrate: 0, observedBitrate: 0, droppedFramesTotal: 0, playbackType: "VOD", startupTimeMs: 1210, preferredPeakBitRate: 0, itemGeneration: facade.itemGen))
        now += 500
        e.onRateChanged?(1)                              // play intent at 10_500
        e.onTimeControlChanged?(.waitingToPlay(toMinimizeStalls: false))
        now += 1300
        e.onTimeControlChanged?(.playing)
        let s = ctx.last("startup")!
        XCTAssertEqual(s.data?["ttffMs"], .int(1300)); XCTAssertEqual(s.data?["accessLogStartupMs"], .int(1210))
        e.onTimeControlChanged?(.paused); e.onTimeControlChanged?(.playing)
        XCTAssertEqual(ctx.emitted.filter { $0.type == "startup" }.count, 1)
        XCTAssertFalse(ctx.types.contains("buffer_start"))   // waiting before first frame is startup, not a rebuffer
    }
    func testBufferingAfterFirstFrameIsARebufferWithDurationMsAndCausesAPause() {
        integration(); startPlaying()
        now += 5000
        e.onTimeControlChanged?(.waitingToPlay(toMinimizeStalls: true))
        now += 800
        e.onTimeControlChanged?(.playing)
        XCTAssertEqual(ctx.types.suffix(4), ["pause", "buffer_start", "buffer_end", "play"])
        XCTAssertEqual(ctx.last("buffer_end")?.data?["durationMs"], .int(800))
    }
    func testWaitingForOtherReasonsIsNotARebuffer() {
        integration(); startPlaying()
        e.onTimeControlChanged?(.waitingToPlay(toMinimizeStalls: false))
        XCTAssertFalse(ctx.types.contains("buffer_start"))
    }
    func testPlayPauseSeekAndRate() {
        integration(); startPlaying()
        e.onPeriodicTime?(9_800, facade.itemGen)
        e.onTimeJumped?(60_000, facade.itemGen)
        XCTAssertEqual(ctx.last("seek")?.data, ["fromMs": .int(9_800), "toMs": .int(60_000)])
        e.onTimeJumped?(60_400, facade.itemGen)                                    // < 1 s: not a seek
        XCTAssertEqual(ctx.emitted.filter { $0.type == "seek" }.count, 1)
        e.onRateChanged?(1.5)
        XCTAssertEqual(ctx.last("rate_change")?.data?["rate"], .double(1.5))
        e.onRateChanged?(0)                                        // pause via rate is NOT a rate_change
        XCTAssertEqual(ctx.emitted.filter { $0.type == "rate_change" }.count, 1)
        e.onTimeControlChanged?(.paused)
        XCTAssertEqual(ctx.types.last, "pause")
    }
    /// Codex round-7, W7-I1 — a periodic tick READ FOR ITEM A, delivered after B replaced it.
    /// It used to be applied ungated because the registration behind it is player-level, which
    /// left B's playhead at A's 60 000 ms and, worse, marked it SEEDED: B's first `timeJumped(0)`
    /// was then differenced against A and emitted a `seek` that never happened, and the stats in
    /// between measured B's buffer ahead from A's position.
    func testAPeriodicTickReadForThePreviousItemNeitherSeedsNorSeeksTheNewOne() {
        let i = integration(); startPlaying()
        let a = facade.itemGen
        e.onPeriodicTime?(60_000, a)
        e.onItemChanged?(ItemIdentity(url: URL(string: "https://h/b.m3u8")), false, 0, facade.nextItemGen())
        e.onLoadedRangesChanged?([(start: 0, end: 8_000)], facade.itemGen)
        e.onPeriodicTime?(60_000, a)                       // A's in-flight tick finally lands
        i.snapshot { s in
            XCTAssertEqual(s?.bufferAheadMs, 8_000, "B's buffer ahead is measured from B's own position, not A's 60 s")
            return true
        }
        e.onTimeJumped?(0, facade.itemGen)
        XCTAssertFalse(ctx.types.contains("seek"), "B's first position is its baseline, not a seek back from A's")
        // B's own tick still lands, and a real seek after it is still reported.
        e.onPeriodicTime?(0, facade.itemGen)
        e.onTimeJumped?(30_000, facade.itemGen)
        XCTAssertEqual(ctx.last("seek")?.data, ["fromMs": .int(0), "toMs": .int(30_000)])
    }
    func testRateChangeRoundsToThreeDecimals() {
        integration(); startPlaying()
        e.onRateChanged?(1.2345678)
        XCTAssertEqual(ctx.last("rate_change")?.data?["rate"], .double(1.235))
    }
    func testDetachClosesAnOpenPlayAndAnOpenRebufferSpanAndUnobserves() {
        let i = integration(); startPlaying()
        e.onTimeControlChanged?(.waitingToPlay(toMinimizeStalls: true))
        now += 300
        i.detach()
        XCTAssertEqual(ctx.types.suffix(1), ["buffer_end"])
        XCTAssertEqual(ctx.last("buffer_end")?.data?["durationMs"], .int(300))
        XCTAssertEqual(facade.unobserveCount, 1)
        XCTAssertNil(i.startupTimings())
    }
    func testASourceTransitionClosesTheOpenRebufferSpanBeforeItResets() {
        integration(); startPlaying()
        e.onTimeControlChanged?(.waitingToPlay(toMinimizeStalls: true))
        e.onItemChanged?(ItemIdentity(url: URL(string: "https://h/next.m3u8")), false, 0, facade.nextItemGen())
        let types = ctx.types
        XCTAssertLessThan(types.lastIndex(of: "buffer_end")!, types.lastIndex(of: "source_change")!)
    }
    func testAttachingToAPlayingPlayerSeedsSourcePlayAndFirstFrame() {
        facade.state.item = ItemIdentity(url: hls); facade.state.timeControl = .playing; facade.state.rate = 1; facade.state.itemStatus = .readyToPlay
        integration()
        // The seed owes the timeline a DRM entry too (Android round-5 #10): joined
        // past the first frame, no further `.readyToPlay` status change is coming,
        // so a clear item reported nowhere else stays "DRM unknown" forever.
        XCTAssertEqual(ctx.types, ["source_change", "play", "drm"])
        XCTAssertEqual(ctx.last("drm")?.data?["keySystem"], .string("none"))
        now += 100
        e.onTimeControlChanged?(.waitingToPlay(toMinimizeStalls: true))     // past first frame → rebuffer
        XCTAssertTrue(ctx.types.contains("buffer_start"))
        e.onTimeControlChanged?(.playing)
        XCTAssertEqual(ctx.emitted.filter { $0.type == "play" }.count, 2)
        XCTAssertFalse(ctx.types.contains("startup"))                        // never measured for a joined item
    }
    func testAttachingMidRebufferOpensTheBufferSpan() {
        facade.state.item = ItemIdentity(url: hls); facade.state.timeControl = .waitingToPlay(toMinimizeStalls: true); facade.state.itemStatus = .readyToPlay; facade.state.currentTimeMs = 5_000
        integration()
        XCTAssertTrue(ctx.types.contains("buffer_start"))
        now += 200; e.onTimeControlChanged?(.playing)
        XCTAssertEqual(ctx.last("buffer_end")?.data?["durationMs"], .int(200))
    }
    func testAttachingDuringStartupReportsNoTtffAndOnlyLaterWaitsAreRebuffers() {
        facade.state.item = ItemIdentity(url: hls); facade.state.timeControl = .waitingToPlay(toMinimizeStalls: true); facade.state.itemStatus = .unknown; facade.state.currentTimeMs = 0
        integration()
        XCTAssertFalse(ctx.types.contains("buffer_start"))   // the launch wait is startup, not a rebuffer
        e.onTimeControlChanged?(.playing)
        // A JOINED item has no origin to measure from — the item began before we
        // arrived — so it reports no ttff at all rather than a fabricated ~0 that
        // would drag the dashboard's p50 startup down. Same as Media3.
        XCTAssertFalse(ctx.types.contains("startup"))
        XCTAssertTrue(ctx.types.contains("drm"))
        XCTAssertEqual(ctx.types.last, "play")
        // …but the first frame IS now latched, so the next stall is a real rebuffer.
        now += 400
        e.onTimeControlChanged?(.waitingToPlay(toMinimizeStalls: true))
        XCTAssertEqual(ctx.types.suffix(2), ["pause", "buffer_start"])
        now += 250
        e.onTimeControlChanged?(.playing)
        XCTAssertEqual(ctx.last("buffer_end")?.data?["durationMs"], .int(250))
        XCTAssertFalse(ctx.types.contains("startup"))
    }
    func testAttachingToALiveStreamStillStartingUpDoesNotTreatItsBufferAsARebuffer() {
        facade.state.item = ItemIdentity(url: hls); facade.state.timeControl = .waitingToPlay(toMinimizeStalls: true); facade.state.itemStatus = .unknown; facade.state.currentTimeMs = 99_000
        integration()
        e.onAccessLogEntry?(AccessLogSnapshot(indicatedBitrate: 0, observedBitrate: 0, droppedFramesTotal: 0, playbackType: "LIVE", startupTimeMs: nil, preferredPeakBitRate: 0, itemGeneration: facade.itemGen))
        XCTAssertFalse(ctx.types.contains("buffer_start"))
    }
    func testDescribeReEmitsCachedSourceAndDrmAndReOpensOngoingSpans() {
        integration(); startPlaying()
        e.onItemStatusChanged?(.readyToPlay, facade.itemGen)
        e.onTimeControlChanged?(.waitingToPlay(toMinimizeStalls: true))
        let d = recorder()
        integrationUnderTest?.describe(d)
        XCTAssertEqual(d.types, ["source_change", "drm", "buffer_start"])
        e.onTimeControlChanged?(.playing)
        let d2 = recorder()
        integrationUnderTest?.describe(d2)
        XCTAssertEqual(d2.types, ["source_change", "drm", "play"])
    }
    /// Codex round-5, W5-I5 — a describe must carry the instant its state was READ, not the
    /// instant a stalled drain gets round to delivering it. Round 3 gave every transition its
    /// occurrence time and left describe stamped on arrival, so the two disagreed across a
    /// stall: the describe re-opened the play span at delivery time while the pause that closes
    /// it carried the earlier moment it happened, the span went negative, the accumulator
    /// clamped it to zero, and the playback in between was lost.
    func testADescribeCarriesTheInstantItsStateWasReadNotTheInstantTheDrainDeliversIt() {
        let i = integration(); startPlaying()
        let d = recorder()
        var readAt: Int64 = 0
        // The describe is queued from inside another emission's delivery, so the drainer already
        // owns the outbox: it goes behind that entry and is delivered only after the stall.
        ctx.onEmit = { [self] type in
            guard type == "error", readAt == 0 else { return }
            readAt = now
            i.describe(d)
            now += 5_000              // the drain stalls, and the world moves on
        }
        e.onFailedToPlayToEnd?("AVFoundationErrorDomain", -11800, "x")

        XCTAssertEqual(d.types, ["source_change", "drm", "play"])
        XCTAssertEqual(d.last("play")?.t, readAt, "the re-opened span starts where the state was read")
        XCTAssertEqual(d.last("source_change")?.t, readAt)
        XCTAssertEqual(now, readAt + 5_000, "…which is emphatically not when it was delivered")
    }
    func testDetachReleasesTheDeclarationTimeSentinelSoALaterReleaseFiresNothing() {
        let i = integration(); startPlaying()
        var hook = 0; i.onReleased = { hook += 1 }
        i.observeRelease()
        i.detach()
        XCTAssertEqual(facade.unobserveReleaseCount, 1)
        let after = ctx.emitted.count
        facade.fireRelease()                       // the player really does go away, later
        XCTAssertEqual(hook, 0)                    // …and we are no longer listening
        XCTAssertEqual(ctx.emitted.count, after)   // nothing was emitted into a dead timeline
        i.detach()                                 // idempotent: one subscription, one release
        XCTAssertEqual(facade.unobserveReleaseCount, 1)
    }
    func testANeverAttachedIntegrationStillReleasesItsDeclarationTimeSentinel() {
        facade.failObserve = true
        let i = integration(attach: false)
        i.observeRelease()
        XCTAssertFalse(i.attach(ctx))
        i.detach()
        XCTAssertEqual(facade.unobserveReleaseCount, 1)   // round-8 #1: the declaration took it, the teardown gives it back
        XCTAssertEqual(facade.unobserveCount, 0)          // …but nothing was ever subscribed to unobserve
    }

    // MARK: quality / DRM / errors / stats / release (twin of Media3IntegrationQualityTest.kt)

    func testAccessLogBitrateChangeEmitsWithReasonAndUnchangedIsSuppressed() {
        integration(); startPlaying()
        e.onPresentationSizeChanged?(1280, 720, facade.itemGen)
        e.onAccessLogEntry?(AccessLogSnapshot(indicatedBitrate: 2_800_000, observedBitrate: 5_200_000, droppedFramesTotal: 0, playbackType: "VOD", startupTimeMs: nil, preferredPeakBitRate: 0, itemGeneration: facade.itemGen))
        XCTAssertEqual(ctx.last("bitrate_change")?.data, ["bitrate": .int(2_800_000), "width": .int(1280), "height": .int(720), "reason": .string("abr")])
        e.onAccessLogEntry?(AccessLogSnapshot(indicatedBitrate: 2_800_000, observedBitrate: 5_000_000, droppedFramesTotal: 0, playbackType: "VOD", startupTimeMs: nil, preferredPeakBitRate: 0, itemGeneration: facade.itemGen))
        XCTAssertEqual(ctx.emitted.filter { $0.type == "bitrate_change" }.count, 1)
        e.onAccessLogEntry?(AccessLogSnapshot(indicatedBitrate: 0, observedBitrate: 1, droppedFramesTotal: 0, playbackType: "VOD", startupTimeMs: nil, preferredPeakBitRate: 0, itemGeneration: facade.itemGen))   // unknown → never emitted
        XCTAssertEqual(ctx.emitted.filter { $0.type == "bitrate_change" }.count, 1)
    }
    func testAPreferredPeakBitRateReportsManual() {
        integration(); e.onItemChanged?(ItemIdentity(url: hls), false, 1_000_000, facade.nextItemGen())
        e.onAccessLogEntry?(AccessLogSnapshot(indicatedBitrate: 900_000, observedBitrate: 0, droppedFramesTotal: 0, playbackType: nil, startupTimeMs: nil, preferredPeakBitRate: 1_000_000, itemGeneration: facade.itemGen))
        XCTAssertEqual(ctx.last("bitrate_change")?.data?["reason"], .string("manual"))
    }
    func testPresentationSizeChangeEmitsQualityChangeOnceAndIgnoresZero() {
        integration(); startPlaying()
        e.onPresentationSizeChanged?(0, 0, facade.itemGen); e.onPresentationSizeChanged?(1920, 1080, facade.itemGen); e.onPresentationSizeChanged?(1920, 1080, facade.itemGen)
        XCTAssertEqual(ctx.emitted.filter { $0.type == "quality_change" }.count, 1)
        XCTAssertEqual(ctx.last("quality_change")?.data, ["width": .int(1920), "height": .int(1080)])
    }
    func testDrmIsReportedOncePerItemFairplayOrNone() {
        integration(); e.onItemChanged?(ItemIdentity(url: hls), true, 0, facade.nextItemGen())
        e.onItemStatusChanged?(.readyToPlay, facade.itemGen); e.onItemStatusChanged?(.readyToPlay, facade.itemGen)
        XCTAssertEqual(ctx.emitted.filter { $0.type == "drm" }.count, 1); XCTAssertEqual(ctx.last("drm")?.data?["keySystem"], .string("fairplay"))
        e.onItemChanged?(ItemIdentity(url: URL(string: "https://h/clear.m3u8")), false, 0, facade.nextItemGen()); e.onRateChanged?(1); e.onTimeControlChanged?(.playing)
        XCTAssertEqual(ctx.emitted.filter { $0.type == "drm" }.count, 2); XCTAssertEqual(ctx.last("drm")?.data?["keySystem"], .string("none"))
    }
    /// Codex round-4, M9. The facade bumps the item generation and installs the new item's status
    /// observer under its own lock, then delivers the item change — so a `.readyToPlay` can
    /// arrive for a generation the integration has not adopted yet. Round-3's gate dropped it,
    /// and an item that becomes ready without ever reaching `.playing` lost its `drm` entry
    /// (`onTimeControl`'s `lastDrm == nil` recovery only covers the case that does play).
    func testAReadyToPlayThatOvertakesItsOwnItemChangeIsHeldNotDropped() {
        integration()
        e.onItemChanged?(ItemIdentity(url: hls), false, 0, facade.nextItemGen())
        XCTAssertEqual(ctx.emitted.filter { $0.type == "drm" }.count, 0, "precondition: nothing ready yet")

        facade.itemGen = 2                                  // the facade has registered item B…
        e.onItemStatusChanged?(.readyToPlay, 2)             // …and B's status arrives first
        XCTAssertEqual(ctx.emitted.filter { $0.type == "drm" }.count, 0,
                       "it may not be published against the item it does not belong to")

        e.onItemChanged?(ItemIdentity(url: URL(string: "https://h/b.m3u8")), true, 0, 2)   // …and then B's own change
        XCTAssertEqual(ctx.types.suffix(2), ["source_change", "drm"], "redeemed after its own source")
        XCTAssertEqual(ctx.last("drm")?.data?["keySystem"], .string("fairplay"),
                       "…and with the NEW item's key system, never the previous one's")
        XCTAssertEqual(ctx.emitted.filter { $0.type == "drm" }.count, 1)
    }
    /// The hold is redeemed ONCE and only by the generation it names: a status from a generation
    /// that has already been superseded is spent, not carried forward.
    func testAHeldReadyToPlayIsNotRedeemedByALaterItem() {
        integration()
        e.onItemChanged?(ItemIdentity(url: hls), false, 0, facade.nextItemGen())
        facade.itemGen = 2
        e.onItemStatusChanged?(.readyToPlay, 2)
        facade.itemGen = 3
        e.onItemChanged?(ItemIdentity(url: URL(string: "https://h/c.m3u8")), true, 0, 3)   // B was skipped
        XCTAssertEqual(ctx.emitted.filter { $0.type == "drm" }.count, 0,
                       "a status held for an item that never became current publishes nothing")
    }
    func testLiveFlagComesFromTheAccessLogAndIsDescribedAfterwards() {
        let i = integration(); e.onItemChanged?(ItemIdentity(url: hls), false, 0, facade.nextItemGen())
        e.onAccessLogEntry?(AccessLogSnapshot(indicatedBitrate: 0, observedBitrate: 0, droppedFramesTotal: 0, playbackType: "LIVE", startupTimeMs: nil, preferredPeakBitRate: 0, itemGeneration: facade.itemGen))
        let d = RecordingContext(clock: { 0 }); i.describe(d)
        XCTAssertEqual(d.last("source_change")?.data?["live"], .bool(true))
    }
    func testFatalErrorsAndRateLimitedNonFatalErrors() {
        integration(); startPlaying()
        e.onItemStatusChanged?(.failed(domain: "CoreMediaErrorDomain", code: -12889, message: "Source error"), nil)
        XCTAssertEqual(ctx.last("error")?.data, ["message": .string("Source error"), "code": .string("CoreMediaErrorDomain:-12889"), "fatal": .bool(true), "detail": .string("CoreMediaErrorDomain")])
        e.onFailedToPlayToEnd?("AVFoundationErrorDomain", -11800, "The operation could not be completed")
        XCTAssertEqual(ctx.emitted.filter { $0.type == "error" }.count, 2)
        for _ in 0..<15 { e.onErrorLogEntry?(ErrorLogSnapshot(errorStatusCode: 404, errorDomain: "CoreMediaErrorDomain", errorComment: "seg", uriHost: "cdn.example.com")) }
        XCTAssertEqual(ctx.emitted.filter { $0.type == "error" && $0.data?["fatal"] == .bool(false) }.count, 10)
        XCTAssertEqual(ctx.last("error")?.data?["detail"], .string("CoreMediaErrorDomain cdn.example.com"))
        now += 60_000
        e.onErrorLogEntry?(ErrorLogSnapshot(errorStatusCode: 404, errorDomain: "d", errorComment: nil, uriHost: nil))
        XCTAssertEqual(ctx.emitted.filter { $0.type == "error" && $0.data?["fatal"] == .bool(false) }.count, 11)
        XCTAssertEqual(ctx.last("error")?.data?["message"], .string("playback error"))
    }
    func testTheNonFatalLimiterNeverAllowsTwentyErrorsInsideOneRollingMinute() {
        integration(); startPlaying()
        for _ in 0..<10 { e.onErrorLogEntry?(ErrorLogSnapshot(errorStatusCode: 1, errorDomain: "d", errorComment: nil, uriHost: nil)) }
        now += 30_000
        for _ in 0..<10 { e.onErrorLogEntry?(ErrorLogSnapshot(errorStatusCode: 1, errorDomain: "d", errorComment: nil, uriHost: nil)) }
        XCTAssertEqual(ctx.emitted.filter { $0.type == "error" }.count, 10)
    }
    func testARejectedLoadErrorCostsNothingFromTheAllowance() {
        integration(); startPlaying()
        ctx.accepts = false
        for _ in 0..<10 { e.onErrorLogEntry?(ErrorLogSnapshot(errorStatusCode: 1, errorDomain: "d", errorComment: nil, uriHost: nil)) }
        ctx.accepts = true
        e.onErrorLogEntry?(ErrorLogSnapshot(errorStatusCode: 1, errorDomain: "d", errorComment: nil, uriHost: nil))
        XCTAssertEqual(ctx.emitted.filter { $0.type == "error" }.count, 11)   // all attempted, the 11th is the first CHARGED
    }
    func testSnapshotReadsTheCacheReturnsNilWhileIdleAndReportsDroppedFrameDeltas() {
        let i = integration()
        var got: PlayerSnapshot?? = nil
        i.snapshot { got = .some($0); return true }
        XCTAssertEqual(got, .some(nil))                     // idle: no source, not playing
        startPlaying()
        e.onLoadedRangesChanged?([(start: 0, end: 22_400)], facade.itemGen); e.onPeriodicTime?(10_000, facade.itemGen)
        e.onAccessLogEntry?(AccessLogSnapshot(indicatedBitrate: 2_800_000, observedBitrate: 5_200_000, droppedFramesTotal: 2, playbackType: "VOD", startupTimeMs: nil, preferredPeakBitRate: 0, itemGeneration: facade.itemGen))
        e.onPresentationSizeChanged?(1280, 720, facade.itemGen)
        i.snapshot { s in
            XCTAssertEqual(s, PlayerSnapshot(bufferAheadMs: 12_400, bandwidthEstimate: 5_200_000, bitrate: 2_800_000, width: 1280, height: 720, droppedFramesDelta: 2)); return true
        }
        e.onAccessLogEntry?(AccessLogSnapshot(indicatedBitrate: 2_800_000, observedBitrate: 5_200_000, droppedFramesTotal: 5, playbackType: "VOD", startupTimeMs: nil, preferredPeakBitRate: 0, itemGeneration: facade.itemGen))
        i.snapshot { s in XCTAssertEqual(s?.droppedFramesDelta, 3); return false }    // refused → still owed
        i.snapshot { s in XCTAssertEqual(s?.droppedFramesDelta, 3); return true }
        i.snapshot { s in XCTAssertEqual(s?.droppedFramesDelta, 0); return true }
    }
    /// Codex round-7, W7-I2 — the MISS. `AVPlayerItemNewAccessLogEntry` fires when a new ENTRY is
    /// appended, while `numberOfDroppedVideoFrames` accumulates INTO the entry already at the
    /// end. Steady playback inside one entry therefore raised the item's total with no
    /// notification at all, and every 20-second `stats` sample went on reporting zero. Note that
    /// no test below fires `onAccessLogEntry`: the counters move only in the log.
    func testStatsPullTheAccessLogSoDroppedFramesRiseWithoutANewEntry() {
        let i = integration(); startPlaying()
        facade.accessLog = log(dropped: 12)
        i.snapshot { s in XCTAssertEqual(s?.droppedFramesDelta, 12, "no new entry ever fired; the pull is the only source"); return true }
        facade.accessLog = log(dropped: 20)
        i.snapshot { s in XCTAssertEqual(s?.droppedFramesDelta, 8); return true }
        // The refusal contract is unchanged by the pull: the refreshed delta stays OWED.
        facade.accessLog = log(dropped: 26)
        i.snapshot { s in XCTAssertEqual(s?.droppedFramesDelta, 6); return false }
        i.snapshot { s in XCTAssertEqual(s?.droppedFramesDelta, 6, "a refused emission owes the whole delta again"); return true }
        i.snapshot { s in XCTAssertEqual(s?.droppedFramesDelta, 0); return true }
    }
    /// The MISATTRIBUTION, the other half of W7-I2. Joining an item that has already dropped 100
    /// frames and then seeing 105 charged this registration 105, because `droppedItemBaseline`
    /// started at zero. Android's `onDroppedVideoFrames` accumulates only what it observes after
    /// the listener is added; the baseline read at attachment is the same answer.
    func testJoiningAnItemThatHasAlreadyDroppedFramesChargesOnlyWhatFollows() {
        facade.state.item = ItemIdentity(url: hls); facade.state.timeControl = .playing; facade.state.itemStatus = .readyToPlay
        facade.accessLog = log(dropped: 100)
        let i = integration()
        facade.accessLog = log(dropped: 105)
        i.snapshot { s in XCTAssertEqual(s?.droppedFramesDelta, 5, "the 100 frames dropped before we joined are not ours"); return true }
        // And the notification path shares the same baseline — one accumulation rule, not two.
        e.onAccessLogEntry?(log(dropped: 111))
        i.snapshot { s in XCTAssertEqual(s?.droppedFramesDelta, 6); return true }
    }
    /// The pull is generation-bound like every other per-item read: a total for an item this
    /// integration has already moved past is dropped, not folded against the new item's baseline.
    func testAPulledAccessLogForThePreviousItemIsNotFoldedIntoTheNewOne() {
        let i = integration(); startPlaying()
        let a = facade.itemGen
        facade.accessLog = log(dropped: 40)
        i.snapshot { s in XCTAssertEqual(s?.droppedFramesDelta, 40); return true }
        e.onItemChanged?(ItemIdentity(url: URL(string: "https://h/b.m3u8")), false, 0, facade.nextItemGen())
        facade.accessLog = AccessLogSnapshot(indicatedBitrate: 1, observedBitrate: 1, droppedFramesTotal: 40, playbackType: "VOD",
                                             startupTimeMs: nil, preferredPeakBitRate: 0, itemGeneration: a)
        i.snapshot { s in XCTAssertEqual(s?.droppedFramesDelta, 0, "A's total must not be charged against B's zero baseline"); return true }
        facade.accessLog = log(dropped: 3)
        i.snapshot { s in XCTAssertEqual(s?.droppedFramesDelta, 3, "B's own counters still land"); return true }
    }
    private func log(dropped: Int) -> AccessLogSnapshot {
        AccessLogSnapshot(indicatedBitrate: 0, observedBitrate: 0, droppedFramesTotal: dropped, playbackType: "VOD",
                          startupTimeMs: nil, preferredPeakBitRate: 0, itemGeneration: facade.itemGen)
    }
    /// Codex round-1, #10 — `AVPlayerItem.accessLog()` counts per ITEM and restarts at zero, so
    /// the two items' frames ADD UP (4 + 6). The old `max(droppedTotal, total)` reported 6:
    /// item B's frames only counted once they exceeded item A's historical maximum.
    func testAnUnsampledItemsDroppedFramesFoldIntoTheNextStats() {
        let i = integration(); startPlaying()
        e.onAccessLogEntry?(AccessLogSnapshot(indicatedBitrate: 1, observedBitrate: 1, droppedFramesTotal: 4, playbackType: "VOD", startupTimeMs: nil, preferredPeakBitRate: 0, itemGeneration: facade.itemGen))
        e.onItemChanged?(ItemIdentity(url: URL(string: "https://h/next.m3u8")), false, 0, facade.nextItemGen())
        e.onAccessLogEntry?(AccessLogSnapshot(indicatedBitrate: 1, observedBitrate: 1, droppedFramesTotal: 6, playbackType: "VOD", startupTimeMs: nil, preferredPeakBitRate: 0, itemGeneration: facade.itemGen))
        i.snapshot { s in XCTAssertEqual(s?.droppedFramesDelta, 10); return true }
    }
    /// The failure the maximum hid completely: a second item whose own total is LOWER than the
    /// first's used to contribute nothing at all, for as long as it played.
    func testASecondItemWithALowerTotalStillContributesItsDroppedFrames() {
        let i = integration(); startPlaying()
        e.onAccessLogEntry?(AccessLogSnapshot(indicatedBitrate: 1, observedBitrate: 1, droppedFramesTotal: 100, playbackType: "VOD", startupTimeMs: nil, preferredPeakBitRate: 0, itemGeneration: facade.itemGen))
        i.snapshot { s in XCTAssertEqual(s?.droppedFramesDelta, 100); return true }
        e.onItemChanged?(ItemIdentity(url: URL(string: "https://h/next.m3u8")), false, 0, facade.nextItemGen())
        e.onAccessLogEntry?(AccessLogSnapshot(indicatedBitrate: 1, observedBitrate: 1, droppedFramesTotal: 20, playbackType: "VOD", startupTimeMs: nil, preferredPeakBitRate: 0, itemGeneration: facade.itemGen))
        i.snapshot { s in XCTAssertEqual(s?.droppedFramesDelta, 20); return true }
        e.onAccessLogEntry?(AccessLogSnapshot(indicatedBitrate: 1, observedBitrate: 1, droppedFramesTotal: 25, playbackType: "VOD", startupTimeMs: nil, preferredPeakBitRate: 0, itemGeneration: facade.itemGen))
        i.snapshot { s in XCTAssertEqual(s?.droppedFramesDelta, 5); return true }
    }
    /// Codex round-2, #6 (and M2) — item callbacks arrive on whatever thread AVFoundation chose
    /// and `NotificationCenter.removeObserver` is not synchronised against an in-flight delivery,
    /// so an access-log snapshot READ for item A can be DELIVERED after the player switched to B
    /// and `onItem` reset the per-item baseline. A's total then counted a second time against B's
    /// zero baseline, and A's bitrate and bandwidth estimate came back with it — for a player
    /// that is no longer showing that item. `AccessLogSnapshot.itemGeneration` is checked in the
    /// same critical section as the mutations it guards.
    func testAnAccessLogReadForThePreviousItemIsDroppedRatherThanCountedAgain() {
        let i = integration(); startPlaying()
        facade.itemGen = 2
        e.onItemChanged?(ItemIdentity(url: URL(string: "https://h/a.m3u8")), false, 0, 2)
        let a = AccessLogSnapshot(indicatedBitrate: 6_000_000, observedBitrate: 9_000_000, droppedFramesTotal: 100,
                                  playbackType: "VOD", startupTimeMs: nil, preferredPeakBitRate: 0, itemGeneration: 2)
        e.onAccessLogEntry?(a)
        i.snapshot { s in XCTAssertEqual(s?.droppedFramesDelta, 100); return true }

        facade.itemGen = 3
        e.onItemChanged?(ItemIdentity(url: URL(string: "https://h/b.m3u8")), false, 0, 3)
        e.onAccessLogEntry?(a)                        // A's in-flight callback finally lands
        i.snapshot { s in
            XCTAssertEqual(s?.droppedFramesDelta, 0, "the old item's total must not be counted again")
            XCTAssertNil(s?.bandwidthEstimate, "nor may it restore the old item's bandwidth estimate")
            XCTAssertNil(s?.bitrate, "nor its bitrate")
            return true
        }
        XCTAssertEqual(ctx.emitted.filter { $0.type == "bitrate_change" }.count, 1, "and it emits no second bitrate_change")
        // B's own entries still land: the gate drops the stale generation, not the item.
        e.onAccessLogEntry?(AccessLogSnapshot(indicatedBitrate: 1_000_000, observedBitrate: 2_000_000, droppedFramesTotal: 7,
                                              playbackType: "VOD", startupTimeMs: nil, preferredPeakBitRate: 0, itemGeneration: 3))
        i.snapshot { s in XCTAssertEqual(s?.droppedFramesDelta, 7); XCTAssertEqual(s?.bitrate, 1_000_000); return true }
    }
    /// Codex round-6, W6-I2 — an item change PARKED between the facade's registration and its
    /// delivery to the integration. `replaceCurrentItem` (or an automatic queue advance) bumps the
    /// facade's generation and installs B's observers, then the change waits on the integration
    /// lock while `attach()` — holding that lock — reads the very generation it installed and
    /// seeds B's already-settled state. The parked change then arrived for a generation the seed
    /// had already initialised and, under the old `gen >= itemGeneration`, re-initialised it:
    /// `firstFrameSeen` cleared and a fresh `itemStartedAt` invented, so B's next stall was not
    /// reported as rebuffering at all and its resumption emitted a fabricated `startup` — which
    /// is what ruling R11 exists to forbid.
    func testAnItemChangeParkedByAttachmentCannotReInitialiseTheGenerationItSeeded() {
        facade.itemGen = 1                                                     // B is registered…
        facade.state.item = ItemIdentity(url: hls); facade.state.timeControl = .playing; facade.state.itemStatus = .readyToPlay
        integration()                                                          // …and seeded as playing
        XCTAssertEqual(ctx.types, ["source_change", "play", "drm"], "precondition: the seed describes B")

        e.onItemChanged?(ItemIdentity(url: hls), false, 0, 1)                                     // …then B's own change lands

        XCTAssertEqual(ctx.emitted.filter { $0.type == "source_change" }.count, 1,
                       "the duplicate initialisation re-announces the source it seeded: \(ctx.types)")
        now += 500
        e.onTimeControlChanged?(.waitingToPlay(toMinimizeStalls: true))
        now += 800
        e.onTimeControlChanged?(.playing)
        XCTAssertFalse(ctx.types.contains("startup"),
                       "a joined item has no observed origin, so its stall is a rebuffer: \(ctx.types)")
        XCTAssertEqual(ctx.last("buffer_end")?.data?["durationMs"], .int(800))
    }
    /// Codex round-3, #2 — the ITEM-CHANGE delivery itself was unfenced. `onItem` read the
    /// facade's CURRENT generation, so a stalled `onItemChanged(A)` delivered after
    /// `onItemChanged(B)` reset every per-item cache to A's values and then LABELLED them with
    /// B's generation: B's own access logs went on passing the generation check against state
    /// that describes A. The change now carries the generation it was made for, and one that is
    /// older than the change already applied is refused outright.
    func testAStalledItemChangeCannotRelabelTheNewItemsState() {
        let i = integration(); startPlaying()
        facade.itemGen = 2
        e.onItemChanged?(ItemIdentity(url: URL(string: "https://h/a.m3u8")), false, 0, 2)
        facade.itemGen = 3
        e.onItemChanged?(ItemIdentity(url: URL(string: "https://h/b.m3u8")), false, 0, 3)
        e.onPresentationSizeChanged?(1920, 1080, 3)
        e.onAccessLogEntry?(AccessLogSnapshot(indicatedBitrate: 1, observedBitrate: 1, droppedFramesTotal: 100,
                                              playbackType: "VOD", startupTimeMs: nil, preferredPeakBitRate: 0, itemGeneration: 3))
        i.snapshot { s in XCTAssertEqual(s?.droppedFramesDelta, 100); return true }

        e.onItemChanged?(ItemIdentity(url: URL(string: "https://h/a.m3u8")), false, 0, 2)      // A's in-flight change lands

        let sources = ctx.emitted.filter { $0.type == "source_change" }
        XCTAssertEqual(sources.count, 3, "the stale change must announce nothing: \(ctx.types)")
        XCTAssertEqual(sources.last?.data?["src"], .string("https://h/b.m3u8"))
        i.snapshot { s in
            XCTAssertEqual(s?.width, 1920, "nor may it clear the CURRENT item's resolution")
            return true
        }
        // …and B's own accounting is still B's: without the refusal the stale change reset the
        // baseline to 0 while claiming generation 3, so this entry counted 105 frames again.
        e.onAccessLogEntry?(AccessLogSnapshot(indicatedBitrate: 1, observedBitrate: 1, droppedFramesTotal: 105,
                                              playbackType: "VOD", startupTimeMs: nil, preferredPeakBitRate: 0, itemGeneration: 3))
        i.snapshot { s in XCTAssertEqual(s?.droppedFramesDelta, 5); return true }
    }
    /// Codex round-3, #5 — the outbox preserved ORDER but discarded TIME: every entry queued with
    /// `t: nil`, which stamps DRAIN time. The deterministic form of a stalled drain is a
    /// transition driven from inside the drain of an earlier one; the clock is advanced past it
    /// so a drain-time stamp is visibly wrong.
    func testAQueuedTransitionCarriesTheTimeItHappenedNotTheTimeItWasDrained() {
        integration(); startPlaying()
        ctx.onEmit = { [self] type in
            guard type == "buffer_start" else { return }
            ctx.onEmit = nil
            now += 5_000
            e.onTimeControlChanged?(.playing)     // queued behind the emission being delivered
            now += 20_000                          // …and the drain is 20 s behind the player
        }
        now += 10_000
        let stalled = now
        e.onTimeControlChanged?(.waitingToPlay(toMinimizeStalls: true))
        let start = ctx.last("buffer_start"), end = ctx.last("buffer_end")
        XCTAssertEqual(start?.t, stalled, "buffer_start must carry the instant the stall began")
        XCTAssertEqual(end?.t, stalled + 5_000, "buffer_end must carry the instant it ended, not the drain's")
        XCTAssertEqual(end?.data?["durationMs"], .int(5_000))
        XCTAssertEqual(end?.t.map { $0 - (start?.t ?? 0) }, 5_000,
                       "the summary spans these two timestamps: they must agree with durationMs")
    }
    /// Codex round-3, #3 — two access-log notifications for the SAME item can overtake each
    /// other; the generation check only tells ITEMS apart. A delayed lower total used to move the
    /// baseline BACK, so 20 → a late 10 → 25 charged 35 frames for 25 actually dropped.
    func testAReorderedAccessLogForOneItemCannotDoubleCountDroppedFrames() {
        let i = integration(); startPlaying()
        func log(_ total: Int) {
            e.onAccessLogEntry?(AccessLogSnapshot(indicatedBitrate: 1, observedBitrate: 1, droppedFramesTotal: total,
                                                  playbackType: "VOD", startupTimeMs: nil, preferredPeakBitRate: 0, itemGeneration: facade.itemGen))
        }
        log(20); log(10); log(25)
        i.snapshot { s in XCTAssertEqual(s?.droppedFramesDelta, 25); return true }
    }
    /// Codex round-3, #4 — the allowance was checked at QUEUE time and charged at drain time, so
    /// while one thread owns a stalled drain every queued error reads an allowance nothing has
    /// spent yet. Re-entrant delivery from inside the drain is that interleaving, deterministically:
    /// these nineteen are queued by a thread that already owns `draining`.
    func testTheNonFatalAllowanceIsDecidedAtDrainTimeNotAtQueueTime() {
        integration(); startPlaying()
        let storm = ErrorLogSnapshot(errorStatusCode: 1, errorDomain: "d", errorComment: nil, uriHost: nil)
        var stormed = false
        ctx.onEmit = { [self] type in
            guard type == "error", !stormed else { return }
            stormed = true
            for _ in 0..<19 { e.onErrorLogEntry?(storm) }
        }
        e.onErrorLogEntry?(storm)
        XCTAssertEqual(ctx.emitted.filter { $0.type == "error" }.count, AVPlayerIntegration.nonFatalPerWindow)
    }
    /// Codex round-3, #6 — ruling R11 and Media3Integration.onFirstFrame() both require an
    /// OBSERVED item origin before startup is reported. Taking `playIntentAt ?? itemStartedAt`
    /// let a joined item fabricate one anyway: the existing joined-startup test jumps straight to
    /// `.playing`, which is exactly the path that does not set a play intent.
    func testAJoinedItemReportsNoStartupEvenAfterARateOrWaitingCallback() {
        facade.state.item = ItemIdentity(url: hls); facade.state.timeControl = .paused; facade.state.itemStatus = .unknown
        integration()
        now += 500
        e.onRateChanged?(1)                                           // …sets playIntentAt
        e.onTimeControlChanged?(.waitingToPlay(toMinimizeStalls: false))
        now += 1_300
        e.onTimeControlChanged?(.playing)
        XCTAssertFalse(ctx.types.contains("startup"), "a joined item has no origin to measure from: \(ctx.types)")
        XCTAssertTrue(ctx.types.contains("play"))
        XCTAssertTrue(ctx.types.contains("drm"))
        // …and a NEW item, whose origin we did observe, still reports one.
        facade.itemGen = 1
        e.onItemChanged?(ItemIdentity(url: URL(string: "https://h/next.m3u8")), false, 0, 1)
        now += 700
        e.onTimeControlChanged?(.playing)
        XCTAssertEqual(ctx.last("startup")?.data?["ttffMs"], .int(700))
    }
    /// Codex round-3, #7 — the first `source_change` says `live: false` because AVPlayerItem has
    /// no synchronous live signal. Updating only `lastSource` corrected nothing that had already
    /// shipped, and ordinary playback runs no `describe()` at all, so a live stream's whole first
    /// session could report itself as VOD.
    func testLearningAStreamIsLiveCorrectsTheSourceAlreadyOnTheTimeline() {
        integration(); e.onItemChanged?(ItemIdentity(url: hls), false, 0, facade.nextItemGen())
        XCTAssertEqual(ctx.last("source_change")?.data?["live"], .bool(false))
        func log(_ type: String) {
            e.onAccessLogEntry?(AccessLogSnapshot(indicatedBitrate: 0, observedBitrate: 0, droppedFramesTotal: 0,
                                                  playbackType: type, startupTimeMs: nil, preferredPeakBitRate: 0, itemGeneration: facade.itemGen))
        }
        log("LIVE")
        XCTAssertEqual(ctx.emitted.filter { $0.type == "source_change" }.count, 2, "the correction must reach the timeline")
        XCTAssertEqual(ctx.last("source_change")?.data?["live"], .bool(true))
        XCTAssertEqual(ctx.last("source_change")?.data?["src"], .string("https://cdn.example.com/live/master.m3u8"))
        log("LIVE"); log("LIVE")
        XCTAssertEqual(ctx.emitted.filter { $0.type == "source_change" }.count, 2, "…once, not once per access log")
    }
    /// Codex round-3, #8 — the cap was cached at attachment and item changes only, so the sample
    /// app's own Throttle button (which sets `preferredPeakBitRate` on the item already playing)
    /// still produced `reason: "abr"`, and removing a cap configured up front left every later
    /// change classified `"manual"`.
    func testABitRateCapSetOnTheItemAlreadyPlayingIsClassifiedManual() {
        integration(); startPlaying()
        func log(_ bitrate: Double, cap: Double) {
            e.onAccessLogEntry?(AccessLogSnapshot(indicatedBitrate: bitrate, observedBitrate: 1, droppedFramesTotal: 0,
                                                  playbackType: "VOD", startupTimeMs: nil, preferredPeakBitRate: cap, itemGeneration: facade.itemGen))
        }
        log(2_800_000, cap: 0)
        XCTAssertEqual(ctx.last("bitrate_change")?.data?["reason"], .string("abr"))
        log(600_000, cap: 600_000)                     // Throttle, on the item already playing
        XCTAssertEqual(ctx.last("bitrate_change")?.data?["reason"], .string("manual"))
        log(2_800_000, cap: 0)                         // …and Restore quality
        XCTAssertEqual(ctx.last("bitrate_change")?.data?["reason"], .string("abr"))
    }
    /// The same staleness on the other per-item cache `onItem` resets.
    func testAPresentationSizeFromThePreviousItemIsNotAdoptedAsTheNewOnes() {
        let i = integration(); startPlaying()
        facade.itemGen = 2
        e.onItemChanged?(ItemIdentity(url: URL(string: "https://h/a.m3u8")), false, 0, 2)
        e.onPresentationSizeChanged?(1920, 1080, 2)
        facade.itemGen = 3
        e.onItemChanged?(ItemIdentity(url: URL(string: "https://h/b.m3u8")), false, 0, 3)
        e.onPresentationSizeChanged?(1920, 1080, 2)          // A's in-flight callback
        i.snapshot { s in XCTAssertNil(s?.width); XCTAssertNil(s?.height); return true }
        XCTAssertEqual(ctx.emitted.filter { $0.type == "quality_change" }.count, 1)
    }
    /// Round-1, O4 — resolution and bandwidth estimate belong to the item that reported them.
    func testASourceChangeClearsTheResolutionAndBandwidthEstimateOfThePreviousItem() {
        let i = integration(); startPlaying()
        e.onPresentationSizeChanged?(1920, 1080, facade.itemGen)
        e.onAccessLogEntry?(AccessLogSnapshot(indicatedBitrate: 6_000_000, observedBitrate: 9_000_000, droppedFramesTotal: 0, playbackType: "VOD", startupTimeMs: nil, preferredPeakBitRate: 0, itemGeneration: facade.itemGen))
        i.snapshot { s in XCTAssertEqual(s?.width, 1920); XCTAssertEqual(s?.bandwidthEstimate, 9_000_000); return true }
        e.onItemChanged?(ItemIdentity(url: URL(string: "https://h/next.m3u8")), false, 0, facade.nextItemGen())
        i.snapshot { s in
            XCTAssertNil(s?.width); XCTAssertNil(s?.height); XCTAssertNil(s?.bandwidthEstimate); XCTAssertNil(s?.bitrate)
            return true
        }
    }
    /// Codex round-4, #5 — the same reset left the BUFFER and the PLAYHEAD alone. Item A at 60 s
    /// with 0–120 s loaded, replaced by an unbuffered B, reported 60 s of buffer ahead on B's
    /// first stats tick and went on reporting it (B posts no loaded-range notification of its own
    /// until it buffers), and B's first time jump was differenced against A's position.
    func testASourceChangeClearsTheBufferAheadAndThePlayheadOfThePreviousItem() {
        let i = integration(); startPlaying()
        e.onLoadedRangesChanged?([(start: 0, end: 120_000)], facade.itemGen)
        e.onPeriodicTime?(60_000, facade.itemGen)
        i.snapshot { s in XCTAssertEqual(s?.bufferAheadMs, 60_000); return true }

        facade.itemGen = 1
        e.onItemChanged?(ItemIdentity(url: URL(string: "https://h/b.m3u8")), false, 0, facade.nextItemGen())
        i.snapshot { s in XCTAssertEqual(s?.bufferAheadMs, 0, "an unbuffered item inherits no buffer"); return true }
        // …and the new item's own first loaded range is measured from the new item's start, not
        // from wherever the previous item's playhead had reached.
        e.onLoadedRangesChanged?([(start: 0, end: 20_000)], facade.itemGen)
        i.snapshot { s in XCTAssertEqual(s?.bufferAheadMs, 20_000); return true }

        // The new item's timeline becoming valid — here at a resume position, as a live stream's
        // does — is not a seek from a playhead that belongs to no item.
        e.onTimeJumped?(30_000, facade.itemGen)
        XCTAssertEqual(ctx.emitted.filter { $0.type == "seek" }.count, 0,
                       "no seek may be fabricated across an item boundary")
        // …and the baseline it established is what a real seek within the new item is measured from.
        e.onTimeJumped?(90_000, facade.itemGen)
        XCTAssertEqual(ctx.last("seek")?.data, ["fromMs": .int(30_000), "toMs": .int(90_000)])
        XCTAssertEqual(ctx.emitted.filter { $0.type == "seek" }.count, 1)
    }
    func testAReleasedPlayerDetachesThroughTheHookClosesItsSpansAndSnapshotsNil() {
        let i = integration(); startPlaying()
        let hook = Locked(0); i.onReleased = { hook.mutate { $0 += 1 } }
        i.observeRelease()
        facade.fireRelease()
        // Round-1, Critical 2: the sentinel's work is ENQUEUED (it may fire from inside one of
        // this integration's own locked sections), so the assertions wait for that queue.
        XCTAssertTrue(AsyncTestHelpersSync.waitFor { hook.value == 1 })
        XCTAssertEqual(ctx.types.last, "pause"); XCTAssertEqual(facade.unobserveCount, 1)
        XCTAssertEqual(facade.unobserveReleaseCount, 1)   // the teardown gives the sentinel back too (round-8 #1)
        facade.fireRelease()                                   // idempotent
        VitalsQueue.shared.sync {}
        XCTAssertEqual(hook.value, 1)
        var got: PlayerSnapshot?? = nil
        i.snapshot { got = .some($0); return true }
        XCTAssertEqual(got, .some(nil))
    }
    /// Codex round-1, #4 — emissions must reach the timeline in the order their transitions were
    /// APPLIED. The deterministic form of "thread B applies `.paused` while thread A is between
    /// its unlock and its emit" is a re-entrant transition driven from inside the collector
    /// callback: with the emissions computed under the lock but sent one at a time afterwards,
    /// the re-entrant `pause` overtook the `play` still waiting behind `drm`, and the
    /// accumulator opened a playback span for a player that is paused — with the integration's
    /// own `playing` latch already false, so detach() emits no corrective pause either.
    func testATransitionArrivingMidEmissionCannotOvertakeTheOneAlreadyQueued() {
        integration()
        ctx.onEmit = { [self] type in
            guard type == "drm" else { return }        // once: `drm` precedes `play` in the same batch
            e.onTimeControlChanged?(.paused)
        }
        startPlaying()
        XCTAssertEqual(ctx.types, ["source_change", "startup", "drm", "play", "pause"])
    }

    /// Codex round-1, Critical 2. The sentinel fires while `attach()` holds the integration
    /// lock — the window `facade.observe()`'s temporary strong reference to the weak player
    /// opens. Processing the release inline from there re-enters the SAME nonrecursive lock on
    /// the SAME thread: `attach()` never returns, and the pending-registration drain, every
    /// later player callback and the teardown all hang behind it. Reverting the enqueue in
    /// `observeRelease()` makes the wait below time out.
    func testAReleaseFiringWhileAttachHoldsTheLockNeitherDeadlocksNorIsLost() {
        let i = AVPlayerIntegration(facade: facade, captureSourceQuery: { false }, now: { [box = clock] in box.t })
        let hook = Locked(0); i.onReleased = { hook.mutate { $0 += 1 } }
        i.observeRelease()
        facade.fireReleaseOnObserve = true
        let attached = Locked(false)
        let done = DispatchSemaphore(value: 0)
        let c = ctx
        DispatchQueue.global().async { attached.mutate { $0 = i.attach(c) }; done.signal() }
        XCTAssertEqual(done.wait(timeout: .now() + 5), .success,
                       "the release sentinel must not take the integration lock on the releasing thread")
        XCTAssertTrue(attached.value)
        XCTAssertTrue(AsyncTestHelpersSync.waitFor { hook.value == 1 }, "the release is still processed, just not inline")
        XCTAssertEqual(facade.unobserveCount, 1)
    }
    func testAPlayerGoneAtSnapshotTimeSelfDetaches() {
        let i = integration(); startPlaying()
        var hook = 0; i.onReleased = { hook += 1 }
        facade.alive = false
        i.snapshot { _ in true }
        XCTAssertEqual(hook, 1); XCTAssertEqual(facade.unobserveCount, 1)
    }
    func testObserveReleaseOnADeadPlayerReleasesTheDeclarationImmediately() {
        facade.alive = false
        let i = integration(attach: false)
        var hook = 0; i.onReleased = { hook += 1 }
        i.observeRelease()
        XCTAssertEqual(hook, 1)
    }
    func testNoPerSegmentEntriesEver() {
        integration(); startPlaying()
        for k in 0..<50 {
            e.onLoadedRangesChanged?([(start: 0, end: Int64(k * 6000))], facade.itemGen); e.onPeriodicTime?(Int64(k * 1000), facade.itemGen)
            e.onAccessLogEntry?(AccessLogSnapshot(indicatedBitrate: 2_800_000, observedBitrate: Double(5_000_000 + k), droppedFramesTotal: k, playbackType: "VOD", startupTimeMs: nil, preferredPeakBitRate: 0, itemGeneration: facade.itemGen))
        }
        XCTAssertEqual(ctx.emitted.count, 5)   // source_change, startup, drm, play, ONE bitrate_change — never one per segment
        XCTAssertEqual(ctx.types, ["source_change", "startup", "drm", "play", "bitrate_change"])
    }
    func testContractAttachEmitsNothingDetachUnobservesSnapshotNeverThrows() {
        let i = integration()
        XCTAssertEqual(ctx.emitted.count, 0)
        i.snapshot { _ in true }
        i.detach(); i.detach()
        XCTAssertEqual(facade.unobserveCount, 1)
        i.snapshot { s in XCTAssertNil(s); return true }
    }
    private var integrationUnderTest: AVPlayerIntegration? { lastIntegration }
    private var lastIntegration: AVPlayerIntegration?
}
