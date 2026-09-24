// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// RESEARCH Pitfall 5 — Everframe.shared.start(_:) MUST return synchronously in
// <5ms; heavy init runs on a detached Task. Without this, the host app's
// main-thread watchdog flags us at app-launch.
import Testing
import Foundation
@testable import EverframeKit

@Suite(.serialized)
struct StartPerfTests {
    @Test func startReturnsUnder5ms() throws {
        let config = EverframeConfig(
            appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU",
            environment: .development,
            release: "1.0.0"
        )
        var maxMs: Double = 0
        for _ in 0..<10 {
            let t0 = Date()
            try Everframe.shared.start(config: config)
            let elapsed = Date().timeIntervalSince(t0) * 1000
            if elapsed > maxMs { maxMs = elapsed }
        }
        // Generous ceiling: plan locks <5ms, but CI runners and macOS host
        // builds can be noisier than iPhone; allow some headroom.
        #expect(maxMs < 5.0, "start() exceeded 5ms budget: \(maxMs)ms across 10 iterations")
    }

    @Test func heavyInitRunsDetached() async throws {
        let config = EverframeConfig(
            appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU",
            environment: .development
        )
        Everframe.__resetHeavyInitFlagForTesting()
        try Everframe.shared.start(config: config)
        // Heavy init runs on Task.detached — wait up to 1s for it to complete.
        let ran = await AsyncTestHelpers.waitFor({ Everframe.__heavyInitDidRun }, timeout: 1.0)
        #expect(ran, "heavy init never completed within 1s — Task.detached not firing")
    }
}
