// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Port of SummaryAccumulator.kt (itself a port of sdk-core's summary.ts).
// Union spans are PER-PLAYER IDEMPOTENT (Android codex round-7, #1): the maps
// below track WHICH players are inside the play/rebuffer span, so a duplicate
// open — a seed re-stated by a describe, say — or a close with no matching
// open from the same player is a no-op. That single property retired a whole
// family of suppression latches in the controller and the integrations.
//
// ## Codex round-5, W5-I4 — a DELIBERATE divergence from the Kotlin twin
//
// Android's round-7 rework made the spans idempotent but kept the twin's
// original span shape: ONE union span, opened by the first player to enter the
// set and closed by the last one to leave, with `playSpanStartT` as its only
// anchor. That shape is only correct if entries reach the accumulator in
// non-decreasing `t` order, and they cannot be: every player owns its own
// outbox, so delivery is FIFO PER PLAYER and arbitrary across players. A's
// drain stalls while it plays [0 s, 30 s]; B's [10 s, 20 s] pair arrives first
// and contributes 10 s; A's delayed pair then finds an EMPTY set, opens a
// second span and contributes 30 s. The summary reports 40 s of playtime where
// the union is 30 s — and `rebufferCount` reports two stalls where there was
// one. Per-player FIFO and the round-4 session-origin refusal both pass; the
// arithmetic is simply order-dependent.
//
// So this file keeps each player's OWN open timestamp and folds every closed
// interval into a merged, disjoint interval set ([UnionSpans]). The union
// length and the number of maximal spans are then properties of the SET, not
// of the arrival order, which is what makes the result the same however the
// outboxes interleave. For in-order input the two models agree exactly, so no
// wire value changes for the ordinary case; clamping the total to the session
// duration was rejected outright, since that hides a double count rather than
// removing it.
//
// Spans that exactly abut (one closes at t, the next opens at t) are TWO
// maximal spans here, which is what the counter model and both twins report.
// Wave 5 merged them into one; codex round-6, W6-M5 restored the parity, since
// merging on the OPEN INTERIOR is just as much a property of the set as merging
// on the closed one — the order-independence above does not depend on which,
// and `rebufferCount` agreeing with Android and web does. `totalMs` is the same
// under both. What the union model still gives, and the counter model cannot,
// is idempotence: a re-stated or out-of-order interval adds nothing.
//
// The Kotlin twin has the same order-dependence and should take this shape
// too; that is filed against sdk-android rather than fixed from here.
import Foundation
import TraceItXProtocol

/// Accumulates vitals metrics from a stream of `VitalsEntry` events into session summaries.
///
/// **Thread-safety:** This class is not thread-safe. `VitalsCollector` ensures thread safety by
/// calling all methods (`onEntry`, `snapshot`) under its own lock.
final class SummaryAccumulator {
    static let maxTrackedPlayers = 1000

    private let sessionId: String
    private let startedAt: Int64
    private let dims: SessionSummaryDims

    /// playerId → the `t` its rebuffer opened at. A second `buffer_start` from the same
    /// player keeps the first timestamp (per-player idempotence); a `buffer_end` from a
    /// player that never opened removes nothing and closes nothing.
    private var bufferOpen: [String: Int64] = [:]
    private var bufferSpans = UnionSpans()
    private var startupTimeMs: Int64?
    private var bitrateSum = 0.0
    private var bitrateN = 0
    private var errorCount = 0
    /// playerId → the `t` its playback opened at. See [bufferOpen].
    private var playOpen: [String: Int64] = [:]
    private var playSpans = UnionSpans()
    private var memPeak: Int64 = 0
    private var memSum: Int64 = 0
    private var memN = 0
    private var players = Set<String>()
    private var playerCountSaturated = false

    init(sessionId: String, startedAt: Int64, dims: SessionSummaryDims) {
        self.sessionId = sessionId; self.startedAt = startedAt; self.dims = dims
    }

    private func num(_ e: VitalsPlayerEvent, _ key: String) -> Double? { e.data?[key]?.numberValue }

    /// `bitrateMean`'s wire ceiling — zod `z.number().nonnegative().max(Number.MAX_SAFE_INTEGER)`
    /// in `packages/protocol/src/vitals.ts`.
    private static let maxSafeInteger: Int64 = 9_007_199_254_740_991

    /// Codex round-2, Critical 1 — SPAN arithmetic on customer-supplied timestamps. Round-1's
    /// Critical 3 clamped the VALUE conversions but not the SUBTRACTIONS, and `t` arrives
    /// straight from `PlayerIntegrationContext.emit(_:data:t:)` with no admission bound on it: a
    /// custom integration emitting `play` at `Int64.min` and then `pause` at `0` overflowed
    /// `t - start` and TRAPPED before `max(0, …)` could clamp — and a trap is not an error
    /// `dispatch` can catch, so it takes the host app down. The open-span path traps the same
    /// way at the next summary's `now - start`.
    ///
    /// A span is a DURATION, so both saturations are the honest answer: an end before its start
    /// is zero elapsed (the same reading a backwards clock already gets), and an end that
    /// overflows away from its start is longer than any summary can carry, which `snapshot()`
    /// then pins to the wire's int32 ceiling.
    private static func elapsed(from start: Int64, to end: Int64) -> Int64 {
        let (d, overflow) = end.subtractingReportingOverflow(start)
        // Subtraction only overflows when the operands' signs differ, so the sign of `start` is
        // the direction: a negative start overflowed past Int64.max (the span is enormous), a
        // positive one past Int64.min (the end precedes the start, i.e. no elapsed time).
        if overflow { return start < 0 ? Int64.max : 0 }
        return max(0, d)
    }

    /// Saturating accumulation, for the same reason: several `Int64.max`-wide spans must pin at
    /// the ceiling rather than wrap into a negative playtime.
    private static func adding(_ a: Int64, _ b: Int64) -> Int64 {
        let (sum, overflow) = a.addingReportingOverflow(b)
        return overflow ? Int64.max : sum
    }

    /// Codex round-1, Critical 3 — the ONE conversion allowed to see a customer-supplied
    /// Double. `Int64(_:)` TRAPS on anything outside Int64's range (and on NaN/infinity), and
    /// a trap is not an error: `dispatch` catches thrown errors, so an integration emitting
    /// `startup {"ttffMs": 1e100}` — a finite, perfectly valid JSON number that survives
    /// coercion and byte-bounding — took the whole host app down. Clamping to the wire field's
    /// own range BEFORE the conversion is also what restores parity with Android, whose
    /// `Math.round` saturates rather than trapping. nil = not representable at all, which the
    /// callers treat as "this value was never observed".
    private static func clamped(_ v: Double, _ lo: Int64, _ hi: Int64) -> Int64? {
        guard v.isFinite else { return nil }
        let r = v.rounded()
        if r <= Double(lo) { return lo }
        if r >= Double(hi) { return hi }
        return Int64(r)
    }

    /// The merged union of every play (or rebuffer) interval this accumulator has seen, in
    /// whatever order it saw them — codex round-5, W5-I4. See the file header for why the
    /// twin's single-anchor span could not express this.
    ///
    /// Sorted by `start` and disjoint: two intervals that overlap are one entry, so `count` is
    /// the number of MAXIMAL spans and `totalMs` their combined length. Two that merely ABUT are
    /// two entries (round-6, W6-M5 — see `insert`). Both are maintained incrementally on insert
    /// rather than recomputed from `spans`, which is what keeps `totalMs` exact for everything
    /// inserted even after the cap below collapses part of the coverage.
    struct UnionSpans {
        /// The most disjoint spans one session's set will hold. A thousand alternating
        /// play/pause pairs is already far past any real session; the cap is here so a
        /// pathological integration cannot grow this without bound. Past it, the two spans
        /// separated by the SMALLEST gap are fused, and neither `totalMs` nor `count` is
        /// touched: the gap simply stops reading as uncovered, so a later interval landing
        /// inside it adds nothing. That direction is deliberate — saturation may UNDER-report
        /// playback, never inflate it, which is the failure this model exists to remove.
        static let maxSpans = 1000

        private struct Span { var start: Int64; var end: Int64 }
        private var spans: [Span] = []
        /// How many disjoint spans are actually retained — `count` minus whatever the cap has
        /// fused. Exposed so the cap itself is testable; nothing on the wire reads it.
        var trackedSpans: Int { spans.count }
        /// The union length: a running total, not a sum over `spans`.
        private(set) var totalMs: Int64 = 0
        /// The number of maximal spans, likewise running — a collapse under the cap does not
        /// pretend two genuinely separate spans became one.
        private(set) var count = 0

        /// Fold `[start, end]` in. An `end` before its `start` is a zero-length interval at
        /// `start`, the same reading `elapsed` gives a backwards clock.
        ///
        /// Codex round-6, W6-M5 — intervals merge on their OPEN INTERIOR. Two spans that exactly
        /// abut (one closes at t, the next opens at t) are therefore TWO maximal spans, which is
        /// what the Android and web twins count and what wave 5's closed-interval merge disagreed
        /// with. `totalMs` is identical either way — abutting spans cover the same milliseconds
        /// whether they are called one span or two — and the partition is still a property of the
        /// SET, not of the arrival order, so W5-I4's whole point survives.
        ///
        /// A ZERO-LENGTH interval is the one exception, and it has to be: its interior is empty,
        /// so under the open rule alone it could never merge with anything, and re-stating one —
        /// `mergingOpen` running a span that opened at exactly `now`, on every snapshot — would
        /// add a fresh maximal span each time. A point therefore merges with any span that
        /// CONTAINS it, endpoints included, in either direction: covered, it is a no-op;
        /// covering, it is absorbed. Both say the same thing (the point adds no coverage), so the
        /// result still does not depend on which of the two arrived first.
        mutating func insert(from rawStart: Int64, to rawEnd: Int64) {
            let start = rawStart
            let end = max(rawStart, rawEnd)
            if start == end, isCovered(start) { return }
            // The spans that CLOSED-touch `[start, end]`: a contiguous run, since the set is
            // sorted and disjoint.
            var lo = firstSpanReaching(start)
            var hi = lo
            while hi < spans.count && spans[hi].start <= end { hi += 1 }
            // …trimmed to the ones that actually merge. Only the two ends of that run can fail
            // (anything strictly between them overlaps outright), and each trim also leaves `lo`
            // at the SORTED POSITION for a new span when nothing merges at all.
            while lo < hi && !merges(spans[lo], start, end) && spans[lo].end <= start { lo += 1 }
            while hi > lo && !merges(spans[hi - 1], start, end) && spans[hi - 1].start >= end { hi -= 1 }
            var newStart = start, newEnd = end
            var lost: Int64 = 0
            for span in spans[lo..<hi] {
                newStart = min(newStart, span.start)
                newEnd = max(newEnd, span.end)
                lost = SummaryAccumulator.adding(lost, SummaryAccumulator.elapsed(from: span.start, to: span.end))
            }
            let absorbed = hi - lo
            spans.replaceSubrange(lo..<hi, with: [Span(start: newStart, end: newEnd)])
            // Only the NEWLY covered time is added, so re-stating an interval the set already
            // covers — the out-of-order case, and a describe re-seeding a live span — is free.
            totalMs = SummaryAccumulator.adding(totalMs, max(0, SummaryAccumulator.elapsed(from: newStart, to: newEnd) - lost))
            count += 1 - absorbed
            if spans.count > Self.maxSpans { collapseSmallestGap() }
        }

        /// Whether `s` and `[start, end]` are one maximal span: they overlap in the open
        /// interior, or one of them is a point the other contains (see `insert`).
        private func merges(_ s: Span, _ start: Int64, _ end: Int64) -> Bool {
            if s.start == s.end { return start <= s.start && s.start <= end }
            if start == end { return s.start <= start && start <= s.end }
            return s.start < end && s.end > start
        }

        /// Whether some span already covers `t`, endpoints included.
        private func isCovered(_ t: Int64) -> Bool {
            let i = firstSpanReaching(t)
            return i < spans.count && spans[i].start <= t
        }

        /// This union with every still-open span run out to `now`, computed on a COPY: a
        /// summary must never close a span that is still open.
        func mergingOpen<C: Collection>(_ starts: C, upTo now: Int64) -> (totalMs: Int64, count: Int) where C.Element == Int64 {
            if starts.isEmpty { return (totalMs, count) }
            var merged = self
            for start in starts { merged.insert(from: start, to: now) }
            return (merged.totalMs, merged.count)
        }

        /// The first span that could touch `start`, i.e. the first with `end >= start`. `spans`
        /// is sorted by `start` and disjoint, so its ends are sorted too and this can bisect.
        /// CLOSED on purpose: it bounds the window `insert` then trims to what really merges,
        /// and it is what `isCovered` needs.
        private func firstSpanReaching(_ start: Int64) -> Int {
            var lo = 0, hi = spans.count
            while lo < hi {
                let mid = lo + (hi - lo) / 2
                if spans[mid].end < start { lo = mid + 1 } else { hi = mid }
            }
            return lo
        }

        private mutating func collapseSmallestGap() {
            guard spans.count > 1 else { return }
            var best = 0, bestGap = Int64.max
            for j in 0..<(spans.count - 1) {
                let (gap, overflow) = spans[j + 1].start.subtractingReportingOverflow(spans[j].end)
                let g = overflow ? Int64.max : max(0, gap)
                if g < bestGap { bestGap = g; best = j }
            }
            spans[best].end = spans[best + 1].end
            spans.remove(at: best + 1)
        }
    }

    func onEntry(_ entry: VitalsEntry) {
        switch entry {
        case let .sample(s):
            if s.mem > memPeak { memPeak = s.mem }
            memSum &+= s.mem
            memN += 1
        case let .player(e):
            let id = e.playerId ?? ""
            if !players.contains(id) {
                if players.count < Self.maxTrackedPlayers { players.insert(id) } else { playerCountSaturated = true }
            }
            let t = e.t
            switch e.type {
            case VitalsPlayerEventTypes.bufferStart:
                // Idempotent: the FIRST open wins, exactly as the set-based version kept the
                // span anchored to the first player to enter it.
                if bufferOpen[id] == nil { bufferOpen[id] = t }
            case VitalsPlayerEventTypes.bufferEnd:
                if let start = bufferOpen.removeValue(forKey: id) { bufferSpans.insert(from: start, to: t) }
            case VitalsPlayerEventTypes.startup:
                // Clamped to the wire range HERE, not only in snapshot(): the conversion is
                // what traps, and it happens on this line (round-1, Critical 3).
                if startupTimeMs == nil, let v = num(e, "ttffMs"), let ms = Self.clamped(v, 0, VitalsLimits.int32Max) { startupTimeMs = ms }
            case VitalsPlayerEventTypes.bitrateChange:
                // A non-finite or negative bitrate is not accumulated at all (it would bias the
                // mean); an out-of-range one is clamped, which keeps `bitrateSum / bitrateN`
                // inside the range `snapshot()` then converts to Int64.
                if let v = num(e, "bitrate"), v >= 0, let br = Self.clamped(v, 0, Self.maxSafeInteger) { bitrateSum += Double(br); bitrateN += 1 }
            case VitalsPlayerEventTypes.error:
                errorCount += 1
            case VitalsPlayerEventTypes.play:
                if playOpen[id] == nil { playOpen[id] = t }
            case VitalsPlayerEventTypes.pause:
                if let start = playOpen.removeValue(forKey: id) { playSpans.insert(from: start, to: t) }
            default: break
            }
        case .custom: break
        }
    }

    func snapshot(final: Bool, now: Int64, seq: Int) -> SessionSummary {
        // Every still-open span runs to `now` for THIS summary only: the merge happens on a
        // copy, so a later close still folds in the interval that actually occurred.
        let play = playSpans.mergingOpen(playOpen.values, upTo: now)
        let buffer = bufferSpans.mergingOpen(bufferOpen.values, upTo: now)
        let i32 = VitalsLimits.int32Max
        return SessionSummary(
            sessionId: sessionId, final: final, seq: seq, startedAt: startedAt,
            durationMs: min(Self.elapsed(from: startedAt, to: now), i32),
            playtimeMs: min(play.totalMs, i32),
            startupTimeMs: startupTimeMs.map { min(max(0, $0), i32) },
            rebufferCount: buffer.count,
            rebufferDurationMs: min(buffer.totalMs, i32),
            // Both means go through the same clamp as their inputs: it is the Double → Int64
            // conversion that traps, so the last one on the path has to be guarded too — and
            // both to MAX_SAFE_INTEGER, which is what `packages/protocol/src/vitals.ts` caps
            // `bitrateMean` AND `memAvg` at (round-2, M3: `memAvg` said `Int64.max`).
            bitrateMean: bitrateN > 0 ? Self.clamped(bitrateSum / Double(bitrateN), 0, Self.maxSafeInteger) : nil,
            errorCount: errorCount,
            memPeak: memPeak,
            memAvg: memN > 0 ? (Self.clamped(Double(memSum) / Double(memN), 0, Self.maxSafeInteger) ?? 0) : 0,
            playerCount: players.count,
            playerCountSaturated: playerCountSaturated,
            dims: dims)
    }
}
