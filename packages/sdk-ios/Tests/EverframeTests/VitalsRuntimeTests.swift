// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Twin of VitalsRuntimeTest.kt. Drives VitalsRuntime.shared directly with an
// injected kill-generation source; never touches Everframe.shared.
import XCTest
import EverframeProtocol
@testable import EverframeKit

final class VitalsRuntimeTests: XCTestCase {
    private final class NoopScheduler: VitalsScheduler, @unchecked Sendable {
        final class H: VitalsCancellable, @unchecked Sendable { func cancel() {} }
        func repeating(intervalMs: Int64, _ tick: @escaping @Sendable () -> Void) -> VitalsCancellable { H() }
    }
    private var killGen: UInt64 = 0
    private let queue = DispatchQueue(label: "test.vitals.runtime")

    override func setUp() {
        super.setUp()
        VitalsRuntime.shared.resetForTesting(); VitalsServerConfigBox.shared.resetForTesting()
        killGen = 0
        VitalsRuntime.shared.__setKillGenerationForTesting { [self] in killGen }
    }
    override func tearDown() { VitalsRuntime.shared.resetForTesting(); VitalsServerConfigBox.shared.resetForTesting(); super.tearDown() }

    private func controller(sink: RecordingSink = RecordingSink()) -> VitalsController {
        let q = queue
        return VitalsController(deps: VitalsController.Deps(
            localConfig: VitalsConfig(), dims: SessionSummaryDims(platform: "ios", appVersion: "1", sdkVersion: "0.7.0"),
            transport: { sink }, scheduler: NoopScheduler(),
            samplerFactory: { onSample, onTick in ResourceSampler(queue: q, now: { 0 }, onSample: onSample, onTick: onTick) },
            lifecycle: { _, _ in nil }, now: { 1_000 }, random: { 0 }, newSessionId: { "sid" }))
    }
    private func enable() {
        VitalsServerConfigBox.shared.publish(VitalsServerConfig(vitalsEnabled: true, vitalsSampleRate: 1), ifCurrent: { true })
        VitalsQueue.shared.sync {}
    }

    func testATrackPlayerCallBeforeInstallIsHonouredOnceInstallRuns() {
        let i = FakeIntegration()
        let h = VitalsRuntime.shared.trackPlayer(i, name: "main")
        XCTAssertEqual(h.id, ""); XCTAssertNil(i.ctx)
        VitalsRuntime.shared.install(controller(), isCurrent: { true })
        XCTAssertEqual(h.id, "p1"); XCTAssertNotNil(i.ctx)
        XCTAssertEqual(VitalsRuntime.shared.pendingCountForTesting, 0)
    }
    func testADeferredHandleDetachedBeforeInstallAttachesNothingAndReleasesItsIntegration() {
        let i = FakeIntegration()
        let h = VitalsRuntime.shared.trackPlayer(i, name: nil)
        h.detach()
        XCTAssertEqual(VitalsRuntime.shared.pendingCountForTesting, 0)   // round-5, #5: removed, not merely marked
        XCTAssertEqual(i.detached, 1)                                     // round-8, #1: released
        VitalsRuntime.shared.install(controller(), isCurrent: { true })
        XCTAssertNil(i.ctx)
    }
    func testTrackPlayerDelegatesImmediatelyOnceAControllerIsInstalled() {
        VitalsRuntime.shared.install(controller(), isCurrent: { true })
        let i = FakeIntegration()
        XCTAssertEqual(VitalsRuntime.shared.trackPlayer(i, name: nil).id, "p1"); XCTAssertNotNil(i.ctx)
    }
    func testShutdownDropsAStillQueuedRegistrationInsteadOfCarryingItIntoTheNextSession() {
        let i = FakeIntegration()
        _ = VitalsRuntime.shared.trackPlayer(i, name: nil)
        killGen = 1                                         // kill() bumped
        VitalsRuntime.shared.shutdown(dropPending: true, ifCurrent: { true })
        XCTAssertEqual(i.detached, 1)
        VitalsRuntime.shared.install(controller(), isCurrent: { true })
        XCTAssertNil(i.ctx)
    }
    func testARegistrationQueuedBeforeTheFirstStartSurvivesASupersedingStartsBoundary() {
        let i = FakeIntegration()
        _ = VitalsRuntime.shared.trackPlayer(i, name: nil)
        VitalsRuntime.shared.shutdown(dropPending: false, ifCurrent: { true })
        VitalsRuntime.shared.install(controller(), isCurrent: { true })
        XCTAssertNotNil(i.ctx); XCTAssertEqual(i.detached, 0)
    }
    func testARegistrationMadeAfterKillAttachesToTheSessionTheNextStartInstalls() {
        killGen = 1
        let i = FakeIntegration()
        _ = VitalsRuntime.shared.trackPlayer(i, name: nil)          // tagged gen 1
        VitalsRuntime.shared.shutdown(dropPending: true, ifCurrent: { true })   // partitions at gen 1: keeps it
        XCTAssertEqual(i.detached, 0)
        VitalsRuntime.shared.install(controller(), isCurrent: { true })
        XCTAssertNotNil(i.ctx)
    }
    func testAPlayerAttachedIntoTheLiveSessionIsNotReAttachedByTheNextStart() {
        VitalsRuntime.shared.install(controller(), isCurrent: { true })
        let i = FakeIntegration(); _ = VitalsRuntime.shared.trackPlayer(i, name: nil)
        VitalsRuntime.shared.install(controller(), isCurrent: { true })
        XCTAssertEqual(i.detached, 1)                                // old controller's shutdown detached it
        XCTAssertEqual(VitalsRuntime.shared.pendingCountForTesting, 0)
    }
    func testShutdownRefusesToUnpublishAControllerANewerStartAlreadyInstalled() {
        let c = controller()
        VitalsRuntime.shared.install(c, isCurrent: { true })
        VitalsRuntime.shared.shutdown(dropPending: false, ifCurrent: { false })
        XCTAssertTrue(VitalsRuntime.shared.current() === c)
    }
    func testInstallRefusesAndShutsDownAControllerWhoseStartEpochIsAlreadyStale() {
        let c = controller()
        VitalsRuntime.shared.install(c, isCurrent: { false })
        XCTAssertNil(VitalsRuntime.shared.current())
        XCTAssertNil(c.trackPlayer(FakeIntegration(), name: nil))      // it was shut down
    }
    func testAnAttachThatReEntersTrackPlayerDuringTheDrainNeitherDeadlocksNorLosesARegistration() {
        let inner = FakeIntegration()
        let outer = FakeIntegration()
        outer.onAttach = { _ = VitalsRuntime.shared.trackPlayer(inner, name: nil) }
        _ = VitalsRuntime.shared.trackPlayer(outer, name: nil)
        VitalsRuntime.shared.install(controller(), isCurrent: { true })
        XCTAssertNotNil(outer.ctx); XCTAssertNotNil(inner.ctx)
    }
    func testADelayedKillTailRevokesOnlyWhatWasDeclaredBeforeItsOwnGenerationBump() {
        let before = FakeIntegration(), after = FakeIntegration()
        _ = VitalsRuntime.shared.trackPlayer(before, name: nil)
        killGen = 1
        _ = VitalsRuntime.shared.trackPlayer(after, name: nil)
        VitalsRuntime.shared.shutdown(dropPending: true, ifCurrent: { true })
        XCTAssertEqual(before.detached, 1); XCTAssertEqual(after.detached, 0)
        VitalsRuntime.shared.install(controller(), isCurrent: { true })
        XCTAssertNotNil(after.ctx); XCTAssertNil(before.ctx)
    }
    func testAnInstallThatBeatsTheKillTailToTheQueueRevokesThePreKillEntriesItself() {
        let before = FakeIntegration()
        _ = VitalsRuntime.shared.trackPlayer(before, name: nil)
        killGen = 1
        VitalsRuntime.shared.install(controller(), isCurrent: { true })
        XCTAssertEqual(before.detached, 1); XCTAssertNil(before.ctx)
    }
    func testTrackPlayerQueuesInsteadOfAttachingToAControllerAKillHasAlreadyDoomed() {
        let c = controller()
        VitalsRuntime.shared.install(c, isCurrent: { true })
        killGen = 1                                 // kill bumped; tail not yet here
        let i = FakeIntegration()
        let h = VitalsRuntime.shared.trackPlayer(i, name: nil)
        XCTAssertEqual(h.id, ""); XCTAssertNil(i.ctx); XCTAssertEqual(VitalsRuntime.shared.pendingCountForTesting, 1)
        VitalsRuntime.shared.shutdown(dropPending: true, ifCurrent: { true })
        VitalsRuntime.shared.install(controller(), isCurrent: { true })
        XCTAssertEqual(h.id, "p1")
    }
    func testADirectTrackPlayerRefusedForShutdownQueuesInsteadOfReturningAnInertHandle() {
        let c = controller()
        VitalsRuntime.shared.install(c, isCurrent: { true })
        c.shutdown()                                // controller dead but still published
        let i = FakeIntegration()
        let h = VitalsRuntime.shared.trackPlayer(i, name: nil)
        XCTAssertEqual(VitalsRuntime.shared.pendingCountForTesting, 1)
        VitalsRuntime.shared.install(controller(), isCurrent: { true })
        XCTAssertEqual(h.id, "p1")
    }
    func testAKillLandingMidDrainRevokesTheRestOfTheSnapshotInsteadOfAttachingIt() {
        let first = FakeIntegration(), second = FakeIntegration()
        first.onAttach = { [self] in killGen = 1 }
        _ = VitalsRuntime.shared.trackPlayer(first, name: nil); _ = VitalsRuntime.shared.trackPlayer(second, name: nil)
        VitalsRuntime.shared.install(controller(), isCurrent: { true })
        XCTAssertNotNil(first.ctx); XCTAssertNil(second.ctx); XCTAssertEqual(second.detached, 1)
    }
    func testARegistrationCancelledWhileAnEarlierOneIsAttachingReleasesItsIntegration() {
        // Round-9, #1: the drain lifted both entries out of `pending`; a detach() on the second
        // handle fired from inside the first's attach() finds nothing to remove, so the DRAIN
        // must release the second integration when it skips it.
        let first = FakeIntegration(), second = FakeIntegration()
        _ = VitalsRuntime.shared.trackPlayer(first, name: nil)
        let h2 = VitalsRuntime.shared.trackPlayer(second, name: nil)
        first.onAttach = { h2.detach() }
        VitalsRuntime.shared.install(controller(), isCurrent: { true })
        XCTAssertNotNil(first.ctx); XCTAssertNil(second.ctx); XCTAssertEqual(second.detached, 1)
        XCTAssertEqual(VitalsRuntime.shared.pendingCountForTesting, 0)
    }
    func testCurrentStampReadsThroughTheInstalledController() {
        XCTAssertNil(VitalsRuntime.shared.currentStamp())
        VitalsRuntime.shared.install(controller(), isCurrent: { true }); enable()
        XCTAssertEqual(VitalsRuntime.shared.currentStamp()?.sessionId, "sid")
    }

    // MARK: - the remaining VitalsRuntimeTest.kt cases

    /// The other half of round-3 Critical 3: a trackPlayer() made while killed is a fresh
    /// declaration for the NEXT start(), exactly like one made before the very first start().
    func testARegistrationMadeAfterShutdownIsHonouredByTheNextInstall() {
        killGen = 1
        VitalsRuntime.shared.shutdown(dropPending: true, ifCurrent: { true })   // kill()
        let i = FakeIntegration()
        let h = VitalsRuntime.shared.trackPlayer(i, name: nil)
        VitalsRuntime.shared.install(controller(), isCurrent: { true })
        XCTAssertEqual(i.attached, 1)
        XCTAssertEqual(h.id, "p1")
    }

    /// Final review, I4. Scripting the true concurrent interleaving is not reliable; the
    /// invariant that closes the race is sequential and is what is asserted here.
    func testADeferredHandleDetachedBeforeItsDelegateArrivesDetachesTheDelegateInsteadOfStoringIt() {
        let h = DeferredPlayerHandle()
        h.detach()
        XCTAssertTrue(h.detachedEarly)

        let real = CountingHandle(id: "p9")
        h.attachDelegate(real)

        XCTAssertEqual(real.detaches, 1)
        XCTAssertNil(h.delegate)
        XCTAssertEqual(h.id, "")
    }
    private final class CountingHandle: PlayerHandle {
        let id: String
        var detaches = 0
        init(id: String) { self.id = id }
        func track(_ name: String, data: Any?) {}
        func detach() { detaches += 1 }
    }

    /// Round-4, #2's other failure: a stale kill tail must touch neither the controller a
    /// newer start installed nor the gate that start published.
    func testASupersededKillTailNeitherUnpublishesTheLiveControllerNorClearsTheSignal() {
        let c = controller()
        VitalsRuntime.shared.install(c, isCurrent: { true })
        enable()
        XCTAssertTrue(c.isRunning)

        let staleKill: () -> Bool = { false }
        VitalsRuntime.shared.shutdown(dropPending: true, ifCurrent: staleKill)
        VitalsServerConfigBox.shared.publish(nil, ifCurrent: staleKill)

        XCTAssertTrue(VitalsRuntime.shared.current() === c)
        XCTAssertTrue(c.isRunning)
        XCTAssertNotNil(VitalsServerConfigBox.shared.value)
    }

    /// Round-4, #3 — the drain attaches to whatever controller is CURRENT at each step, not to
    /// the one this install published. Made deterministic by superseding B from inside the
    /// FIRST drained entry's attach().
    func testTheDrainAttachesToTheControllerThatIsCurrentNotToTheOneThisInstallPublished() {
        let b = controller(), cc = controller()
        let second = FakeIntegration()
        let first = FakeIntegration()
        first.onAttach = {
            guard VitalsRuntime.shared.current() === b else { return }
            VitalsRuntime.shared.shutdown(dropPending: false, ifCurrent: { true })   // a superseding start()'s boundary
            VitalsRuntime.shared.install(cc, isCurrent: { true })
        }
        let firstHandle = VitalsRuntime.shared.trackPlayer(first, name: "first")
        let secondHandle = VitalsRuntime.shared.trackPlayer(second, name: "second")

        VitalsRuntime.shared.install(b, isCurrent: { true })

        XCTAssertTrue(VitalsRuntime.shared.current() === cc)
        XCTAssertEqual(second.attached, 1)
        // Round-8, #3 — B refused `first` at publication time (it was shut down from inside
        // its own attach()), the drain re-selected C, and `first` attached there, taking p1.
        XCTAssertEqual(first.attached, 2)
        XCTAssertEqual(firstHandle.id, "p1")
        XCTAssertEqual(secondHandle.id, "p2")
    }

    /// Round-8, #3, THE finding: a shutdown refusal is transient and must be retried against
    /// the controller that is current now, never committed as an inert delegate.
    func testARegistrationRefusedByASupersededControllerIsRetriedAgainstTheCurrentOne() {
        let b = controller(), cc = controller()
        let i = FakeIntegration()
        i.onAttach = {
            guard VitalsRuntime.shared.current() === b else { return }
            VitalsRuntime.shared.shutdown(dropPending: false, ifCurrent: { true })
            VitalsRuntime.shared.install(cc, isCurrent: { true })
        }
        let h = VitalsRuntime.shared.trackPlayer(i, name: "main")

        VitalsRuntime.shared.install(b, isCurrent: { true })

        XCTAssertTrue(VitalsRuntime.shared.current() === cc)
        XCTAssertEqual(i.attached, 2)          // B refused for shutdown; C took the registration
        XCTAssertEqual(h.id, "p1")
    }

    /// The other half: nothing is current when the refusal comes back, so the entry goes back
    /// to the queue rather than being consumed.
    func testARegistrationRefusedWithNoControllerLeftIsRequeuedForTheNextStart() {
        let b = controller()
        let i = FakeIntegration()
        i.onAttach = {
            if VitalsRuntime.shared.current() === b { VitalsRuntime.shared.shutdown(dropPending: false, ifCurrent: { true }) }
        }
        let h = VitalsRuntime.shared.trackPlayer(i, name: "main")

        VitalsRuntime.shared.install(b, isCurrent: { true })

        XCTAssertEqual(h.id, "")
        XCTAssertEqual(VitalsRuntime.shared.pendingCountForTesting, 1)

        VitalsRuntime.shared.install(controller(), isCurrent: { true })
        XCTAssertEqual(h.id, "p1")
    }

    /// If nothing is current at all mid-drain, the not-yet-drained entries go back to the
    /// FRONT of the queue so the next install honours them in declaration order.
    func testADrainWithNoControllerLeftRequeuesTheRemainderInDeclarationOrder() {
        let second = FakeIntegration(), third = FakeIntegration()
        let b = controller()
        let first = FakeIntegration()
        first.onAttach = {
            if VitalsRuntime.shared.current() === b { VitalsRuntime.shared.shutdown(dropPending: false, ifCurrent: { true }) }
        }
        let h1 = VitalsRuntime.shared.trackPlayer(first, name: "first")
        let h2 = VitalsRuntime.shared.trackPlayer(second, name: "second")
        let h3 = VitalsRuntime.shared.trackPlayer(third, name: "third")

        VitalsRuntime.shared.install(b, isCurrent: { true })
        XCTAssertEqual(second.attached, 0)
        XCTAssertEqual(third.attached, 0)
        XCTAssertEqual(VitalsRuntime.shared.pendingCountForTesting, 3)

        VitalsRuntime.shared.install(controller(), isCurrent: { true })
        XCTAssertEqual(second.attached, 1)
        XCTAssertEqual(third.attached, 1)
        // Declaration order survived the requeue: ids are minted in drain order.
        XCTAssertEqual(h1.id, "p1"); XCTAssertEqual(h2.id, "p2"); XCTAssertEqual(h3.id, "p3")
    }

    /// Codex round-5, W5-I3 — the requeue must not resurrect an entry cancelled mid-drain. The
    /// drain lifted all three out of `pending`, so `h3.detach()` found nothing to remove and
    /// stood down, leaving the drain to own the teardown; requeueing the remainder wholesale put
    /// the third entry back with its cancellation callback already consumed, so nothing released
    /// its integration until some later install — with `detach()` long since returned.
    func testTheRequeuedRemainderDropsAnEntryCancelledWhileItWasOutOfTheQueue() {
        let first = FakeIntegration(), second = FakeIntegration(), third = FakeIntegration()
        let b = controller()
        let h1 = VitalsRuntime.shared.trackPlayer(first, name: "first")
        let h2 = VitalsRuntime.shared.trackPlayer(second, name: "second")
        let h3 = VitalsRuntime.shared.trackPlayer(third, name: "third")
        // The cancellation targets the LAST entry, so the requeue — not the drain's own
        // `detachedEarly` check, which only ever sees the entry it is standing on — is what has
        // to notice it. The shutdown makes that first entry's attach a refusal, so the whole
        // remainder (`first` included) is what goes back.
        first.onAttach = {
            h3.detach()
            if VitalsRuntime.shared.current() === b { VitalsRuntime.shared.shutdown(dropPending: false, ifCurrent: { true }) }
        }

        VitalsRuntime.shared.install(b, isCurrent: { true })

        XCTAssertEqual(VitalsRuntime.shared.pendingCountForTesting, 2, "the two live entries go back; the cancelled one does not")
        XCTAssertEqual(third.detached, 1, "detach() returned, so the integration is released now — not at some later install")
        XCTAssertEqual(third.attached, 0)

        VitalsRuntime.shared.install(controller(), isCurrent: { true })
        XCTAssertEqual(second.attached, 1)
        XCTAssertEqual(third.attached, 0)
        XCTAssertEqual(third.detached, 1, "and exactly once")
        // Declaration order still survived the requeue for what remained.
        XCTAssertEqual(h1.id, "p1"); XCTAssertEqual(h2.id, "p2"); XCTAssertEqual(h3.id, "")
    }

    /// Round-5, #5 — a pre-start detach() REMOVES its queue entry rather than only marking the
    /// handle, so an app that registers and never starts does not retain every integration.
    func testAPreStartDetachRemovesItsQueueEntryInsteadOfLeavingItInTheProcessWideList() {
        let i = FakeIntegration()
        let h = VitalsRuntime.shared.trackPlayer(i, name: nil)
        XCTAssertEqual(VitalsRuntime.shared.pendingCountForTesting, 1)

        h.detach()

        XCTAssertEqual(VitalsRuntime.shared.pendingCountForTesting, 0)
        XCTAssertEqual(i.detached, 1)          // round-8, #1: and it releases the integration

        VitalsRuntime.shared.install(controller(), isCurrent: { true })
        XCTAssertEqual(i.attached, 0)
        XCTAssertEqual(h.id, "")
    }

    /// Round-8, #1 — revoking a pending registration releases its INTEGRATION, not only its
    /// handle: media3 subscribes a release observer at declaration time.
    func testAPendingRegistrationRevokedByTheKillTailReleasesItsIntegration() {
        let i = FakeIntegration()
        _ = VitalsRuntime.shared.trackPlayer(i, name: nil)
        killGen = 1
        VitalsRuntime.shared.shutdown(dropPending: true, ifCurrent: { true })
        XCTAssertEqual(i.attached, 0)
        XCTAssertEqual(i.detached, 1)
    }

    /// The other half of round-4 #2's partition: whichever of {the kill tail, the next
    /// install} reaches the queue first does the revoking, so both must release.
    func testAPendingRegistrationRevokedByTheNextInstallReleasesItsIntegration() {
        let i = FakeIntegration()
        _ = VitalsRuntime.shared.trackPlayer(i, name: nil)
        killGen = 1
        VitalsRuntime.shared.install(controller(), isCurrent: { true })
        XCTAssertEqual(i.attached, 0)
        XCTAssertEqual(i.detached, 1)
    }

    /// Two owners could run the teardown — the revocation, and the onCancel the deferred
    /// handle fires as the revocation marks it. Whoever LIFTED the entry owns it.
    func testARevokedDeclarationReleasesItsIntegrationExactlyOnce() {
        let i = FakeIntegration()
        _ = VitalsRuntime.shared.trackPlayer(i, name: nil)
        killGen = 1
        VitalsRuntime.shared.shutdown(dropPending: true, ifCurrent: { true })
        XCTAssertEqual(i.detached, 1)
    }

    /// The retry is a LOOP: two superseding starts in a row walk the registration from B to C
    /// to D, and it must arrive rather than be returned unregistered and unqueued.
    func testASecondShutdownRefusalReSelectsAgainRatherThanDroppingTheRegistration() {
        let b = controller(), c2 = controller(), c3 = controller()
        let i = FakeIntegration()
        i.onAttach = {
            let cur = VitalsRuntime.shared.current()
            if cur === b {
                VitalsRuntime.shared.shutdown(dropPending: false, ifCurrent: { true })
                VitalsRuntime.shared.install(c2, isCurrent: { true })
            }
            if cur === c2 {
                VitalsRuntime.shared.shutdown(dropPending: false, ifCurrent: { true })
                VitalsRuntime.shared.install(c3, isCurrent: { true })
            }
        }
        VitalsRuntime.shared.install(b, isCurrent: { true })

        let h = VitalsRuntime.shared.trackPlayer(i, name: "main")

        XCTAssertTrue(VitalsRuntime.shared.current() === c3)
        XCTAssertEqual(i.attached, 3)          // B and C both refused for shutdown; D took it
        XCTAssertEqual(h.id, "p1")
        XCTAssertEqual(VitalsRuntime.shared.pendingCountForTesting, 0)
    }

    /// The termination guard: a controller shut down WITHOUT being unpublished would be
    /// re-selected for ever, so the remainder requeues instead. Bounded on purpose — a test
    /// that hangs is worse than one that fails.
    func testADrainRefusedByTheControllerThatIsStillPublishedRequeuesInsteadOfRetryingIt() {
        let b = controller()
        let i = FakeIntegration()
        i.onAttach = { b.shutdown() }
        let h = VitalsRuntime.shared.trackPlayer(i, name: nil)

        let done = DispatchSemaphore(value: 0)
        DispatchQueue.global().async { VitalsRuntime.shared.install(b, isCurrent: { true }); done.signal() }
        XCTAssertEqual(done.wait(timeout: .now() + 10), .success,
                       "the drain must terminate: a re-selected refusing controller would loop for ever")

        XCTAssertEqual(h.id, "")
        XCTAssertEqual(VitalsRuntime.shared.pendingCountForTesting, 1)
    }

    /// Codex round-4, #2 — a registration whose `attach()` is interrupted by a kill() used to
    /// acquire the NEW kill generation on its retry. Controller A refuses it for shutdown
    /// (transient, so the runtime re-selects), and the re-selection re-read `killGeneration()`:
    /// a player declared against the session the kill is ending therefore queued for the NEXT
    /// one — or was handed straight to a controller already installed for it — and started
    /// collecting there without the customer ever declaring it.
    func testARegistrationWhoseSessionIsKilledMidAttachIsNotCarriedIntoTheNextOne() {
        let a = controller()
        VitalsRuntime.shared.install(a, isCurrent: { true })
        let i = FakeIntegration()
        i.onAttach = { [self] in
            killGen = 1                                                       // the kill bumps…
            a.shutdown()                                                      // …and its tail takes A down
            VitalsRuntime.shared.shutdown(dropPending: true, ifCurrent: { true })
        }
        let h = VitalsRuntime.shared.trackPlayer(i, name: "main")

        XCTAssertEqual(i.attached, 1, "precondition: the attach really did run inside the doomed session")
        XCTAssertEqual(VitalsRuntime.shared.pendingCountForTesting, 0,
                       "a declaration made for a killed session must not queue for the next one")
        XCTAssertEqual(h.id, "")
        // Twice: A's shutdown refusal rolled the attachment back, and the terminal refusal here
        // disposes of what the rollback put back.
        XCTAssertEqual(i.detached, 2, "the integration's declaration-time resources are released")

        VitalsRuntime.shared.install(controller(), isCurrent: { true })
        XCTAssertEqual(h.id, "", "the next session must not adopt it")
        XCTAssertEqual(i.attached, 1, "…nor re-attach it")
    }

    /// Round-6, #2 — the kill generation is read BEFORE install()'s predicate, so a kill
    /// bumping inside that critical section can only ever stamp the controller too OLD, and
    /// too old queues.
    func testAKillBumpingInsideInstallsOwnCriticalSectionCannotStampTheControllerAsLive() {
        let c = controller()
        VitalsRuntime.shared.install(c, isCurrent: { [self] in killGen += 1; return true })

        let i = FakeIntegration()
        let h = VitalsRuntime.shared.trackPlayer(i, name: "main")

        XCTAssertEqual(i.attached, 0)
        XCTAssertEqual(h.id, "")
        XCTAssertEqual(VitalsRuntime.shared.pendingCountForTesting, 1)
    }
}
