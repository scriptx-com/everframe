// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Twin of VitalsControllerTest.kt. Host-runnable: the lifecycle seam is injected
// (nil, or a recording handle) so no UIKit is needed.
import XCTest
import EverframeProtocol
@testable import EverframeKit

final class VitalsControllerTests: XCTestCase {
    private final class NoopScheduler: VitalsScheduler, @unchecked Sendable {
        final class H: VitalsCancellable, @unchecked Sendable { func cancel() {} }
        func repeating(intervalMs: Int64, _ tick: @escaping @Sendable () -> Void) -> VitalsCancellable { H() }
    }
    private final class RecordingLifecycle: VitalsLifecycleHandle, @unchecked Sendable {
        let fg: @Sendable () -> Void, bg: @Sendable () -> Void
        var installs = 0, uninstalls = 0
        init(fg: @escaping @Sendable () -> Void, bg: @escaping @Sendable () -> Void) { self.fg = fg; self.bg = bg }
        func install() { installs += 1 }
        func uninstall() { uninstalls += 1 }
    }

    /// Makes Codex round-2 Critical 2 deterministic: the disable lands INSIDE the enable
    /// tail, between the transition being decided and `start()`/`install()` running.
    private final class SupersedingSampler: ResourceSampler, @unchecked Sendable {
        private let onStart: @Sendable () -> Void
        private let onStop: @Sendable () -> Void
        init(queue: DispatchQueue, now: @escaping @Sendable () -> Int64,
             onSample: @escaping @Sendable (VitalsSample) -> Void, onTick: @escaping @Sendable () -> Void,
             onStart: @escaping @Sendable () -> Void, onStop: @escaping @Sendable () -> Void) {
            self.onStart = onStart; self.onStop = onStop
            super.init(queue: queue, now: now, onSample: onSample, onTick: onTick)
        }
        override func start() { onStart(); super.start() }
        override func stop() { onStop(); super.stop() }
    }

    private var sink = RecordingSink()
    private var sinkBuilds = 0
    private var now: Int64 = 1_000_000
    private var draw = 0.0
    private var samplerOnSample: (@Sendable (VitalsSample) -> Void)?
    private var samplerOnTick: (@Sendable () -> Void)?
    private var lifecycle: RecordingLifecycle?
    private var wantsLifecycle = false
    /// Set before the enable to hand the controller a scripted sampler.
    private var samplerOverride: (@Sendable (@escaping @Sendable (VitalsSample) -> Void, @escaping @Sendable () -> Void) -> ResourceSampler)?
    /// Fires from inside `deps.now()` — the seam VitalsControllerTest.kt uses to
    /// script a detach into the window where an entry is being stamped.
    private var onNow: (@Sendable () -> Void)?
    private let testQueue = DispatchQueue(label: "test.vitals.sampler")

    override func setUp() {
        super.setUp()
        sink = RecordingSink(); sinkBuilds = 0; now = 1_000_000; draw = 0
        samplerOnSample = nil; samplerOnTick = nil; lifecycle = nil; onNow = nil; wantsLifecycle = false; samplerOverride = nil
        InternalLogger.drainFailures()
    }

    private func controller(local: VitalsConfig = VitalsConfig(), withLifecycle: Bool = false,
                            overrides: @escaping @Sendable (VitalsCollector.Deps) -> VitalsCollector.Deps = { $0 },
                            newSessionId: @escaping @Sendable () -> String = { "sid" }) -> VitalsController {
        let box = self
        box.wantsLifecycle = withLifecycle
        let lifecycleFactory: @Sendable (@escaping @Sendable () -> Void, @escaping @Sendable () -> Void) -> VitalsLifecycleHandle? = { fg, bg in
            guard box.wantsLifecycle else { return nil }
            let l = RecordingLifecycle(fg: fg, bg: bg)
            box.lifecycle = l
            return l
        }
        let deps = VitalsController.Deps(
            localConfig: local,
            dims: SessionSummaryDims(platform: "ios", appVersion: "1", sdkVersion: "0.7.0"),
            transport: { box.sinkBuilds += 1; return box.sink },
            scheduler: NoopScheduler(),
            samplerFactory: { onSample, onTick in
                box.samplerOnSample = onSample; box.samplerOnTick = onTick
                if let override = box.samplerOverride { return override(onSample, onTick) }
                return ResourceSampler(queue: box.testQueue, now: { box.now }, onSample: onSample, onTick: onTick)
            },
            lifecycle: lifecycleFactory,
            now: { box.onNow?(); return box.now }, random: { box.draw },
            newSessionId: newSessionId, collectorOverrides: overrides)
        return VitalsController(deps: deps)
    }
    private func track(_ c: VitalsController, _ i: PlayerIntegration, _ name: String? = nil) -> PlayerHandle {
        c.trackPlayer(i, name: name) ?? { XCTFail("shutdown refusal in a live-controller test"); return InertHandleForTests() }()
    }
    private let on = VitalsServerConfig(vitalsEnabled: true, vitalsSampleRate: 1.0)
    private let off = VitalsServerConfig(vitalsEnabled: false, vitalsSampleRate: 1.0)

    /// The recent-ring view VitalsControllerTest.kt asserts on: player events and
    /// custom entries the CURRENT collector is still holding.
    private func playerEvents(_ c: VitalsController) -> [VitalsPlayerEvent] {
        (c.currentStamp()?.entries ?? []).compactMap { if case let .player(p) = $0 { return p }; return nil }
    }
    private func customEntries(_ c: VitalsController) -> [VitalsCustomEntry] {
        (c.currentStamp()?.entries ?? []).compactMap { if case let .custom(x) = $0 { return x }; return nil }
    }
    /// A collector whose transport budget fits NOTHING, so every entry is refused.
    private static let tinyBuffer: @Sendable (VitalsCollector.Deps) -> VitalsCollector.Deps = { base in
        var d = base; d.maxBufferBytes = 40; return d
    }

    func testDoesNothingUntilTheServerSaysEnabled() {
        let c = controller()
        XCTAssertFalse(c.isRunning); XCTAssertNil(c.currentStamp())
        c.applyServerConfig(off); XCTAssertFalse(c.isRunning); XCTAssertEqual(sink.bodies.count, 0)
        c.applyServerConfig(on); XCTAssertTrue(c.isRunning); XCTAssertEqual(sink.kinds, ["summary"]); XCTAssertEqual(c.currentStamp()?.sessionId, "sid")
    }
    func testLocalOptOutWinsOverTheServer() {
        let c = controller(local: VitalsConfig(enabled: false))
        c.applyServerConfig(on); XCTAssertFalse(c.isRunning)
    }
    func testSamplingDrawUsesMinLocalServerAndIsNeverReRolled() {
        draw = 0.4
        let c = controller(local: VitalsConfig(sampleRate: 0.9))
        c.applyServerConfig(VitalsServerConfig(vitalsEnabled: true, vitalsSampleRate: 0.3))   // min = 0.3 < 0.4 → lose
        XCTAssertFalse(c.isRunning)
        c.applyServerConfig(VitalsServerConfig(vitalsEnabled: true, vitalsSampleRate: 1.0))   // raised rate never re-rolls
        XCTAssertFalse(c.isRunning)
    }
    func testMidSessionFlipToDisabledStopsWithAFinalSummaryReEnableStartsFresh() {
        let c = controller()
        c.applyServerConfig(on); c.applyServerConfig(off)
        XCTAssertFalse(c.isRunning)
        let summaries = sink.payloads.filter { $0["kind"] as? String == "summary" }
        XCTAssertEqual(summaries.last?["final"] as? Bool, true)
        XCTAssertEqual(sink.finishes, 1)   // round-1, #9: graceful on a server disable, not cancelled
        c.applyServerConfig(on); XCTAssertTrue(c.isRunning); XCTAssertEqual(sinkBuilds, 2)
    }
    func testTrackPlayerBeforeStartIsHonouredOnceTheCollectorStartsWithPlayerAttachFirst() {
        let c = controller(); let i = FakeIntegration()
        let h = track(c, i, "main")
        XCTAssertEqual(h.id, "p1"); XCTAssertNotNil(i.ctx); XCTAssertEqual(i.described, 0)
        i.ctx?.emit("play", data: nil, t: nil)           // before announce → dropped
        c.applyServerConfig(on)
        XCTAssertEqual(i.described, 1)
        c.shutdown()
        XCTAssertEqual(sink.playerEventTypes.first, "player_attach")
        XCTAssertFalse(sink.playerEventTypes.contains("play"))      // the pre-announce emission was dropped, not buffered
    }
    func testIntegrationEventsFlowThroughWithThePlayerIdCustomEntriesAreDroppedWithNoCollector() {
        let c = controller(); let i = FakeIntegration()
        c.trackVitals("early", data: nil, playerId: nil)
        c.applyServerConfig(on)
        let h = track(c, i, "main")
        XCTAssertTrue(i.ctx!.emit("seek", data: ["fromMs": 1, "toMs": 2], t: nil))
        h.track("ad", data: ["x": 1]); c.trackVitals("global", data: 3, playerId: nil)
        c.shutdown()
        let entries = sink.payloads.filter { $0["kind"] as? String == "chunk" }.flatMap { $0["entries"] as! [[String: Any]] }
        XCTAssertEqual(entries.first { $0["type"] as? String == "seek" }?["playerId"] as? String, "p1")
        XCTAssertEqual(entries.first { $0["name"] as? String == "ad" }?["playerId"] as? String, "p1")
        XCTAssertNotNil(entries.first { $0["name"] as? String == "global" })
        XCTAssertNil(entries.first { $0["name"] as? String == "early" })
    }
    func testRefusedAttachYieldsAnInertHandleDetachesBestEffortAndNeverAnnounces() {
        let c = controller(); c.applyServerConfig(on)
        let i = FakeIntegration(ok: false)
        let h = track(c, i)
        XCTAssertEqual(h.id, ""); XCTAssertEqual(i.detached, 1); XCTAssertEqual(i.described, 0)
        h.track("x", data: nil); h.detach()
        c.shutdown()
        XCTAssertFalse(sink.playerEventTypes.contains("player_attach"))
    }
    /// Kotlin: `a throwing attach is treated exactly like a refusal`. Swift getters
    /// and `attach` cannot throw, so the equivalent is an attach that subscribed
    /// halfway and then refused: same inert handle, same best-effort teardown.
    func testAnAttachThatRefusesAfterPartiallySubscribingIsTreatedExactlyLikeARefusal() {
        let c = controller(); c.applyServerConfig(on)
        let i = ScriptedIntegration(library: "boom", version: nil)
        i.attachResult = false
        i.onAttach = { ctx in ctx.emit("play", data: nil, t: nil) }   // a half-done subscription
        let h = track(c, i)
        XCTAssertEqual(h.id, ""); XCTAssertEqual(i.detached, 1)
        c.shutdown()
        XCTAssertFalse(sink.playerEventTypes.contains("player_attach"))
        XCTAssertFalse(sink.playerEventTypes.contains("play"))
    }
    func testAPlayerRegisteredWhileShutdownIsRunningIsRefusedAndDetached() {
        let c = controller(); c.applyServerConfig(on); c.shutdown()
        let i = FakeIntegration()
        XCTAssertNil(c.trackPlayer(i, name: nil))
        // The refusal is made BEFORE `attach()`, so there is nothing to tear down —
        // `detach()` is only best-effort for a registration that did attach.
        XCTAssertNil(i.ctx)
        XCTAssertEqual(i.detached, 0)
    }
    func testDetachEmitsPlayerDetachOnceAndAStaleHandleIsANoOp() {
        let c = controller(); c.applyServerConfig(on)
        let h = track(c, FakeIntegration())
        h.detach(); h.detach()
        c.shutdown()
        XCTAssertEqual(sink.playerEventTypes.filter { $0 == "player_detach" }.count, 1)
    }
    func testSamplerTickCollectsStatsPerPlayerWithASnapshotSkippingIdleOnes() {
        let c = controller(); c.applyServerConfig(on)
        let a = FakeIntegration(), b = FakeIntegration()
        a.snap = PlayerSnapshot(bufferAheadMs: 100, bandwidthEstimate: nil, bitrate: 5, width: nil, height: nil, droppedFramesDelta: 2)
        _ = track(c, a); _ = track(c, b)
        samplerOnTick?()
        c.shutdown()
        let stats = sink.payloads.filter { $0["kind"] as? String == "chunk" }.flatMap { $0["entries"] as! [[String: Any]] }.filter { $0["type"] as? String == "stats" }
        XCTAssertEqual(stats.count, 1)
        let data = stats[0]["data"] as! [String: Any]
        XCTAssertEqual(data["bufferAheadMs"] as? Int, 100); XCTAssertEqual(data["bitrate"] as? Int, 5); XCTAssertEqual(data["droppedFrames"] as? Int, 2); XCTAssertNil(data["bandwidthEstimate"])
    }
    func testRotationReseedsEveryLivePlayer() {
        let c = controller(); c.applyServerConfig(on)
        let a = FakeIntegration(), b = FakeIntegration()
        _ = track(c, a); _ = track(c, b)
        now += 31 * 60_000
        samplerOnSample?(VitalsSample(t: now, mem: 1))     // unpinned entry → idle rotation
        XCTAssertEqual(a.described, 2); XCTAssertEqual(b.described, 2)
        c.shutdown()
        XCTAssertEqual(sink.playerEventTypes.filter { $0 == "player_attach" }.count, 4)
    }
    func testShutdownFinalizesDetachesEveryPlayerAndClearsTheRegistry() {
        let c = controller(); c.applyServerConfig(on)
        let a = FakeIntegration(); _ = track(c, a)
        c.shutdown()
        XCTAssertEqual(a.detached, 1); XCTAssertFalse(c.isRunning)
        XCTAssertEqual(sink.playerEventTypes.last, "player_detach")
        XCTAssertEqual((sink.payloads.last?["kind"] as? String), "summary"); XCTAssertEqual(sink.payloads.last?["final"] as? Bool, true)
        XCTAssertEqual(sink.closes, 1)
        c.shutdown()   // idempotent
    }
    func testStartupAnnouncesALivePlayerExactlyOnceNeverOneStillAttaching() {
        let c = controller()
        let slow = FakeIntegration()
        let attaching = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        slow.onAttach = { attaching.signal(); release.wait() }
        DispatchQueue.global().async { _ = c.trackPlayer(slow, name: nil) }
        attaching.wait()
        c.applyServerConfig(on)          // slow is reserved but unpublished → not announced here
        release.signal()
        XCTAssertTrue(AsyncTestHelpersSync.waitFor { slow.described == 1 })
        c.shutdown()
        XCTAssertEqual(sink.playerEventTypes.filter { $0 == "player_attach" }.count, 1)
    }
    func testAnAsyncSnapshotThatLandsAfterItsPlayerDetachedEmitsNothing() {
        let c = controller(); c.applyServerConfig(on)
        let i = FakeIntegration(); i.deferSnapshot = true; i.snap = PlayerSnapshot(droppedFramesDelta: 1)
        let h = track(c, i)
        samplerOnTick?()
        h.detach()
        XCTAssertEqual(i.deferred?(i.snap), false)
        c.shutdown()
        XCTAssertFalse(sink.playerEventTypes.contains("stats"))
    }
    func testAnAsyncSnapshotThatLandsAfterTheCollectorWasReplacedEmitsNothing() {
        let c = controller(); c.applyServerConfig(on)
        let i = FakeIntegration(); i.deferSnapshot = true; i.snap = PlayerSnapshot(droppedFramesDelta: 1)
        _ = track(c, i)
        samplerOnTick?()
        c.applyServerConfig(off); c.applyServerConfig(on)
        XCTAssertEqual(i.deferred?(i.snap), false)
        c.shutdown()
        XCTAssertFalse(sink.playerEventTypes.contains("stats"))
    }
    func testRotationReseedsOngoingPlayAndBufferStateAndADuplicateOpenCostsNoPlaytime() {
        let c = controller(); c.applyServerConfig(on)
        let i = FakeIntegration(); i.playing = true
        _ = track(c, i)
        i.ctx?.emit("play", data: nil, t: nil)
        now += 31 * 60_000
        samplerOnSample?(VitalsSample(t: now, mem: 1))
        now += 10_000
        c.shutdown()
        let finals = sink.payloads.filter { $0["kind"] as? String == "summary" && $0["final"] as? Bool == true }
        XCTAssertEqual(finals.last?["playtimeMs"] as? Int, 10_000)
    }
    func testShutdownDoesNotHoldTheControllerMonitorWhileIntegrationsTearDown() {
        let c = controller(); c.applyServerConfig(on)
        let i = FakeIntegration(); i.deferDetach = true
        _ = track(c, i)
        let done = DispatchSemaphore(value: 0)
        DispatchQueue.global().async { c.shutdown(); done.signal() }
        XCTAssertTrue(AsyncTestHelpersSync.waitFor { i.pendingComplete != nil })
        XCTAssertNil(c.currentStamp())            // field already nil — no monitor held
        i.pendingComplete?()
        XCTAssertEqual(done.wait(timeout: .now() + 2), .success)
    }
    /// The other half of Critical 5: `describe()` used to run under the controller
    /// monitor too, so an integration that hands a worker thread anything which
    /// re-enters the controller deadlocked the enable transition.
    func testStartCollectorDoesNotHoldTheControllerMonitorWhileDescribing() {
        let c = controller()
        let i = ScriptedIntegration()
        let workerFinished = Locked(false)
        i.onDescribe = { _, _ in
            let ran = DispatchSemaphore(value: 0)
            DispatchQueue.global().async { c.trackVitals("from-describe", data: nil, playerId: nil); ran.signal() }
            let ok = ran.wait(timeout: .now() + 2) == .success
            workerFinished.mutate { $0 = ok }
        }
        _ = track(c, i)
        c.applyServerConfig(on)
        XCTAssertTrue(workerFinished.value, "describe() ran with the controller monitor held")
        XCTAssertEqual(i.described, 1)
        XCTAssertTrue(customEntries(c).contains { $0.name == "from-describe" })
        c.shutdown()
    }
    // Kotlin `a throwing sampler factory publishes nothing and a later config change
    // retries` has no Swift twin: `samplerFactory` is a non-throwing closure that
    // returns a non-optional `ResourceSampler`, so the failure it pins cannot be
    // constructed here at all. The transactional half it also covers — nothing is
    // published unless every part was built, and each sink belongs to exactly one
    // collector — is exercised by
    // `testEachCollectorGetsItsOwnSinkClosedAfterThatCollectorsFinalSummary`.
    func testTheLifecycleObserverIsInstalledOnEnableAndUninstalledOnDisable() {
        let c = controller(withLifecycle: true)
        c.applyServerConfig(on)
        XCTAssertEqual(lifecycle?.installs, 1)
        c.applyServerConfig(off)
        XCTAssertEqual(lifecycle?.uninstalls, 1)
    }
    /// Round-2, Critical 2. `sampler.start()` and `lifecycle.install()` run with the lock
    /// DROPPED, so a disable can complete between the transition being decided and the tail
    /// executing: it stops the sampler it captured and returns, and the tail then starts that
    /// same sampler and installs an observer feeding a dead controller. The fake below makes
    /// the race deterministic by re-entering `applyServerConfig(off)` from inside `start()`.
    func testAnEnableTailSupersededMidFlightStopsTheSamplerItStartedAndUninstallsTheObserver() {
        let c = controller(withLifecycle: true)
        let stops = Locked(0), reentered = Locked(false)
        let box = self, disable = off
        samplerOverride = { onSample, onTick in
            SupersedingSampler(
                queue: box.testQueue, now: { box.now }, onSample: onSample, onTick: onTick,
                onStart: {
                    var first = false
                    reentered.mutate { if !$0 { $0 = true; first = true } }
                    if first { c.applyServerConfig(disable) }
                },
                onStop: { stops.mutate { $0 += 1 } })
        }

        c.applyServerConfig(on)

        XCTAssertTrue(reentered.value, "the disable must have run from inside start()")
        XCTAssertEqual(lifecycle?.installs, 1, "precondition: the superseded tail really did install")
        // Twice: the disable's own tail uninstalled the observer it captured (not yet
        // installed), and the enable tail's undo branch uninstalled the one it had just
        // resurrected. Without the `generation != gen` re-check this is 1, and the observer
        // is left installed on a controller that has already stopped.
        XCTAssertEqual(lifecycle?.uninstalls, 2, "a superseded tail must not leave an observer installed")
        XCTAssertGreaterThanOrEqual(stops.value, 2, "the resurrected sampler must be stopped again")
        XCTAssertFalse(c.isRunning)
    }
    /// Codex round-3, E2 — controller A finishes `attach()` and is shut down before the
    /// registration is published, so A answers the TRANSIENT nil and `VitalsRuntime` retries the
    /// SAME integration against B. The rollback used to be a plain `detach()`, which on a
    /// `RemotePlayerIntegration` clears `playing`/`buffering` (round-1, C1 made detach close its
    /// spans) — B then announced a playing player with no open spans and measured nothing until
    /// a transition that, for uninterrupted playback, never comes. Twin of
    /// `VitalsControllerTest.kt`'s `a remote player rolled back for a shutdown…`.
    ///
    /// `captureSourceQuery` is resolved INSIDE `attach()`, i.e. between `reserve()` and the
    /// publication: exactly the window that produces the refusal.
    func testARemotePlayerRolledBackForAShutdownKeepsItsHostModelForTheRetry() {
        let a = controller(); a.applyServerConfig(on)
        let b = controller(); b.applyServerConfig(on)
        let refuseOnce = Locked<Bool>(true)
        let i = RemotePlayerIntegration(library: "rnv", version: nil,
                                        captureSourceQuery: {
                                            if refuseOnce.value { refuseOnce.mutate { $0 = false }; a.shutdown() }
                                            return false
                                        },
                                        // The seed's own clock, on the SAME base as the controller's
                                        // `now` — a seed stamped before the session starts is refused.
                                        now: { 1_000_000 })
        i.record("play", t: 1, data: nil)
        i.record("buffer_start", t: 2, data: nil)

        XCTAssertNil(a.trackPlayer(i, name: "main"), "A refused for shutdown: the registration goes back on the queue")
        // (A is shut down, so it has no stamp left to inspect; that the rollback emits NOTHING is
        // asserted directly in RemotePlayerIntegrationTests.)

        XCTAssertNotNil(b.trackPlayer(i, name: "main"), "…and B picks the same integration up")
        XCTAssertEqual(playerEvents(b).map { $0.type }, ["player_attach", "play", "buffer_start"])
    }

    func testEventsEmittedBeforePlayerAttachAreDroppedNeverBufferedAheadOfIt() {
        let c = controller(); let i = FakeIntegration()
        _ = track(c, i)
        XCTAssertFalse(i.ctx!.emit("play", data: nil, t: nil))
        c.applyServerConfig(on); c.shutdown()
        let types = sink.playerEventTypes
        XCTAssertEqual(types.first, "player_attach")
    }
    func testAnEventTypeOutsideTheProtocolEnumIsDroppedAndLogged() {
        let c = controller(); c.applyServerConfig(on)
        let i = FakeIntegration(); _ = track(c, i)
        XCTAssertFalse(i.ctx!.emit("buffering", data: nil, t: nil))
        XCTAssertTrue(InternalLogger.drainFailures().contains { $0.label.contains("unknownType") })
        XCTAssertTrue(i.ctx!.emit("dropped_frames", data: nil, t: nil))   // protocol-valid, not a typo
    }
    /// The enable tail snapshots the registry under the lock and announces after
    /// dropping it, so a release landing in that window must produce no timeline
    /// at all — never an attach with no matching detach.
    func testARegistrationUnregisteredBeforeItsAnnouncementIsNeverAnnounced() {
        let c = controller()
        let second = Locked<PlayerHandle?>(nil)
        let i1 = ScriptedIntegration()
        i1.onDescribe = { _, _ in second.value?.detach() }
        let i2 = ScriptedIntegration()
        _ = track(c, i1, "one")
        second.mutate { $0 = track(c, i2, "two") }

        c.applyServerConfig(on)

        let events = playerEvents(c)
        XCTAssertEqual(events.filter { $0.playerId == "p2" }.count, 0, "the released player must not be announced")
        XCTAssertEqual(i2.described, 0, "...nor described")
        XCTAssertEqual(i2.detached, 1, "...and it really was released")
        XCTAssertEqual(events.filter { $0.playerId == "p1" }.map(\.type), ["player_attach", "source_change"])
    }
    func testADetachRacingAnAnnouncementEmitsPlayerDetachAfterTheAttachNeverBefore() {
        let c = controller(); c.applyServerConfig(on)
        let i = FakeIntegration()
        let h = track(c, i)
        h.detach(); c.shutdown()
        let t = sink.playerEventTypes
        XCTAssertEqual(t.firstIndex(of: "player_attach")! < t.firstIndex(of: "player_detach")!, true)
    }
    func testShutdownWaitsForAnAsynchronousDetachSoItsClosingSpansPrecedePlayerDetach() {
        let c = controller(); c.applyServerConfig(on)
        let i = FakeIntegration(); i.deferDetach = true
        _ = track(c, i)
        DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(50)) {
            i.ctx?.emit("pause", data: nil, t: nil); i.pendingComplete?()
        }
        c.shutdown()
        let t = sink.playerEventTypes
        XCTAssertEqual(Array(t.suffix(2)), ["pause", "player_detach"])
    }
    func testAnIntegrationThatNeverCompletesItsDetachDoesNotHangShutdown() {
        let c = controller(); c.applyServerConfig(on)
        let i = FakeIntegration(); i.deferDetach = true
        _ = track(c, i)
        let t0 = Date(); c.shutdown()
        XCTAssertLessThan(Date().timeIntervalSince(t0), 2.0)
        XCTAssertFalse(c.isRunning)
        XCTAssertTrue(InternalLogger.drainFailures().contains { $0.label == "VitalsController.shutdown.detachDrain" })
    }
    /// Round-3, Important 6: the marker is emitted from the integration's
    /// COMPLETION callback, never the instant `detach()` returns.
    func testAHandleDetachRecordsPlayerDetachOnlyOnceItsIntegrationHasFinishedTearingDown() {
        let c = controller(); c.applyServerConfig(on)
        let i = FakeIntegration(); i.deferDetach = true
        let h = track(c, i)
        h.detach()
        XCTAssertEqual(playerEvents(c).filter { $0.type == "player_detach" }.count, 0,
                       "nothing may be recorded until the integration reports completion")
        i.ctx?.emit("pause", data: nil, t: nil)
        i.pendingComplete?()
        XCTAssertEqual(playerEvents(c).map(\.type), ["player_attach", "source_change", "pause", "player_detach"])
    }
    /// Codex round-2, #3 — `detach()` queues its closing `pause` and then calls `drainOutbox()`,
    /// which YIELDS to a drain another thread already owns. The default
    /// `PlayerIntegration.detach(onComplete:)` signalled completion right there, so
    /// `detachAndMark` marked the registration detached and recorded `player_detach` while that
    /// `pause` was still in the queue — `Ctx.emit`'s `reg.detached ? nil : …` then refused it and
    /// the play span ran to the end of the session. The ordered outbox barrier makes the
    /// completion follow its own emissions without blocking (or being blocked by) the drainer.
    func testADetachCompletionCannotOvertakeTheClosingSpansAnotherThreadIsDraining() {
        let c = controller(); c.applyServerConfig(on)
        let facade = FakeFacade()
        let integration = AVPlayerIntegration(facade: facade, captureSourceQuery: { false }, now: { 1_000_000 })
        let h = track(c, integration, "main")
        let e = facade.events!
        e.onItemChanged?(ItemIdentity(url: URL(string: "https://cdn.example.com/a.m3u8")!), false, 0, facade.nextItemGen())
        // Seeds the playhead for the new item, exactly as the periodic time observer does within
        // a second in production — a time jump against an UNSEEDED playhead establishes the
        // baseline instead of deriving a seek (round-4, #5), and the stall seam below needs the
        // seek to be an actual emission.
        e.onPeriodicTime?(0, facade.itemGen)
        e.onTimeControlChanged?(.playing)                       // opens the play span
        XCTAssertTrue(playerEvents(c).contains { $0.type == "play" }, "precondition: a play span is open")

        // Thread A takes the drain and stalls INSIDE the emit for its `seek`: `buildPlayerEvent`
        // calls `deps.now()` before any lock is taken, so A owns `draining` and holds nothing.
        let arm = Locked(false)
        let entered = DispatchSemaphore(value: 0), proceed = DispatchSemaphore(value: 0)
        onNow = {
            var take = false
            arm.mutate { if $0 { $0 = false; take = true } }
            if take { entered.signal(); proceed.wait() }
        }
        DispatchQueue.global().async { arm.mutate { $0 = true }; e.onTimeJumped?(60_000, facade.itemGen) }
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success, "precondition: thread A owns the drain")

        h.detach()                                              // queues the closing pause, then the barrier
        XCTAssertFalse(playerEvents(c).contains { $0.type == "player_detach" },
                       "player_detach must not be recorded while the closing pause is still queued")
        proceed.signal()

        XCTAssertTrue(AsyncTestHelpersSync.waitFor { playerEvents(c).contains { $0.type == "player_detach" } })
        let types = playerEvents(c).map(\.type)
        guard let pause = types.lastIndex(of: "pause"), let detach = types.firstIndex(of: "player_detach") else {
            return XCTFail("the closing pause never reached the timeline: \(types)")
        }
        XCTAssertLessThan(pause, detach, "the closing pause must precede player_detach: \(types)")
        onNow = nil
        c.shutdown()
    }
    /// Codex round-3, #5 — the outbox kept emissions in order but stamped them at DRAIN time, so
    /// a rebuffer the player observed between 10 s and 15 s, drained at 45 s, arrived as two
    /// entries with the same timestamp: the summary accumulated ~0 ms of rebuffering while the
    /// `buffer_end` entry's own `durationMs` said 5000. Same stall seam as the barrier test above.
    func testAStalledDrainStillReportsTheRebufferTheSpanActuallyHad() {
        let box = self
        let c = controller(); c.applyServerConfig(on)
        let facade = FakeFacade()
        let integration = AVPlayerIntegration(facade: facade, captureSourceQuery: { false }, now: { box.now })
        _ = track(c, integration, "main")
        let e = facade.events!
        e.onItemChanged?(ItemIdentity(url: URL(string: "https://cdn.example.com/a.m3u8")!), false, 0, facade.nextItemGen())
        // Seeds the playhead for the new item, exactly as the periodic time observer does within
        // a second in production — a time jump against an UNSEEDED playhead establishes the
        // baseline instead of deriving a seek (round-4, #5), and the stall seam below needs the
        // seek to be an actual emission.
        e.onPeriodicTime?(0, facade.itemGen)
        e.onTimeControlChanged?(.playing)

        let arm = Locked(false)
        let entered = DispatchSemaphore(value: 0), proceed = DispatchSemaphore(value: 0)
        onNow = {
            var take = false
            arm.mutate { if $0 { $0 = false; take = true } }
            if take { entered.signal(); proceed.wait() }
        }
        DispatchQueue.global().async { arm.mutate { $0 = true }; e.onTimeJumped?(60_000, facade.itemGen) }
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success, "precondition: thread A owns the drain")

        now += 10_000
        e.onTimeControlChanged?(.waitingToPlay(toMinimizeStalls: true))   // the stall begins…
        now += 5_000
        e.onTimeControlChanged?(.playing)                                 // …and ends 5 s later
        now += 30_000                                                     // the drain is half a minute behind
        proceed.signal()

        XCTAssertTrue(AsyncTestHelpersSync.waitFor { playerEvents(c).contains { $0.type == "buffer_end" } })
        onNow = nil
        let end = playerEvents(c).last { $0.type == "buffer_end" }
        XCTAssertEqual(end?.data?["durationMs"], .int(5_000))
        c.shutdown()
        let final = sink.payloads.last { $0["kind"] as? String == "summary" && $0["final"] as? Bool == true }
        XCTAssertEqual(final?["rebufferDurationMs"] as? Int, 5_000,
                       "the summary must agree with the entry's own durationMs, however late the drain ran")
    }
    /// Codex round-4, #3 — round-3 gave a queued emission its own TRANSITION time, but its
    /// SESSION was still resolved at delivery time, so the two halves disagreed across a
    /// rotation: a drainer stalled with `play` and `pause` in the queue found the registration
    /// re-announced into a session that began after both of them, and that session was credited
    /// with playback from before it existed — a summary reporting `playtimeMs > durationMs`.
    /// The real integration outbox, a real rotation, and the invariant a summary cannot break.
    func testAStalledDrainCannotCreditANewSessionWithPlaybackFromBeforeItBegan() {
        let box = self
        let ids = Locked(0)
        let c = controller(newSessionId: { var n = 0; ids.mutate { $0 += 1; n = $0 }; return "sid-\(n)" })
        c.applyServerConfig(on)
        let facade = FakeFacade()
        let integration = AVPlayerIntegration(facade: facade, captureSourceQuery: { false }, now: { box.now })
        _ = track(c, integration, "main")
        let e = facade.events!
        e.onItemChanged?(ItemIdentity(url: URL(string: "https://cdn.example.com/a.m3u8")!), false, 0, facade.nextItemGen())
        // Seeds the playhead for the new item, exactly as the periodic time observer does within
        // a second in production — a time jump against an UNSEEDED playhead establishes the
        // baseline instead of deriving a seek (round-4, #5), and the stall seam below needs the
        // seek to be an actual emission.
        e.onPeriodicTime?(0, facade.itemGen)

        // Thread A owns the drain and stalls inside `buildPlayerEvent`'s clock read, holding nothing.
        let arm = Locked(false)
        let entered = DispatchSemaphore(value: 0), proceed = DispatchSemaphore(value: 0), drained = DispatchSemaphore(value: 0)
        onNow = {
            var take = false
            arm.mutate { if $0 { $0 = false; take = true } }
            if take { entered.signal(); proceed.wait() }
        }
        DispatchQueue.global().async { arm.mutate { $0 = true }; e.onTimeJumped?(60_000, facade.itemGen); drained.signal() }
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success, "precondition: thread A owns the drain")

        now += 10_000; e.onTimeControlChanged?(.playing)     // `play` queued, and it happened HERE
        now += 5_000;  e.onTimeControlChanged?(.paused)      // `pause` queued five seconds later

        let before = c.currentStamp()?.sessionId
        now += 31 * 60_000
        c.trackVitals("rotate-me", data: nil, playerId: nil)  // unpinned → idle rotation, and a reseed
        XCTAssertNotEqual(before, c.currentStamp()?.sessionId, "precondition: the session really rotated")

        proceed.signal()
        XCTAssertEqual(drained.wait(timeout: .now() + 5), .success, "the stalled drain must run to completion")
        onNow = nil

        let landed = playerEvents(c).map(\.type)
        XCTAssertFalse(landed.contains("play") || landed.contains("pause") || landed.contains("startup"),
                       "an event that predates this session must not land in it: \(landed)")
        XCTAssertTrue(landed.contains("player_attach"), "precondition: the reseed did re-announce the player: \(landed)")

        c.shutdown()
        let final = sink.payloads.last { $0["kind"] as? String == "summary" && $0["final"] as? Bool == true }
        let playtime = final?["playtimeMs"] as? Int ?? -1
        let duration = final?["durationMs"] as? Int ?? -1
        XCTAssertLessThanOrEqual(playtime, duration, "a session cannot report more playtime than it has existed for")
        XCTAssertEqual(playtime, 0, "the five seconds belonged to the session that is already finalized")
    }
    func testADetachedHandleRecordsNothing() {
        let c = controller(); c.applyServerConfig(on)
        let h = track(c, FakeIntegration()); h.detach(); h.track("late", data: nil)
        c.shutdown()
        XCTAssertFalse(sink.payloads.description.contains("late"))
    }
    /// Round-1, #9 — each collector gets its own sink AND its own end: a server DISABLE
    /// finishes it gracefully (the trailing chunk and the final summary `stop()` just queued
    /// are still on the wire, and cancelling them lost both), a shutdown closes it outright.
    func testEachCollectorGetsItsOwnSinkEndedAfterThatCollectorsFinalSummary() {
        let c = controller()
        c.applyServerConfig(on)
        c.applyServerConfig(off)
        XCTAssertEqual(sink.finishes, 1, "a server disable must not cancel the final summary it just produced")
        XCTAssertEqual(sink.closes, 0)
        XCTAssertEqual(sink.finishTimeoutMs, VitalsController.sinkFinishTimeoutMs)
        c.applyServerConfig(on); c.shutdown()
        XCTAssertEqual(sinkBuilds, 2)
        XCTAssertEqual(sink.closes, 1, "kill()/shutdown() still closes immediately")
        XCTAssertEqual(sink.finishes, 1)
    }
    /// Codex round-2, #5 — a server disable clears the `sink` FIELD and hands the sink a 5 s
    /// graceful `finish`. A `kill()` landing inside that window used to capture `sink == nil`
    /// and had nothing to close, so the trailing chunk and the final summary kept transmitting
    /// for the rest of the window — the transport's kill predicate only guards NEW attempts.
    /// Driven as disable → kill, which is the interleaving; `finish()` and `close()` on their
    /// own were already covered and both passed against the defect.
    func testAKillDuringTheDisableGracePeriodStillClosesTheSinkThatIsFinishing() {
        let c = controller()
        c.applyServerConfig(on)
        c.applyServerConfig(off)
        XCTAssertEqual(sink.finishes, 1); XCTAssertEqual(sink.closes, 0, "the grace window is still open")
        c.shutdown()
        XCTAssertEqual(sink.closes, 1, "kill() must cancel what the disable left on the wire")
    }
    /// Codex round-1, #6 — an integration that KEEPS its context (the normal shape, and what
    /// `detach()` is explicitly allowed to do) closed registration → integration → ctx →
    /// registration. The weak controller does not touch that cycle, so unregistering the player
    /// and dropping its handle reclaimed nothing — the integration, its context, the
    /// registration and the announcement's pinned collector all stayed alive for the life of
    /// the process. Making `Ctx.reg` weak fails this test if it is reverted.
    func testAnIntegrationThatKeepsItsContextIsReclaimedAfterItsHandleDetaches() {
        let c = controller()
        c.applyServerConfig(on)
        weak var weakIntegration: FakeIntegration?
        autoreleasepool {
            let i = FakeIntegration()          // its `ctx` is never cleared, not even by detach()
            weakIntegration = i
            let h = track(c, i, "main")
            XCTAssertNotNil(i.ctx)
            h.detach()
        }
        XCTAssertNil(weakIntegration, "the registration must not be retained by the context it handed out")
    }

    func testLifecycleObserverFlushesOnBackground() {
        let c = controller(withLifecycle: true); c.applyServerConfig(on)
        let before = sink.bodies.count
        lifecycle?.bg()
        XCTAssertGreaterThan(sink.bodies.count, before)     // flushNow sent a summary
        lifecycle?.fg()
        c.shutdown()
    }
    /// Round-4, #1. `announce()` holds the registration's `announceLock` across the
    /// `player_attach` record; firing the rotation INLINE from inside that record
    /// ran `reseed -> describe()` — customer code — under the lock, and a describe
    /// that waits for a thread detaching another player deadlocked both.
    /// Codex round-1, #11 — the protocol counts UTF-16 code units (JavaScript `String.length`),
    /// `String.prefix` counts graphemes. 33 emoji passed a 64-GRAPHEME cut unchanged and
    /// arrived with a JS length of 66, so ingest rejected the whole chunk — every unrelated
    /// sample in it included.
    func testProtocolLimitedIdentityStringsAreCutByUTF16BudgetNotGraphemes() {
        let c = controller()
        c.applyServerConfig(on)
        let emoji = String(repeating: "😀", count: 33)              // 33 graphemes, 66 UTF-16 units
        c.trackVitals(emoji, data: nil, playerId: emoji)
        let entry = customEntries(c).last
        XCTAssertEqual(entry?.name.utf16.count, VitalsLimits.maxCustomNameLength)
        XCTAssertEqual(entry?.playerId?.utf16.count, VitalsLimits.maxPlayerIdLength)

        let i = FakeIntegration(library: emoji, version: emoji)
        _ = track(c, i, emoji)
        let attach = playerEvents(c).last { $0.type == VitalsPlayerEventTypes.playerAttach }
        guard case let .string(library)? = attach?.data?["library"] else { return XCTFail("no library") }
        guard case let .string(name)? = attach?.data?["name"] else { return XCTFail("no name") }
        guard case let .string(version)? = attach?.data?["libraryVersion"] else { return XCTFail("no version") }
        XCTAssertEqual(library.utf16.count, VitalsLimits.maxPlayerLibraryLength)
        XCTAssertEqual(version.utf16.count, VitalsLimits.maxPlayerLibraryLength)
        XCTAssertEqual(name.utf16.count, VitalsLimits.maxCustomNameLength)
    }

    func testARotationTriggeredUnderARegistrationsAnnounceLockDoesNotRunCustomerCodeUnderIt() {
        let c = controller()
        let second = Locked<PlayerHandle?>(nil)
        let workerFinished = Locked<Bool?>(nil)
        let box = self
        let first = ScriptedIntegration()
        first.onDescribe = { _, n in
            if n == 1 { box.now += 31 * 60_000; return }      // open the idle gap
            guard workerFinished.value == nil, let h = second.value else { return }
            let done = DispatchSemaphore(value: 0)
            DispatchQueue.global().async { h.detach(); done.signal() }
            let ok = done.wait(timeout: .now() + 2) == .success
            workerFinished.mutate { $0 = ok }
        }
        let secondInteg = ScriptedIntegration()
        _ = track(c, first, "one")
        second.mutate { $0 = track(c, secondInteg, "two") }

        c.applyServerConfig(on)

        XCTAssertNotNil(workerFinished.value, "precondition: the reseed reached the detaching describe")
        XCTAssertEqual(workerFinished.value, true,
                       "the reseed's describe() ran under the announcing registration's announceLock")
        XCTAssertEqual(secondInteg.detached, 1, "...and the detach really completed")
        c.shutdown()
    }
    /// Round-4, #5. `announce()` releases `announceLock` before `describe()`, so a
    /// detach can complete in between — and the retained source/DRM state must not
    /// land after the `player_detach` that closed the player.
    func testADelayedDescribeEmissionIsDroppedOnceItsRegistrationIsGone() {
        let c = controller()
        let handle = Locked<PlayerHandle?>(nil)
        let i = ScriptedIntegration()
        i.emitDefaultDescribe = false
        i.onDescribe = { ctx, _ in
            handle.value?.detach()
            ctx.emit("source_change", data: ["src": "s", "protocol": "hls"], t: nil)
            ctx.emit("play", data: nil, t: nil)
        }
        handle.mutate { $0 = track(c, i) }

        c.applyServerConfig(on)

        XCTAssertEqual(i.described, 1, "the describe really ran")
        XCTAssertEqual(playerEvents(c).map(\.type), ["player_attach", "player_detach"])
    }
    /// Round-4, #6. The liveness decision and the record are ONE critical section;
    /// the entry is BUILT outside it, which is where a racing detach can land.
    func testAHandleTrackThatRacesItsOwnDetachCannotLandAfterPlayerDetach() {
        let c = controller(); c.applyServerConfig(on)
        let i = FakeIntegration()
        let h = track(c, i)
        let payload = DetachingPayload { h.detach() }

        h.track("late", data: payload)

        XCTAssertEqual(playerEvents(c).map(\.type), ["player_attach", "source_change", "player_detach"],
                       "precondition: the detach really completed mid-build")
        XCTAssertTrue(customEntries(c).isEmpty,
                      "a custom entry must never land after the player_detach that closed its player")
    }
    /// Round-4, #7. A refused entry must answer the integration `false`, or a
    /// reported delta is committed against a timeline that never received it.
    func testASnapshotTheCollectorRefusesAnswersTheIntegrationFalse() {
        let c = controller(overrides: Self.tinyBuffer)
        c.applyServerConfig(on)
        let i = FakeIntegration()
        i.snap = PlayerSnapshot(bufferAheadMs: 1200, bandwidthEstimate: 5_000_000, bitrate: 2_000_000, width: 1280, height: 720, droppedFramesDelta: 3)
        _ = track(c, i)
        let answered = Locked<Bool?>(nil)
        i.onSnapshotAnswer = { a in answered.mutate { $0 = a } }
        samplerOnTick?()
        XCTAssertEqual(answered.value, false, "a refused entry must not be reported as recorded")
    }
    /// Round-5 residual of #6/#7. A tick landing between a rotation and this
    /// player's reseed must not put `stats` ahead of the reseeded `player_attach`.
    func testASnapshotLandingBetweenARotationAndTheReseedEmitsNothing() {
        let landDeferred = Locked<(() -> Void)?>(nil)
        let ids = Locked(0)
        let c = controller(overrides: { base in
            var d = base
            let inner = base.onRotate
            d.onRotate = { trigger in
                let pending = landDeferred.value
                landDeferred.mutate { $0 = nil }
                pending?()
                inner?(trigger)
            }
            return d
        }, newSessionId: { var n = 0; ids.mutate { $0 += 1; n = $0 }; return "sid-\(n)" })
        c.applyServerConfig(on)
        let i = FakeIntegration(); i.deferSnapshot = true
        _ = track(c, i)
        samplerOnTick?()
        let late = i.deferred
        XCTAssertNotNil(late, "precondition: the snapshot is outstanding")
        let answered = Locked<Bool?>(nil)
        landDeferred.mutate { $0 = { let a = late?(PlayerSnapshot(bufferAheadMs: 1200, droppedFramesDelta: 3)); answered.mutate { $0 = a } } }

        now += 31 * 60_000
        samplerOnSample?(VitalsSample(t: now, mem: 1))

        XCTAssertEqual(answered.value, false, "a snapshot that missed its session must be answered false")
        let types = playerEvents(c).map(\.type)
        XCTAssertFalse(types.contains("stats"), "no stats may precede the reseeded player_attach: \(types)")
        XCTAssertEqual(types, ["player_attach", "source_change"])
    }
    /// Round-6, W6-I1. The other side of the same window: the snapshot is answered
    /// AFTER the rotation has finished reseeding, so the registration already carries a
    /// FRESH announcement — in the SAME collector, which is why capturing the collector
    /// could not tell these measurements apart from B's own. They were read in session A
    /// and must not be recorded in B under a B-era timestamp.
    func testASnapshotDeliveredAfterACompletedReseedIsRefused() {
        let ids = Locked(0)
        let c = controller(newSessionId: { var n = 0; ids.mutate { $0 += 1; n = $0 }; return "sid-\(n)" })
        c.applyServerConfig(on)
        let i = FakeIntegration(); i.deferSnapshot = true
        _ = track(c, i)
        samplerOnTick?()
        let late = i.deferred
        XCTAssertNotNil(late, "precondition: the snapshot is outstanding")
        let sessionA = c.currentStamp()?.sessionId

        now += 31 * 60_000
        samplerOnSample?(VitalsSample(t: now, mem: 1))     // unpinned entry → idle rotation, and a reseed
        XCTAssertNotEqual(sessionA, c.currentStamp()?.sessionId, "precondition: the session really rotated")
        XCTAssertEqual(i.described, 2, "precondition: the reseed COMPLETED before the snapshot was answered")

        let answered = late?(PlayerSnapshot(bufferAheadMs: 1200, droppedFramesDelta: 3))
        XCTAssertEqual(answered, false, "a snapshot requested in the previous session must be answered false")
        let types = playerEvents(c).map(\.type)
        XCTAssertFalse(types.contains("stats"), "…and record nothing in the session it did not measure: \(types)")
        XCTAssertEqual(types, ["player_attach", "source_change"])
        c.shutdown()
    }
    /// Round-4, #8. A teardown finishing after a disable/re-enable must hand its
    /// closing spans and its marker to NEITHER collector.
    func testADetachCompletingAfterACollectorSwapEmitsIntoNeitherCollector() {
        let c = controller(); c.applyServerConfig(on)
        let i = FakeIntegration(); i.deferDetach = true
        let h = track(c, i)

        h.detach()
        c.applyServerConfig(off)   // collector #1 stops
        c.applyServerConfig(on)    // collector #2 — a different timeline

        i.ctx?.emit("pause", data: nil, t: nil)   // the teardown's closing span
        i.pendingComplete?()                      // ...and its completion, which marks the detach

        XCTAssertTrue(playerEvents(c).isEmpty,
                      "the new collector must receive nothing for a player it never announced")
    }
    /// Round-5, #3. The customer's `data` map is coerced BEFORE `announceLock` is
    /// taken — a value whose `description` blocks on the player's own lock would
    /// otherwise deadlock against a teardown waiting for that same monitor.
    func testADescribeEmissionCoercesItsCustomerMapWithNoAnnounceLockHeld() {
        let c = controller()
        let handle = Locked<PlayerHandle?>(nil)
        let workerFinished = Locked<Bool?>(nil)
        let i = ScriptedIntegration()
        i.emitDefaultDescribe = false
        i.onDescribe = { ctx, _ in
            let hostile = DetachingPayload {
                guard workerFinished.value == nil, let h = handle.value else { return }
                let done = DispatchSemaphore(value: 0)
                DispatchQueue.global().async { h.detach(); done.signal() }
                let ok = done.wait(timeout: .now() + 2) == .success
                workerFinished.mutate { $0 = ok }
            }
            ctx.emit("source_change", data: ["src": hostile], t: nil)
        }
        handle.mutate { $0 = track(c, i) }

        c.applyServerConfig(on)

        XCTAssertNotNil(workerFinished.value, "precondition: the hostile value really was coerced")
        XCTAssertEqual(workerFinished.value, true,
                       "the customer map was coerced under the announce monitor — a concurrent detach deadlocked against it")
        // Round-4, #5 still holds: the detach won, so the delayed emission is dropped.
        XCTAssertEqual(playerEvents(c).map(\.type), ["player_attach", "player_detach"])
    }
    /// Round-7, #2. A live callback builds its entry outside every lock; a detach
    /// completing in that window must refuse it, not let it land after the marker.
    func testALiveEmissionThatRacesItsOwnDetachCannotLandAfterPlayerDetach() {
        let c = controller(); c.applyServerConfig(on)
        let i = FakeIntegration()
        let h = track(c, i)
        let detachRan = Locked(false)
        let hostile = DetachingPayload {
            var first = false
            detachRan.mutate { if !$0 { $0 = true; first = true } }
            if first { h.detach() }
        }

        XCTAssertFalse(i.ctx!.emit("play", data: ["reason": hostile], t: nil),
                       "a live emission admitted after its detach completed must be refused")
        XCTAssertTrue(detachRan.value, "precondition: the detach really completed mid-build")
        XCTAssertEqual(i.detached, 1)
        XCTAssertEqual(playerEvents(c).map(\.type), ["player_attach", "source_change", "player_detach"])
    }
    /// Round-5, #7. `announcedIn` is per collector AND per session, so a callback
    /// arriving between a re-enable and that player's announcement is dropped.
    func testALiveCallbackBetweenAReEnableAndThatPlayersAnnouncementRecordsNothing() {
        let c = controller(); c.applyServerConfig(on)
        let second = FakeIntegration()
        let armed = Locked(false)
        let first = ScriptedIntegration()
        first.onDescribe = { _, _ in
            var fire = false
            armed.mutate { if $0 { $0 = false; fire = true } }
            if fire { second.ctx?.emit("play", data: nil, t: nil) }
        }
        _ = track(c, first, "one")
        _ = track(c, second, "two")

        c.applyServerConfig(off)                  // C1 stops
        armed.mutate { $0 = true }
        c.applyServerConfig(on)                   // C2 is published, then announces

        let p2 = playerEvents(c).filter { $0.playerId == "p2" }
        XCTAssertEqual(p2.filter { $0.type == "player_attach" }.count, 1,
                       "precondition: the second player really was announced into C2")
        XCTAssertEqual(p2.first?.type, "player_attach",
                       "nothing may reach a new collector before that player's own player_attach")
        c.shutdown()
    }
    /// Round-5, #6. Same rule across a ROTATION: the collector object is the same,
    /// the session is not.
    func testALiveCallbackBetweenARotationAndThatPlayersReseedRecordsNothingInTheNewSession() {
        let ids = Locked(0)
        let c = controller(newSessionId: { var n = 0; ids.mutate { $0 += 1; n = $0 }; return "sid-\(n)" })
        c.applyServerConfig(on)
        let second = FakeIntegration()
        let armed = Locked(false)
        let first = ScriptedIntegration()
        first.onDescribe = { _, _ in
            var fire = false
            armed.mutate { if $0 { $0 = false; fire = true } }
            if fire { second.ctx?.emit("play", data: nil, t: nil) }
        }
        _ = track(c, first, "one")
        _ = track(c, second, "two")

        let before = c.currentStamp()?.sessionId
        armed.mutate { $0 = true }
        now += 31 * 60_000
        c.trackVitals("rotate-me", data: nil, playerId: nil)
        XCTAssertNotEqual(before, c.currentStamp()?.sessionId, "precondition: the session really rotated")

        let p2 = playerEvents(c).filter { $0.playerId == "p2" }
        XCTAssertEqual(p2.filter { $0.type == "player_attach" }.count, 1,
                       "precondition: the reseed really re-announced the second player")
        XCTAssertEqual(p2.first?.type, "player_attach",
                       "nothing may reach a new session before that player's reseeded player_attach")
        c.shutdown()
    }
    /// Codex round-5, W5-I5 × round-4, #3 — the two must not fight. A describe now carries the
    /// instant its state was READ, and that instant is inside the session it reseeds into (a
    /// reseed only ever runs after the rotation that caused it), so the origin refusal
    /// (`origin < sessionStartedAt`) cannot fire on it. Stamping a describe with the moment the
    /// span it re-opens ORIGINALLY opened would be refused here instead, and the new session
    /// would carry no play span at all.
    func testAReseededDescribeStampedAtItsReadInstantIsAdmittedIntoTheSessionItReseedsInto() {
        let box = self
        let ids = Locked(0)
        let c = controller(newSessionId: { var n = 0; ids.mutate { $0 += 1; n = $0 }; return "sid-\(n)" })
        c.applyServerConfig(on)
        let facade = FakeFacade()
        let integration = AVPlayerIntegration(facade: facade, captureSourceQuery: { false }, now: { box.now })
        _ = track(c, integration, "main")
        let e = facade.events!
        e.onItemChanged?(ItemIdentity(url: URL(string: "https://cdn.example.com/a.m3u8")!), false, 0, facade.nextItemGen())
        e.onRateChanged?(1); e.onTimeControlChanged?(.waitingToPlay(toMinimizeStalls: false))
        now += 1_300; e.onTimeControlChanged?(.playing)
        XCTAssertTrue(playerEvents(c).contains { $0.type == "play" }, "precondition: the player is playing")

        let before = c.currentStamp()?.sessionId
        now += 31 * 60_000
        c.trackVitals("rotate-me", data: nil, playerId: nil)     // unpinned → idle rotation, and a reseed
        let rotatedAt = now
        XCTAssertNotEqual(before, c.currentStamp()?.sessionId, "precondition: the session really rotated")

        let reseeded = playerEvents(c).filter { $0.type == "play" }
        XCTAssertEqual(reseeded.count, 1, "the reseeded play must be admitted, not refused for predating the session")
        XCTAssertEqual(reseeded.first?.t, rotatedAt, "…carrying the instant the reseed read the state")

        now += 5_000; e.onTimeControlChanged?(.paused)
        c.shutdown()
        let final = sink.payloads.last { $0["kind"] as? String == "summary" && $0["final"] as? Bool == true }
        XCTAssertEqual(final?["playtimeMs"] as? Int, 5_000,
                       "the playback after the rotation belongs to the new session and must not be lost")
    }
    /// Round-5, #8. The reseed skips the player whose own `player_attach` caused
    /// the rotation — it is already in the new session and is about to be described.
    func testAPlayerAttachThatTripsARotationAnnouncesThatPlayerExactlyOnce() {
        let c = controller(); c.applyServerConfig(on)
        let existing = FakeIntegration()
        _ = track(c, existing, "one")

        now += 31 * 60_000
        let joining = FakeIntegration(); joining.playing = true
        _ = track(c, joining, "two")

        let p2 = playerEvents(c).filter { $0.playerId == "p2" }
        XCTAssertEqual(existing.described, 2, "precondition: the attach really rotated the session")
        XCTAssertEqual(p2.filter { $0.type == "player_attach" }.count, 1, "exactly one attach for the joining player")
        XCTAssertEqual(p2.filter { $0.type == "play" }.count, 1, "...and exactly one open play span")
        XCTAssertEqual(joining.described, 1, "...described once, not twice")
        c.shutdown()
    }
    /// The session-id half of #8: the collector is the same object, the session the
    /// detach began against is not.
    func testADetachCompletingAfterASessionRotationEmitsIntoNeitherSession() {
        let ids = Locked(0)
        let c = controller(newSessionId: { var n = 0; ids.mutate { $0 += 1; n = $0 }; return "sid-\(n)" })
        c.applyServerConfig(on)
        let i = FakeIntegration(); i.deferDetach = true
        let h = track(c, i)

        h.detach()
        let before = c.currentStamp()?.sessionId
        now += 31 * 60_000
        c.trackVitals("rotate-me", data: nil, playerId: nil)
        XCTAssertNotEqual(before, c.currentStamp()?.sessionId, "precondition: the session really rotated")

        i.ctx?.emit("pause", data: nil, t: nil)
        i.pendingComplete?()

        XCTAssertTrue(playerEvents(c).isEmpty,
                      "a detach that began in the previous session must not be marked in this one")
        c.shutdown()
    }
    func testAPlayerDetachAfterALongIdleGapIsDroppedNotRotatedIntoAFreshSession() {
        let c = controller(); c.applyServerConfig(on)
        let h = track(c, FakeIntegration())
        now += 31 * 60_000
        h.detach()
        XCTAssertEqual(c.currentStamp()?.sessionId, "sid")
        c.shutdown()
        XCTAssertFalse(sink.playerEventTypes.contains("player_detach"))
    }
    /// Round-6, #4. A describe context belongs to ONE announcement, identified by
    /// the object itself — a rotation keeps the same collector, so identity is the
    /// only thing that can tell a superseded describe from the current one.
    func testADescribeEmissionFromASupersededAnnouncementIsDropped() {
        let c = controller(); c.applyServerConfig(on)
        let firstCtx = Locked<PlayerIntegrationContext?>(nil)
        let i = ScriptedIntegration()
        i.emitDefaultDescribe = false
        i.onDescribe = { ctx, n in
            if n == 1 { firstCtx.mutate { $0 = ctx }; return }   // the SLOW describe: captures, emits nothing yet
            ctx.emit("play", data: nil, t: nil)                  // every later describe is a reseed
        }
        _ = track(c, i)
        let stale = firstCtx.value
        XCTAssertNotNil(stale)

        now += 31 * 60_000
        samplerOnSample?(VitalsSample(t: now, mem: 1))
        XCTAssertEqual(i.described, 2, "precondition: the rotation really re-described the player")

        XCTAssertFalse(stale!.emit("play", data: nil, t: nil),
                       "an emission from a superseded announcement must be dropped")

        let types = playerEvents(c).map(\.type)
        XCTAssertEqual(types, ["player_attach", "play"])
        c.shutdown()
    }
    /// Round-6, #6. The liveness check, the announcement resolution and the record
    /// are ONE critical section — beside each other they were a plain TOCTOU.
    func testASnapshotThatRacesItsOwnDetachCannotLandAfterPlayerDetach() {
        let c = controller(); c.applyServerConfig(on)
        let i = FakeIntegration(); i.deferSnapshot = true
        let h = track(c, i)
        samplerOnTick?()
        let late = i.deferred
        XCTAssertNotNil(late, "precondition: the snapshot is outstanding")

        // Fires once, from inside the stats entry's own timestamp read.
        let box = self
        onNow = { box.onNow = nil; h.detach() }
        let answered = late?(PlayerSnapshot(bufferAheadMs: 1200, droppedFramesDelta: 3))

        XCTAssertEqual(answered, false, "a snapshot that lost the race must be answered false")
        let types = playerEvents(c).map(\.type)
        XCTAssertEqual(types, ["player_attach", "source_change", "player_detach"])
        XCTAssertFalse(types.contains("stats"), "stats must never land after the player_detach that closed its player")
        c.shutdown()
    }
    func testAThrowingLibraryGetterStillAnnouncesThePlayer() {
        // Swift getters cannot throw; the equivalent is an over-long library name that must be cut, not rejected.
        let c = controller(); c.applyServerConfig(on)
        let i = FakeIntegration(library: String(repeating: "L", count: 100))
        _ = track(c, i); c.shutdown()
        let attach = sink.payloads.filter { $0["kind"] as? String == "chunk" }.flatMap { $0["entries"] as! [[String: Any]] }.first { $0["type"] as? String == "player_attach" }
        XCTAssertEqual(((attach?["data"] as? [String: Any])?["library"] as? String)?.count, 32)
    }
}

/// Inert stand-in used only when a test's registration is unexpectedly refused.
final class InertHandleForTests: PlayerHandle { let id = ""; func track(_ name: String, data: Any?) {}; func detach() {} }

/// A value whose JSON coercion runs `onRead` — `JsonCoerce`'s fallback calls
/// `String(describing:)`, which is exactly the window between an entry being
/// built and being recorded.
final class DetachingPayload: CustomStringConvertible, @unchecked Sendable {
    private let onRead: () -> Void
    init(_ onRead: @escaping () -> Void) { self.onRead = onRead }
    var description: String { onRead(); return "detached-underneath-me" }
}

/// The scriptable twin of `FakeIntegration` (which is `final`): the Kotlin suite
/// subclasses its fake for the ordering cases, so the hooks live here instead.
final class ScriptedIntegration: PlayerIntegration, @unchecked Sendable {
    let library: String
    let version: String?
    var attachResult = true
    var ctx: PlayerIntegrationContext?
    var detached = 0
    var described = 0
    var playing = false
    var buffering = false
    var snap: PlayerSnapshot?
    var deferSnapshot = false
    var deferred: ((PlayerSnapshot?) -> Bool)?
    var onSnapshotAnswer: ((Bool) -> Void)?
    var deferDetach = false
    var pendingComplete: (() -> Void)?
    var onAttach: ((PlayerIntegrationContext) -> Void)?
    /// Emit the standard reseed body before `onDescribe`.
    var emitDefaultDescribe = true
    /// `(ctx, 1-based describe count)`.
    var onDescribe: ((PlayerIntegrationContext, Int) -> Void)?

    init(library: String = "fake", version: String? = "1") { self.library = library; self.version = version }

    func attach(_ ctx: PlayerIntegrationContext) -> Bool { self.ctx = ctx; onAttach?(ctx); return attachResult }
    func snapshot(_ onResult: @escaping (PlayerSnapshot?) -> Bool) {
        if deferSnapshot { deferred = onResult; return }
        let answered = onResult(snap)   // never short-circuited by a nil observer
        onSnapshotAnswer?(answered)
    }
    func startupTimings() -> StartupTimings? { nil }
    func describe(_ ctx: PlayerIntegrationContext) {
        described += 1
        if emitDefaultDescribe {
            ctx.emit("source_change", data: ["src": "s", "protocol": "hls"], t: nil)
            if playing { ctx.emit("play", data: nil, t: nil) }
            if buffering { ctx.emit("buffer_start", data: nil, t: nil) }
        }
        onDescribe?(ctx, described)
    }
    func detach() { detached += 1 }
    func detach(onComplete: @escaping () -> Void) {
        detach()
        if deferDetach { pendingComplete = onComplete } else { onComplete() }
    }
}

enum AsyncTestHelpersSync {
    static func waitFor(_ p: () -> Bool, timeout: TimeInterval = 5) -> Bool {
        let d = Date().addingTimeInterval(timeout)
        while Date() < d { if p() { return true }; Thread.sleep(forTimeInterval: 0.01) }
        return p()
    }
}
