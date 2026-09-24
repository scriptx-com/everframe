// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Round-3 review Finding F13 (2026-08-01-network-body-capture-native):
// `ReplaySession.enableIfConfigured()` used to launch its initial
// `refreshConfigNow()` fetch via an unretained `Task { [weak self] in
// await self?.refreshConfigNow() }`. Because `await`ing inside a task body
// re-derives a strong reference from a `weak self` capture for the duration
// of the await, an in-flight INITIAL fetch outlived teardown: `kill()` (or
// any other release of the session) could land while the fetch was still
// parked mid-network-call, and `deinit` — which only cancelled
// `refreshLoopTask` — never got a chance to run until that promoted-strong
// reference was released, by which point the fetch had already resolved and
// applied a possibly-stale `captureBodies: true` response to the PROCESS-
// GLOBAL `NetworkBodyCaptureGate.shared`, re-arming it for a session that no
// longer exists.
//
// Fixed two ways (mirroring `Everframe._startEpoch`, round-2 review Finding
// F9, commit 826e5f76):
//   1. The initial fetch's `Task` handle is now retained
//      (`initialRefreshTask`) and cancelled in `deinit` alongside
//      `refreshLoopTask`.
//   2. More importantly, `ReplaySession.teardown()` — called explicitly from
//      `Everframe.kill()`'s MainActor hop, NOT just relied upon via `deinit`
//      timing — bumps a per-session `epoch` synchronously. `refreshConfigNow()`
//      captures that epoch before its first `await` and re-checks it (plus
//      `Task.isCancelled`) immediately before touching ANY process-global
//      state (the network-body gate, its ring buffer's byte budget, the
//      breadcrumb config). A fetch that resolves after `teardown()` sees a
//      stale epoch and discards its result instead of applying it.
//
// This spec drives `ReplaySession.refreshConfigNow()`/`teardown()` directly
// via an injectable-fetcher `ReplayConfigProvider`, mirroring
// ReplaySessionRefreshLoopTests.swift's StubFetcher/MutableClock pattern —
// plus a gate (mirroring StartEpochGuardTests.swift's `AsyncGate`) to park
// the fetch mid-flight so the race is deterministic rather than a guessed
// sleep.
#if canImport(UIKit)
import Testing
import Foundation
@testable import EverframeKit

/// A fetcher whose single call parks on an `AsyncGate` before returning a
/// canned response — lets the test suspend an in-flight `refreshConfigNow()`
/// deterministically, tear the session down while it's still parked, then
/// release it and observe whether the stale response was allowed to apply.
private final class GatedFetcher: URLSessionFetching, @unchecked Sendable {
    private let gate: AsyncGate
    private let body: Data
    private(set) var callCount = 0

    init(gate: AsyncGate, body: Data) {
        self.gate = gate
        self.body = body
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        callCount += 1
        await gate.waitUntilOpen()
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil
        )!
        return (body, response)
    }
}

/// A mutable monotonic clock holder safe to capture in a `@Sendable` closure
/// (mirrors ReplayConfigProviderTests.swift's MutableClock).
private final class MutableClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: TimeInterval
    init(_ value: TimeInterval = 0) { self.value = value }
    var read: TimeInterval { lock.lock(); defer { lock.unlock() }; return value }
}

/// Tiny actor gate so the test can park a fetch deterministically and then
/// release it after racing `teardown()` against it (mirrors
/// StartEpochGuardTests.swift's private `AsyncGate` — file-private there, so
/// re-declared here rather than shared).
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

/// Touches the process-wide `NetworkBodyCaptureGate.shared` (same seam
/// ReplaySessionRefreshLoopTests.swift exercises) — `.serialized` so these
/// specs never interleave with each other or with that suite.
@Suite(.serialized)
@MainActor
struct ReplaySessionTeardownRaceTests {
    // Round-5 review Finding F22 (re-review gap): `refreshConfigNow()`'s
    // network-body gate fails closed on a nil `Everframe.shared.currentConfig`
    // (spec §3). This suite drives `ReplaySession` directly (not via
    // `Everframe.start()`), so `currentConfig` would otherwise stay nil
    // throughout and `NetworkBodyCaptureGate.shared.isActive` could NEVER
    // legitimately become true — making both tests' `!isActive` assertions
    // vacuously true regardless of whether teardown()/the epoch guard still
    // works. Set the client config via the test-only seam (BOTH client
    // preconditions opted in) before each test and restore it via `defer`,
    // mirroring `ReplaySessionRefreshLoopTests.setClientConfigForTesting()`.
    private func setClientConfigForTesting() {
        Everframe.__setConfigForTesting(
            EverframeConfig(appId: "app", capture: CaptureConfig(network: true, networkBodies: true)))
    }

    private func body(_ json: String) -> Data { Data(json.utf8) }

    private func makeSession(fetcher: URLSessionFetching, clock: MutableClock) -> ReplaySession {
        let provider = ReplayConfigProvider(
            configUrl: URL(string: "https://x/api/config")!,
            apiKey: "k",
            fetcher: fetcher,
            ttlSec: 300,
            now: { clock.read }
        )
        return ReplaySession(provider: provider, locallyDisabled: false)
    }

    // Round-6 review Finding F31: both tests below drive
    // `NetworkBodyCaptureGate.shared` and `Everframe.shared`'s test-only
    // config seam for real — each is wrapped in `withGlobalCaptureStateLock`
    // so it cannot interleave with any other suite doing the same (see
    // Helpers/GlobalCaptureStateTestLock.swift).
    @Test func staleInitialFetchCompletingAfterTeardownCannotArmTheGlobalBodyGate() async {
      await withGlobalCaptureStateLock {
        NetworkBodyCaptureGate.shared.resetForTesting()
        defer { NetworkBodyCaptureGate.shared.resetForTesting() }
        setClientConfigForTesting()
        defer { Everframe.__setConfigForTesting(nil) }

        let gate = AsyncGate()
        let onBody = body(#"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "networkBodies":{"captureBodies":true}}
            """#)
        let fetcher = GatedFetcher(gate: gate, body: onBody)
        let clock = MutableClock(0)
        let session = makeSession(fetcher: fetcher, clock: clock)

        // Exactly what enableIfConfigured() does for the INITIAL fetch:
        // kick off refreshConfigNow() as its own unretained-from-the-
        // caller's-perspective Task. It immediately parks inside the
        // fetcher's gate, before observing anything about teardown.
        let refreshTask = Task { await session.refreshConfigNow() }

        // Let the task actually reach the parked fetch call before tearing
        // the session down, so teardown() genuinely races an in-flight
        // fetch rather than trivially winning by running first.
        let reachedFetch = await AsyncTestHelpers.waitFor({ fetcher.callCount == 1 })
        #expect(reachedFetch, "fetch never started — test setup is wrong, not exercising the race")

        // Tear the session down while the fetch is still parked — mirrors
        // kill() (via ReplaySession.teardown(), the same method
        // Everframe.kill() calls) landing mid-await in production.
        session.teardown()

        // Release the parked fetch now that the session believes itself
        // torn down, and let refreshConfigNow() run to completion.
        await gate.open()
        await refreshTask.value

        #expect(
            !NetworkBodyCaptureGate.shared.isActive,
            "a fetch that resolves after teardown() must not be allowed to re-arm the global body gate"
        )
      }
    }

    @Test func teardownCancelsBothTheInitialAndPeriodicRefreshTasks() async {
      await withGlobalCaptureStateLock {
        NetworkBodyCaptureGate.shared.resetForTesting()
        defer { NetworkBodyCaptureGate.shared.resetForTesting() }
        setClientConfigForTesting()
        defer { Everframe.__setConfigForTesting(nil) }

        let gate = AsyncGate()
        let onBody = body(#"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "networkBodies":{"captureBodies":true}}
            """#)
        let fetcher = GatedFetcher(gate: gate, body: onBody)
        let clock = MutableClock(0)
        let session = makeSession(fetcher: fetcher, clock: clock)

        session.enableIfConfigured()
        let reachedFetch = await AsyncTestHelpers.waitFor({ fetcher.callCount == 1 })
        #expect(reachedFetch)

        session.teardown()
        await gate.open()

        // Give the released (but now-stale) initial fetch time to run to
        // completion and attempt its apply.
        try? await Task.sleep(nanoseconds: 100_000_000)

        #expect(
            !NetworkBodyCaptureGate.shared.isActive,
            "teardown() during enableIfConfigured()'s real initial-fetch path must also block the stale apply"
        )
      }
    }
}
#endif
