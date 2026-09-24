// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import EverframeProtocol
@testable import EverframeKit

final class SummaryAccumulatorTests: XCTestCase {
    private let dims = SessionSummaryDims(platform: "ios", appVersion: "1", sdkVersion: "0.7.0")
    private func acc() -> SummaryAccumulator { SummaryAccumulator(sessionId: "s", startedAt: 1000, dims: dims) }
    private func p(_ t: Int64, _ type: String, _ id: String? = "p1", _ data: [String: VitalsJSON]? = nil) -> VitalsEntry {
        .player(VitalsPlayerEvent(t: t, type: type, playerId: id, data: data))
    }

    func testCountsRebuffersFromBufferStartBufferEndPairs() {
        let a = acc()
        a.onEntry(p(1000, "buffer_start")); a.onEntry(p(1800, "buffer_end", "p1", ["durationMs": .int(800)]))
        a.onEntry(p(3000, "buffer_start")); a.onEntry(p(3100, "buffer_end"))
        let s = a.snapshot(final: false, now: 5000, seq: 0)
        XCTAssertEqual(s.rebufferCount, 2); XCTAssertEqual(s.rebufferDurationMs, 900)
    }
    func testTakesTheFirstStartupTtffAndAveragesBitrates() {
        let a = acc()
        a.onEntry(p(1, "startup", "p1", ["ttffMs": .int(1300)])); a.onEntry(p(2, "startup", "p1", ["ttffMs": .int(99)]))
        a.onEntry(p(3, "bitrate_change", "p1", ["bitrate": .int(1000)])); a.onEntry(p(4, "bitrate_change", "p1", ["bitrate": .int(3000)]))
        let s = a.snapshot(final: false, now: 10, seq: 0)
        XCTAssertEqual(s.startupTimeMs, 1300); XCTAssertEqual(s.bitrateMean, 2000)
    }
    func testAccumulatesPlaytimeAcrossSpansAndClosesAnOpenSpanAtSnapshot() {
        let a = acc()
        a.onEntry(p(1000, "play")); a.onEntry(p(3000, "pause")); a.onEntry(p(4000, "play"))
        XCTAssertEqual(a.snapshot(final: false, now: 6000, seq: 0).playtimeMs, 4000)
    }
    func testTracksMemPeakAndAvgFromSamplesErrorsFromErrorEvents() {
        let a = acc()
        a.onEntry(.sample(VitalsSample(t: 1, mem: 100))); a.onEntry(.sample(VitalsSample(t: 2, mem: 300)))
        a.onEntry(p(3, "error")); a.onEntry(p(4, "error"))
        let s = a.snapshot(final: false, now: 5, seq: 0)
        XCTAssertEqual(s.memPeak, 300); XCTAssertEqual(s.memAvg, 200); XCTAssertEqual(s.errorCount, 2)
    }
    func testClampsDurationsToZeroOnABackwardsClock() {
        let a = acc()
        a.onEntry(p(5000, "play")); a.onEntry(p(4000, "pause"))
        let s = a.snapshot(final: false, now: 500, seq: 0)
        XCTAssertEqual(s.playtimeMs, 0); XCTAssertEqual(s.durationMs, 0)
    }
    /// Codex round-2, Critical 1 — `t` is customer-supplied and admission does not bound it, so
    /// `t - start` could overflow and TRAP. A trap is not a thrown error: `dispatch` cannot catch
    /// it, and the host app dies. Restoring `playtimeMs += max(0, t - start)` crashes the test
    /// PROCESS here rather than failing an assertion.
    func testExtremeEventTimestampsSaturateInsteadOfTrappingTheHostApp() {
        let a = acc()
        a.onEntry(p(Int64.min, "play")); a.onEntry(p(0, "pause"))                 // positive overflow
        a.onEntry(p(Int64.max, "buffer_start")); a.onEntry(p(Int64.min, "buffer_end"))   // negative overflow
        let s = a.snapshot(final: false, now: 6000, seq: 0)
        XCTAssertEqual(s.playtimeMs, VitalsLimits.int32Max, "an unrepresentably long span pins at the wire ceiling")
        XCTAssertEqual(s.rebufferDurationMs, 0, "a span that ends before it starts is zero elapsed")
        XCTAssertEqual(s.rebufferCount, 1)
    }
    /// The OPEN-span half of the same finding: nothing closes the span, so the trap moves to
    /// `now - start` inside `snapshot()`, once per summary until the session ends.
    func testAnOpenSpanOpenedAtAnExtremeTimestampSaturatesAtEverySnapshot() {
        let a = acc()
        a.onEntry(p(Int64.min, "play")); a.onEntry(p(Int64.min, "buffer_start"))
        let s = a.snapshot(final: false, now: Int64.max, seq: 0)
        XCTAssertEqual(s.playtimeMs, VitalsLimits.int32Max)
        XCTAssertEqual(s.rebufferDurationMs, VitalsLimits.int32Max)
        // `durationMs` runs the same subtraction against the session's own start.
        let far = SummaryAccumulator(sessionId: "s", startedAt: Int64.min, dims: dims)
        XCTAssertEqual(far.snapshot(final: true, now: Int64.max, seq: 1).durationMs, VitalsLimits.int32Max)
    }
    /// Round-2, M3 — `memAvg` was clamped to `Int64.max` while `bitrateMean` used
    /// MAX_SAFE_INTEGER; `packages/protocol/src/vitals.ts` caps both at MAX_SAFE_INTEGER.
    func testMemAvgIsCappedAtTheWiresMaxSafeInteger() {
        let a = acc()
        a.onEntry(.sample(VitalsSample(t: 1, mem: Int64.max)))
        XCTAssertEqual(a.snapshot(final: false, now: 2, seq: 0).memAvg, 9_007_199_254_740_991)
    }
    func testNilStartupAndBitrateWhenNeverObserved() {
        let s = acc().snapshot(final: true, now: 2000, seq: 0)
        XCTAssertNil(s.startupTimeMs); XCTAssertNil(s.bitrateMean); XCTAssertEqual(s.memAvg, 0)
    }
    func testTwoPlayersPlaytimeIsTheUnionNotTheSum() {
        let a = acc()
        a.onEntry(p(1000, "play", "p1")); a.onEntry(p(2000, "play", "p2")); a.onEntry(p(3000, "pause", "p1")); a.onEntry(p(5000, "pause", "p2"))
        XCTAssertEqual(a.snapshot(final: false, now: 9000, seq: 0).playtimeMs, 4000)
    }
    func testOverlappingBufferSpansFromTwoPlayersCollapseIntoOneRebuffer() {
        let a = acc()
        a.onEntry(p(1000, "buffer_start", "p1")); a.onEntry(p(1500, "buffer_start", "p2"))
        a.onEntry(p(2000, "buffer_end", "p1")); a.onEntry(p(3000, "buffer_end", "p2"))
        let s = a.snapshot(final: false, now: 9000, seq: 0)
        XCTAssertEqual(s.rebufferCount, 1); XCTAssertEqual(s.rebufferDurationMs, 2000)
    }
    func testStrayPauseOrBufferEndNeverGoesNegative() {
        let a = acc()
        a.onEntry(p(1000, "pause")); a.onEntry(p(1000, "buffer_end"))
        let s = a.snapshot(final: false, now: 2000, seq: 0)
        XCTAssertEqual(s.playtimeMs, 0); XCTAssertEqual(s.rebufferDurationMs, 0); XCTAssertEqual(s.rebufferCount, 0)
    }
    func testADuplicatePlayFromOnePlayerStillClosesOnThatPlayersSinglePause() {
        let a = acc()
        a.onEntry(p(1000, "play")); a.onEntry(p(1500, "play")); a.onEntry(p(3000, "pause"))
        XCTAssertEqual(a.snapshot(final: false, now: 9000, seq: 0).playtimeMs, 2000)
    }
    func testADuplicateBufferStartClosesOnItsSingleBufferEndAndCountsOneRebuffer() {
        let a = acc()
        a.onEntry(p(1000, "buffer_start")); a.onEntry(p(1200, "buffer_start")); a.onEntry(p(2000, "buffer_end"))
        let s = a.snapshot(final: false, now: 9000, seq: 0)
        XCTAssertEqual(s.rebufferCount, 1); XCTAssertEqual(s.rebufferDurationMs, 1000)
    }
    func testADuplicateOpenFromOnePlayerNeverDisturbsAnotherPlayersSpan() {
        let a = acc()
        a.onEntry(p(1000, "play", "p1")); a.onEntry(p(2000, "play", "p2")); a.onEntry(p(2500, "play", "p2")); a.onEntry(p(3000, "pause", "p1"))
        XCTAssertEqual(a.snapshot(final: false, now: 5000, seq: 0).playtimeMs, 4000)   // p2 still open to `now`
    }
    func testAPauseOrBufferEndFromAPlayerThatNeverOpenedIsANoOpForTheOpenSpan() {
        let a = acc()
        a.onEntry(p(1000, "play", "p1")); a.onEntry(p(2000, "pause", "p2"))
        XCTAssertEqual(a.snapshot(final: false, now: 4000, seq: 0).playtimeMs, 3000)
    }
    func testPlayerCountCountsDistinctIdsAcrossAnyPlayerEventUnnamedOnceCustomNever() {
        let a = acc()
        a.onEntry(p(1, "play", "p1")); a.onEntry(p(2, "stats", "p2")); a.onEntry(p(3, "play", nil)); a.onEntry(p(4, "pause", nil))
        a.onEntry(.custom(VitalsCustomEntry(t: 5, name: "x", playerId: "p9")))
        let s = a.snapshot(final: false, now: 9, seq: 0)
        XCTAssertEqual(s.playerCount, 3); XCTAssertFalse(s.playerCountSaturated)
    }
    func testPlayerCountSaturatesAt1000AndFlagsIt() {
        let a = acc()
        for i in 0..<1001 { a.onEntry(p(Int64(i), "play", "p\(i)")) }
        let s = a.snapshot(final: false, now: 2000, seq: 0)
        XCTAssertEqual(s.playerCount, 1000); XCTAssertTrue(s.playerCountSaturated)
    }
    func testIgnoresStringTypedTtffMsAndBitrateThenTakesTheFirstNumericStartup() {
        let a = acc()
        a.onEntry(p(1, "startup", "p1", ["ttffMs": .string("1300")])); a.onEntry(p(2, "bitrate_change", "p1", ["bitrate": .string("9")]))
        a.onEntry(p(3, "startup", "p1", ["ttffMs": .double(700.4)]))
        let s = a.snapshot(final: false, now: 9, seq: 0)
        XCTAssertEqual(s.startupTimeMs, 700); XCTAssertNil(s.bitrateMean)
    }
    func testClampsDurationsToInt32Max() {
        let a = SummaryAccumulator(sessionId: "s", startedAt: 0, dims: dims)
        a.onEntry(p(0, "play")); a.onEntry(p(0, "startup", "p1", ["ttffMs": .double(1e12)]))
        a.onEntry(p(0, "buffer_start"))
        let s = a.snapshot(final: false, now: 5_000_000_000, seq: 0)
        XCTAssertEqual(s.durationMs, VitalsLimits.int32Max); XCTAssertEqual(s.playtimeMs, VitalsLimits.int32Max)
        XCTAssertEqual(s.rebufferDurationMs, VitalsLimits.int32Max); XCTAssertEqual(s.startupTimeMs, VitalsLimits.int32Max)
    }

    /// Codex round-1, Critical 3. `1e100` is a finite JSON number: it passes coercion and byte
    /// bounding and reaches the accumulator intact. Before the clamp, `Int64(v.rounded())`
    /// TRAPPED here and took the host app with it — `dispatch` catches thrown errors, not
    /// arithmetic traps. Reverting either clamp aborts this test process outright.
    func testAnAbsurdlyLargeTtffOrBitrateIsClampedInsteadOfTrappingTheHostApp() {
        let a = acc()
        a.onEntry(p(1, "startup", "p1", ["ttffMs": .double(1e100)]))
        a.onEntry(p(2, "bitrate_change", "p1", ["bitrate": .double(1e100)]))
        a.onEntry(p(3, "bitrate_change", "p1", ["bitrate": .double(-1e100)]))   // rejected, not summed
        let s = a.snapshot(final: false, now: 9, seq: 0)
        XCTAssertEqual(s.startupTimeMs, VitalsLimits.int32Max)
        XCTAssertEqual(s.bitrateMean, 9_007_199_254_740_991)
    }
    // MARK: codex round-5, W5-I4 — the union must not depend on delivery order

    /// Every player owns its own outbox, so delivery is FIFO PER PLAYER and arbitrary across
    /// players. The single-anchor span model added the two spans (10 s + 30 s = 40 s) because
    /// A's delayed pair found an empty set and opened a second span; the union is 30 s.
    func testAStalledPlayersDelayedSpanIsUnionedWithTheOneDeliveredBeforeIt() {
        let a = acc()
        a.onEntry(p(11_000, "play", "b")); a.onEntry(p(21_000, "pause", "b"))     // B's [10 s, 20 s]
        a.onEntry(p(1_000, "play", "a")); a.onEntry(p(31_000, "pause", "a"))      // A's stalled [0 s, 30 s]
        XCTAssertEqual(a.snapshot(final: false, now: 32_000, seq: 0).playtimeMs, 30_000)
    }

    /// Rebuffer spans had the identical defect, and it reached `rebufferCount` too: the counter
    /// version saw two union opens where the merged coverage is one stall.
    func testADelayedRebufferSpanIsUnionedAndCountedOnce() {
        let a = acc()
        a.onEntry(p(11_000, "buffer_start", "b")); a.onEntry(p(21_000, "buffer_end", "b"))
        a.onEntry(p(1_000, "buffer_start", "a")); a.onEntry(p(31_000, "buffer_end", "a"))
        let s = a.snapshot(final: false, now: 32_000, seq: 0)
        XCTAssertEqual(s.rebufferDurationMs, 30_000)
        XCTAssertEqual(s.rebufferCount, 1)
    }

    /// The property behind both: any interleaving that preserves each player's own order gives
    /// the same summary. Only the timestamps decide.
    func testTheSummaryIsIdenticalUnderEveryPerPlayerFifoInterleaving() {
        let a: [VitalsEntry] = [p(1_000, "play", "a"), p(31_000, "pause", "a")]
        let b: [VitalsEntry] = [p(11_000, "play", "b"), p(21_000, "pause", "b")]
        let c: [VitalsEntry] = [p(25_000, "play", "c"), p(40_000, "pause", "c")]
        var seen = Set<String>()
        for order in Self.interleavings([a, b, c]) {
            let acc = acc()
            order.forEach { acc.onEntry($0) }
            let s = acc.snapshot(final: false, now: 41_000, seq: 0)
            seen.insert("\(s.playtimeMs)")
        }
        XCTAssertEqual(seen, ["39000"], "the union of [1s,31s], [11s,21s] and [25s,40s] is 39 s, however it arrives")
    }

    /// A `describe` re-seeding a span the set already covers — the reseed path wave 4 leans on —
    /// must add nothing at all, not a second copy of the same time.
    func testReStatingAnIntervalTheUnionAlreadyCoversAddsNothing() {
        var u = SummaryAccumulator.UnionSpans()
        u.insert(from: 1_000, to: 5_000)
        u.insert(from: 2_000, to: 3_000)
        u.insert(from: 1_000, to: 5_000)
        XCTAssertEqual(u.totalMs, 4_000); XCTAssertEqual(u.count, 1); XCTAssertEqual(u.trackedSpans, 1)
    }

    /// Codex round-6, W6-M5 — two spans that exactly ABUT are two maximal spans: the merge is on
    /// the open interior, which is what the Android and web twins count. The covered time is the
    /// same under either rule, and the answer is still the same in every arrival order.
    func testAbuttingSpansAreTwoMaximalSpansAsBothTwinsCount() {
        for order in [[0, 1], [1, 0]] {
            let a = acc()
            let first: [VitalsEntry] = [p(1_000, "buffer_start", "p1"), p(2_000, "buffer_end", "p1")]
            let second: [VitalsEntry] = [p(2_000, "buffer_start", "p2"), p(3_000, "buffer_end", "p2")]
            for i in order { ([first, second][i]).forEach { a.onEntry($0) } }
            let s = a.snapshot(final: false, now: 9_000, seq: 0)
            XCTAssertEqual(s.rebufferDurationMs, 2_000, "order \(order)")
            XCTAssertEqual(s.rebufferCount, 2, "order \(order)")
        }
    }

    /// The one thing the open rule cannot express on its own: a POINT has no interior, so it
    /// would merge with nothing and every re-statement would add a maximal span. A point a span
    /// already covers is a no-op, and a point a later span covers is absorbed by it — both
    /// directions, so the answer does not depend on which arrived first.
    func testAZeroLengthIntervalIsIdempotentAgainstTheSpanThatCoversIt() {
        var covered = SummaryAccumulator.UnionSpans()
        covered.insert(from: 1_000, to: 2_000)
        covered.insert(from: 2_000, to: 2_000)          // a span that opened exactly at `now`…
        covered.insert(from: 2_000, to: 2_000)          // …restated on the next snapshot
        covered.insert(from: 1_500, to: 1_500)          // and one in the interior
        XCTAssertEqual(covered.count, 1); XCTAssertEqual(covered.totalMs, 1_000)
        XCTAssertEqual(covered.trackedSpans, 1)

        var pointFirst = SummaryAccumulator.UnionSpans()
        pointFirst.insert(from: 2_000, to: 2_000)
        XCTAssertEqual(pointFirst.count, 1, "a point nothing covers is its own span")
        pointFirst.insert(from: 1_000, to: 2_000)
        XCTAssertEqual(pointFirst.count, 1, "…and is absorbed by the span that comes to cover it")
        XCTAssertEqual(pointFirst.totalMs, 1_000); XCTAssertEqual(pointFirst.trackedSpans, 1)
    }

    /// A span inserted entirely BEFORE the set, abutting it, keeps the set sorted — the trim that
    /// leaves an abutting neighbour alone also has to leave the insertion point right.
    func testAnAbuttingSpanInsertedBeforeTheSetStaysOrdered() {
        var u = SummaryAccumulator.UnionSpans()
        u.insert(from: 1_000, to: 2_000)
        u.insert(from: 0, to: 1_000)
        u.insert(from: 2_000, to: 3_000)
        XCTAssertEqual(u.count, 3); XCTAssertEqual(u.totalMs, 3_000); XCTAssertEqual(u.trackedSpans, 3)
        u.insert(from: 500, to: 2_500)                  // …and one that swallows all three
        XCTAssertEqual(u.count, 1); XCTAssertEqual(u.totalMs, 3_000); XCTAssertEqual(u.trackedSpans, 1)
    }

    /// The set is capped so a pathological integration cannot grow it without bound. Fusing the
    /// smallest gap loses COVERAGE, never total: what has already been inserted still reads
    /// exactly, and the only later error is an under-count inside a fused gap.
    func testTheUnionSetIsBoundedAndSaturationNeverInflatesTheTotal() {
        var u = SummaryAccumulator.UnionSpans()
        let n = SummaryAccumulator.UnionSpans.maxSpans + 200
        for i in 0..<n { u.insert(from: Int64(i) * 20, to: Int64(i) * 20 + 10) }
        XCTAssertEqual(u.trackedSpans, SummaryAccumulator.UnionSpans.maxSpans, "bounded")
        XCTAssertEqual(u.totalMs, Int64(n) * 10, "every inserted interval still counts exactly once")
        XCTAssertEqual(u.count, n, "a fused gap does not pretend two spans were ever one")
    }

    /// Interval arithmetic is saturating on both ends, exactly as `elapsed` is: the union model
    /// must not reintroduce the trap round-2's Critical 1 removed.
    func testUnionArithmeticSaturatesOnExtremeIntervals() {
        var u = SummaryAccumulator.UnionSpans()
        u.insert(from: Int64.min, to: 0)
        u.insert(from: Int64.max, to: Int64.min)    // ends before it starts: zero length at Int64.max
        XCTAssertEqual(u.totalMs, Int64.max)
        XCTAssertEqual(u.count, 2)
    }

    /// Every interleaving of the given per-player sequences, each sequence kept in its own order.
    private static func interleavings(_ streams: [[VitalsEntry]]) -> [[VitalsEntry]] {
        if streams.allSatisfy({ $0.isEmpty }) { return [[]] }
        var out: [[VitalsEntry]] = []
        for i in streams.indices where !streams[i].isEmpty {
            var rest = streams
            let head = rest[i].removeFirst()
            for tail in interleavings(rest) { out.append([head] + tail) }
        }
        return out
    }

    /// The other half: a huge value must not poison the mean of the sane ones around it.
    func testANegativeBitrateIsIgnoredAndTheMeanOfTheValidOnesSurvives() {
        let a = acc()
        a.onEntry(p(1, "bitrate_change", "p1", ["bitrate": .double(-5)]))
        a.onEntry(p(2, "bitrate_change", "p1", ["bitrate": .int(1000)]))
        a.onEntry(p(3, "bitrate_change", "p1", ["bitrate": .int(3000)]))
        XCTAssertEqual(a.snapshot(final: false, now: 9, seq: 0).bitrateMean, 2000)
    }
}
