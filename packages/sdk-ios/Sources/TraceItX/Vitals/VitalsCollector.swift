// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Port of VitalsCollector.kt (→ sdk-core collector.ts). Session lifecycle,
// chunk buffering, idle/age/seq rotation, summary cadence, recent ring.
//
// ## Locking
// `deps.send` is invoked while the collector holds `lock`: it must be
// non-blocking and must not acquire any other lock — hand the payload to the
// transport (which enqueues) and return.
//
// `deps.onRotate` is NOT invoked under `lock`. It runs after the lock is
// released, with the entry that triggered the rotation, and may call back into
// this collector. Callers that hold a lock of their own (VitalsController holds
// a registration's announceLock across its records) use the DEFERRED forms and
// fire the returned `Recorded` once they hold nothing.
//
// A non-nil `expectedSessionId` means "this session or nowhere": the entry is
// refused if the collector has moved on AND if the entry would itself rotate
// the session (Android codex round-6, #3). Unpinned entries rotate and land in
// the new session, and `Recorded.sessionId` reports where they landed.
import Foundation
import TraceItXProtocol

struct VitalsStamp: Equatable, Sendable {
    let sessionId: String
    let entries: [VitalsEntry]
}

final class VitalsCollector: @unchecked Sendable {
    struct Deps {
        var dims: SessionSummaryDims
        var now: @Sendable () -> Int64
        /// Invoked under the collector's lock. Non-blocking; hands off and returns.
        var send: @Sendable (VitalsIngestPayload) -> Void
        var newSessionId: @Sendable () -> String
        var scheduler: VitalsScheduler
        var flushIntervalMs: Int64 = 30_000
        var maxEntriesPerChunk: Int = 50
        var maxBufferBytes: Int = 65_536
        var summaryEveryChunks: Int = 5
        var maxIdleMs: Int64 = 1_800_000
        var maxSessionMs: Int64 = 86_400_000
        /// Rotate one short of the cap so finalize's trailing chunk + summary fit.
        var maxSeq: Int = VitalsLimits.maxSeq
        /// Invoked AFTER the lock is released. nil trigger = a rotation no entry caused.
        var onRotate: (@Sendable (VitalsEntry?) -> Void)? = nil

        init(dims: SessionSummaryDims, now: @escaping @Sendable () -> Int64, send: @escaping @Sendable (VitalsIngestPayload) -> Void,
             newSessionId: @escaping @Sendable () -> String, scheduler: VitalsScheduler,
             flushIntervalMs: Int64 = 30_000, maxEntriesPerChunk: Int = 50, maxBufferBytes: Int = 65_536,
             summaryEveryChunks: Int = 5, maxIdleMs: Int64 = 1_800_000, maxSessionMs: Int64 = 86_400_000,
             maxSeq: Int = VitalsLimits.maxSeq, onRotate: (@Sendable (VitalsEntry?) -> Void)? = nil) {
            self.dims = dims; self.now = now; self.send = send; self.newSessionId = newSessionId; self.scheduler = scheduler
            self.flushIntervalMs = flushIntervalMs; self.maxEntriesPerChunk = maxEntriesPerChunk; self.maxBufferBytes = maxBufferBytes
            self.summaryEveryChunks = summaryEveryChunks; self.maxIdleMs = maxIdleMs; self.maxSessionMs = maxSessionMs
            self.maxSeq = maxSeq; self.onRotate = onRotate
        }
    }

    static let recentWindowMs: Int64 = 60_000
    static let maxRingEntries = 800
    /// Headroom for the transport's `{"payload":…}` wrapper (12 bytes), rounded up.
    static let requestWrapperReserveBytes = 32
    /// Crash-handler guard: recent()/stamp() give up after this rather than risk a dead lock holder.
    static let recentLockTimeoutMs: Int64 = 100
    /// How close the running estimate must come to the budget before the exact framed encode is paid for.
    static let exactCostMarginBytes = 4096
    private static let approxBytesCap = Int.max / 2

    private let deps: Deps
    private let lock = NSLock()
    private let idLock = NSLock()
    private var _sessionId: String
    private var seq = 0
    private var summarySeq = 0
    private var stopped = false
    private var chunksSinceSummary = 0
    /// Entries of ANY kind recorded since the last summary went out —
    /// including samples, which are not transported but do move
    /// memPeak/memAvg. Gates `bumpSummaryCadence`.
    private var entriesSinceSummary = 0
    private var lastEntryAt: Int64?
    private var sessionStartedAt: Int64
    private var pending: [VitalsEntry] = []
    private var pendingApproxBytes = 0
    private var ring: [VitalsEntry] = []
    private var accumulator: SummaryAccumulator
    private var timer: VitalsCancellable?
    private(set) var exactCostCalls = 0

    /// Read without `lock` (own tiny lock): the crash handler must never block on the collector lock just to read the id.
    var sessionId: String { idLock.lock(); defer { idLock.unlock() }; return _sessionId }
    private func setSessionId(_ id: String) { idLock.lock(); _sessionId = id; idLock.unlock() }

    init(deps: Deps) {
        self.deps = deps
        let id = deps.newSessionId()
        _sessionId = id
        sessionStartedAt = deps.now()
        accumulator = SummaryAccumulator(sessionId: id, startedAt: sessionStartedAt, dims: deps.dims)
        timer = deps.scheduler.repeating(intervalMs: deps.flushIntervalMs) { [weak self] in
            guard let self else { return }
            dispatch("VitalsCollector.tick") {
                // Round-2, Important 7: the cap check runs BEFORE the send.
                let rotated: Bool = self.locked {
                    if self.stopped { return false }
                    let r = self.rotateIfSeqExhausted()
                    if !self.pending.isEmpty { self.sendChunk() } else { self.bumpSummaryCadence() }
                    return r
                }
                if rotated { self.fireRotate(nil) }
            }
        }
        dispatch("VitalsCollector.init") { locked { sendSummary(final: false) } }
    }

    private func locked<T>(_ body: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return body() }

    // MARK: locked helpers

    private func sendSummary(final: Bool, at: Int64? = nil) {
        let s = accumulator.snapshot(final: final, now: at ?? deps.now(), seq: summarySeq)
        deps.send(.summary(s))
        summarySeq += 1
        // Reset AFTER the send, matching this file's send-then-advance
        // discipline: a throwing transport must leave the collector believing it
        // still owes a summary, or the throw silently discards the fact that
        // anything was accumulated and the next periodic summary never fires.
        entriesSinceSummary = 0
    }

    private func sendChunk() {
        if pending.isEmpty { return }
        deps.send(.chunk(VitalsChunk(sessionId: _sessionId, seq: seq, entries: pending)))
        pending = []
        pendingApproxBytes = 0
        seq += 1
        bumpSummaryCadence()
    }

    /// Advances the periodic non-final summary cadence by one interval.
    ///
    /// Called from `sendChunk` AND from the flush tick when there was nothing
    /// to send. Both matter: the cadence used to live inside `sendChunk`
    /// alone, and `sendChunk` returns early on an empty buffer — so once
    /// samples stopped being transported, a session with no playback activity
    /// produced no chunks and therefore no periodic summaries at all. That
    /// silently broke two things: memPeak/memAvg only reached the server if
    /// the session ended cleanly (an app killed by the OS lost them
    /// entirely), and the server's `lastSeenAt` stopped advancing while the
    /// session was still live, which drives stale-session detection and
    /// retention.
    ///
    /// Gated on `entriesSinceSummary` so a collector on a genuinely dead
    /// session stays silent rather than heartbeating forever. Samples count
    /// as accumulation even though they are not transported.
    private func bumpSummaryCadence() {
        if entriesSinceSummary == 0 { return }
        chunksSinceSummary += 1
        if chunksSinceSummary >= deps.summaryEveryChunks {
            chunksSinceSummary = 0
            sendSummary(final: false)
        }
    }

    private func finalizeSession(at: Int64) {
        sendChunk()
        sendSummary(final: true, at: at)
    }

    private func startNewSession(startedAt: Int64) {
        let id = deps.newSessionId()
        setSessionId(id)
        seq = 0; summarySeq = 0; chunksSinceSummary = 0
        sessionStartedAt = startedAt
        accumulator = SummaryAccumulator(sessionId: id, startedAt: startedAt, dims: deps.dims)
        ring.removeAll()
        sendSummary(final: false)
    }

    /// EXACT framed cost; Int.max on any failure so an unencodable chunk reads as over-budget.
    private func chunkCost() -> Int {
        exactCostCalls += 1
        guard let d = try? VitalsWireCodec.encodePayload(.chunk(VitalsChunk(sessionId: _sessionId, seq: seq, entries: pending))) else { return Int.max }
        return d.count
    }

    private func entryCost(_ e: VitalsEntry) -> Int {
        guard let d = try? VitalsWireCodec.encodeEntry(e) else { return Self.approxBytesCap }
        return d.count + 1
    }

    /// Codex round-6, W6-I3 — every entry is tested, not just an expired PREFIX. The ring is in
    /// ARRIVAL order, and `t` is an explicit transition timestamp on a player event, so an entry
    /// stamped before one already in the ring can arrive after it: a delayed player outbox drains
    /// into a ring whose newest entry is minutes younger. Prefix pruning stopped at the first fresh
    /// entry and kept everything behind it, so the stale evidence survived into the crash stamp and
    /// — worse — a delayed backlog could fill the newest `maxEnvelopeVitalsEntries` arrival slots
    /// `recent()`/`stamp()` take and displace the evidence that actually describes the crash.
    ///
    /// `removeAll(where:)` is in place and order preserving, so this stays a single O(ring) pass
    /// with no allocation — the `maxRingEntries` cap (800) bounds it, which is what keeps the
    /// crash path's timed acquisition bounded.
    private func pruneRing(cutoff: Int64) {
        ring.removeAll { $0.t < cutoff }
    }

    private func rotateIfSeqExhausted() -> Bool {
        if seq < deps.maxSeq - 1 && summarySeq < deps.maxSeq - 1 { return false }
        let at = deps.now()
        finalizeSession(at: at); startNewSession(startedAt: at)
        return true
    }

    private struct RotationTrigger {
        let idleGap: Bool, maxAge: Bool, seqExhausted: Bool
        var any: Bool { idleGap || maxAge || seqExhausted }
    }

    private func rotationTrigger(nowT: Int64) -> RotationTrigger {
        RotationTrigger(
            idleGap: lastEntryAt.map { nowT - $0 > deps.maxIdleMs } ?? false,
            maxAge: nowT - sessionStartedAt >= deps.maxSessionMs,
            seqExhausted: seq >= deps.maxSeq - 1 || summarySeq >= deps.maxSeq - 1)
    }

    private struct AddResult { let rotated: Bool; let accepted: Bool }

    private func addEntry(_ entry: VitalsEntry, nowT: Int64, rot: RotationTrigger) -> AddResult {
        var rotated = false
        if rot.idleGap {
            finalizeSession(at: lastEntryAt!); startNewSession(startedAt: nowT); rotated = true
        } else if rot.maxAge {
            finalizeSession(at: sessionStartedAt + deps.maxSessionMs); startNewSession(startedAt: nowT); rotated = true
        } else if rot.seqExhausted {
            finalizeSession(at: nowT); startNewSession(startedAt: nowT); rotated = true
        }
        lastEntryAt = nowT

        // CPU/memory samples feed the accumulator (so memPeak/memAvg still land
        // on the summary) and count as activity above (so rotation and
        // lastEntryAt are unchanged) — but they are never transported.
        // Resource consumption is covered by the report resource window: a
        // 2-second-resolution ring attached to the report or crash that
        // explains it, which is both finer than this 30-second stream and
        // actually aligned to the failure. The API discards `sample` entries
        // on arrival, so shipping them only spends battery and bandwidth.
        var transported = true
        if case .sample = entry { transported = false }
        var transportRefused = false
        if transported {
            let cost = entryCost(entry)
            pending.append(entry)
            pendingApproxBytes = min(pendingApproxBytes + cost, Self.approxBytesCap)
            let budget = deps.maxBufferBytes - Self.requestWrapperReserveBytes
            if pendingApproxBytes >= budget - Self.exactCostMarginBytes && chunkCost() > budget {
                // Round-2, Important 8 — FLUSH BEFORE ADMIT; nothing accepted is ever deleted.
                pending.removeLast()
                if !pending.isEmpty { sendChunk() }
                pending.append(entry)
                pendingApproxBytes = min(cost, Self.approxBytesCap)
                if chunkCost() > budget {
                    pending.removeLast(); pendingApproxBytes = 0; transportRefused = true
                }
            }
            if !transportRefused {
                // The ring is stamped verbatim into a bug/crash report, so an
                // entry that is not transported must not enter it either.
                ring.append(entry)
                if ring.count > Self.maxRingEntries { ring.removeFirst(ring.count - Self.maxRingEntries) }
            }
        }
        pruneRing(cutoff: nowT - Self.recentWindowMs)
        // Marked HERE, beside the accumulator call that gives it meaning,
        // not up beside `lastEntryAt`. FLUSH BEFORE ADMIT can send a chunk —
        // and therefore a summary — in the middle of this function, before
        // the triggering entry has been applied; marking dirty earlier let
        // that summary clear the flag out from under an entry it had not yet
        // counted, leaving the entry's own contribution with nothing to push
        // it out periodically. A transport-refused entry reaches neither the
        // accumulator nor this counter, which is the same rule.
        if !transportRefused {
            accumulator.onEntry(entry)
            entriesSinceSummary += 1
        }
        if transported && pending.count >= deps.maxEntriesPerChunk { sendChunk() }
        return AddResult(rotated: rotated, accepted: !transportRefused)
    }

    private func fireRotate(_ trigger: VitalsEntry?) {
        guard let cb = deps.onRotate else { return }
        dispatch("VitalsCollector.onRotate") { cb(trigger) }
    }

    // MARK: public API

    /// A record whose rotation notification has NOT been fired yet.
    final class Recorded: @unchecked Sendable {
        let accepted: Bool
        /// The session the entry LANDED in (after any rotation it triggered). Non-nil iff accepted.
        let sessionId: String?
        private let lock = NSLock()
        private var rotate: (() -> Void)?
        init(accepted: Bool, sessionId: String?, rotate: (() -> Void)?) {
            self.accepted = accepted; self.sessionId = sessionId; self.rotate = rotate
        }
        /// One-shot (Android parked item "fireRotate not one-shot" closed here).
        func fireRotate() {
            lock.lock(); let r = rotate; rotate = nil; lock.unlock()
            r?()
        }
    }
    private static let refused = Recorded(accepted: false, sessionId: nil, rotate: nil)

    func recordSample(_ s: VitalsSample) {
        dispatch("VitalsCollector.recordSample") {
            let r: AddResult? = locked {
                if stopped { return nil }
                let nowT = deps.now()
                return addEntry(.sample(s), nowT: nowT, rot: rotationTrigger(nowT: nowT))
            }
            if let r, r.rotated { fireRotate(.sample(s)) }
        }
    }

    /// `originatedAt` is the caller-supplied TRANSITION TIME (`PlayerIntegrationContext.emit`'s
    /// `t`), nil when the entry is stamped on arrival. See `admit`.
    func recordPlayerEventDeferred(_ e: VitalsPlayerEvent, expectedSessionId: String? = nil, originatedAt: Int64? = nil) -> Recorded {
        dispatch("VitalsCollector.recordPlayerEvent") {
            let bounded = boundStructuredJson(e.data, maxBytes: VitalsLimits.maxPlayerEventDataBytes)
            var entry = e
            entry.data = bounded.data
            entry.truncated = bounded.truncated ? true : e.truncated
            return admit(.player(entry), expectedSessionId: expectedSessionId, originatedAt: originatedAt)
        } ?? Self.refused
    }

    @discardableResult
    func recordPlayerEvent(_ e: VitalsPlayerEvent) -> Bool {
        let r = recordPlayerEventDeferred(e); r.fireRotate(); return r.accepted
    }

    func recordCustomDeferred(_ e: VitalsCustomEntry, expectedSessionId: String? = nil) -> Recorded {
        dispatch("VitalsCollector.recordCustom") { admit(.custom(e), expectedSessionId: expectedSessionId) } ?? Self.refused
    }

    @discardableResult
    func recordCustom(_ e: VitalsCustomEntry) -> Bool {
        let r = recordCustomDeferred(e); r.fireRotate(); return r.accepted
    }

    /// The session CHECK, the ORIGIN check, the would-rotate decision and the admission are ONE
    /// critical section.
    ///
    /// Codex round-4, #3 — an entry that carries its OWN transition time (round-3, #5 gave the
    /// AVPlayer integration them) still resolved its SESSION at delivery time, so the two halves
    /// disagreed across a rotation: a drainer stalled with `play` at 10 s and `pause` at 15 s
    /// queued, another thread rotated at 20 s and re-announced the player, and both events then
    /// resolved against the NEW announcement — crediting a session that did not exist yet with
    /// five seconds of playback, so its summary could report `playtimeMs > durationMs`.
    /// `expectedSessionId` cannot see this: it comes from that new announcement.
    ///
    /// So an explicitly timestamped entry that PREDATES the session it would land in is refused
    /// here, inside the same critical section that reads `_sessionId` — the session start and the
    /// session id must be read together or the check is against a boundary that has already
    /// moved. Nothing is lost that the boundary does not restate: `describe()` re-opens the
    /// player's ongoing spans into the new session, stamped at the instant it READS that state
    /// (round-5, W5-I5 — at or after the new session's start, so this refusal never fires on a
    /// reseed) and queued in the same outbox BEHIND those stale events, which is exactly what a
    /// reseed is for.
    ///
    /// Codex round-5, M11 — the refusal CAN split a pair, and the comment that used to stand
    /// here ("a refused open implies a refused close") was false: a `play` at t₁ and its `pause`
    /// at t₂ straddling the boundary (t₁ < start ≤ t₂) refuses only the open, so the new session
    /// receives a pause with no matching play. It is harmless for a different reason. The
    /// accumulator's spans are PER-PLAYER IDEMPOTENT: a close for a player with no open interval
    /// removes nothing and adds nothing, and every interval it does close is clamped to a
    /// non-negative duration. The span the reseed re-opens is the one that counts.
    private func admit(_ entry: VitalsEntry, expectedSessionId: String?, originatedAt: Int64? = nil) -> Recorded {
        var landedIn: String?
        let r: AddResult? = locked {
            if stopped { return nil }
            if let expected = expectedSessionId, _sessionId != expected { return nil }
            if let origin = originatedAt, origin < sessionStartedAt { return nil }
            let nowT = deps.now()
            let rot = rotationTrigger(nowT: nowT)
            if expectedSessionId != nil && rot.any { return nil }
            let res = addEntry(entry, nowT: nowT, rot: rot)
            landedIn = _sessionId
            return res
        }
        guard let r else { return Self.refused }
        return Recorded(accepted: r.accepted, sessionId: r.accepted ? landedIn : nil,
                        rotate: r.rotated ? { [weak self] in self?.fireRotate(entry) } : nil)
    }

    /// Bounded: gives up after `lockTimeoutMs` and returns [] rather than block a dying thread.
    ///
    /// Round-1, O12 — and CAPPED at `maxEnvelopeVitalsEntries`, the same cap the envelope's
    /// stamp site applies. Production reads the ring through `stamp()`, so this is test-only
    /// today; returning the whole 800-entry ring left a future call site one line away from
    /// shipping twice what the spec says an enriched report may carry.
    func recent(windowMs: Int64 = VitalsCollector.recentWindowMs, lockTimeoutMs: Int64 = VitalsCollector.recentLockTimeoutMs) -> [VitalsEntry] {
        dispatch("VitalsCollector.recent") {
            guard lock.lock(before: Date(timeIntervalSinceNow: Double(lockTimeoutMs) / 1000)) else { return [] }
            defer { lock.unlock() }
            pruneRing(cutoff: deps.now() - windowMs)
            return Array(ring.suffix(VitalsLimits.maxEnvelopeVitalsEntries))
        } ?? []
    }

    /// Session id and ring under ONE timed acquisition (Android round-1, Important 4).
    func stamp(windowMs: Int64 = VitalsCollector.recentWindowMs, lockTimeoutMs: Int64 = VitalsCollector.recentLockTimeoutMs) -> VitalsStamp {
        dispatch("VitalsCollector.stamp") {
            guard lock.lock(before: Date(timeIntervalSinceNow: Double(lockTimeoutMs) / 1000)) else {
                return VitalsStamp(sessionId: sessionId, entries: [])
            }
            defer { lock.unlock() }
            pruneRing(cutoff: deps.now() - windowMs)
            return VitalsStamp(sessionId: _sessionId, entries: ring)
        } ?? VitalsStamp(sessionId: sessionId, entries: [])
    }

    func flushNow() {
        dispatch("VitalsCollector.flushNow") {
            let rotated: Bool = locked {
                if stopped { return false }
                let r = rotateIfSeqExhausted()
                sendChunk(); sendSummary(final: false)
                return r
            }
            if rotated { fireRotate(nil) }
        }
    }

    func stop() {
        dispatch("VitalsCollector.stop") {
            locked {
                if stopped { return }
                stopped = true
                timer?.cancel(); timer = nil
                defer { ring.removeAll() }    // evidence zeroized even if finalize fails (round-1, Important 5)
                _ = rotateIfSeqExhausted()
                finalizeSession(at: deps.now())
            }
        }
    }
}
