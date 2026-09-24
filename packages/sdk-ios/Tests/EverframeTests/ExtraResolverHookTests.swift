// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Spec 2026-09-17 setExtra-resolver — iOS core half of the RN ask-and-wait
// round trip. `Everframe.__pendingExtraResolveHook` is the seam
// `__consumePendingAttachments()` awaits right before it drains pending
// attachments; the RN bridge (`EverframeBridge.configure`) installs a real
// implementation there. This file tests the CORE contract directly, with a
// fake hook standing in for the RN implementation — mirrors
// `packages/sdk-android/.../ExtraResolverHookTest.kt` exactly:
//
//   1. No hook installed → drains exactly as before this feature landed.
//   2. A hook that updates the pending extra before returning → the drained
//      value reflects that update (a resolver "answered in time").
//   3. The hook type is non-throwing (`() async -> Void`) — "fail open"
//      holds BY CONSTRUCTION, there is no throw path to swallow.
//   4. A hook that never resumes its own continuation, but is itself
//      bounded by a scheduled fallback (mirroring
//      `CompanionCaptureBridge.awaitJsReactTreeAttach`'s exact shape) →
//      `__consumePendingAttachments()` still returns promptly.
import Testing
import Foundation
@testable import EverframeKit

/// A one-shot async gate: `wait()` suspends until `open()` is called.
/// Stands in for JS's `signalExtraResolverReady` ack inside a fake hook, so
/// finding F5's concurrency tests can control exactly when each of two
/// racing hook invocations is allowed to proceed — mirrors
/// `ExtraResolverHookTest.kt`'s `CompletableDeferred` usage.
private actor ExtraResolverTestGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func open() {
        isOpen = true
        let toResume = waiters
        waiters.removeAll()
        for w in toResume { w.resume() }
    }

    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            waiters.append(cont)
        }
    }
}

/// Actor-guarded event log + call counter for the same tests — plain
/// `var`s would be a data race across the two concurrently-running hook
/// invocations these tests deliberately create.
private actor ExtraResolverTestRecorder {
    private(set) var events: [String] = []
    private var callCount = 0

    func nextCallIndex() -> Int {
        callCount += 1
        return callCount
    }

    func record(_ event: String) {
        events.append(event)
    }
}

/// Polls `condition` until it's true or `timeout` elapses, instead of a
/// fixed sleep — keeps these tests fast in the common case while staying
/// robust on a slow CI machine. No virtual-time test scheduler is set up
/// for this package (unlike the Kotlin twin's `runTest`), so real
/// wall-clock polling is this file's existing style (see
/// `hookThatNeverResumesButBoundsItself_stillLetsConsumeReturnPromptly`'s
/// own `Date()`-based elapsed check below).
private func waitUntil(
    timeout: TimeInterval = 2.0,
    _ condition: () async -> Bool
) async {
    let deadline = Date().addingTimeInterval(timeout)
    while await !condition(), Date() < deadline {
        try? await Task.sleep(nanoseconds: 2_000_000)
    }
}

@Suite(.serialized)
final class ExtraResolverHookTests {

    init() {
        Everframe.__pendingExtraResolveHook = nil
        Everframe.shared.clearExtra()
    }

    deinit {
        Everframe.__pendingExtraResolveHook = nil
        Everframe.shared.clearExtra()
    }

    @Test func noHookInstalled_drainsPendingExtraExactlyAsBeforeThisFeature() async {
        Everframe.__pendingExtraResolveHook = nil
        Everframe.shared.setExtra("pre-existing value")

        let (extra, _) = await Everframe.shared.__consumePendingAttachments()

        #expect(extra == "pre-existing value")
    }

    @Test func hookThatAnswersInTime_updatesTheDrainedValue() async {
        Everframe.shared.setExtra("stale")
        Everframe.__pendingExtraResolveHook = {
            // Mirrors what the RN implementation does when JS answers: push
            // a fresh value through the ordinary setExtra() entry point
            // BEFORE the hook returns.
            Everframe.shared.setExtra("fresh from resolver")
        }

        let (extra, _) = await Everframe.shared.__consumePendingAttachments()

        #expect(extra == "fresh from resolver")
    }

    @Test func nonThrowingHookType_makesFailOpenHoldByConstruction() async {
        // The hook type is `() async -> Void` (non-throwing) precisely so
        // "fail open" holds BY CONSTRUCTION — there is no throw path for
        // `__consumePendingAttachments()` to swallow. A hook representing
        // JS having already failed open on its own side (a throwing
        // resolver, budgeted+caught, empty string pushed) still has nothing
        // to propagate here.
        Everframe.shared.setExtra("still ships")
        Everframe.__pendingExtraResolveHook = {
            // Intentionally empty — represents "JS answered with nothing to
            // push" (already-omitted extra), the same shape a fail-open
            // outcome takes on the JS side.
        }

        let (extra, _) = await Everframe.shared.__consumePendingAttachments()

        #expect(extra == "still ships")
    }

    @Test func hookThatNeverResumesButBoundsItself_stillLetsConsumeReturnPromptly() async {
        Everframe.shared.setExtra("unchanged — JS never answered")
        Everframe.__pendingExtraResolveHook = {
            // Mirrors `CompanionCaptureBridge.awaitJsReactTreeAttach`'s
            // exact shape: a continuation resumed only by a scheduled
            // fallback timer, standing in for "JS never calls back" — much
            // shorter bound here so the test stays fast.
            await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
                DispatchQueue.global().asyncAfter(deadline: .now() + 0.02) {
                    cont.resume()
                }
            }
        }

        let start = Date()
        let (extra, _) = await Everframe.shared.__consumePendingAttachments()
        let elapsed = Date().timeIntervalSince(start)

        // The wait honoured its own bound — the hook returned instead of
        // hanging — and the report proceeds with the last pushed value.
        #expect(extra == "unchanged — JS never answered")
        #expect(elapsed < 1.0, "the wait must honour its own bound, not hang")
    }

    @Test func consumeStillClearsPendingStateExactlyOnceRegardlessOfTheHook() async {
        Everframe.shared.setExtra("only once")
        Everframe.__pendingExtraResolveHook = nil

        let (first, _) = await Everframe.shared.__consumePendingAttachments()
        let (second, _) = await Everframe.shared.__consumePendingAttachments()

        #expect(first == "only once")
        #expect(second == nil)
    }

    // ---------------- Finding F5 — concurrent ask-and-wait + drain ----------------
    //
    // `consumeStillClearsPendingStateExactlyOnceRegardlessOfTheHook` above
    // sets the hook to nil and drains SEQUENTIALLY — the await is never in
    // play, so it proves nothing about two reports racing a REAL suspending
    // hook. The reachable interleaving: reports A and B both suspend in the
    // hook → JS answers A (`setExtra(X)`) then B (`setExtra(Y)`, overwriting
    // X) → without serialization, whichever drains first gets Y (not X) and
    // the other gets nil. `Everframe.__consumePendingAttachments()`'s
    // `extraResolveSerializer` (an `actor`) fixes this by construction: at
    // most one ask-and-wait + drain sequence is ever in flight, so B's hook
    // cannot even START until A's drain has completed and released it.
    // These tests exercise that directly with real concurrent `Task`s and a
    // real suspending hook — not a fake sequential drain.

    @Test
    func twoConcurrentConsumeCallsAreSerialized_BsHookDoesNotStartUntilAsWholeAskAndWaitAndDrainFinish() async {
        let recorder = ExtraResolverTestRecorder()
        let gateA = ExtraResolverTestGate()
        let gateB = ExtraResolverTestGate()

        Everframe.shared.setExtra("stale")
        Everframe.__pendingExtraResolveHook = {
            let index = await recorder.nextCallIndex()
            await recorder.record("enter-\(index)")
            if index == 1 {
                await gateA.wait()
                Everframe.shared.setExtra("from A")
            } else {
                await gateB.wait()
                Everframe.shared.setExtra("from B")
            }
            await recorder.record("exit-\(index)")
        }

        let taskA = Task { await Everframe.shared.__consumePendingAttachments() }

        // Task creation order is not execution order. Wait until A has
        // actually entered the hook before starting B so the values below
        // describe the named tasks rather than whichever task the executor
        // happened to schedule first.
        await waitUntil { await recorder.events.count >= 1 }
        let taskB = Task { await Everframe.shared.__consumePendingAttachments() }

        // Let B run as far as it can WITHOUT JS answering A yet. If the two
        // calls were NOT serialized, B's hook would already have entered
        // here (both would suspend inside the hook concurrently, which is
        // exactly the race this fix closes).
        var midEvents = await recorder.events
        #expect(midEvents == ["enter-1"], "B's hook must not start while A's ask-and-wait + drain is still in flight")

        // JS answers A. A's hook returns, A drains (reading "from A" — the
        // value ITS OWN call caused JS to push), and only THEN does the
        // serializer let B's hook start.
        await gateA.open()
        await waitUntil { await recorder.events.count >= 3 }
        midEvents = await recorder.events
        #expect(
            midEvents == ["enter-1", "exit-1", "enter-2"],
            "A must finish (hook return + drain) before B's hook starts",
        )

        // JS answers B.
        await gateB.open()
        let (extraA, _) = await taskA.value
        let (extraB, _) = await taskB.value

        // Each call drains exactly the value ITS OWN resolve round trip
        // caused JS to push — not the other call's, and not nil. Before the
        // serializer fix, this is where B's overwrite of `_pendingExtra`
        // (before A's drain read it) could make A observe "from B" instead
        // of "from A", or make B observe nil because A already cleared the
        // slot.
        #expect(extraA == "from A")
        #expect(extraB == "from B")
    }

    @Test
    func aSlowHookDoesNotBlockReportBFromEventuallyShipping_itJustSerializesAfterA() async {
        let gateA = ExtraResolverTestGate()
        let recorder = ExtraResolverTestRecorder()

        Everframe.__pendingExtraResolveHook = {
            let index = await recorder.nextCallIndex()
            if index == 1 {
                await gateA.wait()
                Everframe.shared.setExtra("A's value")
            } else {
                Everframe.shared.setExtra("B's value")
            }
        }

        let taskA = Task { await Everframe.shared.__consumePendingAttachments() }
        let taskB = Task { await Everframe.shared.__consumePendingAttachments() }

        await gateA.open()
        let (extraA, _) = await taskA.value
        let (extraB, _) = await taskB.value

        #expect(extraA == "A's value")
        #expect(extraB == "B's value")
    }
}
