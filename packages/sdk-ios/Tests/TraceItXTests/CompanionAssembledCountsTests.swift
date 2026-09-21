// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Task 2 (companion-tv-trail-hardening): `report.assembled` counts must
// reflect the real LogRingBuffer/NetworkRingBuffer contents instead of the
// hard-coded zeros from the initial companion bridge cut.
import Testing
import Foundation
@testable import TraceItXKit

@MainActor
@Suite(.serialized)
struct CompanionAssembledCountsTests {
    @Test func countsReflectRingBuffers() throws {
        // LogRingBuffer.shared honors TraceItX.shared.captureGate (DEFE-03);
        // arm it explicitly rather than relying on suite ordering, same
        // pattern as LogRingBufferTests.killGateBlocksAppend.
        try TraceItX.shared.start(config: .init(appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"))
        LogRingBuffer.shared.clear()
        NetworkRingBuffer.shared.clear()
        defer { LogRingBuffer.shared.clear(); NetworkRingBuffer.shared.clear() }
        LogRingBuffer.shared.append(LogEntry(
            timestamp: Date(), level: "info", message: "m"))
        let counts = CompanionCaptureBridge.currentArtifactCounts()
        #expect(counts.logs == 1)
        #expect(counts.network == 0)
    }
}
