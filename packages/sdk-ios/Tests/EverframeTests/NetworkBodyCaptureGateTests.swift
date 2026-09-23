// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// NetworkBodyCaptureGate: server-authoritative body-capture gate with a
// one-shot sampling draw (CONFIG-04 parity — the draw happens AT MOST ONCE
// per process, on the first `applyConfig` where the server block says ON;
// later refreshes never re-draw, so a sampled-out session cannot flip in
// mid-session and a sampled-in session cannot flip out). Client veto
// (`locallyDisabled`) always wins — fail-closed: a nil server block, a veto,
// or a sampled-out draw all yield `isActive == false`. No flag ever forces
// capture ON.
import Testing
import Foundation
@testable import EverframeKit

@Suite(.serialized)
struct NetworkBodyCaptureGateTests {
    private func wire(
        captureBodies: Bool,
        bodyByteCap: Int? = nil,
        bodyContentTypes: [String]? = nil,
        bodyTotalBudget: Int? = nil
    ) -> NetworkBodiesConfigWire {
        NetworkBodiesConfigWire(
            captureBodies: captureBodies,
            bodyByteCap: bodyByteCap,
            bodyContentTypes: bodyContentTypes,
            bodyTotalBudget: bodyTotalBudget
        )
    }

    @Test func inactiveByDefault() {
        let gate = NetworkBodyCaptureGate()
        #expect(!gate.isActive)
    }

    @Test func activeWhenServerOnAndSampledIn() {
        let gate = NetworkBodyCaptureGate()
        gate.applyConfig(
            wire(captureBodies: true), samplingRate: 0.5,
            locallyDisabled: false, random: { 0.4 })
        #expect(gate.isActive)
    }

    @Test func sampledOutStaysOutAcrossRefreshes() {
        let gate = NetworkBodyCaptureGate()
        gate.applyConfig(
            wire(captureBodies: true), samplingRate: 0.5,
            locallyDisabled: false, random: { 0.9 })  // out
        gate.applyConfig(
            wire(captureBodies: true), samplingRate: 0.5,
            locallyDisabled: false, random: { 0.0 })  // would be in — must NOT re-draw
        #expect(!gate.isActive)
    }

    @Test func clientVetoWins() {
        let gate = NetworkBodyCaptureGate()
        gate.applyConfig(
            wire(captureBodies: true), samplingRate: 1.0,
            locallyDisabled: true, random: { 0.0 })
        #expect(!gate.isActive)
    }

    // ==================== Round-5 review Finding F22 ====================
    //
    // The privacy gate (spec §3) is:
    //     captureBodies = serverConfig.captureBodies
    //                   && capture.network == true
    //                   && capture.networkBodies != false
    //                   && sampledIn
    // §3.1's original "structural precondition" claim for `capture.network`
    // was wrong: `networkCaptureConfiguration()` attaches
    // `EFNetworkCaptureProtocol` unconditionally, never reading
    // `capture.network`, so a host leaving it at its default `false` still
    // got metadata capture — and, pre-fix, still got BODY capture whenever
    // the server block was ON. These specs drive
    // `NetworkBodyCaptureGate.locallyDisabled(for:)` (the fix) through the
    // full `applyConfig` composition, exactly like `clientVetoWins` above.

    @Test func serverOnButCaptureNetworkLeftAtDefaultFalseStaysInactive() {
        let gate = NetworkBodyCaptureGate()
        // `capture.network` defaults to false; `capture.networkBodies`
        // defaults to true (no explicit client veto) — the exact scenario a
        // host gets by leaving `CaptureConfig` untouched.
        let config = EverframeConfig(appId: "app", capture: .defaults)
        gate.applyConfig(
            wire(captureBodies: true), samplingRate: 1.0,
            locallyDisabled: NetworkBodyCaptureGate.locallyDisabled(for: config),
            random: { 0.0 })
        #expect(!gate.isActive, "capture.network left at its default false must keep bodies off even with server ON")
    }

    @Test func serverOnNetworkTrueButNetworkBodiesVetoStaysInactive() {
        let gate = NetworkBodyCaptureGate()
        let config = EverframeConfig(
            appId: "app", capture: CaptureConfig(network: true, networkBodies: false))
        gate.applyConfig(
            wire(captureBodies: true), samplingRate: 1.0,
            locallyDisabled: NetworkBodyCaptureGate.locallyDisabled(for: config),
            random: { 0.0 })
        #expect(!gate.isActive, "existing networkBodies veto behavior must survive the F22 fix")
    }

    @Test func serverOnNetworkTrueAndNetworkBodiesTrueBecomesActive() {
        let gate = NetworkBodyCaptureGate()
        let config = EverframeConfig(
            appId: "app", capture: CaptureConfig(network: true, networkBodies: true))
        gate.applyConfig(
            wire(captureBodies: true), samplingRate: 1.0,
            locallyDisabled: NetworkBodyCaptureGate.locallyDisabled(for: config),
            random: { 0.0 })
        #expect(gate.isActive, "the happy path (both flags opted in) must not be over-gated by the F22 fix")
    }

    @Test func nilClientConfigFailsClosedEvenWithServerOn() {
        let gate = NetworkBodyCaptureGate()
        gate.applyConfig(
            wire(captureBodies: true), samplingRate: 1.0,
            locallyDisabled: NetworkBodyCaptureGate.locallyDisabled(for: nil),
            random: { 0.0 })
        #expect(!gate.isActive, "a nil/absent client config (pre-start) must fail closed")
    }

    @Test func nilBlockIsFailClosed() {
        let gate = NetworkBodyCaptureGate()
        gate.applyConfig(nil, samplingRate: 1.0, locallyDisabled: false, random: { 0.0 })
        #expect(!gate.isActive)
    }

    @Test func capsFallBackToDefaults() {
        let gate = NetworkBodyCaptureGate()
        gate.applyConfig(
            wire(captureBodies: true), samplingRate: 1.0,
            locallyDisabled: false, random: { 0.0 })
        #expect(gate.bodyByteCap == 8192)
        #expect(gate.bodyContentTypes == ["application/json", "text/*"])
    }

    @Test func serverCapsApply() {
        let gate = NetworkBodyCaptureGate()
        gate.applyConfig(
            wire(captureBodies: true, bodyByteCap: 4096, bodyContentTypes: ["application/json"]),
            samplingRate: 1.0, locallyDisabled: false, random: { 0.0 })
        #expect(gate.bodyByteCap == 4096)
        #expect(gate.bodyContentTypes == ["application/json"])
    }

    @Test func reqIdsAreMonotonic() {
        let gate = NetworkBodyCaptureGate()
        let first = gate.mintReqId()
        let second = gate.mintReqId()
        #expect(first < second)
    }

    @Test func resetForTestingRestoresDefaults() {
        let gate = NetworkBodyCaptureGate()
        gate.applyConfig(
            wire(captureBodies: true, bodyByteCap: 4096), samplingRate: 1.0,
            locallyDisabled: false, random: { 0.0 })
        _ = gate.mintReqId()
        gate.resetForTesting()
        #expect(!gate.isActive)
        #expect(gate.bodyByteCap == 8192)
        #expect(gate.bodyContentTypes == ["application/json", "text/*"])
        #expect(gate.mintReqId() == 1)
    }

    /// Final-review Finding 3 (process-lifetime sampling): `sampleDraw` was
    /// only ever cleared by the test-only `resetForTesting()` — a production
    /// kill()/start() cycle reused the OLD process's draw even though a new
    /// session (possibly a new config/samplingRate) should get a fresh one.
    /// This drives the production `reset()` seam directly: draw IN at
    /// samplingRate 1.0, `reset()`, then re-apply with samplingRate 0 (which
    /// would draw OUT) and a `random` that would draw IN at any nonzero rate
    /// — if the old draw were still sticky the gate would stay active
    /// (wrongly). It must instead honor the fresh draw and go inactive.
    // ==================== Round-6 review Finding F28 ====================
    //
    // Bodies are meaningless without a correlating SHIPPED network
    // breadcrumb (EnvelopeBuilder drops any `ref` with no matching crumb) —
    // `networkBodiesConfig.captureBodies` was independently toggleable from
    // `breadcrumbsConfig`, so a server config with bodies ON but breadcrumbs
    // OFF (or `kinds` omitting `network`) silently captured, then silently
    // dropped, every body. These specs drive
    // `NetworkBodyCaptureGate.breadcrumbsExcludeNetwork(_:)` through the
    // full `applyConfig` composition, exactly like the F22 specs above.

    private func crumbs(
        enabled: Bool, kinds: [String] = ["console", "custom", "error", "lifecycle", "navigation", "network", "tap"]
    ) -> BreadcrumbsConfigWire {
        BreadcrumbsConfigWire(enabled: enabled, kinds: kinds, maxCount: 100, byteBudget: 16384, consoleEntryCap: 1024)
    }

    @Test func serverOnButBreadcrumbsDisabledStaysInactive() {
        let gate = NetworkBodyCaptureGate()
        gate.applyConfig(
            wire(captureBodies: true), samplingRate: 1.0,
            locallyDisabled: NetworkBodyCaptureGate.breadcrumbsExcludeNetwork(crumbs(enabled: false)),
            random: { 0.0 })
        #expect(!gate.isActive, "breadcrumbs disabled must keep bodies off even with server ON")
    }

    @Test func serverOnButBreadcrumbKindsOmitNetworkStaysInactive() {
        let gate = NetworkBodyCaptureGate()
        let noNetwork = crumbs(enabled: true, kinds: ["console", "custom", "error", "lifecycle", "navigation", "tap"])
        gate.applyConfig(
            wire(captureBodies: true), samplingRate: 1.0,
            locallyDisabled: NetworkBodyCaptureGate.breadcrumbsExcludeNetwork(noNetwork),
            random: { 0.0 })
        #expect(!gate.isActive, "breadcrumb kinds omitting 'network' must keep bodies off even with server ON")
    }

    @Test func serverOnBreadcrumbsEnabledWithNetworkKindBecomesActive() {
        let gate = NetworkBodyCaptureGate()
        gate.applyConfig(
            wire(captureBodies: true), samplingRate: 1.0,
            locallyDisabled: NetworkBodyCaptureGate.breadcrumbsExcludeNetwork(crumbs(enabled: true)),
            random: { 0.0 })
        #expect(gate.isActive, "the happy path (breadcrumbs on, network kind included) must not be over-gated by the F28 fix")
    }

    @Test func absentBreadcrumbsBlockMatchesBreadcrumbRingBufferDefaultAndStaysActive() {
        // `BreadcrumbRingBuffer.applyConfig(nil)` defaults to enabled + all 7
        // kinds (including `network`) — an unconfigured breadcrumbs block
        // must NOT disable bodies, matching that exact default.
        let gate = NetworkBodyCaptureGate()
        gate.applyConfig(
            wire(captureBodies: true), samplingRate: 1.0,
            locallyDisabled: NetworkBodyCaptureGate.breadcrumbsExcludeNetwork(nil),
            random: { 0.0 })
        #expect(gate.isActive, "an absent breadcrumbs block must not disable bodies")
    }

    @Test func breadcrumbsExcludeNetworkPureFunction() {
        #expect(NetworkBodyCaptureGate.breadcrumbsExcludeNetwork(nil) == false)
        #expect(NetworkBodyCaptureGate.breadcrumbsExcludeNetwork(crumbs(enabled: false)) == true)
        #expect(NetworkBodyCaptureGate.breadcrumbsExcludeNetwork(
            crumbs(enabled: true, kinds: ["console"])) == true)
        #expect(NetworkBodyCaptureGate.breadcrumbsExcludeNetwork(crumbs(enabled: true)) == false)
    }

    // ==================== Round-7 review Finding F34 ====================
    //
    // A remote `captureBodies: false` must be authoritative at the final
    // append/sink boundary, not just at the pre-`makeEntry` decision point.
    // These specs drive the generation counter itself; the buffer-side
    // enforcement (`NetworkBodyRingBuffer.append(_:guard:)`) is covered in
    // `NetworkBodyRingBufferTests.swift`.

    @Test func generationStartsAtZeroAndIsStableAcrossNoOpApplyConfigCalls() {
        let gate = NetworkBodyCaptureGate()
        let first = gate.snapshotActive().generation
        // Repeating the exact same inactive config must not bump the
        // generation — nothing about the effective `active` bit changed.
        gate.applyConfig(nil, samplingRate: 1.0, locallyDisabled: false, random: { 0.0 })
        #expect(gate.snapshotActive().generation == first)
    }

    @Test func generationBumpsOnTransitionToActive() {
        let gate = NetworkBodyCaptureGate()
        let before = gate.snapshotActive().generation
        gate.applyConfig(
            wire(captureBodies: true), samplingRate: 1.0, locallyDisabled: false, random: { 0.0 })
        #expect(gate.isActive)
        #expect(gate.snapshotActive().generation != before)
    }

    @Test func generationBumpsOnTransitionToInactive() {
        let gate = NetworkBodyCaptureGate()
        gate.applyConfig(
            wire(captureBodies: true), samplingRate: 1.0, locallyDisabled: false, random: { 0.0 })
        let whileActive = gate.snapshotActive().generation
        // Remote refresh flips the server block OFF — the exact F34 scenario.
        gate.applyConfig(
            wire(captureBodies: false), samplingRate: 1.0, locallyDisabled: false, random: { 0.0 })
        #expect(!gate.isActive)
        #expect(gate.snapshotActive().generation != whileActive)
    }

    @Test func generationDoesNotBumpWhenActiveStaysTrueAcrossRefreshes() {
        let gate = NetworkBodyCaptureGate()
        gate.applyConfig(
            wire(captureBodies: true), samplingRate: 1.0, locallyDisabled: false, random: { 0.0 })
        let firstActive = gate.snapshotActive()
        // A second refresh that keeps the server block ON (e.g. just
        // changing bodyByteCap) must not invalidate an already-captured,
        // still-valid token.
        gate.applyConfig(
            wire(captureBodies: true, bodyByteCap: 4096), samplingRate: 1.0,
            locallyDisabled: false, random: { 0.0 })
        let secondActive = gate.snapshotActive()
        #expect(secondActive.active)
        #expect(secondActive.generation == firstActive.generation)
    }

    @Test func isActiveForGenerationRejectsStaleGenerationEvenWhenActiveAgain() {
        let gate = NetworkBodyCaptureGate()
        gate.applyConfig(
            wire(captureBodies: true), samplingRate: 1.0, locallyDisabled: false, random: { 0.0 })
        let staleGeneration = gate.snapshotActive().generation

        // Flip OFF then back ON — a NEW generation, even though `active`
        // ends up true again exactly like it started.
        gate.applyConfig(nil, samplingRate: 1.0, locallyDisabled: false, random: { 0.0 })
        gate.applyConfig(
            wire(captureBodies: true), samplingRate: 1.0, locallyDisabled: false, random: { 0.0 })
        #expect(gate.isActive)
        #expect(
            !gate.isActive(forGeneration: staleGeneration),
            "a token captured before an OFF/ON cycle must not validate against the new cycle's generation")
        #expect(gate.isActive(forGeneration: gate.snapshotActive().generation))
    }

    @Test func resetBumpsGenerationUnconditionally() {
        let gate = NetworkBodyCaptureGate()
        // Gate never activated — `active` is false both before and after
        // `reset()` — but reset() is itself a session boundary and must
        // still invalidate any token captured before it.
        let before = gate.snapshotActive().generation
        gate.reset()
        #expect(gate.snapshotActive().generation != before)
        #expect(!gate.isActive(forGeneration: before))
    }

    // ==================== Round-8 review Finding F39 ====================
    //
    // `applyConfig`'s new `guard` parameter (mirrors `NetworkBodyRingBuffer
    // .append(_:guard:)`'s F34 guard and Android's
    // `NetworkBodyCaptureState.applyConfig`'s F26 guard for this exact
    // method) — evaluated INSIDE `lock`, before any mutation. These specs
    // drive the parameter directly; the actual race it closes
    // (`ReplaySession.refreshConfigNow()`'s epoch check racing a
    // background-thread `start()`/`kill()`) is covered end-to-end in
    // `StartEpochApplyRaceTests.swift`.

    @Test func guardReturningFalseSkipsTheMutationEntirely() {
        let gate = NetworkBodyCaptureGate()
        gate.applyConfig(
            wire(captureBodies: true), samplingRate: 1.0,
            locallyDisabled: false, random: { 0.0 },
            guard: { false })
        #expect(!gate.isActive, "a guard returning false must skip the mutation, including the sampling draw")
    }

    @Test func guardReturningTrueAppliesNormally() {
        let gate = NetworkBodyCaptureGate()
        gate.applyConfig(
            wire(captureBodies: true), samplingRate: 1.0,
            locallyDisabled: false, random: { 0.0 },
            guard: { true })
        #expect(gate.isActive, "a guard returning true must not block a normal apply")
    }

    @Test func nilGuardAppliesNormallyMatchingEveryOtherTestInThisFile() {
        let gate = NetworkBodyCaptureGate()
        gate.applyConfig(
            wire(captureBodies: true), samplingRate: 1.0,
            locallyDisabled: false, random: { 0.0 },
            guard: nil)
        #expect(gate.isActive, "a nil guard (the default) must behave exactly like every other test in this file")
    }

    @Test func guardReturningFalseDoesNotConsumeTheOneShotSamplingDraw() {
        let gate = NetworkBodyCaptureGate()
        // A rejected apply must not burn the sticky one-shot draw — a LATER,
        // successful apply (guard true) must still get to draw fresh.
        gate.applyConfig(
            wire(captureBodies: true), samplingRate: 0.0,
            locallyDisabled: false, random: { 0.0 },
            guard: { false })
        gate.applyConfig(
            wire(captureBodies: true), samplingRate: 1.0,
            locallyDisabled: false, random: { 0.0 },
            guard: { true })
        #expect(gate.isActive, "a guard-rejected apply must not have pre-drawn (and stuck) sampling for the next apply")
    }

    @Test func resetClearsStickySamplingDrawSoAFreshSessionRedraws() {
        let gate = NetworkBodyCaptureGate()
        gate.applyConfig(
            wire(captureBodies: true), samplingRate: 1.0,
            locallyDisabled: false, random: { 0.0 })  // draws IN
        #expect(gate.isActive)

        gate.reset()
        #expect(!gate.isActive)

        gate.applyConfig(
            wire(captureBodies: true), samplingRate: 0,
            locallyDisabled: false, random: { 0.0 })  // would draw IN at any rate > 0
        #expect(!gate.isActive, "stale sticky draw must not survive reset()")
    }
}
