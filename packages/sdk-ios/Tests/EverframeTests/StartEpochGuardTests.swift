// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Round-2 review Finding F9 (post killTearsDownReplaySessionSoItsPeriodicLoopStops,
// see KillTeardownTests.swift) — start()'s heavy-init tail awaits
// drainOutbox() before it hops to MainActor and installs a fresh
// `ReplaySession` built from `config`. If `kill()` runs during that await —
// it nils `_replaySession` immediately, synchronously — the still-in-flight
// start() Task used to go on and install a session moments later anyway,
// built from the KILLED config. That stale session's provider/refresh loop
// can later re-arm the global network-body gate off a dead app's config,
// even though the Everframe SDK believes itself killed.
//
// Fixed with a monotonically increasing `startEpoch`, bumped under
// `stateLock` by both start() and kill(). start()'s async tail captures its
// epoch at launch and the MainActor install (session construction +
// assignment + `enableIfConfigured()`) only proceeds if that epoch is still
// current — otherwise the would-be session is discarded without ever
// starting its refresh loop. kill() also cancels the retained start-task
// handle as a belt-and-suspenders defense.
//
// `Everframe.__startTailDelayHookForTesting` parks the async tail right after
// drainOutbox() (an empty local outbox otherwise drains near-instantly,
// making the real race window too narrow to hit deterministically) so this
// test can interleave kill() before releasing it.
#if canImport(UIKit)
import Testing
import Foundation
@testable import EverframeKit

@MainActor
@Suite(.serialized)
struct StartEpochGuardTests {
    private let testAppId = "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"

    // Round-6 review Finding F31: every test in this file drives
    // `Everframe.shared` (start/kill, the async start-tail hook) for real —
    // each is wrapped in `withGlobalCaptureStateLock` so it cannot
    // interleave with any other suite doing the same (see
    // Helpers/GlobalCaptureStateTestLock.swift).
    @Test func killDuringStartsAsyncTailDiscardsTheStaleSessionInstall() async throws {
        try await withGlobalCaptureStateLock {
            defer { Everframe.__resetStartTailDelayHookForTesting() }

            let gate = AsyncGate()
            Everframe.__startTailDelayHookForTesting = {
                await gate.waitUntilOpen()
            }

            let config = EverframeConfig(appId: testAppId, capture: CaptureConfig(logs: false))
            try Everframe.shared.start(config: config)

            // start() must return synchronously (its documented contract) with
            // the async tail now parked inside the hook — before it has reached
            // the MainActor install. kill() races it right here, mid-tail.
            Everframe.shared.kill()

            // Release the parked tail so it can (attempt to) proceed to the
            // MainActor install.
            await gate.open()

            // Give the released tail's MainActor hop time to actually run —
            // long enough that an unguarded install would have landed.
            try? await Task.sleep(nanoseconds: 200_000_000)

            #expect(
                !Everframe.__hasReplaySessionForTesting,
                "kill() during start()'s async tail must discard the stale ReplaySession install, not let it land after kill()"
            )

            // Clean slate for any tests that run after this one in the suite.
            try Everframe.shared.start(config: config)
            Everframe.shared.kill()
        }
    }

    @Test func startAfterTheRacedKillStillInstallsItsOwnSessionNormally() async throws {
        try await withGlobalCaptureStateLock {
            defer { Everframe.__resetStartTailDelayHookForTesting() }

            let gate = AsyncGate()
            Everframe.__startTailDelayHookForTesting = {
                await gate.waitUntilOpen()
            }

            let config = EverframeConfig(appId: testAppId, capture: CaptureConfig(logs: false))
            try Everframe.shared.start(config: config)
            Everframe.shared.kill()
            await gate.open()
            try? await Task.sleep(nanoseconds: 200_000_000)
            #expect(!Everframe.__hasReplaySessionForTesting)

            // A later, LEGITIMATE start() (its own fresh epoch, no delay hook
            // this time) must still be able to install its own session — the
            // epoch guard must not permanently wedge the Everframe SDK shut.
            Everframe.__resetStartTailDelayHookForTesting()
            try Everframe.shared.start(config: config)
            let armed = await AsyncTestHelpers.waitFor({ Everframe.__hasReplaySessionForTesting })
            #expect(armed, "a later legitimate start() must still be able to install its session")

            Everframe.shared.kill()
        }
    }
}

/// A tiny actor gate so the test can park start()'s async tail
/// deterministically (rather than relying on a fixed guessed sleep) and
/// then release it after racing kill() against it.
private actor AsyncGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func open() {
        isOpen = true
        let pending = waiters
        waiters.removeAll()
        pending.forEach { $0.resume() }
    }

    func waitUntilOpen() async {
        if isOpen { return }
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            waiters.append(cont)
        }
    }
}
#endif
