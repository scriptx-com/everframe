// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Round-5 review Finding F23 (2026-08-02-pr25-review-round-5): `start(A) ->
// start(B)` is not a safe app/session boundary by itself. `start()`
// synchronously overwrites `_config`/re-opens `captureGate`/changes the
// submit key, but A's `NetworkBodyCaptureGate`/`NetworkBodyRingBuffer` state
// (including its STICKY sampling draw) and A's refresh-owning
// `ReplaySession` all stayed live until the delayed async tail ran — and the
// body ring buffer was never cleared at all. Consequences: (1) requests
// captured during that window kept capturing under A's server authorization;
// (2) a report opened under B could upload A's buffered bodies (and their
// correlated crumbs) to B's app/key.
//
// Fixed by moving `NetworkBodyCaptureGate.shared.reset()` (deactivate + clear
// the sticky sample draw — previously only called from `kill()`) and
// `NetworkBodyRingBuffer.shared.clear()` into `start()`'s SYNCHRONOUS section,
// before `_config`/`captureGate` flip to the new session. A's refresh-owning
// `ReplaySession`'s `teardown()` is additionally requested as the FIRST thing
// dispatched to MainActor (ahead of the heavy-init tail's
// `await drainOutbox()`), shrinking — though, per MainActor scheduling, not
// eliminating outright — the window in which A's own periodic/initial
// refresh could re-arm the just-reset gate before its epoch is invalidated.
// See `Everframe.swift`'s `start()` for the full rationale.
//
// SCOPE UPDATE (2026-08-13, follow-ups register item 10): this header used to
// end "…including why breadcrumbs are deliberately NOT cleared by this fix",
// and F23's own reasoning for leaving them was consistency with every other
// breadcrumb kind surviving a restart. It never weighed tenancy: A's crumb
// chain and A's network metadata rows outliving `start(B)` meant the next
// ordinary report in B shipped them to a different customer's project.
// `start()` now clears `BreadcrumbRingBuffer` and `NetworkRingBuffer` as well,
// alongside the two calls this file tests. The regression guards for that live
// in `EnvelopeUserTests` (which, unlike this suite, is neither UIKit-gated nor
// absent from `swift.yml`'s `--filter` allowlist).
#if canImport(UIKit)
import Testing
import Foundation
import EverframeProtocol
@testable import EverframeKit

@MainActor
@Suite(.serialized)
struct SessionBoundaryResetTests {
    private let appA = "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"
    private let appB = "txx_live_AnotherAppBBBBBBBBBBBBBBBBBBBBBB"

    private func bodyEntry(ref: Int) -> EverframeNetworkBody {
        EverframeNetworkBody(
            ref: Double(ref),
            reqBody: "A's secret request body",
            reqBodyBytes: 24,
            reqBodySkipped: nil,
            reqBodyTruncated: nil,
            reqHeaders: nil,
            resBody: "A's secret response body",
            resBodyBytes: 25,
            resBodySkipped: nil,
            resBodyTruncated: nil,
            resHeaders: nil,
            t: 0
        )
    }

    // Round-6 review Finding F31: every test in this file drives
    // `Everframe.shared` (start/kill) and `NetworkBodyCaptureGate.shared` /
    // `NetworkBodyRingBuffer.shared` for real — each is wrapped in
    // `withGlobalCaptureStateLock` so it cannot interleave with any other
    // suite doing the same (see Helpers/GlobalCaptureStateTestLock.swift).
    @Test func startBSynchronouslyResetsSessionAsNetworkBodyState() async throws {
      try await withGlobalCaptureStateLock {
        NetworkBodyCaptureGate.shared.resetForTesting()
        defer { NetworkBodyCaptureGate.shared.resetForTesting() }

        let configA = EverframeConfig(appId: appA, capture: CaptureConfig(logs: false))
        try Everframe.shared.start(config: configA)

        // Simulate A's session having been authorized ON by the server and
        // having sampled itself in — this sticky draw is exactly what this
        // fix must clear.
        NetworkBodyCaptureGate.shared.applyConfig(
            NetworkBodiesConfigWire(captureBodies: true, bodyByteCap: nil, bodyContentTypes: nil, bodyTotalBudget: nil),
            samplingRate: 1.0, locallyDisabled: false, random: { 0.0 })
        #expect(NetworkBodyCaptureGate.shared.isActive, "test setup: A's gate must be active before start(B)")

        // Simulate a body having actually been captured under A's
        // authorization — this is what a report opened under B must never
        // be able to upload.
        NetworkBodyRingBuffer.shared.append(bodyEntry(ref: 1))
        #expect(!NetworkBodyRingBuffer.shared.snapshot().isEmpty, "test setup: A's body must be buffered before start(B)")

        let configB = EverframeConfig(appId: appB, capture: CaptureConfig(logs: false))
        try Everframe.shared.start(config: configB)

        // SYNCHRONOUS assertions — no await, no sleep — immediately after
        // start(B) returns. Both NetworkBodyCaptureGate and
        // NetworkBodyRingBuffer are NSLock-guarded, non-actor singletons, so
        // this really does exercise the synchronous part of start().
        #expect(!NetworkBodyCaptureGate.shared.isActive, "start(B) must deactivate A's still-armed body gate synchronously")
        #expect(NetworkBodyRingBuffer.shared.snapshot().isEmpty, "start(B) must zeroize A's buffered bodies synchronously")

        // Prove the STICKY sampling draw itself was cleared (not just
        // `active`): re-apply an ON config with samplingRate 0 and a
        // random() that always draws "sampled out". If reset() had NOT
        // cleared the sticky draw, applyConfig would treat the OLD draw
        // (true, from A) as already-decided and never re-roll — isActive
        // would come back true. Only a genuinely-cleared draw re-rolls and
        // lands here as false.
        NetworkBodyCaptureGate.shared.applyConfig(
            NetworkBodiesConfigWire(captureBodies: true, bodyByteCap: nil, bodyContentTypes: nil, bodyTotalBudget: nil),
            samplingRate: 0.0, locallyDisabled: false, random: { 0.999 })
        #expect(!NetworkBodyCaptureGate.shared.isActive, "start(B) must clear A's sticky sampling draw, not just deactivate the gate")

        Everframe.shared.kill()
      }
    }

    @Test func startBTearsDownSessionAsRefreshLoopSoItCannotReArmTheGateLater() async throws {
      try await withGlobalCaptureStateLock {
        NetworkBodyCaptureGate.shared.resetForTesting()
        defer {
            NetworkBodyCaptureGate.shared.resetForTesting()
            Everframe.__resetReplaySessionFactoryForTesting()
        }

        let gateA = AsyncGate()
        let onBody = Data(#"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "networkBodies":{"captureBodies":true}}
            """#.utf8)
        let fetcherA = GatedFetcher(gate: gateA, body: onBody)
        let providerA = ReplayConfigProvider(
            configUrl: URL(string: "https://x/api/config")!,
            apiKey: "a",
            fetcher: fetcherA,
            ttlSec: 300,
            now: { 0 }
        )
        let sessionA = ReplaySession(provider: providerA, locallyDisabled: false)

        let offBody = Data(#"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "networkBodies":{"captureBodies":false}}
            """#.utf8)
        let fetcherB = ImmediateFetcher(body: offBody)
        let providerB = ReplayConfigProvider(
            configUrl: URL(string: "https://x/api/config")!,
            apiKey: "b",
            fetcher: fetcherB,
            ttlSec: 300,
            now: { 0 }
        )
        let sessionB = ReplaySession(provider: providerB, locallyDisabled: false)

        var installCount = 0
        Everframe.__replaySessionFactoryForTesting = { _ in
            installCount += 1
            return installCount == 1 ? sessionA : sessionB
        }

        // network: true / networkBodies: true (default) — the F22 gate fails
        // closed on `capture.network != true` (see
        // `NetworkBodyCaptureGate.locallyDisabled(for:)`), and
        // `refreshConfigNow` reads that flag off the REAL
        // `Everframe.shared.currentConfig` snapshot installed by `start()`
        // below (not off the `ReplaySession` constructor's own
        // `locallyDisabled` param, which only gates the replay/lifecycle
        // sampling, not the body gate). Without this the gate could never
        // legitimately reach `isActive == true` and every assertion below
        // would be vacuously true regardless of whether the F23 teardown
        // fix actually works.
        let captureConfig = CaptureConfig(logs: false, network: true)
        try Everframe.shared.start(config: EverframeConfig(appId: appA, capture: captureConfig))
        let aReachedFetch = await AsyncTestHelpers.waitFor({ fetcherA.callCount == 1 })
        #expect(aReachedFetch, "session A's initial fetch never started — test setup is wrong, not exercising the race")

        // The superseding start(B) — this is what F23 hardens: A's session's
        // teardown() is now requested as the FIRST thing dispatched to
        // MainActor (ahead of B's own heavy-init tail), not only after B's
        // `await drainOutbox()` completes.
        try Everframe.shared.start(config: EverframeConfig(appId: appB, capture: captureConfig))

        // Not literally zero-wait — `_replaySession` is MainActor-isolated
        // and needs at least one scheduling turn to update (see
        // Everframe.swift's start() doc comment for why this can't be made
        // more synchronous than this without risking a crash on a
        // non-main-thread caller) — but bounded, and this resolves well
        // before A's gated fetch is ever released below.
        let bInstalled = await AsyncTestHelpers.waitFor({ installCount == 2 })
        #expect(bInstalled, "session B was never installed by the superseding start()")
        let bFetched = await AsyncTestHelpers.waitFor({ fetcherB.callCount >= 1 })
        #expect(bFetched, "session B's initial refresh never ran")
        try? await Task.sleep(nanoseconds: 100_000_000)
        #expect(!NetworkBodyCaptureGate.shared.isActive, "session B's OFF config must stand once installed")

        // Release session A's parked ON response only NOW — after B has
        // already taken over.
        await gateA.open()
        try? await Task.sleep(nanoseconds: 150_000_000)

        #expect(
            !NetworkBodyCaptureGate.shared.isActive,
            """
            session A's stale captureBodies:true response, resolving AFTER start(B) superseded it, \
            must not re-arm the process-global gate
            """
        )

        Everframe.shared.kill()
      }
    }

    // Round-6 review Finding F27: `startBTearsDownSessionAsRefreshLoopSoItCannotReArmTheGateLater`
    // above only releases session A's parked response AFTER session B is
    // confirmed installed — by then A's belt-and-suspenders `teardown()`
    // (dispatched as the FIRST thing onto MainActor at the top of `start()`)
    // has had ample scheduling turns to run, so that test never exercises
    // the interval where A's continuation resumes BEFORE (or without) its
    // own teardown() ever landing. `start(A) -> start(B)` still resets the
    // shared gate/buffer and bumps the GLOBAL start epoch synchronously, but
    // a stale `refreshConfigNow()` continuation could previously still pass
    // its OWN (session-local) unchanged epoch check and re-arm the gate,
    // because that check had no way to see a supersession until its own
    // session's `teardown()` — an async MainActor dispatch, no ordering
    // guarantee relative to the continuation's resumption — actually ran.
    //
    // This spec makes that ordering irrelevant to the outcome: `sessionA`
    // below is constructed directly (mirrors `ReplaySessionTeardownRaceTests`'
    // pattern) and is NEVER installed as `Everframe.shared._replaySession` and
    // NEVER torn down anywhere in this test — a harmless dummy session is
    // installed via the factory instead, so the real `start()`/`start()`
    // sequence's belt-and-suspenders `_replaySession?.teardown()` calls have
    // nothing of sessionA's to touch. The ONLY mechanism that can stop
    // sessionA's stale ON response from re-arming the gate is therefore the
    // NEW global-start-epoch check under test (F27) — sessionA's own
    // session-local `epoch` never changes throughout.
    @Test func staleSessionAResponseAfterStartBCannotArmGlobalGateEvenWithoutItsOwnTeardownEverRunning() async throws {
      try await withGlobalCaptureStateLock {
        NetworkBodyCaptureGate.shared.resetForTesting()
        defer {
            NetworkBodyCaptureGate.shared.resetForTesting()
            Everframe.__resetReplaySessionFactoryForTesting()
        }

        // Harmless session installed as `_replaySession` for both start()
        // calls below — resolves immediately, OFF. Its own teardown() (the
        // belt-and-suspenders hop both start() calls dispatch) is irrelevant
        // to this test: the interleaving under test is between the
        // STANDALONE `sessionA` constructed below (never installed, never
        // torn down) and `start(B)`'s SYNCHRONOUS global-epoch bump.
        let dummyOffBody = Data(#"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "networkBodies":{"captureBodies":false}}
            """#.utf8)
        Everframe.__replaySessionFactoryForTesting = { _ in
            ReplaySession(
                provider: ReplayConfigProvider(
                    configUrl: URL(string: "https://x/api/config")!,
                    apiKey: "dummy",
                    fetcher: ImmediateFetcher(body: dummyOffBody),
                    ttlSec: 300,
                    now: { 0 }
                ),
                locallyDisabled: false
            )
        }

        let captureConfig = CaptureConfig(logs: false, network: true)
        try Everframe.shared.start(config: EverframeConfig(appId: appA, capture: captureConfig))

        // Capture the epoch A's OWN (standalone, never-installed) session
        // sees at its creation — mirrors exactly what start()'s heavy-init
        // tail does for the session it actually installs.
        let epochAtACreation = Everframe.shared.currentStartEpoch

        let gateA = AsyncGate()
        let onBody = Data(#"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "networkBodies":{"captureBodies":true}}
            """#.utf8)
        let fetcherA = GatedFetcher(gate: gateA, body: onBody)
        let providerA = ReplayConfigProvider(
            configUrl: URL(string: "https://x/api/config")!,
            apiKey: "a",
            fetcher: fetcherA,
            ttlSec: 300,
            now: { 0 }
        )
        let sessionA = ReplaySession(provider: providerA, locallyDisabled: false, startEpoch: epochAtACreation)

        // Mirrors enableIfConfigured()'s initial fetch — parks immediately
        // on gateA, exactly like a slow/loaded network in production. Kicked
        // off manually (not via enableIfConfigured()/install) since sessionA
        // is deliberately never installed as `_replaySession`.
        let refreshTaskA = Task { await sessionA.refreshConfigNow() }
        let aReachedFetch = await AsyncTestHelpers.waitFor({ fetcherA.callCount == 1 })
        #expect(aReachedFetch, "session A's fetch never started — test setup is wrong, not exercising the race")

        // start(B): resets NetworkBodyCaptureGate/NetworkBodyRingBuffer AND
        // bumps the global start epoch SYNCHRONOUSLY, before this call even
        // returns. `sessionA` above is never installed as `_replaySession`
        // and its `teardown()` is never called anywhere in this test — the
        // ONLY mechanism that can stop its stale response from re-arming the
        // gate is the NEW global-start-epoch check under test.
        try Everframe.shared.start(config: EverframeConfig(appId: appB, capture: captureConfig))

        // Release session A's parked ON response immediately — before
        // anything else has a chance to run — exactly the interval the
        // OTHER test above (which releases only after B is confirmed
        // installed) never exercises.
        await gateA.open()
        await refreshTaskA.value

        #expect(
            !NetworkBodyCaptureGate.shared.isActive,
            """
            session A's stale ON response, resolving after start(B) already bumped the global start \
            epoch synchronously, must not re-arm the process-global body gate — even though session \
            A's OWN session-local epoch was never bumped (its teardown() is never called in this test)
            """
        )
        #expect(
            NetworkBodyRingBuffer.shared.snapshot().isEmpty,
            "start(B)'s synchronous buffer clear must not be refilled by session A's stale authorization"
        )

        Everframe.shared.kill()
      }
    }
}

/// Minimal fakes — mirrors `ReplaySessionSupersessionTests`' private
/// `GatedFetcher`/`ImmediateFetcher`/`AsyncGate` (re-declared here rather
/// than shared, per that file's own documented convention).
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
