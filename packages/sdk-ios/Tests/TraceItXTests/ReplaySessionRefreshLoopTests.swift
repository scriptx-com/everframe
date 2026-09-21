// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Final-review Finding 1 (native body-capture kill-switch latency,
// 2026-08-01-network-body-capture-native): `enableIfConfigured()` used to be
// the ONLY caller of the refresh seam (provider.refresh() -> read current ->
// BreadcrumbRingBuffer.applyConfig -> NetworkBodyCaptureGate.applyConfig +
// setTotalBudget -> startBufferingIfEligible), invoked once at start(). The
// remote kill-switch (spec §3) needs that seam re-invoked periodically
// (~300s, matching the config TTL) so a server-side flip actually reaches a
// long-lived session instead of only the next process launch.
//
// These specs drive the extracted `ReplaySession.refreshConfigNow()` seam
// directly — via an injectable-fetcher/injectable-clock `ReplayConfigProvider`
// — rather than the periodic loop itself, mirroring
// ReplayConfigProviderTests.swift's StubFetcher/MutableClock pattern. No real
// network, no 300s sleep.
#if canImport(UIKit)
import Testing
import Foundation
@testable import TraceItXKit

/// Returns canned (Data, 200) pairs in order; the last one repeats.
private final class StubFetcher: URLSessionFetching, @unchecked Sendable {
    private var bodies: [Data]
    private(set) var callCount = 0

    init(_ bodies: [Data]) { self.bodies = bodies }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        let body = bodies[min(callCount, bodies.count - 1)]
        callCount += 1
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil
        )!
        return (body, response)
    }
}

private struct StubFetchError: Error {}

private enum ScriptedOutcome {
    case success(Data)
    case failure
}

/// A fetcher whose per-call outcome is scripted in order (success or throw) —
/// the last entry repeats once the script is exhausted. Used to drive a
/// SINGLE provider/session through a success → failure → success sequence
/// (Finding 5) so the provider's last-good cache genuinely persists across
/// the failed call, matching production behavior.
private final class ScriptedFetcher: URLSessionFetching, @unchecked Sendable {
    private var outcomes: [ScriptedOutcome]
    private(set) var callCount = 0

    init(_ outcomes: [ScriptedOutcome]) { self.outcomes = outcomes }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        let outcome = outcomes[min(callCount, outcomes.count - 1)]
        callCount += 1
        switch outcome {
        case let .success(body):
            let response = HTTPURLResponse(
                url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil
            )!
            return (body, response)
        case .failure:
            throw StubFetchError()
        }
    }
}

/// A mutable monotonic clock holder safe to capture in a `@Sendable` closure
/// (mirrors ReplayConfigProviderTests.swift's MutableClock).
private final class MutableClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: TimeInterval
    init(_ value: TimeInterval = 0) { self.value = value }
    func set(_ v: TimeInterval) { lock.lock(); value = v; lock.unlock() }
    var read: TimeInterval { lock.lock(); defer { lock.unlock() }; return value }
}

/// File-scope (not a struct method) deliberately — `ReplaySessionRefreshLoopTests`
/// is `@MainActor`, and this has no MainActor-isolated state to touch, so
/// keeping it free-standing (mirrors `StubFetcher`/`MutableClock` above)
/// avoids any isolation hop when called from the `@Sendable` provider closure
/// in the round-17 test below. Mirrors `IdentityProviderWarmTests.swift`'s
/// own `jwt(sub:exp:)` helper line for line.
private func jwt(sub: String, exp: Date) -> String {
    let header = #"{"alg":"HS256","typ":"JWT"}"#.data(using: .utf8)!
    let payload = try! JSONSerialization.data(withJSONObject: ["sub": sub, "exp": Int(exp.timeIntervalSince1970)])
    func b64(_ d: Data) -> String {
        d.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
    return "\(b64(header)).\(b64(payload)).sig"
}

/// Bounded poll for an async condition — there is no synchronous signal for
/// "the detached warm Task fired by `refreshConfigNow()`'s transition
/// detection has finished," so this is the only honest way to observe it
/// settling (mirrors `IdentityProviderWarmTests.swift`'s
/// `pollForCapturedSubject()` and the Android twin's `pollUntil`). Deliberately
/// bounded, not an unconditional wait: against a reverted fix the condition
/// never becomes true, and this must fail the test, not hang the run.
private func poll(timeout: TimeInterval = 5, _ condition: @Sendable () async -> Bool) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !(await condition()), Date() < deadline {
        try? await Task.sleep(nanoseconds: 20_000_000)  // 20ms
    }
}

/// Touches the process-wide `NetworkBodyCaptureGate.shared` (the seam under
/// test always writes into `.shared`, matching `NetworkCaptureProtocol.swift`
/// production usage).
///
/// Round-6 review Finding F31: `.serialized` here only serializes tests
/// WITHIN this suite — it does NOT stop this suite's tests from interleaving
/// with `StartEpochGuardTests`, `ReplaySessionSupersessionTests`, and the
/// other suites that also drive `TraceItX.shared`/`NetworkBodyCaptureGate
/// .shared`, which Swift Testing schedules concurrently by default. Every
/// test below now ALSO wraps its entire body in
/// `await withGlobalCaptureStateLock { ... }`, which serializes across every
/// suite sharing that gate, not just within this one — see
/// Helpers/GlobalCaptureStateTestLock.swift.
@Suite(.serialized)
@MainActor
struct ReplaySessionRefreshLoopTests {
    // Round-5 review Finding F22: `refreshConfigNow()`'s network-body gate
    // now fails closed on a nil `TraceItX.shared.currentConfig` (spec §3 —
    // a nil client config means the `capture.network`/`networkBodies`
    // preconditions can't be confirmed). This suite drives `ReplaySession`
    // directly (not via `TraceItX.start()`), so `currentConfig` would
    // otherwise stay nil throughout — every test below that calls
    // `refreshConfigNow()` sets it via the test-only seam with BOTH client
    // preconditions opted in (matching what a real `start()`'d host with
    // body capture enabled looks like) and restores it to nil via `defer`,
    // mirroring the `@Before`/`@After` `TraceItX.__setConfigForTesting`
    // seam Android's `ReplaySessionRefreshLoopTest.kt` added for the same
    // finding. Tests only assert on the SERVER block / sampling behavior,
    // so this fixed client config keeps that the only variable.
    private func setClientConfigForTesting() {
        TraceItX.__setConfigForTesting(
            TraceItXConfig(appId: "app", capture: CaptureConfig(network: true, networkBodies: true)))
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

    // Report Resource Window (spec 2026-09-05) — negotiation-gap fix. Proves
    // `ResourceRingBuffer.shared.windowSec` is read LIVE off every resolved
    // config, the same seam (`ReplaySession.applyConfig`) that already
    // live-applies breadcrumbs/networkBodies above — a config refresh must
    // apply without an SDK restart, and a malformed `windowSec` alone must
    // fall back to the default rather than losing the whole block.
    @Test func periodicReReadAppliesResourcesWindowSecLive() async {
      await withGlobalCaptureStateLock {
        setClientConfigForTesting()
        defer { TraceItX.__setConfigForTesting(nil) }

        let originalWindow = ResourceRingBuffer.shared.windowSec
        defer { ResourceRingBuffer.shared.windowSec = originalWindow }

        let clock = MutableClock(0)
        let fetcher = StubFetcher([
            body(#"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "resources":{"enabled":true,"windowSec":120}}
            """#),
            // A malformed windowSec on the SAME live config must fall back
            // to the default, not freeze the previous (non-default) value —
            // proving this is read fresh every cycle, not cached once.
            body(#"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "resources":{"enabled":true,"windowSec":-5}}
            """#),
        ])
        let session = makeSession(fetcher: fetcher, clock: clock)

        await session.refreshConfigNow()
        #expect(ResourceRingBuffer.shared.windowSec == 120)

        clock.set(400)
        await session.refreshConfigNow()
        #expect(ResourceRingBuffer.shared.windowSec == ResourceRingBuffer.defaultWindowSec)
      }
    }

    // Report Resource Window (spec 2026-09-05) — lifecycle wiring follow-up.
    // An app with the feature switched off must do NO sampling work at all,
    // not merely ship an empty/absent `payload.resources` — a running timer
    // that happens to no-op at `append` still burns CPU/battery polling
    // `task_info` every 2s.
    @Test func samplerDoesNotRunWhenResourcesDisabled() async {
      await withGlobalCaptureStateLock {
        setClientConfigForTesting()
        defer { TraceItX.__setConfigForTesting(nil) }

        let clock = MutableClock(0)
        let fetcher = StubFetcher([
            body(#"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "resources":{"enabled":false,"windowSec":60}}
            """#),
        ])
        let session = makeSession(fetcher: fetcher, clock: clock)
        defer { session.teardown() }

        await session.refreshConfigNow()
        #expect(!session.__resourceSamplerIsRunningForTesting)
      }
    }

    // The non-vacuity control: the SAME config shape, `enabled: true`, DOES
    // start the sampler — proving the case above tests the enabled gate
    // specifically, not e.g. a sampler that never starts at all.
    @Test func samplerRunsWhenResourcesEnabled() async {
      await withGlobalCaptureStateLock {
        setClientConfigForTesting()
        defer { TraceItX.__setConfigForTesting(nil) }

        let clock = MutableClock(0)
        let fetcher = StubFetcher([
            body(#"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "resources":{"enabled":true,"windowSec":60}}
            """#),
        ])
        let session = makeSession(fetcher: fetcher, clock: clock)
        defer { session.teardown() }

        await session.refreshConfigNow()
        #expect(session.__resourceSamplerIsRunningForTesting)
      }
    }

    // `teardown()` — the same call `TraceItX.kill()` and a superseding
    // `start()` both make — must genuinely stop the sampler (invalidate its
    // timer), not merely leave it ticking into a ring that separately
    // no-ops on the kill gate.
    @Test func teardownStopsTheSampler() async {
      await withGlobalCaptureStateLock {
        setClientConfigForTesting()
        defer { TraceItX.__setConfigForTesting(nil) }

        let clock = MutableClock(0)
        let fetcher = StubFetcher([
            body(#"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "resources":{"enabled":true,"windowSec":60}}
            """#),
        ])
        let session = makeSession(fetcher: fetcher, clock: clock)

        await session.refreshConfigNow()
        #expect(session.__resourceSamplerIsRunningForTesting)

        session.teardown()
        #expect(!session.__resourceSamplerIsRunningForTesting)
      }
    }

    // The server flipping `enabled` false -> true on a LATER refresh (the
    // ~300s periodic re-read, simulated here via a second `refreshConfigNow()`
    // past the provider's TTL) must start sampling with no SDK restart —
    // same "applies live" doctrine as `periodicReReadAppliesResourcesWindowSecLive`
    // above.
    @Test func samplerStartsOnALiveConfigFlipFromDisabledToEnabled() async {
      await withGlobalCaptureStateLock {
        setClientConfigForTesting()
        defer { TraceItX.__setConfigForTesting(nil) }

        let clock = MutableClock(0)
        let fetcher = StubFetcher([
            body(#"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "resources":{"enabled":false,"windowSec":60}}
            """#),
            body(#"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "resources":{"enabled":true,"windowSec":60}}
            """#),
        ])
        let session = makeSession(fetcher: fetcher, clock: clock)
        defer { session.teardown() }

        await session.refreshConfigNow()
        #expect(!session.__resourceSamplerIsRunningForTesting)

        clock.set(400)
        await session.refreshConfigNow()
        #expect(session.__resourceSamplerIsRunningForTesting)
      }
    }

    @Test func periodicReReadDeactivatesGateAfterServerFlipsCaptureBodiesOff() async {
      await withGlobalCaptureStateLock {
        NetworkBodyCaptureGate.shared.resetForTesting()
        defer { NetworkBodyCaptureGate.shared.resetForTesting() }
        setClientConfigForTesting()
        defer { TraceItX.__setConfigForTesting(nil) }

        let clock = MutableClock(0)
        let fetcher = StubFetcher([
            body(#"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "networkBodies":{"captureBodies":true}}
            """#),
            body(#"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "networkBodies":{"captureBodies":false}}
            """#),
        ])
        let session = makeSession(fetcher: fetcher, clock: clock)

        // Initial read (what enableIfConfigured() does at start()): server ON,
        // samplingRate 1.0 -> always sampled in -> gate active.
        await session.refreshConfigNow()
        #expect(NetworkBodyCaptureGate.shared.isActive)

        // Simulate the periodic loop's next tick (past the provider's TTL) by
        // invoking the SAME seam again directly — no sleep, no real network.
        clock.set(400)
        await session.refreshConfigNow()

        // The kill-switch reaches the gate without a process restart.
        #expect(!NetworkBodyCaptureGate.shared.isActive)
        #expect(fetcher.callCount == 2)
      }
    }

    @Test func stickySamplingDrawIsNotReDrawnOnPeriodicReRead() async {
      await withGlobalCaptureStateLock {
        NetworkBodyCaptureGate.shared.resetForTesting()
        defer { NetworkBodyCaptureGate.shared.resetForTesting() }
        setClientConfigForTesting()
        defer { TraceItX.__setConfigForTesting(nil) }

        let clock = MutableClock(0)
        let fetcher = StubFetcher([
            // samplingRate 0 -> sampled OUT on the first read, sticky.
            body(#"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":0,
            "networkBodies":{"captureBodies":true}}
            """#),
            // Second read raises samplingRate to 1 -- must NOT re-draw
            // (NetworkBodyCaptureGate's one-shot sampling draw, spec §3).
            body(#"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "networkBodies":{"captureBodies":true}}
            """#),
        ])
        let session = makeSession(fetcher: fetcher, clock: clock)

        await session.refreshConfigNow()
        #expect(!NetworkBodyCaptureGate.shared.isActive)

        clock.set(400)
        await session.refreshConfigNow()
        #expect(!NetworkBodyCaptureGate.shared.isActive)
      }
    }

    /// Final-review Finding 5 (failed refresh must fail the body gate
    /// closed): the provider fails closed by keeping its last-good cache on
    /// a failed fetch, so `refreshConfigNow()` re-reading `provider.current`
    /// after a failed forced fetch used to see the SAME stale ON block as
    /// before and kept re-arming the gate active forever — an
    /// unreachable/malformed config could never turn capture back off once
    /// it had been on. `refreshConfigNow()` must instead notice the fetch
    /// itself failed (via `refresh(force:)`'s Bool return) and explicitly
    /// deactivate the gate, THEN reactivate once a later fetch actually
    /// succeeds with an ON block again.
    @Test func refreshConfigNowFailsGateClosedOnFailedFetchThenReactivatesOnNextSuccess() async {
      await withGlobalCaptureStateLock {
        NetworkBodyCaptureGate.shared.resetForTesting()
        defer { NetworkBodyCaptureGate.shared.resetForTesting() }
        setClientConfigForTesting()
        defer { TraceItX.__setConfigForTesting(nil) }

        let onBody = body(#"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "networkBodies":{"captureBodies":true}}
            """#)
        // Same provider/session throughout, so its last-good cache genuinely
        // persists an ON block across the failed middle call — exactly the
        // scenario the bug depended on (a stale cached ON block getting
        // blindly re-applied by a caller that only ever reads `.current`).
        let clock = MutableClock(0)
        let fetcher = ScriptedFetcher([.success(onBody), .failure, .success(onBody)])
        let session = makeSession(fetcher: fetcher, clock: clock)

        // Call 1: successful ON read arms the gate active (samplingRate 1.0
        // -> always sampled in).
        await session.refreshConfigNow()
        #expect(NetworkBodyCaptureGate.shared.isActive)

        // Call 2: fetch fails — provider's cache silently keeps the ON block
        // from call 1, but refreshConfigNow must notice THIS fetch failed and
        // deactivate the gate rather than re-arming off the stale cache.
        clock.set(400)
        await session.refreshConfigNow()
        #expect(!NetworkBodyCaptureGate.shared.isActive, "a failed refresh must fail the gate closed")

        // Call 3: fetch succeeds again with an ON block — reactivates. The
        // sticky sampling draw (already true from call 1) is honored, not
        // re-drawn.
        clock.set(800)
        await session.refreshConfigNow()
        #expect(NetworkBodyCaptureGate.shared.isActive)
        #expect(fetcher.callCount == 3)
      }
    }

    // ==================== Round-6 review Finding F28 ====================
    //
    // End-to-end (provider fetch -> refreshConfigNow -> gate): a server
    // config with `networkBodies.captureBodies: true` but breadcrumbs
    // off/network-excluding must leave the CAPTURE gate inactive, not just
    // filter at encode time — nothing should ever enter the body buffer in
    // the first place.

    @Test func serverOnButBreadcrumbsDisabledEndToEndStaysInactive() async {
      await withGlobalCaptureStateLock {
        NetworkBodyCaptureGate.shared.resetForTesting()
        defer { NetworkBodyCaptureGate.shared.resetForTesting() }
        setClientConfigForTesting()
        defer { TraceItX.__setConfigForTesting(nil) }

        let clock = MutableClock(0)
        let fetcher = StubFetcher([
            body(#"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "breadcrumbs":{"enabled":false,"kinds":["network"],"maxCount":100,"byteBudget":16384,"consoleEntryCap":1024},
            "networkBodies":{"captureBodies":true}}
            """#),
        ])
        let session = makeSession(fetcher: fetcher, clock: clock)

        await session.refreshConfigNow()
        #expect(!NetworkBodyCaptureGate.shared.isActive, "breadcrumbs disabled must keep the capture gate off despite server bodies ON")
      }
    }

    @Test func serverOnButBreadcrumbKindsOmitNetworkEndToEndStaysInactive() async {
      await withGlobalCaptureStateLock {
        NetworkBodyCaptureGate.shared.resetForTesting()
        defer { NetworkBodyCaptureGate.shared.resetForTesting() }
        setClientConfigForTesting()
        defer { TraceItX.__setConfigForTesting(nil) }

        let clock = MutableClock(0)
        let fetcher = StubFetcher([
            body(#"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "breadcrumbs":{"enabled":true,"kinds":["console","tap"],"maxCount":100,"byteBudget":16384,"consoleEntryCap":1024},
            "networkBodies":{"captureBodies":true}}
            """#),
        ])
        let session = makeSession(fetcher: fetcher, clock: clock)

        await session.refreshConfigNow()
        #expect(!NetworkBodyCaptureGate.shared.isActive, "breadcrumb kinds omitting 'network' must keep the capture gate off despite server bodies ON")
      }
    }

    @Test func serverOnBreadcrumbsEnabledWithNetworkEndToEndBecomesActive() async {
      await withGlobalCaptureStateLock {
        NetworkBodyCaptureGate.shared.resetForTesting()
        defer { NetworkBodyCaptureGate.shared.resetForTesting() }
        setClientConfigForTesting()
        defer { TraceItX.__setConfigForTesting(nil) }

        let clock = MutableClock(0)
        let fetcher = StubFetcher([
            body(#"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "breadcrumbs":{"enabled":true,"kinds":["console","network"],"maxCount":100,"byteBudget":16384,"consoleEntryCap":1024},
            "networkBodies":{"captureBodies":true}}
            """#),
        ])
        let session = makeSession(fetcher: fetcher, clock: clock)

        await session.refreshConfigNow()
        #expect(NetworkBodyCaptureGate.shared.isActive, "the happy path must not be over-gated by the F28 fix")
      }
    }

    @Test func absentBreadcrumbsBlockEndToEndStaysActive() async {
      await withGlobalCaptureStateLock {
        // Matches BreadcrumbRingBuffer.applyConfig(nil)'s own default
        // (enabled + all kinds including network) — an app that never
        // configured breadcrumbs must not have bodies silently disabled.
        NetworkBodyCaptureGate.shared.resetForTesting()
        defer { NetworkBodyCaptureGate.shared.resetForTesting() }
        setClientConfigForTesting()
        defer { TraceItX.__setConfigForTesting(nil) }

        let clock = MutableClock(0)
        let fetcher = StubFetcher([
            body(#"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "networkBodies":{"captureBodies":true}}
            """#),
        ])
        let session = makeSession(fetcher: fetcher, clock: clock)

        await session.refreshConfigNow()
        #expect(NetworkBodyCaptureGate.shared.isActive, "an absent breadcrumbs block must not disable bodies")
      }
    }

    // ==================== Round 17 review, New ====================
    //
    // `refreshConfigNow()` now detects a genuine DISABLED -> ENABLED identity
    // transition right where `_identityEnabledFlag` — the value every submit
    // path actually reads — is already being updated, and reuses the
    // EXISTING `TraceItX.shared.__warmIdentityToken()` entry point rather
    // than a second one. Before this fix, a host installing a provider
    // immediately after `start()` (the documented, recommended integration)
    // found identity disabled — config had not been fetched yet — so the
    // install-time warm correctly no-op'd per round 6's enabled-gate, and
    // NOTHING ever retried it once a LATER config fetch enabled identity:
    // the cache stayed cold until some unrelated reporter-open warm happened
    // to fire, so every capture in between (including a crash) shipped
    // anonymous for the exact integration this SDK recommends.
    //
    // This drives `ReplaySession.refreshConfigNow()` directly, matching the
    // rest of this suite, plus `TraceItX.shared.setIdentityToken(...)` /
    // `_identityHolder` / `__replayConfigOverrideForTesting` — the SAME
    // singleton state `IdentityProviderWarmTests.swift` and
    // `AccountSwitchEvidenceDiscardTests.swift` (XCTest) drive, and the same
    // state `CrashDrainIdentityHeaderTests.swift` / `KillSwitchTests.swift`
    // (the other `@Suite(.serialized)` structs that touch it) already wrap
    // in `withGlobalCaptureStateLock` for exactly this cross-suite reason —
    // so this test does too.

    /// Mirrors the Android twin (`ReplaySessionRefreshLoopTest.kt`'s
    /// `` `a config apply that enables identity retries the warm and caches
    /// the subject` ``) line for line, including the deliberately
    /// short-lived (inside `IDENTITY_REFRESH_MARGIN`, 30s) provider token: a
    /// comfortably long-lived token would pass step 3 below even with the
    /// fix's transition gate removed entirely, because `IdentityTokenHolder
    /// .get(now:)`'s OWN cache would stay comfortably fresh regardless of
    /// which gate (if any) called the warm — only a token near its own
    /// margin actually exercises `refreshConfigNow()`'s gate rather than the
    /// holder's unrelated caching.
    ///
    /// Mutation-verified on the Android twin, both halves independently (see
    /// that test's own doc comment) — NOT independently re-verified here:
    /// this whole file is `#if canImport(UIKit)`-gated and this machine's
    /// installed Xcode/SDK is ahead of CI's pinned version, which hits an
    /// unrelated, pre-existing Swift 6 strict-concurrency failure elsewhere
    /// in the target (`VTreeProducer.swift`/`UIView+Sensitive.swift`,
    /// confirmed via `git stash` to reproduce on the clean tree too) before
    /// `xcodebuild test` ever reaches this file. Written to mirror the
    /// verified Kotlin test and the already-proven, adjacent patterns in
    /// this file and `IdentityProviderWarmTests.swift` as closely as
    /// possible; CI's `lifecycle-tests-iOS` job (pinned Xcode, real
    /// simulator) is the authoritative verifier.
    @Test func aConfigApplyThatEnablesIdentityRetriesTheWarmAndCachesTheSubject() async {
      await withGlobalCaptureStateLock {
        let invoked = CallCounter()
        defer { TraceItX.shared.setIdentityToken(nil) }
        defer { TraceItX.shared.__replayConfigOverrideForTesting = nil }

        TraceItX.shared.setIdentityToken(.provider {
            await invoked.bump()
            return jwt(sub: "alice", exp: Date().addingTimeInterval(10))
        })

        let clock = MutableClock(0)
        let fetcher = StubFetcher([
            // First fetch: identity disabled (matches "config hasn't
            // resolved yet" immediately after start()).
            body(#"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0}
            """#),
            // Every fetch from here on: identity enabled, unchanged.
            body(#"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "identity":{"enabled":true}}
            """#),
        ])
        let session = makeSession(fetcher: fetcher, clock: clock)

        // 1. Install-time warm equivalent: identity starts disabled (no
        //    override armed, matching config not yet fetched), so the warm
        //    `setIdentityToken()` already fired above must have no-op'd.
        await session.refreshConfigNow()
        var calls = await invoked.value
        #expect(calls == 0, "fixture sanity: the provider must not be invoked while identity is disabled")

        // 2. THE fix under test: config now enables identity. The real
        //    `TraceItX.shared.currentReplayConfig()` (what
        //    `__warmIdentityToken()`'s own gate re-reads) must agree, so arm
        //    the same enabled config there via the test override before
        //    advancing the clock and re-fetching.
        TraceItX.shared.__replayConfigOverrideForTesting = ReplayConfig(
            replayEnabled: false, replayDurationSec: 30, samplingRate: 1.0,
            identity: IdentityConfigWire(enabled: true)
        )
        clock.set(400)
        await session.refreshConfigNow()

        await poll { await invoked.value >= 1 }
        calls = await invoked.value
        #expect(
            calls == 1,
            "the disabled -> enabled transition must retry the warm and invoke the provider exactly once"
        )

        await poll { TraceItX.shared._identityHolder.cachedSubject(now: Date()) != nil }
        #expect(
            TraceItX.shared._identityHolder.cachedSubject(now: Date()) == "alice",
            "the subject must be cached without any reporter ever opening"
        )

        // 3. A periodic refresh that LEAVES identity enabled (the ordinary
        //    ~300s tick) must NOT re-invoke the provider.
        clock.set(800)
        await session.refreshConfigNow()
        try? await Task.sleep(nanoseconds: 300_000_000)  // fair chance for an (unwanted) re-invocation to land
        calls = await invoked.value
        #expect(calls == 1, "a config refresh that leaves identity enabled must not re-invoke the provider")
      }
    }
}
#endif
