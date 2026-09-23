// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// LogRingBuffer behavior + LogCapture install/uninstall idempotency.
// Capacity/eviction tests use `honorsKillGate: false` to dodge cross-suite
// parallel races on Everframe.shared.captureGate (see NetworkRingBufferTests).
import Testing
import Foundation
@testable import EverframeKit

@MainActor
@Suite(.serialized)
struct LogRingBufferTests {
    private func makeEntry(_ msg: String) -> LogEntry {
        LogEntry(timestamp: Date(), level: "default", message: msg)
    }

    @Test func appendsUpToCapacity() {
        let buf = LogRingBuffer(capacity: 5, honorsKillGate: false)
        for i in 0..<5 { buf.append(makeEntry("m\(i)")) }
        #expect(buf.snapshot().count == 5)
    }

    @Test func fifoEvictionPastCapacity() {
        let buf = LogRingBuffer(capacity: 3, honorsKillGate: false)
        for i in 0..<10 { buf.append(makeEntry("m\(i)")) }
        let snap = buf.snapshot()
        #expect(snap.count == 3)
        #expect(snap.first?.message == "m7")
        #expect(snap.last?.message == "m9")
    }

    @Test func killGateBlocksAppend() throws {
        try Everframe.shared.start(config: .init(appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"))
        Everframe.shared.kill()
        let buf = LogRingBuffer(capacity: 10)  // gate-honoring
        buf.append(makeEntry("blocked"))
        #expect(buf.snapshot().count == 0)
        try Everframe.shared.start(config: .init(appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"))
    }

    @Test func sharedDefaultCapacityIs100() {
        // Memory-bounded to the last 100 log lines (matches web + Android).
        #expect(LogRingBuffer.shared.capacity == 100)
    }

    @Test func logCaptureInstallIsIdempotent() {
        // Calling install() twice must not crash and must not double-install.
        LogCapture.install()
        LogCapture.install()
        #expect(StderrIntercept.installedForTesting == true)
        LogCapture.uninstall()
        #expect(StderrIntercept.installedForTesting == false)
        // Idempotent uninstall too
        LogCapture.uninstall()
        #expect(StderrIntercept.installedForTesting == false)
    }
}
