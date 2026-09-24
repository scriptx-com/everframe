// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The public AVPlayer entry point, against a REAL AVPlayer wherever the point is
// the real one (AVFoundation is on the macOS host). Port of TrackPlayerTest.kt.
// The one exception is the release-inside-`register` window, which only the
// `FakeFacade` seam can open on demand.
//
// The player's lifetime is wrapped in an `autoreleasepool` wherever a test turns
// on its DEALLOCATION: a bare `AVPlayer` goes away the moment the last strong
// reference AND the enclosing pool are gone, so the release is observed
// deterministically rather than whenever AVFoundation happens to drain a queue.
import AVFoundation
import XCTest
import EverframeProtocol
@testable import EverframeKit

final class TrackPlayerTests: XCTestCase {
    override func setUp() { super.setUp(); VitalsRuntime.shared.resetForTesting(); VitalsServerConfigBox.shared.resetForTesting() }
    override func tearDown() { VitalsRuntime.shared.resetForTesting(); VitalsServerConfigBox.shared.resetForTesting(); super.tearDown() }

    func testBuildsAnIntegrationRegistersItAndReleaseDetachesThroughTheHandle() {
        var registered: PlayerIntegration?
        let fake = FakeRegistrar()
        var facade: AVPlayerFacade!
        autoreleasepool {
            var player: AVPlayer? = AVPlayer()
            facade = AVPlayerFacade(player: player!)
            let h = trackPlayerWith(facade: facade, name: "main",
                                    register: { i, n in registered = i; return fake.register(i, n) },
                                    captureSourceQuery: { false })
            XCTAssertTrue(registered is AVPlayerIntegration); XCTAssertEqual(h.id, "p1")
            XCTAssertTrue(facade.isAlive)
            XCTAssertEqual(fake.detached, 0)
            player = nil
        }
        XCTAssertFalse(facade.isAlive, "the player really did deallocate")
        // Round-1, Critical 2: the sentinel's work is enqueued rather than run on the thread
        // that dropped the last reference (which can be holding the integration lock).
        XCTAssertTrue(AsyncTestHelpersSync.waitFor { fake.detached == 1 }, "the release reaches the handle register() returned")
    }
    /// The `released` REPLAY, which no real-player test can reach: a release reported while
    /// `register` is still running finds `holder` empty, so the hook's `holder.value?.detach()`
    /// is a no-op and the only thing that unwinds the registration is the replay after the
    /// holder is filled. Deleting `if released.value { handle.detach() }` makes this test — and
    /// only this test — fail.
    ///
    /// Driven through the DEAD-PLAYER path, which is the one that still reports SYNCHRONOUSLY:
    /// `observeRelease()` cannot subscribe, so the integration fires the release inline, before
    /// `register` has returned a handle. (Round-1, Critical 2 moved the sentinel's own path onto
    /// a queue, so a sentinel firing inside `register` no longer lands in that window
    /// deterministically — the inline path opens exactly the same one, on purpose.)
    func testAReleaseLandingInsideRegisterStillDetachesTheHandleItReturns() {
        let facade = FakeFacade()
        facade.alive = false
        let fake = FakeRegistrar()
        let h = trackPlayerWith(facade: facade, name: nil,
                                register: { i, n in fake.register(i, n) },
                                captureSourceQuery: { false })
        XCTAssertEqual(h.id, "p1")
        XCTAssertEqual(fake.detached, 1, "the handle register() returned must come back detached")
    }
    func testAPlayerReleasedBeforeStartDetachesItsPendingRegistration() {
        let holder = FakeRecordingIntegrationHolder()
        autoreleasepool {
            var player: AVPlayer? = AVPlayer()
            let h = trackPlayerWith(facade: AVPlayerFacade(player: player!), name: nil,
                                    register: { integ, _ in holder.integration = integ; return VitalsRuntime.shared.trackPlayer(integ, name: nil) },
                                    captureSourceQuery: { false })
            XCTAssertTrue(holder.integration is AVPlayerIntegration)
            XCTAssertEqual(h.id, "")   // no controller yet: a deferred handle
            XCTAssertEqual(VitalsRuntime.shared.pendingCountForTesting, 1)
            player = nil
        }
        XCTAssertTrue(AsyncTestHelpersSync.waitFor { VitalsRuntime.shared.pendingCountForTesting == 0 })
    }
    func testTheRealFacadeObservesAndUnobservesARealPlayerWithoutCrashing() {
        let player = AVPlayer()
        let facade = AVPlayerFacade(player: player)
        let events = PlayerFacadeEvents()
        // `Locked`, not bare vars: the callback arrives on whatever thread AVFoundation
        // delivers the KVO change on, and the assertions read from the test thread.
        let items = Locked(0)
        let seen = Locked<URL?>(nil)
        events.onItemChanged = { item, _, _, _ in items.mutate { $0 += 1 }; seen.mutate { $0 = item?.url } }
        XCTAssertTrue(facade.observe(events))
        let url = URL(fileURLWithPath: "/nonexistent.mp4")
        player.replaceCurrentItem(with: AVPlayerItem(url: url))
        _ = AsyncTestHelpersSync.waitFor { items.value >= 1 }
        XCTAssertGreaterThanOrEqual(items.value, 1)
        // Pins the KVC `asset` read the facade does instead of the @MainActor
        // property: nothing else in the suite proves it returns the AVURLAsset.
        XCTAssertEqual(seen.value, url)
        XCTAssertEqual(facade.readState()?.item?.url, url)
        // Round-2, M6 — `observe()` used to overwrite `timeObserver` without removing the
        // previous one, leaving a periodic time observer on a live player. Unreachable through
        // `attach()`'s double-attach guard, so this only pins that the re-observe path is safe.
        XCTAssertTrue(facade.observe(events))
        facade.unobserve(); facade.unobserve()
    }
    /// Codex round-1, #5 — the release hook closed a permanent ARC cycle: integration →
    /// `onReleased` → holder → handle → registration → integration (plus the facade, both
    /// `Locked` boxes, the per-facade sentinel key and a strong controller). It was cleared
    /// only in `fireReleased()`, which `detach()` can never reach because it disarms the
    /// sentinel first — so the DOCUMENTED path, `handle.detach()`, leaked one whole graph per
    /// tracked player. Restoring the hook's clear to `fireReleased()` alone fails this test.
    func testAnExplicitHandleDetachReleasesTheWholeIntegrationGraph() {
        VitalsRuntime.shared.install(controller(), isCurrent: { true })
        weak var weakIntegration: AVPlayerIntegration?
        weak var weakFacade: FakeFacade?
        autoreleasepool {
            let facade = FakeFacade()
            weakFacade = facade
            let h = trackPlayerWith(facade: facade, name: "main",
                                    register: { i, n in
                                        weakIntegration = i as? AVPlayerIntegration
                                        return VitalsRuntime.shared.trackPlayer(i, name: n)
                                    },
                                    captureSourceQuery: { false })
            XCTAssertNotNil(weakIntegration); XCTAssertEqual(h.id, "p1")
            h.detach()
        }
        XCTAssertNil(weakIntegration, "handle.detach() must clear the release hook that retains the graph")
        XCTAssertNil(weakFacade, "…and with it the facade and its sentinel key")
    }
    /// Codex round-2, #4 — controller A finishes `attach()` and is then shut down before the
    /// registration is published, so A returns the TRANSIENT nil refusal and the runtime retries
    /// the same integration against B. The rollback used to be a plain `detach()`, which cleared
    /// `onReleased` (round-1, #5) and dropped the declaration-time sentinel (round-8, #1) —
    /// neither of which `attach()` restores. The player could then deallocate with nothing left
    /// to unregister it. Driven with the REAL integration, facade and AVPlayer, because the
    /// sentinel is the half only the real facade installs.
    func testARegistrationRolledBackForShutdownKeepsItsReleaseDetectionWhenItIsRetried() {
        // Through the shared box, not `applyServerConfig` directly: `install()` subscribes each
        // controller and the replay would otherwise disable it again.
        VitalsServerConfigBox.shared.publish(VitalsServerConfig(vitalsEnabled: true, vitalsSampleRate: 1), ifCurrent: { true })
        let a = controller(), b = controller()
        VitalsRuntime.shared.install(a, isCurrent: { true })
        XCTAssertTrue(AsyncTestHelpersSync.waitFor { a.isRunning }, "precondition: A is collecting")
        autoreleasepool {
            var player: AVPlayer? = AVPlayer()
            let h = trackPlayerWith(facade: AVPlayerFacade(player: player!), name: "main",
                                    register: { i, n in VitalsRuntime.shared.trackPlayer(i, name: n) },
                                    // Resolved INSIDE attach(), i.e. between reserve() and
                                    // publication: exactly the window that produces the refusal.
                                    captureSourceQuery: { a.shutdown(); return false })
            XCTAssertEqual(h.id, "", "A refused for shutdown, so the registration went back on the queue")
            VitalsRuntime.shared.install(b, isCurrent: { true })
            XCTAssertEqual(h.id, "p1", "…and B picked it up")
            XCTAssertTrue(AsyncTestHelpersSync.waitFor { Self.attachedIn(b) }, "precondition: B announced it")
            player = nil
        }
        XCTAssertTrue(AsyncTestHelpersSync.waitFor { Self.detachedIn(b) },
                      "the released player must still detach from the controller that retried it")
    }
    private static func typesIn(_ c: VitalsController) -> [String] {
        (c.currentStamp()?.entries ?? []).compactMap { if case let .player(p) = $0 { return p.type }; return nil }
    }
    private static func attachedIn(_ c: VitalsController) -> Bool { typesIn(c).contains(VitalsPlayerEventTypes.playerAttach) }
    private static func detachedIn(_ c: VitalsController) -> Bool { typesIn(c).contains(VitalsPlayerEventTypes.playerDetach) }
    private final class NoopScheduler: VitalsScheduler, @unchecked Sendable {
        final class H: VitalsCancellable, @unchecked Sendable { func cancel() {} }
        func repeating(intervalMs: Int64, _ tick: @escaping @Sendable () -> Void) -> VitalsCancellable { H() }
    }
    private func controller() -> VitalsController {
        let q = DispatchQueue(label: "test.trackplayer.sampler")
        return VitalsController(deps: VitalsController.Deps(
            localConfig: VitalsConfig(), dims: SessionSummaryDims(platform: "ios", appVersion: "1", sdkVersion: "0.7.0"),
            transport: { RecordingSink() }, scheduler: NoopScheduler(),
            samplerFactory: { onSample, onTick in ResourceSampler(queue: q, now: { 0 }, onSample: onSample, onTick: onTick) },
            lifecycle: { _, _ in nil }, now: { 1_000 }, random: { 0 }, newSessionId: { "sid" }))
    }

    func testPublicTrackPlayerReturnsAHandleBeforeStart() {
        // BOUND to a `let`: an unbound temporary can deallocate first and clear the queue
        // through its release hook, which would pass this test without `h.detach()` doing
        // anything at all.
        let player = AVPlayer()
        let h = Everframe.shared.trackPlayer(player, name: "x")
        XCTAssertEqual(h.id, "")
        XCTAssertEqual(VitalsRuntime.shared.pendingCountForTesting, 1)
        h.detach()
        XCTAssertEqual(VitalsRuntime.shared.pendingCountForTesting, 0)
        withExtendedLifetime(player) {}
    }
}

private final class FakeRegistrar {
    var detached = 0
    func register(_ i: PlayerIntegration, _ name: String?) -> PlayerHandle {
        _ = i.attach(RecordingContext(clock: { 0 }))
        return H(owner: self)
    }
    final class H: PlayerHandle { let id = "p1"; weak var owner: FakeRegistrar?; init(owner: FakeRegistrar) { self.owner = owner }
        func track(_ name: String, data: Any?) {}; func detach() { owner?.detached += 1 } }
}
private final class FakeRecordingIntegrationHolder { var integration: PlayerIntegration? }
