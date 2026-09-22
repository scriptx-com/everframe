// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Final-review Finding 1 (post-kill capture, 2026-08-01-network-body-capture-native):
// TraceItX.kill() used to flip captureGate and zeroize buffers but left
// NetworkBodyCaptureGate.shared active and the ReplaySession's periodic
// config-refresh loop running — a post-kill request could still pass the
// gate's (stale) isActive check, and a still-running periodic refresh could
// keep re-arming it off a cached ON config. kill() must both deactivate the
// gate (NetworkBodyCaptureGate.reset() — see Finding 3) and tear down the
// replay session (nil `_replaySession`, letting `deinit` cancel its refresh
// loop `Task`). This file covers the gate-reset and replay-session-teardown
// halves; NetworkBodyRingBufferTests.killGateBlocksAppend covers the
// buffer-level defense, and NetworkCaptureProtocol.swift's
// `TraceItX.shared.captureGate` check (not independently unit-testable
// without a live-HTTP harness — see that file) covers the URLProtocol
// completion-handler race.
#if canImport(UIKit)
import Testing
import Foundation
@testable import TraceItXKit

@MainActor
@Suite(.serialized)
struct KillTeardownTests {
    private let testAppId = "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"

    // Round-6 review Finding F31: every test in this file drives
    // `TraceItX.shared`/`NetworkBodyCaptureGate.shared` for real — each is
    // wrapped in `withGlobalCaptureStateLock` so it cannot interleave with
    // any other suite doing the same (see
    // Helpers/GlobalCaptureStateTestLock.swift).
    @Test func killDeactivatesAndResetsTheNetworkBodyGate() async throws {
        try await withGlobalCaptureStateLock {
            NetworkBodyCaptureGate.shared.resetForTesting()
            defer { NetworkBodyCaptureGate.shared.resetForTesting() }

            // Arm the gate active, as if a config refresh had turned it ON
            // before kill() fires.
            NetworkBodyCaptureGate.shared.applyConfig(
                NetworkBodiesConfigWire(
                    captureBodies: true, bodyByteCap: 4096, bodyContentTypes: nil, bodyTotalBudget: nil),
                samplingRate: 1.0, locallyDisabled: false, random: { 0.0 })
            #expect(NetworkBodyCaptureGate.shared.isActive)

            try TraceItX.shared.start(config: .init(appId: testAppId))
            TraceItX.shared.kill()

            #expect(!NetworkBodyCaptureGate.shared.isActive)
            // reset() (not just deactivation) — boot-time defaults restored too.
            #expect(NetworkBodyCaptureGate.shared.bodyByteCap == NetworkBodyCaptureGate.defaultBodyByteCap)

            try TraceItX.shared.start(config: .init(appId: testAppId))
        }
    }

    @Test func killTearsDownReplaySessionSoItsPeriodicLoopStops() async throws {
        try await withGlobalCaptureStateLock {
            let config = TraceItXConfig(
                appId: testAppId,
                capture: CaptureConfig(logs: false)
            )
            try TraceItX.shared.start(config: config)
            let armed = await AsyncTestHelpers.waitFor({ TraceItX.__hasReplaySessionForTesting })
            #expect(armed, "replay session never armed within timeout — start()'s heavy init not firing")

            TraceItX.shared.kill()

            let tornDown = await AsyncTestHelpers.waitFor({ !TraceItX.__hasReplaySessionForTesting })
            #expect(tornDown, "kill() must nil the replay session so its periodic refresh loop is cancelled")

            try TraceItX.shared.start(config: config)
        }
    }

    // Codex round-2 fix — `start()`'s session-boundary reset
    // (TraceItX.swift, `_user = nil` section) already clears
    // `CompanionBadgeServerConfigBox` so a new app never inherits the
    // previous one's dashboard-configured badge override; `kill()` had no
    // twin, so an override delivered before `kill()` (e.g. `enabled: true`
    // over an inline `false`, or a position override) survived a kill()
    // indefinitely even though the companion client keeps running by
    // design and nothing is left alive to refresh the override away.
    @Test func killClearsTheCompanionBadgeServerConfigOverride() async throws {
        try await withGlobalCaptureStateLock {
            CompanionBadgeServerConfigBox.shared.value = nil
            defer { CompanionBadgeServerConfigBox.shared.value = nil }
            // Branding (iOS spec 2026-08-26) — kill()'s twin clear, same
            // seed/assert shape as the companion box beside it.
            BrandingServerConfigBox.shared.value = nil
            defer { BrandingServerConfigBox.shared.value = nil }

            let config = TraceItXConfig(appId: testAppId, capture: CaptureConfig(logs: false))
            try TraceItX.shared.start(config: config)

            // Simulate a server override having been delivered before kill() fires.
            CompanionBadgeServerConfigBox.shared.value = CompanionBadgeConfigWire(enabled: true, position: "top-left")
            BrandingServerConfigBox.shared.value = BrandingConfigWire(watermark: false)
            #expect(BrandingServerConfigBox.shared.value != nil, "precondition: a prior app's branding override is installed")

            TraceItX.shared.kill()

            let cleared = await AsyncTestHelpers.waitFor({ CompanionBadgeServerConfigBox.shared.value == nil })
            #expect(cleared, "kill() must clear the badge server-config override so it cannot survive indefinitely")
            let brandingCleared = await AsyncTestHelpers.waitFor({ BrandingServerConfigBox.shared.value == nil })
            #expect(brandingCleared, "kill() must clear the branding server-config override so it cannot survive indefinitely")

            try TraceItX.shared.start(config: config)
        }
    }
}
#endif
