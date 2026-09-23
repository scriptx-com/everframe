// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Round-6 review Finding F31: Swift Testing parallelizes DIFFERENT `@Suite`
// types by default. `.serialized` on a suite only serializes tests WITHIN
// that suite — it does nothing at all for tests in a sibling suite scheduled
// concurrently (this is documented Swift Testing behavior: the trait's
// effect is scoped to the suite it's attached to, plus any suite genuinely
// NESTED inside it in source). Every lifecycle suite added for native
// network-body capture (SessionBoundaryResetTests,
// ReplaySessionSupersessionTests, ReplaySessionTeardownRaceTests,
// ReplaySessionRefreshLoopTests, StartEpochGuardTests, StartEpochApplyRaceTests,
// KillTeardownTests, NetworkBodyCaptureTests, NetworkBodyEnvelopeTests,
// NetworkBodyRingBufferTests, NetworkRingBufferTests) drives the SAME process-global `Everframe.shared`
// singleton (start()/kill(), its replay session, its start epoch) and/or
// `NetworkBodyCaptureGate.shared` / `NetworkBodyRingBuffer.shared`. Two of
// these suites' tests running concurrently on separate Tasks can genuinely
// corrupt each other mid-test — e.g. suite A's `start()` install racing
// suite B's `kill()` on the SAME singleton — reproduced pre-fix by running
// e.g. StartEpochGuardTests + ReplaySessionSupersessionTests +
// ReplaySessionRefreshLoopTests together in one `xcodebuild test`
// invocation: "session A's initial fetch never started", "session B was
// never installed by the superseding start()", etc. — all spurious, and all
// gone once every test in this file's domain is mutually exclusive.
//
// This is a fundamentally different failure mode than the brief-critical-
// section races `Helpers/BreadcrumbSharedStateTestLock.swift` guards
// against: these lifecycle tests hold their critical section across
// `await`s (parked fetches via `AsyncGate`, `Task.sleep`, MainActor hops)
// for their ENTIRE body, not just a quick synchronous reset+read. A plain
// `NSLock` held across a suspension point is a real deadlock risk once more
// concurrently-scheduled tests exist than the cooperative thread pool has
// threads (Task A suspends mid-await while holding the lock; Task B, on
// another pool thread, blocks synchronously in `NSLock.lock()`; if enough
// Tasks pile up like this the pool can wedge with no thread free to resume
// Task A). `GlobalCaptureStateTestGate` is therefore an ACTOR-based async
// mutex — waiters suspend cleanly instead of blocking a thread.
//
// Every `@Test` in the suites listed above wraps its ENTIRE body in
// `await withGlobalCaptureStateLock { ... }` as the very first thing it
// does, before touching `Everframe.shared`, `NetworkBodyCaptureGate.shared`,
// or `NetworkBodyRingBuffer.shared` at all. That makes at most one such test
// run at a time, across ALL of those suites, in any xcodebuild/swift-test
// invocation, no matter how many suites Swift Testing schedules
// concurrently. Combined with `resetGlobalCaptureStateForTesting()` (run
// both immediately before AND immediately after `operation`) this also
// gives every test a clean, deterministic slate regardless of what a
// previous test — in ANY suite sharing this gate — left behind, and
// guarantees nothing it does leaks forward either.
//
// Deliberately NOT `#if canImport(UIKit)`-gated: several of the suites that
// share this gate (NetworkBodyCaptureTests, NetworkBodyEnvelopeTests,
// NetworkBodyRingBufferTests, NetworkRingBufferTests) compile and run on the
// macOS host too (`swift test`), so this helper must be available there as
// well — every symbol it touches (`Everframe.shared.kill()`,
// `NetworkBodyCaptureGate.shared`, `NetworkBodyRingBuffer.shared`) is
// itself unconditionally available (not UIKit-only).
import Foundation
@testable import EverframeKit

/// Actor-based async mutex serializing every test, across every suite, that
/// touches `Everframe.shared` / `NetworkBodyCaptureGate.shared` /
/// `NetworkBodyRingBuffer.shared`. See file header for why this can't be a
/// plain `NSLock` the way `BreadcrumbSharedStateTestLock` is.
actor GlobalCaptureStateTestGate {
    static let shared = GlobalCaptureStateTestGate()

    private var isLocked = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    private init() {}

    /// Suspends until this gate is free, then claims it. Fair (FIFO): a
    /// waiter is only ever resumed once the previous holder calls
    /// `release()`, in arrival order.
    func acquire() async {
        if !isLocked {
            isLocked = true
            return
        }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            waiters.append(continuation)
        }
    }

    /// Releases the gate, either handing it directly to the next waiter (so
    /// there is never a window where the gate reads as free while a waiter
    /// is still queued) or marking it free if none are waiting.
    func release() {
        guard !waiters.isEmpty else {
            isLocked = false
            return
        }
        let next = waiters.removeFirst()
        // `isLocked` stays true — ownership transfers straight to `next`.
        next.resume()
    }
}

/// Resets every piece of process-global state the lifecycle suites share:
/// `Everframe.shared` itself (`kill()` — nils the replay session, flips the
/// capture gate off, bumps the start epoch, zeroizes the breadcrumb/network/
/// network-body ring buffers), then `NetworkBodyCaptureGate.shared`
/// (deactivate + clear the sticky sampling draw — `kill()` already does
/// this via `.reset()`, `resetForTesting()` is the same call under a
/// test-readable name) and `NetworkBodyRingBuffer.shared` (belt-and-
/// suspenders — `kill()` already clears it too). Safe to call unconditionally,
/// including when nothing was ever `start()`-ed: `Everframe.kill()` is
/// documented idempotent/safe pre-start.
///
/// `async`, and (on platforms with a replay session — `#if canImport(UIKit)`)
/// waits for `kill()`'s own `Task { @MainActor in ... }` replay-session
/// teardown hop to actually land before returning. `kill()` fires that hop
/// and returns immediately WITHOUT waiting for it; without waiting for it
/// here too, that leftover Task and the next test's own `start()` tail both
/// end up competing for MainActor scheduling turns, which was observed to
/// occasionally push `ReplaySessionSupersessionTests`'
/// `AsyncTestHelpers.waitFor`-bounded install checks (1s default timeout)
/// past their margin under load — spurious "session B was never installed"
/// failures with no code defect behind them. Waiting here, once, before the
/// next test's body ever starts, removes that stray competing Task instead
/// of just hoping every consumer's timeout is generous enough.
@MainActor
func resetGlobalCaptureStateForTesting() async {
    Everframe.shared.kill()
    // Session Vitals: `kill()` tears the runtime down only for the epoch it just
    // established, and leaves the killGeneration test seam (if a suite installed one) in
    // place — so the shared reset has to zeroize both boxes unconditionally too.
    VitalsRuntime.shared.resetForTesting()
    VitalsServerConfigBox.shared.resetForTesting()
    #if canImport(UIKit)
    _ = await AsyncTestHelpers.waitFor({ !Everframe.__hasReplaySessionForTesting })
    #endif
    NetworkBodyCaptureGate.shared.resetForTesting()
    NetworkBodyRingBuffer.shared.clear()
}

/// Runs `operation` as the only holder of `GlobalCaptureStateTestGate`,
/// across every suite that opts into this gate, for its entire (possibly
/// `await`-laden) duration — see file header. Resets all shared capture
/// state immediately before AND after `operation` so ordering relative to
/// whichever test ran previously (in this suite or another) can never leak
/// in either direction, regardless of whether `operation` throws.
@MainActor
func withGlobalCaptureStateLock<T>(
    _ operation: @MainActor () async throws -> T
) async rethrows -> T {
    await GlobalCaptureStateTestGate.shared.acquire()
    await resetGlobalCaptureStateForTesting()
    do {
        let result = try await operation()
        await resetGlobalCaptureStateForTesting()
        await GlobalCaptureStateTestGate.shared.release()
        return result
    } catch {
        await resetGlobalCaptureStateForTesting()
        await GlobalCaptureStateTestGate.shared.release()
        throw error
    }
}
