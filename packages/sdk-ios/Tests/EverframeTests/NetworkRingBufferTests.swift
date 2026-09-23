// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// NetworkRingBuffer behavior: capacity, FIFO eviction, kill-gate, thread-safety.
//
// Tests use the internal `honorsKillGate: false` init for capacity/eviction/
// concurrency cases so cross-suite parallel tests that toggle Everframe.shared
// kill-gate cannot race them. The kill-gate behavior itself is exercised in a
// dedicated test that owns the global gate within a serialized suite.
import Testing
import Foundation
@testable import EverframeKit

@MainActor
@Suite(.serialized)
struct NetworkRingBufferTests {
    private func makeEntry(_ i: Int) -> NetworkLogEntry {
        NetworkLogEntry(
            timestamp: Date(timeIntervalSince1970: TimeInterval(i)),
            method: "GET",
            url: "https://example.com/\(i)",
            status: 200,
            durationMs: 1.0,
            requestHeaders: [:],
            responseHeaders: [:]
        )
    }

    @Test func appendsUpToCapacity() {
        let buf = NetworkRingBuffer(capacity: 5, honorsKillGate: false)
        for i in 0..<5 { buf.append(makeEntry(i)) }
        #expect(buf.snapshot().count == 5)
    }

    @Test func fifoEvictionPastCapacity() {
        let buf = NetworkRingBuffer(capacity: 3, honorsKillGate: false)
        for i in 0..<10 { buf.append(makeEntry(i)) }
        let snap = buf.snapshot()
        #expect(snap.count == 3)
        // Last three retained: 7, 8, 9
        #expect(snap.first?.url == "https://example.com/7")
        #expect(snap.last?.url == "https://example.com/9")
    }

    // Round-6 review Finding F31: this test drives `Everframe.shared` for
    // real (start/kill) — wrapped in `withGlobalCaptureStateLock` so it
    // cannot interleave with any other suite doing the same (see that
    // helper's doc comment in Helpers/GlobalCaptureStateTestLock.swift).
    @Test func killGateBlocksAppend() async throws {
        try await withGlobalCaptureStateLock {
            // Re-arm the gate, then drop it, then assert the gate-honoring
            // buffer refuses appends. Restore the gate at the end so
            // siblings (if any happened to wait on us via .serialized) keep
            // working.
            try Everframe.shared.start(config: .init(appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"))
            Everframe.shared.kill()
            let buf = NetworkRingBuffer(capacity: 10)  // gate-honoring
            buf.append(makeEntry(1))
            #expect(buf.snapshot().count == 0)
            try Everframe.shared.start(config: .init(appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"))
        }
    }

    @Test func concurrentAppendsRetainAllUpToCapacity() async {
        let buf = NetworkRingBuffer(capacity: 1000, honorsKillGate: false)
        await withTaskGroup(of: Void.self) { group in
            for t in 0..<8 {
                group.addTask {
                    for i in 0..<50 {
                        buf.append(NetworkLogEntry(timestamp: Date(), method: "GET", url: "t\(t)-i\(i)", status: 200, durationMs: 1, requestHeaders: [:], responseHeaders: [:]))
                    }
                }
            }
        }
        #expect(buf.snapshot().count == 8 * 50)
    }

    @Test func sharedBuffer_isCappedAt100() {
        // The process-wide buffer is memory-bounded to the last 100 requests
        // (matches web + Android). Older entries are evicted, never accumulate.
        #expect(NetworkRingBuffer.shared.capacity == 100)
    }

    // MARK: - PR review round 4 Finding F15 (kill-gate/append race)

    /// Regression for the exact interleaving F15 closes:
    ///   1. append() reads `captureGate == true` (the cheap pre-lock fast path)
    ///   2. kill() flips the gate false, then clear()s the buffer
    ///   3. append() finally acquires the lock and inserts — after zeroization
    /// `preLockHook` pauses `append` right after step 1's read so this test
    /// can force `Everframe.shared.kill()` (which, on `.shared`, synchronously
    /// flips the gate and clears this exact buffer) to run to completion
    /// before releasing `append` into the lock. Uses `NetworkRingBuffer
    /// .shared` (not a fresh instance) so `kill()`'s real production
    /// `clear()` call targets the same buffer `append` is racing into.
    // Round-6 review Finding F31: uses `NetworkRingBuffer.shared` AND
    // `Everframe.shared` for real — wrapped in `withGlobalCaptureStateLock`
    // (see NetworkRingBufferTests.killGateBlocksAppend above).
    @Test func killGateRaceDoesNotInsertAfterConcurrentClear() async throws {
        try await withGlobalCaptureStateLock {
            let buf = NetworkRingBuffer.shared
            try Everframe.shared.start(config: .init(appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"))
            buf.clear()

            let reachedPreLock = DispatchSemaphore(value: 0)
            let releaseAppend = DispatchSemaphore(value: 0)
            buf.preLockHook = {
                reachedPreLock.signal()
                releaseAppend.wait()
            }

            let racedEntry = makeEntry(1)
            let appendDone = DispatchSemaphore(value: 0)
            DispatchQueue.global().async {
                buf.append(racedEntry)
                appendDone.signal()
            }

            reachedPreLock.wait()
            // kill() flips captureGate false, THEN clears `buf` — same order as
            // production (Everframe.swift's kill(), ~line 448-477).
            Everframe.shared.kill()
            releaseAppend.signal()
            appendDone.wait()

            #expect(buf.snapshot().isEmpty)

            buf.preLockHook = nil
            try Everframe.shared.start(config: .init(appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"))
            buf.clear()
        }
    }
}
