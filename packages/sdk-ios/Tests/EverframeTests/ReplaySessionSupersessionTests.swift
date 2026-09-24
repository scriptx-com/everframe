// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Round-4 review Finding F16 (2026-08-02-pr25-review-round-4): `start()` is
// explicitly supported multiple times (restart / re-init with a different
// app config). A superseding `start()` used to overwrite
// `Everframe._replaySession` with a fresh session WITHOUT tearing down the
// prior session first: the prior session's initial/periodic refresh — parked
// mid-fetch, or about to fire — kept running against its OWN provider and
// could apply ITS stale `captureBodies` response to the process-global
// `NetworkBodyCaptureGate` AFTER the new (superseding) session had already
// taken over. From that point on the new session's config, not the old
// session's, is supposed to own the gate.
//
// This exercises the REAL `start()` install code path (not just
// `ReplaySession` in isolation, which `ReplaySessionTeardownRaceTests`
// already covers for the F13 teardown/epoch mechanism itself) via
// `Everframe.__replaySessionFactoryForTesting` — real network is
// unreachable/uncontrolled from a unit test, so the factory injects sessions
// built from fake providers (mirrors `ReplaySessionTeardownRaceTests`'
// `GatedFetcher`/`MutableClock` pattern) so session A's response can be
// parked deterministically and released only AFTER session B has already
// applied its OFF config. Without the `_replaySession?.teardown()` call
// added to `start()`'s MainActor install block, this test fails: session A's
// epoch is never bumped, so its stale ON response (resolving after B has
// already taken over) sails past the (unbumped) epoch check and re-arms the
// gate.
#if canImport(UIKit)
import Testing
import Foundation
@testable import EverframeKit

@MainActor
@Suite(.serialized)
struct ReplaySessionSupersessionTests {
    private let testAppId = "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"

    private func body(_ json: String) -> Data { Data(json.utf8) }

    // Round-6 review Finding F31: drives `Everframe.shared` (start) and
    // `NetworkBodyCaptureGate.shared` for real — wrapped in
    // `withGlobalCaptureStateLock` so it cannot interleave with any other
    // suite doing the same (see Helpers/GlobalCaptureStateTestLock.swift).
    @Test func supersedingStartTearsDownPriorSessionSoItsStaleOnResponseCannotArmTheGate() async throws {
      try await withGlobalCaptureStateLock {
        NetworkBodyCaptureGate.shared.resetForTesting()
        defer {
            NetworkBodyCaptureGate.shared.resetForTesting()
            Everframe.__resetReplaySessionFactoryForTesting()
        }

        let gateA = AsyncGate()
        let onBody = body(#"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "networkBodies":{"captureBodies":true}}
            """#)
        let fetcherA = GatedFetcher(gate: gateA, body: onBody)
        let clockA = MutableClock(0)
        let providerA = ReplayConfigProvider(
            configUrl: URL(string: "https://x/api/config")!,
            apiKey: "a",
            fetcher: fetcherA,
            ttlSec: 300,
            now: { clockA.read }
        )
        let sessionA = ReplaySession(provider: providerA, locallyDisabled: false)

        let offBody = body(#"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "networkBodies":{"captureBodies":false}}
            """#)
        let fetcherB = ImmediateFetcher(body: offBody)
        let clockB = MutableClock(0)
        let providerB = ReplayConfigProvider(
            configUrl: URL(string: "https://x/api/config")!,
            apiKey: "b",
            fetcher: fetcherB,
            ttlSec: 300,
            now: { clockB.read }
        )
        let sessionB = ReplaySession(provider: providerB, locallyDisabled: false)

        var installCount = 0
        Everframe.__replaySessionFactoryForTesting = { _ in
            installCount += 1
            return installCount == 1 ? sessionA : sessionB
        }

        // network: true / networkBodies: true (default) — the F22 gate fails
        // closed on `capture.network != true` (see
        // `NetworkBodyCaptureGate.locallyDisabled(for:)`); `refreshConfigNow`
        // reads that flag off the REAL `Everframe.shared.currentConfig`
        // snapshot installed by `start()` below, not off `ReplaySession`'s
        // own constructor `locallyDisabled` param. Without this the gate
        // could never legitimately reach `isActive == true` and both
        // `!isActive` assertions below would be vacuously true regardless of
        // whether the F16 supersession-teardown fix actually works.
        let config = EverframeConfig(appId: testAppId, capture: CaptureConfig(logs: false, network: true))

        // Start #1 installs session A; its initial refresh immediately parks
        // on gateA (mid-fetch), exactly like a slow/loaded network in
        // production.
        try Everframe.shared.start(config: config)
        let aReachedFetch = await AsyncTestHelpers.waitFor({ fetcherA.callCount == 1 })
        #expect(aReachedFetch, "session A's initial fetch never started — test setup is wrong, not exercising the race")

        // Start #2 supersedes A with B. B's fetcher resolves immediately
        // (OFF), so this settles the gate to OFF before A is ever released.
        try Everframe.shared.start(config: config)
        let bInstalled = await AsyncTestHelpers.waitFor({ installCount == 2 })
        #expect(bInstalled, "session B was never installed by the superseding start()")
        let bFetched = await AsyncTestHelpers.waitFor({ fetcherB.callCount >= 1 })
        #expect(bFetched, "session B's initial refresh never ran")
        // Give B's refreshConfigNow (immediate fetch, no gate) time to apply.
        try? await Task.sleep(nanoseconds: 100_000_000)
        #expect(!NetworkBodyCaptureGate.shared.isActive, "session B's OFF config must stand once installed")

        // NOW release session A's parked, stale ON response — it resolves
        // LAST, well after B has already taken over.
        await gateA.open()
        try? await Task.sleep(nanoseconds: 150_000_000)

        #expect(
            !NetworkBodyCaptureGate.shared.isActive,
            """
            session A's stale captureBodies:true response, resolving AFTER it was superseded by session B, \
            must not re-arm the process-global gate
            """
        )

        Everframe.shared.kill()
      }
    }

    // -------------------------------------------------------------------
    // Round 17 (codex round 16), Serious x2 — `setIdentityToken(nil)` used
    // to force-discard the replay lifecycle via the now-REMOVED
    // `ReplaySession.forceDiscardForIdentityChange()` (`lifecycle
    // .forceDiscard()` immediately followed by an attempt to resume
    // buffering), dispatched via `Task { @MainActor in ... }` regardless of
    // the lifecycle's current state. Two consequences, both traced to that
    // one call: (1) signing out while a reporter had the lifecycle FROZEN
    // flipped it back to buffering and restarted the `CADisplayLink` tick
    // WHILE reporter chrome was on screen — capturing reporter UI into the
    // next report, and leaving the open reporter's own pending
    // submit/cancel to no-op against a lifecycle that was no longer
    // frozen; (2) the Android twin of this same call held its equivalent
    // of `stateLock` while synchronously driving the main-thread-confined
    // `ReplaySession` from whatever thread `setIdentityToken` happened to
    // run on. Ruling: sign-out stops touching the replay lifecycle
    // entirely — it keeps only the evidence-buffer zeroization (lock-
    // guarded, thread-agnostic).
    // -------------------------------------------------------------------

    /// Regression pin: freeze the lifecycle (simulating an open reporter),
    /// sign out, and assert the lifecycle is STILL frozen — sign-out must
    /// never flip it back to buffering. `ReplaySession
    /// .__lifecycleStateForTesting()` is a new, minimal test-only accessor
    /// (`lifecycle` itself is `private`) added purely so this can be
    /// observed directly. Mirrors the Android twin
    /// (`ReplaySessionRefreshLoopTest.kt`'s `` `sign out does not touch a
    /// frozen replay lifecycle` `` — mutation-verified there; not
    /// independently re-verified here since neither this file nor
    /// `ReplaySession.swift` compiles under plain `swift test` on this
    /// macOS host — CI's `lifecycle-tests-iOS` job is the authoritative
    /// verifier).
    @Test func signOutDoesNotTouchAFrozenReplayLifecycle() async throws {
      try await withGlobalCaptureStateLock {
        defer { Everframe.__resetReplaySessionFactoryForTesting() }

        let onBody = body(#"""
            {"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0}
            """#)
        let fetcher = ImmediateFetcher(body: onBody)
        let clock = MutableClock(0)
        let provider = ReplayConfigProvider(
            configUrl: URL(string: "https://x/api/config")!,
            apiKey: "a",
            fetcher: fetcher,
            ttlSec: 300,
            now: { clock.read }
        )
        var installedSession: ReplaySession?
        // Match production: the new session belongs to the epoch established by start().
        Everframe.__replaySessionFactoryForTesting = { _ in
            let session = ReplaySession(provider: provider, locallyDisabled: false)
            installedSession = session
            return session
        }

        let config = EverframeConfig(appId: testAppId, capture: CaptureConfig(logs: false))
        try Everframe.shared.start(config: config)

        let becameBuffering = await AsyncTestHelpers.waitFor({ installedSession?.__lifecycleStateForTesting() == .buffering })
        let session = try #require(installedSession)
        #expect(becameBuffering, "fixture sanity: an enabled, always-sampled config must start buffering")

        Everframe.shared.__replayFreeze()
        #expect(
            session.__lifecycleStateForTesting() == .frozen,
            "fixture sanity: freezing a buffering session must move it to FROZEN"
        )

        Everframe.shared.setIdentityToken(nil)

        #expect(
            session.__lifecycleStateForTesting() == .frozen,
            "sign-out must not touch a frozen replay lifecycle"
        )

        Everframe.shared.kill()
      }
    }
}

/// Minimal fakes — mirrors `ReplaySessionTeardownRaceTests`' private
/// `GatedFetcher`/`MutableClock`/`AsyncGate` (re-declared here rather than
/// shared, per that file's own documented convention).
private final class GatedFetcher: URLSessionFetching, @unchecked Sendable {
    private let gate: AsyncGate
    private let respBody: Data
    private(set) var callCount = 0

    init(gate: AsyncGate, body: Data) {
        self.gate = gate
        self.respBody = body
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        callCount += 1
        await gate.waitUntilOpen()
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil
        )!
        return (respBody, response)
    }
}

/// A fetcher that resolves immediately (no gate) — mirrors session B's
/// well-behaved network in the race scenario.
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

private final class MutableClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: TimeInterval
    init(_ value: TimeInterval = 0) { self.value = value }
    var read: TimeInterval { lock.lock(); defer { lock.unlock() }; return value }
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
