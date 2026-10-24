// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Final-review Finding 1 (post-kill capture, 2026-08-01-network-body-capture-native):
// Everframe.kill() used to flip captureGate and zeroize buffers but left
// NetworkBodyCaptureGate.shared active and the ReplaySession's periodic
// config-refresh loop running — a post-kill request could still pass the
// gate's (stale) isActive check, and a still-running periodic refresh could
// keep re-arming it off a cached ON config. kill() must both deactivate the
// gate (NetworkBodyCaptureGate.reset() — see Finding 3) and tear down the
// replay session (nil `_replaySession`, letting `deinit` cancel its refresh
// loop `Task`). This file covers the gate-reset and replay-session-teardown
// halves; NetworkBodyRingBufferTests.killGateBlocksAppend covers the
// buffer-level defense, and NetworkCaptureProtocol.swift's
// `Everframe.shared.captureGate` check (not independently unit-testable
// without a live-HTTP harness — see that file) covers the URLProtocol
// completion-handler race.
#if canImport(UIKit)
import Testing
import Foundation
@testable import EverframeKit

@MainActor
@Suite(.serialized)
struct KillTeardownTests {
    private let testSdkKey = "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"

    // Round-6 review Finding F31: every test in this file drives
    // `Everframe.shared`/`NetworkBodyCaptureGate.shared` for real — each is
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

            try Everframe.shared.start(config: .init(sdkKey: testSdkKey))
            Everframe.shared.kill()

            #expect(!NetworkBodyCaptureGate.shared.isActive)
            // reset() (not just deactivation) — boot-time defaults restored too.
            #expect(NetworkBodyCaptureGate.shared.bodyByteCap == NetworkBodyCaptureGate.defaultBodyByteCap)

            try Everframe.shared.start(config: .init(sdkKey: testSdkKey))
        }
    }

    @Test func killTearsDownReplaySessionSoItsPeriodicLoopStops() async throws {
        try await withGlobalCaptureStateLock {
            let config = EverframeConfig(
                sdkKey: testSdkKey,
                capture: CaptureConfig(logs: false)
            )
            try Everframe.shared.start(config: config)
            let armed = await AsyncTestHelpers.waitFor({ Everframe.__hasReplaySessionForTesting })
            #expect(armed, "replay session never armed within timeout — start()'s heavy init not firing")

            Everframe.shared.kill()

            let tornDown = await AsyncTestHelpers.waitFor({ !Everframe.__hasReplaySessionForTesting })
            #expect(tornDown, "kill() must nil the replay session so its periodic refresh loop is cancelled")

            try Everframe.shared.start(config: config)
        }
    }

    // Codex round-2 fix — `start()`'s session-boundary reset
    // (Everframe.swift, `_user = nil` section) clears
    // `BrandingServerConfigBox` so a new app never inherits the previous
    // one's dashboard-configured branding; `kill()` must have the same twin,
    // or a block delivered before `kill()` survives it indefinitely with
    // nothing left alive to refresh it away.
    @Test func killClearsTheBrandingServerConfigOverride() async throws {
        try await withGlobalCaptureStateLock {
            BrandingServerConfigBox.shared.value = nil
            defer { BrandingServerConfigBox.shared.value = nil }

            let config = EverframeConfig(sdkKey: testSdkKey, capture: CaptureConfig(logs: false))
            try Everframe.shared.start(config: config)

            // Simulate a server override having been delivered before kill() fires.
            BrandingServerConfigBox.shared.value = BrandingConfigWire(watermark: false)
            #expect(BrandingServerConfigBox.shared.value != nil, "precondition: a prior app's branding override is installed")

            Everframe.shared.kill()

            let brandingCleared = await AsyncTestHelpers.waitFor({ BrandingServerConfigBox.shared.value == nil })
            #expect(brandingCleared, "kill() must clear the branding server-config override so it cannot survive indefinitely")

            try Everframe.shared.start(config: config)
        }
    }
}
#endif
