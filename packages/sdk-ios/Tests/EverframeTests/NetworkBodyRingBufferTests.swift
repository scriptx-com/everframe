// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// NetworkBodyRingBuffer behavior: byte-budget eviction (not count-capped —
// mirrors sdk-core's network-body buffer.ts budget semantics), freeze/
// discardAndResume/takeFrozen/clear lifecycle. NSLock discipline + freeze
// shape mirrored from BreadcrumbRingBuffer.swift:143-175 /
// BreadcrumbRingBufferTests.swift's freeze suite.
//
// Tests use the internal `honorsKillGate: false` init for budget/eviction/
// freeze cases (mirrors NetworkRingBufferTests's rationale exactly) so
// cross-suite parallel tests that toggle Everframe.shared's kill-gate cannot
// race them. The kill-gate behavior itself (final-review Finding 1) is
// exercised in a dedicated test below that owns the global gate.
import Testing
import Foundation
import EverframeProtocol
@testable import EverframeKit

@MainActor
@Suite(.serialized)
struct NetworkBodyRingBufferTests {
    private func entry(
        ref: Int, t: Double, reqBody: String? = nil, resBody: String? = nil
    ) -> EverframeNetworkBody {
        EverframeNetworkBody(
            ref: Double(ref),
            reqBody: reqBody,
            reqBodyBytes: reqBody.map { Double($0.utf8.count) },
            reqBodySkipped: nil,
            reqBodyTruncated: nil,
            reqHeaders: nil,
            resBody: resBody,
            resBodyBytes: resBody.map { Double($0.utf8.count) },
            resBodySkipped: nil,
            resBodyTruncated: nil,
            resHeaders: nil,
            t: t
        )
    }

    @Test func evictsOldestWhenTotalBudgetExceeded() {
        let buf = NetworkBodyRingBuffer(honorsKillGate: false)
        buf.setTotalBudget(1000)
        buf.append(entry(ref: 1, t: 1, resBody: String(repeating: "a", count: 600)))
        buf.append(entry(ref: 2, t: 2, resBody: String(repeating: "b", count: 600)))
        let refs = buf.snapshot().map(\.ref)
        #expect(refs == [2])  // oldest (by t) shed
    }

    @Test func byteAccountingSumsReqAndResBodies() {
        // Budget accounts for the fixed per-entry overhead (Finding 2, see
        // `zeroBodyEntriesWithHeadersAreStillEvictedOnceBudgetExceeded`
        // below): each entry here costs 300 body bytes + 256 overhead = 556,
        // so 700 keeps one entry resident but not two.
        let buf = NetworkBodyRingBuffer(honorsKillGate: false)
        buf.setTotalBudget(700)
        buf.append(
            entry(
                ref: 1, t: 1,
                reqBody: String(repeating: "a", count: 150),
                resBody: String(repeating: "b", count: 150)
            ))
        // 556 bytes so far, under budget — still present.
        #expect(buf.snapshot().map(\.ref) == [1])
        buf.append(
            entry(
                ref: 2, t: 2,
                reqBody: String(repeating: "c", count: 150),
                resBody: String(repeating: "d", count: 150)
            ))
        // 556 + 556 = 1112 > 700 budget — oldest (ref 1) evicted.
        #expect(buf.snapshot().map(\.ref) == [2])
    }

    @Test func freezeIsIdempotentAndTakeFrozenDrains() {
        let buf = NetworkBodyRingBuffer(honorsKillGate: false)
        buf.append(entry(ref: 1, t: 1, resBody: "x"))
        buf.freeze()
        buf.append(entry(ref: 2, t: 2, resBody: "y"))  // post-freeze appends don't join frozen set
        buf.freeze()  // idempotent — still the first snapshot
        #expect(buf.takeFrozen()?.map(\.ref) == [1])
        #expect(buf.takeFrozen() == nil)
    }

    @Test func discardAndResumeDropsFrozen() {
        let buf = NetworkBodyRingBuffer(honorsKillGate: false)
        buf.append(entry(ref: 1, t: 1, resBody: "a"))
        buf.freeze()
        buf.discardAndResume()
        #expect(buf.takeFrozen() == nil)
        // Live capture continues untouched.
        #expect(buf.snapshot().map(\.ref) == [1])
    }

    @Test func clearZeroizesLiveAndFrozen() {
        let buf = NetworkBodyRingBuffer(honorsKillGate: false)
        buf.append(entry(ref: 1, t: 1, resBody: "a"))
        buf.freeze()
        buf.clear()
        #expect(buf.snapshot().isEmpty)
        #expect(buf.takeFrozen() == nil)
    }

    @Test func setTotalBudgetDefaultsTo262144() {
        #expect(NetworkBodyRingBuffer(honorsKillGate: false).snapshot().isEmpty)
        // Appending a single entry comfortably under the default budget
        // (leaving headroom for the fixed per-entry overhead, Finding 2)
        // survives.
        let buf = NetworkBodyRingBuffer(honorsKillGate: false)
        buf.append(entry(ref: 1, t: 1, resBody: String(repeating: "a", count: 262_144 - 1000)))
        #expect(buf.snapshot().map(\.ref) == [1])
    }

    @Test func sharedIsASingleton() {
        #expect(NetworkBodyRingBuffer.shared === NetworkBodyRingBuffer.shared)
    }

    // MARK: - Final-review Finding 2 (unbounded zero-cost entries)

    /// Regression: entries with no reqBody/resBody (204s, content-type
    /// skips) used to cost 0 under the old `cost()` (reqBody+resBody UTF-8
    /// bytes only), so they were never evicted while their headers/skip
    /// metadata grew the buffer unbounded. `cost()` must now also count
    /// header key+value UTF-8 bytes plus a fixed per-entry overhead, so a
    /// budget is still enforced even for entirely body-less entries — proven
    /// here by pushing enough zero-body, header-bearing entries to exceed a
    /// small budget and asserting the buffer's entry COUNT stays bounded
    /// (rather than growing without limit).
    @Test func zeroBodyEntriesWithHeadersAreStillEvictedOnceBudgetExceeded() {
        let buf = NetworkBodyRingBuffer(honorsKillGate: false)
        buf.setTotalBudget(2000) // small budget relative to per-entry header overhead
        let headers = [
            "content-type": "application/json",
            "x-trace-id": "0123456789abcdef0123456789abcdef",
        ]
        for i in 0..<500 {
            buf.append(
                EverframeNetworkBody(
                    ref: Double(i), reqBody: nil, reqBodyBytes: nil, reqBodySkipped: nil,
                    reqBodyTruncated: nil, reqHeaders: headers,
                    resBody: nil, resBodyBytes: nil, resBodySkipped: nil,
                    resBodyTruncated: nil, resHeaders: headers, t: Double(i)))
        }
        // 500 zero-body entries must NOT all still be resident — each one
        // has non-zero cost from its headers + fixed overhead, so eviction
        // must have kicked in well before entry 500.
        #expect(buf.snapshot().count < 500)
        #expect(!buf.snapshot().isEmpty)
    }

    // MARK: - Final-review Finding 1 (post-kill capture)

    /// Regression: a still-in-flight request's completion handler can race
    /// `kill()` — the gate-honoring buffer (default `init()`, matching
    /// `NetworkBodyRingBuffer.shared`'s production configuration) must
    /// refuse to append once the kill switch has flipped, independent of
    /// whatever `NetworkBodyCaptureGate.shared.isActive` reads at that
    /// instant. Mirrors `NetworkRingBufferTests.killGateBlocksAppend`.
    // Round-6 review Finding F31: drives `Everframe.shared` for real —
    // wrapped in `withGlobalCaptureStateLock` so it cannot interleave with
    // any other suite doing the same (see
    // Helpers/GlobalCaptureStateTestLock.swift).
    @Test func killGateBlocksAppend() async throws {
        try await withGlobalCaptureStateLock {
            try Everframe.shared.start(config: .init(appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"))
            Everframe.shared.kill()
            let buf = NetworkBodyRingBuffer()  // gate-honoring (default)
            buf.append(entry(ref: 1, t: 1, resBody: "post-kill"))
            #expect(buf.snapshot().isEmpty)
            try Everframe.shared.start(config: .init(appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"))
        }
    }

    // MARK: - PR review round 4 Finding F15 (kill-gate/append race)

    /// Regression for the exact interleaving F15 closes:
    ///   1. append() reads `captureGate == true` (the cheap pre-lock fast path)
    ///   2. kill() flips the gate false, then clear()s the buffer
    ///   3. append() finally acquires the lock and inserts — after zeroization
    /// `preLockHook` pauses `append` right after step 1's read so this test
    /// can force `Everframe.shared.kill()` (which, on `.shared`, synchronously
    /// flips the gate and clears this exact buffer) to run to completion
    /// before releasing `append` into the lock. Uses `NetworkBodyRingBuffer
    /// .shared` (not a fresh instance) so `kill()`'s real production
    /// `clear()` call targets the same buffer `append` is racing into.
    // Round-6 review Finding F31: uses `NetworkBodyRingBuffer.shared` AND
    // `Everframe.shared` for real — wrapped in `withGlobalCaptureStateLock`
    // (see NetworkBodyRingBufferTests.killGateBlocksAppend above).
    @Test func killGateRaceDoesNotInsertAfterConcurrentClear() async throws {
        try await withGlobalCaptureStateLock {
            let buf = NetworkBodyRingBuffer.shared
            try Everframe.shared.start(config: .init(appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"))
            buf.clear()

            let reachedPreLock = DispatchSemaphore(value: 0)
            let releaseAppend = DispatchSemaphore(value: 0)
            buf.preLockHook = {
                reachedPreLock.signal()
                releaseAppend.wait()
            }

            let racedEntry = entry(ref: 1, t: 1, resBody: "raced")
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

    // MARK: - Round-7 review Finding F34 (remote captureBodies:false must be
    // authoritative at the append boundary, not just before makeEntry)

    /// Reviewer's probe, reproduced directly: decide/capture with the gate
    /// ON (so `NetworkBodyCapture.makeEntry` would proceed to build the
    /// entry), then apply a remote `captureBodies: false` config — BEFORE
    /// the already-built entry is appended. Pre-fix, `append(_:)` had no way
    /// to know the decision was stale; post-fix, the `guard` closure
    /// (mirroring the production call site in `NetworkCaptureProtocol.swift`)
    /// re-validates the captured generation atomically with the insert and
    /// must refuse it.
    @Test func f34_remoteConfigDisablingBodiesBeforeAppendDropsTheAlreadyBuiltEntry() {
        let gate = NetworkBodyCaptureGate()
        let buf = NetworkBodyRingBuffer(honorsKillGate: false)

        // Decision point: gate ON, exactly as `EFNetworkCaptureProtocol`
        // reads it before calling `NetworkBodyCapture.makeEntry`.
        gate.applyConfig(
            NetworkBodiesConfigWire(captureBodies: true, bodyByteCap: nil, bodyContentTypes: nil, bodyTotalBudget: nil),
            samplingRate: 1.0, locallyDisabled: false, random: { 0.0 })
        let decision = gate.snapshotActive()
        #expect(decision.active, "test setup: gate must be ON at the decision point")

        // The entry was already built (redaction, bounded reads — real work
        // that takes time) while the gate was ON.
        let sensitiveEntry = entry(ref: 1, t: 1, resBody: "sensitive-should-not-ship")

        // A remote config refresh disables body capture BEFORE the append —
        // the exact race F34 closes.
        gate.applyConfig(
            NetworkBodiesConfigWire(captureBodies: false, bodyByteCap: nil, bodyContentTypes: nil, bodyTotalBudget: nil),
            samplingRate: 1.0, locallyDisabled: false, random: { 0.0 })
        #expect(!gate.isActive, "test setup: remote refresh must have deactivated the gate")

        buf.append(sensitiveEntry) {
            gate.isActive(forGeneration: decision.generation)
        }

        #expect(
            buf.snapshot().isEmpty,
            "a remote captureBodies:false must be authoritative even though the entry was already built while the gate was ON")
    }

    /// Companion happy-path: the token must NOT over-block a normal capture
    /// where nothing changed between decision and append.
    @Test func f34_matchingGenerationAndActiveGateStillAppendsNormally() {
        let gate = NetworkBodyCaptureGate()
        let buf = NetworkBodyRingBuffer(honorsKillGate: false)
        gate.applyConfig(
            NetworkBodiesConfigWire(captureBodies: true, bodyByteCap: nil, bodyContentTypes: nil, bodyTotalBudget: nil),
            samplingRate: 1.0, locallyDisabled: false, random: { 0.0 })
        let decision = gate.snapshotActive()

        let e = entry(ref: 1, t: 1, resBody: "ok")
        buf.append(e) {
            gate.isActive(forGeneration: decision.generation)
        }

        #expect(buf.snapshot().map(\.ref) == [1], "a still-valid token must not be over-blocked")
    }

    /// `guard` defaults to `nil` (skips validation entirely) — every
    /// pre-existing call site above this section relies on that default
    /// remaining backward compatible.
    @Test func f34_noGuardClosureBehavesExactlyAsBefore() {
        let buf = NetworkBodyRingBuffer(honorsKillGate: false)
        buf.append(entry(ref: 1, t: 1, resBody: "z"))
        #expect(buf.snapshot().map(\.ref) == [1])
    }
}
