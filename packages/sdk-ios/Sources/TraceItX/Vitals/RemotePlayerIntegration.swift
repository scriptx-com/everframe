// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Event-fed PlayerIntegration (RN spec 2026-09-06 §2) — twin of
// sdk-android's RemotePlayerIntegration.kt. The player lives where this SDK
// cannot see it; the host feeds the phase-4 vocabulary through `record`/
// `updateStats`. Forwards, keeps the model `describe()`/`attach()` seed from,
// serves `snapshot()` from the host-fed cache. Model stores RAW data;
// `source_change.src` is sanitised on every emission with the flag resolved
// at attach time (the I13 provider rule).
//
// EMISSION OUTBOX (codex round-1, C2) — the same mechanism AVPlayerIntegration
// uses, in its smallest useful form (no gates: this integration spends no
// error budget; it does carry AVPlayer's completion BARRIER since round-2 D1,
// because `detach(onComplete:)` must not signal past queued closers). Every
// emission, wherever
// it comes from (`record`, the `attach` seed, `describe`, `detach`), is
// appended to a FIFO *inside the same critical section that mutated the model*,
// together with the context it is owed to and its own timestamp; the queue is
// drained OUTSIDE the lock by whichever thread finds no drainer running.
// Because the model update and the enqueue are one critical section, emission
// order equals model order.
//
// What that fixes: `describe()` used to copy `playing = true`, unlock, and
// emit. A concurrent `record("pause")` could slip in between, emit its `pause`,
// and leave the stale reseed to emit `play` LAST — the accumulator then opened
// a play span for a paused player and accrued playtime to the end of the
// session, with no later transition to close it. The same window existed
// between `record`'s model update and its own emit.
import Foundation
import TraceItXProtocol

public final class RemotePlayerIntegration: PlayerIntegration, AttachRollback, @unchecked Sendable {
    public let library: String
    public let version: String?
    private let captureSourceQuery: () -> Bool
    /// Clock for the emissions this class originates itself — the `attach`/`describe` seeds
    /// and the closing spans `detach()` emits. Host-fed events carry the host's own `t` and
    /// never use this. Injected so the fixture-parity driver and the unit tests can pin it;
    /// production uses the system clock, the same base `PlayerIntegrationContext.now()` reports.
    private let now: () -> Int64
    private let lock = NSLock()
    private var ctx: PlayerIntegrationContext?
    private var keepSourceQuery = false
    // Model — RAW data as received; source_change is sanitised on every emission.
    private var source: [String: Any]?
    private var drm: [String: Any]?
    /// HOST TRUTH — what the host last told us through `record`, independent of any
    /// announcement. Codex round-4, F1: this is the half that must survive a teardown.
    /// A `detach()` unbinds the announcement; it does not stop the player. The SAME
    /// integration object is bound again on every path that re-attaches it — a deferred
    /// registration retried after an attach rollback, a controller that re-announces the
    /// player against a new session — and the seed of that next attach is only as good as
    /// what we still remember the player to be doing. Before the split, `detach()` cleared
    /// `playing`/`buffering` (round-1, C1 made it close its spans), so the re-attached
    /// registration announced a playing player with NO open span — and for uninterrupted
    /// playback no later transition ever comes.
    ///
    /// Codex round-5: the RN reconfigure path no longer goes through this object at all.
    /// The registry's blanket re-registration is gone; a restarted SDK is now followed by
    /// the JS hooks detaching the old token and tracking a FRESH one, i.e. a NEW
    /// integration. The rule above still holds for every in-session re-attach, which is
    /// where it was always load-bearing.
    private var hostPlaying = false
    private var hostBuffering = false
    /// ANNOUNCED span state — what is currently OPEN in the bound `ctx`, which is not the
    /// same question as what the player is doing. Only these two decide what `detach()` has
    /// to close: closing a span the bound ctx never heard opened would fabricate a `pause`
    /// or a `buffer_end` out of nothing, and leaving one open that it did hear accrues to
    /// the end of the session. Seeded from host truth by `attach`/`describe`, moved by
    /// `record` only while a ctx is bound, cleared by `detach()`/`rollbackAttach()`.
    private var spanPlaying = false
    private var spanBuffering = false
    private var stats: [String: Any]?
    private var statsSeq: Int64 = 0
    private var servedSeq: Int64 = 0
    private var droppedCommitted: Int64 = 0
    /// The timestamp of the most recent `attach`/`describe` SEED, 0 until the first one.
    /// Written under `lock` inside `seedLocked`, with the same `now()` the seed entries carry.
    /// See `reseedFloor(for:)` for what it is for. Twin of the Kotlin `lastSeedAt`.
    private var lastSeedAt: Int64 = 0

    /// One queued emission and the context it is owed to. Guarded by `lock`.
    private struct Queued { let ctx: PlayerIntegrationContext; let type: String; let data: [String: Any?]?; let t: Int64 }
    /// The outbox carries two kinds of work, in ONE order.
    ///
    /// Codex round-2, D1 — a `.barrier` is an ORDERED COMPLETION, and it is what makes
    /// `detach(onComplete:)` honest. `detach()` queues its closing `buffer_end`/`pause` and
    /// then calls `drainOutbox()`, which RETURNS IMMEDIATELY when another thread already owns
    /// the drain; the inherited `PlayerIntegration.detach(onComplete:)` signalled completion
    /// there and then, so `VitalsController` marked the registration detached and recorded
    /// `player_detach` while the closing `pause` was still sitting in the queue — and the
    /// controller's own `reg.detached` check then REFUSED it when the drain finally reached it.
    /// The player's play span never closed and kept accruing playtime to the end of the
    /// session, which is exactly the harm the outbox was added to prevent.
    ///
    /// Putting the completion IN the queue, behind those emissions, makes the ordering
    /// structural: whoever owns the drain delivers the closing events and only then runs the
    /// barrier, exactly once. Nothing waits and no lock is held across it, so a drain owned by
    /// another thread can never block — or be blocked by — the thread that is detaching. Twin
    /// of `AVPlayerIntegration.OutboxItem` / `RemotePlayerIntegration.kt`'s `OutboxItem`.
    private enum OutboxItem {
        case emission(Queued)
        case barrier(() -> Void)
    }
    private var outbox: [OutboxItem] = []
    private var draining = false

    /// The wire allowlist minus the two markers the controller alone may stamp
    /// (`player_attach`/`player_detach`) — a host-fed event forging either would
    /// otherwise fabricate an attach/detach boundary no registration ever crossed.
    private static let hostEventTypes: Set<String> = VitalsPlayerEventTypes.all
        .subtracting([VitalsPlayerEventTypes.playerAttach, VitalsPlayerEventTypes.playerDetach])

    public init(library: String, version: String?, captureSourceQuery: @escaping () -> Bool,
                now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.library = library; self.version = version; self.captureSourceQuery = captureSourceQuery; self.now = now
    }

    /// Drain until empty, one owner at a time and never with `lock` held. A caller that finds
    /// another thread already draining returns immediately — its entries are in the queue and
    /// the owner will deliver them. Re-entrant emissions (a host that calls `record` from
    /// inside `emit`) land at the BACK of the queue and are picked up by the re-check below
    /// rather than jumping the line. A `.barrier` is run in its queue position, on whichever
    /// thread owns the drain when it is reached (round-2, D1).
    private func drainOutbox() {
        while true {
            lock.lock()
            guard !draining, !outbox.isEmpty else { lock.unlock(); return }
            draining = true
            let batch = outbox; outbox.removeAll()
            lock.unlock()
            for item in batch {
                switch item {
                case let .emission(q): _ = q.ctx.emit(q.type, data: q.data, t: q.t)
                case let .barrier(run): run()
                }
            }
            lock.lock(); draining = false; let more = !outbox.isEmpty; lock.unlock()
            if !more { return }
        }
    }

    /// Host-fed event. Updates the model AND queues the emission in one critical section;
    /// the queue is drained outside the lock.
    /// Silently ignored (model untouched, nothing emitted) when `type` is not a wire-valid
    /// player event, or is one of the two lifecycle markers the controller reserves for
    /// itself.
    public func record(_ type: String, t: Int64, data: [String: Any]?) {
        guard Self.hostEventTypes.contains(type) else { return }
        lock.lock()
        switch type {
        // Codex round-1, C8/C12 — a source change ends the OLD source's story. Both the
        // host-fed stats cache and the cached DRM describe the outgoing source; a new
        // source's `drm` arrives AFTER its own `source_change` if there is one at all, so
        // keeping the old one made the next `describe()` re-announce a key system the
        // current source may not use, and keeping the old stats let a sampler tick report
        // the previous source's buffer/bitrate/resolution.
        case "source_change": source = data; drm = nil; stats = nil
        case "drm": drm = data
        case "play": hostPlaying = true
        case "pause": hostPlaying = false
        case "buffer_start": hostBuffering = true
        case "buffer_end": hostBuffering = false
        default: break
        }
        if let target = ctx {
            // The ANNOUNCED state moves with the EMISSION, never with the model alone: an
            // event recorded while nothing is bound updates host truth and leaves the
            // announced state exactly as the last bound ctx heard it (round-4, F1).
            switch type {
            case "play": spanPlaying = true
            case "pause": spanPlaying = false
            case "buffer_start": spanBuffering = true
            case "buffer_end": spanBuffering = false
            default: break
            }
            let payload = type == "source_change" ? sanitised(data, keep: keepSourceQuery) : data
            outbox.append(.emission(Queued(ctx: target, type: type, data: payload?.mapValues { Optional($0) }, t: reseedFloor(for: type, t: t))))
        }
        lock.unlock()
        drainOutbox()
    }

    /// Codex round-3, E1 — the RESEED FLOOR, for span transitions only.
    ///
    /// The bridge is asynchronous: a JS `pause` stamped at t=1900 can still be in flight when
    /// the native side rotates the session at t=2000 and `describe()` seeds `play` into the new
    /// one at 2000. The `pause` then arrives carrying 1900, which PREDATES the session it would
    /// land in, and the collector drops it (`t < sessionStartedAt`, round-4 #3). The play span
    /// the reseed just opened is never closed — and a later `detach()` emits nothing to close it
    /// either, because the model's `playing` went false the moment the `pause` was recorded. The
    /// session accrues playtime to its end for a player that has been paused throughout.
    ///
    /// So a span transition that predates the seed which re-opened its span is stamped AT the
    /// seed: the earliest instant the new session can represent, and never earlier than the open
    /// it closes. The span is measured as zero-length rather than lost entirely, which is the
    /// truth as this session can express it. Only `play`/`pause`/`buffer_start`/`buffer_end` are
    /// clamped — they are the four the accumulator opens and closes spans with. Every other
    /// event type keeps the host's own `t` untouched: a `seek` or an `error` that lands late is
    /// a point in time, and moving it would misreport WHEN it happened for no gain. The MODEL
    /// update is unaffected either way; this only moves the emission's stamp.
    private func reseedFloor(for type: String, t: Int64) -> Int64 {
        guard Self.spanTypes.contains(type) else { return t }
        return max(t, lastSeedAt)
    }
    /// The four types the accumulator opens and closes spans with.
    private static let spanTypes: Set<String> = ["play", "pause", "buffer_start", "buffer_end"]

    public func updateStats(_ stats: [String: Any]) {
        lock.lock(); self.stats = stats; statsSeq += 1; lock.unlock()
    }

    public func attach(_ ctx: PlayerIntegrationContext) -> Bool {
        let keep = captureSourceQuery()
        lock.lock()
        self.ctx = ctx; keepSourceQuery = keep
        seedLocked(ctx, at: now())
        lock.unlock()
        drainOutbox()
        return true
    }

    public func describe(_ ctx: PlayerIntegrationContext) {
        lock.lock(); seedLocked(ctx, at: now()); lock.unlock()
        drainOutbox()
    }

    /// Under lock. Identity first, then open spans — say too much rather than too little.
    /// `t` is the instant the state was READ, captured in this same critical section: a drain
    /// that runs late must not stamp a span's open with delivery time while the transition
    /// that closes it carries the earlier moment it happened.
    private func seedLocked(_ target: PlayerIntegrationContext, at t: Int64) {
        // Unconditionally, even when nothing is seeded: the floor describes the SESSION
        // boundary this integration was last (re)seeded across, not what it happened to have
        // to say at the time. Plain assignment, not `max` — the floor tracks the LATEST seed,
        // so a wall clock corrected backwards leaves it on the same base as the session start
        // the collector compares against, instead of pinning it to a stale future reading.
        // See `reseedFloor(for:)`.
        lastSeedAt = t
        if let src = source {
            outbox.append(.emission(Queued(ctx: target, type: "source_change", data: sanitised(src, keep: keepSourceQuery)?.mapValues { Optional($0) }, t: t)))
        }
        if let d = drm { outbox.append(.emission(Queued(ctx: target, type: "drm", data: d.mapValues { Optional($0) }, t: t))) }
        if hostPlaying { outbox.append(.emission(Queued(ctx: target, type: "play", data: nil, t: t))) }
        if hostBuffering { outbox.append(.emission(Queued(ctx: target, type: "buffer_start", data: nil, t: t))) }
        // The seed IS the announcement, so the announced state becomes host truth exactly
        // (round-4, F1) — including the false side: a seed that opened nothing leaves nothing
        // for a later `detach()` to close.
        spanPlaying = hostPlaying; spanBuffering = hostBuffering
    }

    public func snapshot(_ onResult: @escaping (PlayerSnapshot?) -> Bool) {
        lock.lock()
        var snap: PlayerSnapshot?
        var cumulative: Int64?
        if let s = stats, statsSeq != servedSeq {
            servedSeq = statsSeq
            cumulative = Self.nonNegInt64(s["droppedFrames"])
            let delta = max(0, min(Int64(Int32.max), (cumulative ?? 0) - droppedCommitted))
            snap = PlayerSnapshot(
                bufferAheadMs: Self.nonNegInt64(s["bufferAheadMs"]),
                bandwidthEstimate: Self.nonNegInt64(s["bandwidthEstimate"]),
                bitrate: Self.nonNegInt(s["bitrate"]), width: Self.nonNegInt(s["width"]), height: Self.nonNegInt(s["height"]),
                droppedFramesDelta: Int(delta))
        }
        lock.unlock()
        let recorded = onResult(snap)
        if recorded, let cumulative { lock.lock(); droppedCommitted = max(droppedCommitted, cumulative); lock.unlock() }
    }

    public func startupTimings() -> StartupTimings? { nil }

    /// Codex round-1, C1 — `detach()` CLOSES the accounting spans it opened.
    ///
    /// `player_detach` is not a closer at the accumulator: only `pause` closes a play span
    /// and only `buffer_end` closes a buffer span. A host that navigates away (or a Metro
    /// reload, which runs `detachAll()`) while its player is playing or stalled therefore
    /// left an open span accruing to the end of the SESSION — the very harm the outbox
    /// exists to prevent, arriving by another route.
    ///
    /// `buffer_end` first, then `pause`: a rebuffer is inside the play span, so closing the
    /// inner one first keeps the two spans properly nested. Both go through the outbox,
    /// queued before `ctx` is cleared, so they are ordered behind everything already queued
    /// and ahead of nothing. Idempotent (the latches are cleared here), and an integration
    /// that never attached queues nothing at all — there is no timeline to emit into.
    public func detach() { detach(barrier: nil) }

    /// The ASYNCHRONOUS form, and on this integration it really is asynchronous: `onComplete`
    /// runs from the outbox, strictly after this teardown's closing `buffer_end`/`pause` have
    /// been DELIVERED (codex round-2, D1). When this thread owns the drain that is still
    /// inside `detach(barrier:)`; when another thread owns it, that thread runs the barrier
    /// when it reaches it. Either way `player_detach` — and the `reg.detached` flag the
    /// controller sets with it — can no longer overtake the spans this teardown closes.
    /// Nothing blocks the caller. See `OutboxItem`.
    ///
    /// The synchronous `detach()` keeps its previous behaviour exactly: it queues the closers
    /// and no completion.
    public func detach(onComplete: @escaping () -> Void) { detach(barrier: onComplete) }

    private func detach(barrier: (() -> Void)?) {
        lock.lock()
        if let target = ctx {
            let t = now()
            if spanBuffering { outbox.append(.emission(Queued(ctx: target, type: "buffer_end", data: nil, t: t))) }
            if spanPlaying { outbox.append(.emission(Queued(ctx: target, type: "pause", data: nil, t: t))) }
        }
        // Only the ANNOUNCED state is cleared (round-4, F1). Host truth is what the player is
        // doing, and a detach does not stop it: the next `attach()` — a deferred registration
        // retried after a rollback, or a re-announcement against a new session — seeds from it.
        spanPlaying = false; spanBuffering = false
        ctx = nil
        // Queued in the SAME critical section as the closers above, so nothing this attachment
        // could still enqueue can land between them and the completion.
        if let barrier { outbox.append(.barrier(barrier)) }
        lock.unlock()
        drainOutbox()
    }

    /// Codex round-3, E2 — see `AttachRollback`. An attachment rollback is NOT a teardown.
    ///
    /// `VitalsController.trackPlayer` attaches before it publishes, and a `start()` that
    /// supersedes the controller in between refuses the publication. That refusal is transient:
    /// `VitalsRuntime` retries THE SAME integration against the next controller. Running the
    /// terminal `detach()` there clears `playing`/`buffering` (round-1, C1 made detach close its
    /// spans), so the retry announced the player into controller B with NO open spans — a host
    /// whose playback never paused went unmeasured until its next transition, which for
    /// uninterrupted playback never comes. The host model is exactly what the retry needs.
    ///
    /// So: drop the attachment (`ctx`) and nothing else. `source`, `drm`, `playing`, `buffering`,
    /// `stats` and `lastSeedAt` all survive, and the next `attach()` seeds from them. Emits
    /// nothing — there is no timeline that would accept it.
    ///
    /// Entries this attachment already queued are LEFT in the outbox rather than filtered out.
    /// They are bound to a registration the controller never published, and
    /// `VitalsController.Ctx.emit` refuses those outright (`reg.announcedIn == nil` → dropped,
    /// not buffered), so they cost a drain and nothing else. Filtering would only ever be
    /// best-effort anyway — a concurrent drainer already holds its batch and cannot be reached —
    /// so leaving them keeps both paths identical instead of making one of them look reliable.
    func rollbackAttach() {
        lock.lock()
        ctx = nil
        // Round-4, F1 — the announced state belongs to the attachment being rolled back, so it
        // goes with it; host truth is untouched, exactly as before. (This is now the SAME
        // clearing `detach()` does, minus the closing emissions — which is what makes E2's
        // "the retry re-seeds the open spans" behaviour fall out of the split rather than
        // needing a rule of its own.)
        spanPlaying = false; spanBuffering = false
        lock.unlock()
    }

    /// `mime`, when the host supplies it, wins over the URL-extension guess — an
    /// extensionless manifest URL (routine for HLS/DASH) would otherwise sanitise to
    /// `protocol: "unknown"` even though the host already knows the real protocol.
    private func sanitised(_ data: [String: Any]?, keep: Bool) -> [String: Any]? {
        guard var d = data else { return nil }
        let s = sanitizeSource(d["src"] as? String, keepQuery: keep)
        d["src"] = s.src
        d["protocol"] = protocolForMime(d["mime"] as? String) ?? s.protocol
        return d
    }

    /// Finite, non-negative, fits Int64 — else nil. `Int64(_:)` traps on huge finite doubles (iOS loop).
    ///
    /// Codex round-1, C13 — a BOOLEAN is not a number here. `true` bridges to an `NSNumber`
    /// whose `doubleValue` is 1.0, so `{ width: true }` from a JS host used to be admitted as
    /// a resolution of 1 px; the Kotlin twin's `as? Number` refuses a `Boolean` outright, and
    /// this is what makes the two agree. The upper bound is likewise the SAME literal on both
    /// platforms: `9.2e18`, which is below `Int64.max` (9223372036854775807) and so keeps the
    /// `Int64(d)` conversion out of trapping range on every host.
    static func nonNegInt64(_ v: Any?) -> Int64? {
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let d = n.doubleValue
        guard d.isFinite, d >= 0, d < 9.2e18 else { return nil }
        return Int64(d)
    }
    static func nonNegInt(_ v: Any?) -> Int? {
        guard let x = nonNegInt64(v) else { return nil }
        return Int(min(x, Int64(Int32.max)))
    }
}
