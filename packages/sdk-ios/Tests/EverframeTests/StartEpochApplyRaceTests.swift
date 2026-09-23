// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Round-8 review Finding F39 (P1): the SAME defect shape F26/F27 fixed for
// `ReplaySession`/`Everframe` elsewhere was left open at the network-body
// gate's own apply boundary.
//
// Window (a): `refreshConfigNow()`'s `guard Everframe.shared.currentStartEpoch
// == startEpochAtCreation` (F27) is a ONE-OFF check, evaluated once, well
// before the `NetworkBodyCaptureGate.shared.applyConfig(...)` call that
// follows it. `@MainActor` only serializes THIS session's own actor work —
// `Everframe.start()`/`kill()` are synchronous, NON-actor-isolated public
// methods that may run on a background thread. So a superseding `start(B)`
// can land in the real gap between the check passing and the apply actually
// landing, and the stale apply re-arms the gate off session A's config
// anyway. Fixed by giving `applyConfig` a `guard` closure (mirrors
// `NetworkBodyRingBuffer.append(_:guard:)`'s F34 guard and Android's
// `NetworkBodyCaptureState.applyConfig`'s F26 guard for this exact method),
// evaluated FRESH, INSIDE the gate's own lock, immediately before the
// mutation.
//
// Window (b): `start()` used to call `NetworkBodyCaptureGate.shared.reset()`
// BEFORE acquiring `stateLock` to bump `_startEpoch` — so a reader's epoch
// check could observe the OLD epoch (matching its own) even though the
// reset it's about to stomp on had ALREADY run. Fixed by bumping the epoch
// FIRST (its own short `stateLock` acquisition), then resetting the gate —
// see `Everframe.start()`'s doc comment for why this is two short, un-nested
// acquisitions rather than one spanning both (avoiding an AB-BA deadlock
// against window (a)'s new guard, which reads `stateLock` from INSIDE the
// gate's own lock).
//
// Belongs to the same `Everframe.shared` / `NetworkBodyCaptureGate.shared` /
// `NetworkBodyRingBuffer.shared` domain as SessionBoundaryResetTests.swift,
// StartEpochGuardTests.swift, ReplaySessionTeardownRaceTests.swift, etc. —
// every test below is wrapped in `withGlobalCaptureStateLock` (Round-6
// review Finding F31) for the same reason those files are.
#if canImport(UIKit)
import Testing
import Foundation
@testable import EverframeKit

@MainActor
@Suite(.serialized)
struct StartEpochApplyRaceTests {
    private let appA = "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"
    private let appB = "txx_live_AnotherAppBBBBBBBBBBBBBBBBBBBBBB"

    // ==================== Window (a) ====================

    /// Reviewer's exact repro: park session A's `refreshConfigNow()` between
    /// its (already-passed) epoch check and the `NetworkBodyCaptureGate
    /// .applyConfig(...)` call that follows it, run a superseding `start(B)`
    /// FROM A REAL BACKGROUND THREAD (the case `@MainActor` does NOT cover —
    /// `start()`/`kill()` are synchronous, non-actor-isolated), then release
    /// A. A's apply must not be allowed to land — `applyConfig`'s `guard`
    /// closure re-reads `currentStartEpoch` fresh, inside the gate's own
    /// lock, and must see B's already-bumped epoch regardless of how much
    /// earlier A's own one-off check happened to pass.
    @Test func aParkedBetweenItsEpochCheckAndTheApplyCannotArmTheGateAfterStartBOnABackgroundThread() async throws {
      try await withGlobalCaptureStateLock {
        let captureConfig = CaptureConfig(logs: false, network: true)
        try Everframe.shared.start(config: EverframeConfig(appId: appA, capture: captureConfig))
        let epochAtACreation = Everframe.shared.currentStartEpoch

        let onBody = Data(#"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "networkBodies":{"captureBodies":true}}
            """#.utf8)
        let providerA = ReplayConfigProvider(
            configUrl: URL(string: "https://x/api/config")!,
            apiKey: "a",
            fetcher: ImmediateFetcher(body: onBody),
            ttlSec: 300,
            now: { 0 }
        )
        // Standalone session A, never installed as `_replaySession` — same
        // isolation technique as SessionBoundaryResetTests.swift's F27 spec,
        // so the ONLY mechanism that can stop A's stale apply is the thing
        // under test here (window (a)'s fresh in-lock guard), not A's own
        // (never-invoked) `teardown()`.
        let sessionA = ReplaySession(provider: providerA, locallyDisabled: false, startEpoch: epochAtACreation)

        let hookGate = AsyncGate()
        var hookReached = false
        sessionA.preApplyHookForTesting = {
            hookReached = true
            await hookGate.waitUntilOpen()
        }

        // A's fetch/decode and its (currently-valid) epoch check all run to
        // completion unblocked — it parks only at the NEW hook, immediately
        // before the applyConfig call.
        let refreshTaskA = Task { await sessionA.refreshConfigNow() }
        let reachedHook = await AsyncTestHelpers.waitFor({ hookReached })
        #expect(reachedHook, "session A never reached the pre-apply hook — test setup is wrong, not exercising the race")

        // Run the superseding start(B) from a REAL background thread —
        // `@MainActor` isolation on `ReplaySession` does nothing to serialize
        // against this, since `start()` itself is synchronous and NOT
        // actor-isolated.
        let bThread = Thread {
            try? Everframe.shared.start(config: EverframeConfig(appId: appB, capture: captureConfig))
        }
        bThread.start()

        let bEpochBumped = await AsyncTestHelpers.waitFor({ Everframe.shared.currentStartEpoch != epochAtACreation })
        #expect(bEpochBumped, "start(B) on the background thread never bumped the global start epoch")
        // `Thread` has no `join()` — give the background thread's `start()`
        // call (already confirmed via the epoch-bump poll above) a brief
        // moment to fully return before proceeding, same rationale as the
        // other lifecycle specs' small fixed waits after a confirmed signal.
        try? await Task.sleep(nanoseconds: 50_000_000)

        // Only NOW release session A's parked apply — after B has already
        // fully superseded it, synchronously, on another thread.
        await hookGate.open()
        await refreshTaskA.value

        #expect(
            !NetworkBodyCaptureGate.shared.isActive,
            """
            session A's apply, parked between its (already-passed) epoch check and the mutation while \
            start(B) ran on a background thread, must not be allowed to arm the process-global body gate — \
            applyConfig's guard must re-validate the epoch FRESH, inside its own lock, not trust A's earlier check
            """
        )
      }
    }

    // ==================== Window (a), identity flag ====================

    /// Independent review, round 11, P1(b) — the IDENTICAL window (a) shape
    /// as the test above, now proven against `_identityEnabledFlag`
    /// specifically. Round 4 (Serious 3) introduced the flag as a
    /// synchronous mirror of the MainActor-isolated live config, but its
    /// own write at the end of `refreshConfigNow()` relied on the SAME
    /// one-off epoch check `NetworkBodyCaptureGate.applyConfig` used to rely
    /// on before window (a) closed it there — this flag's own write was
    /// left behind, unguarded, one call later in the same function. Same
    /// repro shape (park at the shared `preApplyHookForTesting` seam, race a
    /// superseding `start(B)` in from a real background thread, release),
    /// same fix shape (`IdentityEnabledFlag.set(_:guard:)`, mirroring
    /// `applyConfig`'s own `guard` parameter exactly, per the coordinator's
    /// explicit "look at that gate and follow it" instruction).
    @Test func aParkedBetweenItsEpochCheckAndTheIdentityFlagWriteCannotReEnableIdentityAfterStartBOnABackgroundThread() async throws {
      try await withGlobalCaptureStateLock {
        let captureConfig = CaptureConfig(logs: false, network: true)
        try Everframe.shared.start(config: EverframeConfig(appId: appA, capture: captureConfig))
        let epochAtACreation = Everframe.shared.currentStartEpoch

        let onBody = Data(#"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "identity":{"enabled":true}}
            """#.utf8)
        let providerA = ReplayConfigProvider(
            configUrl: URL(string: "https://x/api/config")!,
            apiKey: "a",
            fetcher: ImmediateFetcher(body: onBody),
            ttlSec: 300,
            now: { 0 }
        )
        // Standalone session A, never installed as `_replaySession` — same
        // isolation technique as the window (a) test above, so the ONLY
        // mechanism that can stop A's stale write is the thing under test
        // here (`IdentityEnabledFlag.set`'s new fresh in-lock guard), not
        // A's own (never-invoked) `teardown()`.
        let sessionA = ReplaySession(provider: providerA, locallyDisabled: false, startEpoch: epochAtACreation)

        let hookGate = AsyncGate()
        var hookReached = false
        sessionA.preApplyHookForTesting = {
            hookReached = true
            await hookGate.waitUntilOpen()
        }

        // A's fetch/decode and its (currently-valid) epoch check all run to
        // completion unblocked — it parks only at the hook, immediately
        // before BOTH applies that follow it, including the identity flag
        // write under test here.
        let refreshTaskA = Task { await sessionA.refreshConfigNow() }
        let reachedHook = await AsyncTestHelpers.waitFor({ hookReached })
        #expect(reachedHook, "session A never reached the pre-apply hook — test setup is wrong, not exercising the race")

        // Run the superseding start(B) from a REAL background thread —
        // `@MainActor` isolation on `ReplaySession` does nothing to
        // serialize against this, since `start()` itself is synchronous and
        // NOT actor-isolated. `start(B)`'s own unconditional
        // `_identityEnabledFlag.set(false)` (inside its own `stateLock`
        // section) runs as part of this call, synchronously, before this
        // thread returns.
        let bThread = Thread {
            try? Everframe.shared.start(config: EverframeConfig(appId: appB, capture: captureConfig))
        }
        bThread.start()

        let bEpochBumped = await AsyncTestHelpers.waitFor({ Everframe.shared.currentStartEpoch != epochAtACreation })
        #expect(bEpochBumped, "start(B) on the background thread never bumped the global start epoch")
        try? await Task.sleep(nanoseconds: 50_000_000)

        // Only NOW release session A's parked apply — after B has already
        // fully superseded it (epoch bumped, flag reset to false by B's own
        // start()), synchronously, on another thread.
        await hookGate.open()
        await refreshTaskA.value

        #expect(
            !Everframe.shared._identityEnabledFlag.get(),
            """
            session A's identity-flag write, parked between its (already-passed) epoch check and the \
            mutation while start(B) ran on a background thread, must not be allowed to re-enable identity \
            for a session it no longer belongs to — IdentityEnabledFlag.set's guard must re-validate the \
            epoch FRESH, inside its own lock, not trust A's earlier check
            """
        )
      }
    }

    // ==================== Window (a), companion badge box ====================

    /// Codex round-2 fix — same window (a) shape as the two tests above, now
    /// proven against `CompanionBadgeServerConfigBox` specifically, with
    /// `kill()` (not a superseding `start(B)`) as the racing event.
    /// `kill()` clears the box, but only from an async `Task { @MainActor
    /// in ... }` dispatched after its synchronous section returns (mirrors
    /// `start()`'s session-boundary reset, which — unlike this one — runs
    /// synchronously). Without a fresh in-lock-style recheck immediately
    /// before `refreshConfigNow()`'s box write, a fetch parked at
    /// `preApplyHookForTesting` between its (already-passed)
    /// `currentStartEpoch` check and that write can resume AFTER kill()'s
    /// async clear has already landed and resurrect the stale override,
    /// with no live session left to overwrite it again.
    @Test func aParkedBetweenItsEpochCheckAndTheBadgeBoxWriteCannotResurrectTheOverrideAfterKill() async throws {
      try await withGlobalCaptureStateLock {
        let captureConfig = CaptureConfig(logs: false, network: true)
        try Everframe.shared.start(config: EverframeConfig(appId: appA, capture: captureConfig))
        let epochAtACreation = Everframe.shared.currentStartEpoch
        CompanionBadgeServerConfigBox.shared.value = nil
        defer { CompanionBadgeServerConfigBox.shared.value = nil }
        // Branding (iOS spec 2026-08-26) — same parked-continuation hazard,
        // same guard, proven against BrandingServerConfigBox alongside its
        // companion sibling above.
        BrandingServerConfigBox.shared.value = nil
        defer { BrandingServerConfigBox.shared.value = nil }

        let onBody = Data(#"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "companionBadge":{"enabled":true,"position":"top-left"},
            "branding":{"watermark":false}}
            """#.utf8)
        let providerA = ReplayConfigProvider(
            configUrl: URL(string: "https://x/api/config")!,
            apiKey: "a",
            fetcher: ImmediateFetcher(body: onBody),
            ttlSec: 300,
            now: { 0 }
        )
        // Standalone session A, never installed as `_replaySession` — same
        // isolation technique as the window (a) tests above, so the ONLY
        // mechanism that can stop A's stale write is the thing under test
        // here (the box write's new fresh recheck), not A's own
        // (never-invoked) `teardown()`, and not `kill()`'s async clear
        // racing it by luck.
        let sessionA = ReplaySession(provider: providerA, locallyDisabled: false, startEpoch: epochAtACreation)

        let hookGate = AsyncGate()
        var hookReached = false
        sessionA.preApplyHookForTesting = {
            hookReached = true
            await hookGate.waitUntilOpen()
        }

        // A's fetch/decode and its (currently-valid) `currentStartEpoch`
        // check all run to completion unblocked — it parks only at the
        // hook, immediately before the badge box write under test here.
        let refreshTaskA = Task { await sessionA.refreshConfigNow() }
        let reachedHook = await AsyncTestHelpers.waitFor({ hookReached })
        #expect(reachedHook, "session A never reached the pre-apply hook — test setup is wrong, not exercising the race")

        // kill() bumps the global start epoch synchronously, then
        // dispatches its box-clear async on the MainActor. Poll until that
        // clear has actually landed (box back to nil) before releasing A —
        // this is what deterministically puts A's release on the LATE side
        // of kill()'s clear, exactly the window the fix brief describes,
        // rather than leaving it to luck.
        Everframe.shared.kill()
        let killClearLanded = await AsyncTestHelpers.waitFor({ CompanionBadgeServerConfigBox.shared.value == nil })
        #expect(killClearLanded, "kill()'s async badge-box clear never landed — test setup is wrong, not exercising the race")

        // Only NOW release session A's parked write — after kill()'s clear
        // has already fully landed.
        await hookGate.open()
        await refreshTaskA.value

        #expect(
            CompanionBadgeServerConfigBox.shared.value == nil,
            """
            session A's badge-box write, parked between its (already-passed) currentStartEpoch check and the \
            mutation while kill() landed its async clear, must not be allowed to resurrect the stale override — \
            the write must re-validate the epoch FRESH immediately before writing, not trust A's earlier check
            """
        )
        #expect(
            BrandingServerConfigBox.shared.value == nil,
            """
            session A's branding-box write, parked between its (already-passed) currentStartEpoch check and the \
            mutation while kill() landed its async clear, must not be allowed to resurrect the stale override — \
            the write must re-validate the epoch FRESH immediately before writing, not trust A's earlier check, \
            same guard as the companion badge box write above
            """
        )

        try Everframe.shared.start(config: EverframeConfig(appId: appA, capture: captureConfig))
      }
    }

    // ==================== Window (a), success path ====================

    /// Review fix (round after Task 3 review): the race test above only
    /// proves the epoch guard BLOCKS a superseded write — nothing anywhere
    /// proved the ordinary, non-superseded write actually LANDS. No parking,
    /// no superseding `start(B)`/`kill()`: the guard's `currentStartEpoch`
    /// check simply passes, exactly as it does on every normal refresh, and
    /// both the companion-badge and branding blocks must land in their
    /// server boxes. `latest.branding` (ReplaySession.swift, directly under
    /// the companion write) is trivially correct by inspection, but the
    /// brief's own instruction was that this must exist as a regression
    /// lock, not merely be true by reading the diff.
    @Test func aNonSupersededApplyPublishesBothTheCompanionBadgeAndBrandingBoxes() async throws {
      try await withGlobalCaptureStateLock {
        let captureConfig = CaptureConfig(logs: false, network: true)
        try Everframe.shared.start(config: EverframeConfig(appId: appA, capture: captureConfig))
        let epochAtCreation = Everframe.shared.currentStartEpoch
        CompanionBadgeServerConfigBox.shared.value = nil
        defer { CompanionBadgeServerConfigBox.shared.value = nil }
        BrandingServerConfigBox.shared.value = nil
        defer { BrandingServerConfigBox.shared.value = nil }
        VitalsServerConfigBox.shared.resetForTesting()
        defer { VitalsServerConfigBox.shared.resetForTesting() }

        let onBody = Data(#"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "companionBadge":{"enabled":true,"position":"top-left"},
            "branding":{"watermark":false}}
            """#.utf8)
        let provider = ReplayConfigProvider(
            configUrl: URL(string: "https://x/api/config")!,
            apiKey: "a",
            fetcher: ImmediateFetcher(body: onBody),
            ttlSec: 300,
            now: { 0 }
        )
        // Standalone session, never installed as `_replaySession` — same
        // isolation technique as the race tests above, but nothing supersedes
        // it here: its `currentStartEpoch` check passes on the first try, so
        // this exercises the plain, unblocked apply path.
        let session = ReplaySession(provider: provider, locallyDisabled: false, startEpoch: epochAtCreation)

        await session.refreshConfigNow()

        #expect(
            CompanionBadgeServerConfigBox.shared.value == CompanionBadgeConfigWire(enabled: true, position: "top-left"),
            "an ordinary, non-superseded apply must publish the companion badge block into its server box"
        )
        #expect(
            BrandingServerConfigBox.shared.value == BrandingConfigWire(watermark: false),
            "an ordinary, non-superseded apply must publish the branding block into its server box"
        )
        #expect(
            VitalsServerConfigBox.shared.value == VitalsServerConfig(vitalsEnabled: false, vitalsSampleRate: 1.0),
            "an ordinary, non-superseded apply must publish into the vitals server box too (absent fields default to off/full-rate)"
        )

        try Everframe.shared.start(config: EverframeConfig(appId: appA, capture: captureConfig))
      }
    }

    // ==================== Window (b) ====================

    /// `start()` must bump the global start epoch no LATER than it resets
    /// the body-capture gate. Verified directly at the exact point in
    /// `start()` between the two — if the epoch bump ever regresses back to
    /// running AFTER `reset()`, a `refreshConfigNow()` guard reading
    /// `currentStartEpoch` right then would still observe the OLD epoch even
    /// though the reset it's about to stomp on already ran.
    @Test func startBumpsTheGlobalEpochNoLaterThanItResetsTheBodyCaptureGate() async throws {
      try await withGlobalCaptureStateLock {
        let epochBeforeStart = Everframe.shared.currentStartEpoch

        var epochObservedAtResetHook: Int?
        Everframe.__bodyStateResetHookForTesting = {
            epochObservedAtResetHook = Everframe.shared.currentStartEpoch
        }
        defer { Everframe.__resetBodyStateResetHookForTesting() }

        try Everframe.shared.start(config: EverframeConfig(appId: appA, capture: CaptureConfig(logs: false)))

        #expect(
            epochObservedAtResetHook != nil,
            "the body-state-reset hook never fired — test setup is wrong, not exercising the invariant"
        )
        #expect(
            epochObservedAtResetHook != epochBeforeStart,
            """
            start() must bump the global start epoch no later than it resets the body-capture gate — a \
            refreshConfigNow() guard reading currentStartEpoch at this exact point must already see the NEW epoch
            """
        )
      }
    }
}

/// Minimal fakes — mirrors SessionBoundaryResetTests.swift's private
/// `ImmediateFetcher`/`AsyncGate` (re-declared here rather than shared, per
/// that file's own documented convention).
private final class ImmediateFetcher: URLSessionFetching, @unchecked Sendable {
    private let respBody: Data
    private(set) var callCount = 0

    init(body: Data) {
        self.respBody = body
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        callCount += 1
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil
        )!
        return (respBody, response)
    }
}

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
