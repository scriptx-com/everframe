// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// AVFoundation → the vitals player vocabulary (iOS spec 2026-09-05 §3). Never
// an entry per segment. All state lives under `lock`; every handler computes
// its emissions AND QUEUES them under the lock, and one owner drains that
// queue after releasing it, so the collector lock is never taken while `lock`
// is held (and vice versa) and emissions cannot overtake each other between
// the transition that produced them and the timeline (codex round-1, #4).
//
// Rulings carried over from Media3Integration.kt:
//  - attach() SEEDS from current state (a joined player opens its play span);
//    a joined item never measures startup; `firstFrameSeen` decides whether a
//    later waiting-to-minimize-stalls is a rebuffer (playing / ready → past
//    startup; an item still `.unknown` is still starting up).
//  - describe() says TOO MUCH rather than too little (duplicate opens are no-ops
//    at the accumulator).
//  - detach() closes open spans first, may be called on a never-attached
//    integration, and releases the declaration-time release sentinel.
//  - the non-fatal error allowance is charged only against ACCEPTED emissions.
//  - dropped frames are cumulative; the delta is committed only when the
//    controller says it recorded the stats entry.
import Foundation
import TraceItXProtocol

final class AVPlayerIntegration: PlayerIntegration, AttachRollback, @unchecked Sendable {
    static let nonFatalWindowMs: Int64 = 60_000
    static let nonFatalPerWindow = 10
    static let seekThresholdMs: Int64 = 1_000

    let library = "avplayer"
    let version: String? = {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "\(v.majorVersion).\(v.minorVersion)"
    }()

    private let facade: PlayerFacade
    private let captureSourceQuery: () -> Bool
    private let now: () -> Int64
    private let lock = NSLock()
    /// Where the release sentinel's work runs. See `observeRelease()` — it must NOT run on the
    /// thread that dropped the player's last reference, which can be this integration itself
    /// with `lock` held. Serial and process-wide, so releases stay ordered against each other.
    private let releaseQueue: DispatchQueue

    // attachment
    private var ctx: PlayerIntegrationContext?
    private var attached = false
    private var keepSourceQuery = false
    private var releaseObserved = false
    private var released = false
    var onReleased: (() -> Void)?

    // cached identity / spans
    private var lastSource: [String: Any?]?
    private var lastDrm: [String: Any?]?
    private var playing = false
    private var playEmitted = false
    private var bufferStartAt: Int64?
    // per item
    private var itemStartedAt: Int64?
    private var playIntentAt: Int64?
    private var firstFrameSeen = false
    private var isFairPlay = false
    private var preferredPeakBitRate: Double = 0
    private var accessLogStartupMs: Int64?
    private var isLive = false
    private var drmDescribed = false
    // quality / stats cache
    private var lastNonZeroRate: Float?
    private var lastIndicatedBitrate: Int?
    private var observedBitrate: Int64?
    private var width = 0, height = 0
    private var playheadMs: Int64 = 0
    /// Whether `playheadMs` describes THIS item yet (codex round-4, #5). An item change resets the
    /// playhead, and the first position observation for the new item ESTABLISHES the baseline
    /// rather than being differenced against a position that belongs to no item — otherwise the
    /// `timeJumped` notification AVFoundation posts as a fresh item's timeline becomes valid is
    /// read as a seek from wherever the previous item happened to be (or, on a live stream whose
    /// start is far from zero, from zero).
    private var playheadSeeded = false
    private var loadedRangesMs: [(start: Int64, end: Int64)] = []
    private var droppedTotal = 0, droppedReported = 0
    /// The last access-log total seen for the CURRENT item. `AVPlayerItem.accessLog()` counts
    /// per ITEM and restarts at zero on every source change, so the lifetime total is built
    /// from per-item DIFFERENCES; only this baseline is reset when the item changes
    /// (codex round-1, #10 — Android adds per-item deltas the same way).
    private var droppedItemBaseline = 0
    /// The facade item generation the per-item cache above belongs to (codex round-2, #6). It is
    /// seeded once by `attach()` and thereafter set from the generation each item change CARRIES
    /// (round-3, #2 — re-reading the facade's current one relabelled a stalled change with a
    /// newer item's generation), and compared inside every other per-item handler's critical
    /// section, so the check and the state mutation it guards are ONE critical section on this
    /// lock — checking a generation and then unlocking before applying leaves the same race.
    /// A per-item callback that arrives after its item was replaced is DROPPED, and the next
    /// access-log entry for the new item (there is one per segment) lands normally against a
    /// baseline that is already 0.
    private var itemGeneration: UInt64 = 0
    /// A `.readyToPlay` that arrived for an item generation this integration has not adopted yet
    /// (codex round-4, M9). The facade bumps the generation and installs the new item's status
    /// observer under its own lock, then delivers the item change — so that observer can fire in
    /// between, and dropping the status outright cost the new item its `drm` entry whenever it
    /// became ready without ever reaching `.playing` (`onTimeControl` recovers only that case).
    /// It cannot be APPLIED early: `isFairPlay` still describes the previous item until `onItem`
    /// runs, and publishing that would be exactly the mislabelling round-3 #2 closed. So it is
    /// HELD, and `onItem` redeems it against the generation it actually names.
    private var pendingReadyGeneration: UInt64?
    private var nonFatalTimes: [Int64] = []

    private typealias Emission = (type: String, data: [String: Any?]?)
    /// One queued emission and the context it is owed to — `ctx` for a live callback or a
    /// teardown, the bound describe context for a reseed. `onResult` carries the collector's
    /// answer back to whoever queued the entry (the non-fatal error allowance is charged only
    /// against an ACCEPTED emission, and queueing must not lose that feedback); it is invoked
    /// by the drainer, outside `lock`. The queue itself is guarded by `lock`.
    ///
    /// Codex round-3, #5 — `t` is the WALL TIME OF THE TRANSITION, captured in the same critical
    /// section that applied it, not the time the drainer got to it. Everything used to queue with
    /// `t: nil`, which stamps drain time: a drainer stalled from 10 s to 20 s turned a
    /// `buffer_start` at 10 s and a `buffer_end` at 15 s into two entries stamped 20 s, so the
    /// summary accumulated ~0 ms of rebuffering while the `buffer_end` entry's own `durationMs`
    /// said 5000 — an entry that contradicts itself. Play/pause spans compressed the same way.
    /// The outbox is what introduced the gap: before it, emissions were synchronous and carried
    /// their own time implicitly. One `now()` per critical section also makes `durationMs` and the
    /// accumulator's span arithmetic agree exactly, since both are computed from the same instant.
    ///
    /// Round-6, W6-M7 — every site in this file now stamps, `describe()` included: wave 5's
    /// W5-I5 gave the reseed the instant it READ the state it re-states, which is the origin the
    /// collector's session check needs, rather than whenever the drainer got to it. `t` stays
    /// optional only because `PlayerIntegrationContext.emit` is public API and a customer
    /// integration may have no transition time to give, in which case the entry is stamped on
    /// arrival; nothing here relies on that any more.
    private struct Queued { let ctx: PlayerIntegrationContext; let e: Emission; let t: Int64?; var onResult: ((Bool) -> Void)? = nil
        /// Run by the drainer immediately BEFORE `emit`, outside `lock`; `false` drops the entry
        /// without emitting it. See `onErrorLog` (round-3, #4) — a budget that is charged on the
        /// way out has to be CHECKED on the way out too, or a stalled drain lets every queued
        /// entry past a limit none of them had spent yet.
        var gate: (() -> Bool)? = nil
    }
    /// The outbox carries two kinds of work, in ONE order.
    ///
    /// Codex round-2, #3 — a `.barrier` is an ORDERED COMPLETION, and it is what makes
    /// `detach(onComplete:)` honest. `detach()` queues its closing `buffer_end`/`pause` and then
    /// calls `drainOutbox()`, which RETURNS IMMEDIATELY when another thread already owns the
    /// drain; the default `PlayerIntegration.detach(onComplete:)` signalled completion there and
    /// then, so `detachAndMark` set `reg.detached = true` and recorded `player_detach` while the
    /// closing `pause` was still sitting in the queue — and `Ctx.emit`'s `reg.detached ? nil : …`
    /// then refused it. The player's play span never closed and kept accruing playtime to the end
    /// of the session, which is exactly the harm the outbox was added to prevent. On the
    /// `shutdown()` path it was worse still: `group.wait` no longer implied delivery, and the
    /// collector was already stopped by the time the drainer got there.
    ///
    /// Putting the completion IN the queue, behind those emissions, makes the ordering
    /// structural: whoever owns the drain delivers the closing events and only then runs the
    /// barrier. Nothing waits and no lock is held across it, so a drain owned by another thread
    /// can never block — or be blocked by — the thread that is detaching.
    private enum OutboxItem {
        case emission(Queued)
        case barrier(() -> Void)
    }
    private var outbox: [OutboxItem] = []
    private var draining = false

    init(facade: PlayerFacade, captureSourceQuery: @escaping () -> Bool, now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
         releaseQueue: DispatchQueue = VitalsQueue.shared) {
        self.facade = facade; self.captureSourceQuery = captureSourceQuery; self.now = now; self.releaseQueue = releaseQueue
    }

    /// Run `body` under the lock and QUEUE what it returns; the queue is drained outside the
    /// lock, by one owner at a time.
    ///
    /// Codex round-1, #4 — computing under the lock and emitting after it is not enough on its
    /// own. Thread A could apply `.playing`, drop the lock and stall before emitting `play`
    /// while thread B applied `.paused` and emitted `pause`; `play` then arrived last and the
    /// accumulator opened a playback span for a player that is paused — and, because the
    /// integration's own `playing` latch is already false, detach() emits no corrective pause,
    /// so the span runs to the end of the session. Appending to the outbox INSIDE the same
    /// critical section that mutated the state makes the queue's order the transition order,
    /// and a single drainer preserves it on the way out.
    private func locked(_ body: (Int64) -> [Emission]) {
        lock.lock()
        // ONE `now()` for the whole critical section (round-3, #5): the transition's own time,
        // used both for the state it writes and for the entries it queues, so a stalled drain
        // cannot compress the spans it produced.
        let t = now()
        if let c = ctx { outbox.append(contentsOf: body(t).map { .emission(Queued(ctx: c, e: $0, t: t)) }) } else { _ = body(t) }
        lock.unlock()
        drainOutbox()
    }

    /// Drain until empty, one owner at a time and never with `lock` held. A caller that finds
    /// another thread already draining returns immediately — its entries are already in the
    /// queue, and the owner delivers them. Re-entrant emissions (a rotation reseed calls
    /// describe() from inside emit()) land at the back of the queue and are picked up by the
    /// re-check below rather than jumping the line. A `.barrier` is run in its queue position,
    /// on whichever thread owns the drain when it is reached (round-2, #3).
    private func drainOutbox() {
        while true {
            lock.lock()
            guard !draining, !outbox.isEmpty else { lock.unlock(); return }
            draining = true
            let batch = outbox; outbox.removeAll()
            lock.unlock()
            for item in batch {
                switch item {
                // NOT `q.onResult?(q.ctx.emit(...))`: optional chaining skips argument evaluation
                // when the base is nil, so an entry nobody is listening for would never be emitted.
                case let .emission(q):
                    // The gate runs in the single drainer, in queue order and with no lock held,
                    // so check-then-emit-then-charge is atomic against every other queued entry.
                    if let gate = q.gate, !gate() { continue }
                    let accepted = q.ctx.emit(q.e.type, data: q.e.data, t: q.t)
                    q.onResult?(accepted)
                case let .barrier(run):
                    run()
                }
            }
            lock.lock(); draining = false; let more = !outbox.isEmpty; lock.unlock()
            if !more { return }
        }
    }

    // MARK: PlayerIntegration

    func attach(_ ctx: PlayerIntegrationContext) -> Bool {
        let events = PlayerFacadeEvents()
        events.onItemChanged = { [weak self] item, fp, peak, gen in self?.onItem(item: item, isFairPlay: fp, preferredPeakBitRate: peak, generation: gen) }
        events.onTimeControlChanged = { [weak self] tc in self?.onTimeControl(tc) }
        events.onRateChanged = { [weak self] r in self?.onRate(r) }
        events.onItemStatusChanged = { [weak self] s, gen in self?.onItemStatus(s, generation: gen) }
        events.onPresentationSizeChanged = { [weak self] w, h, gen in self?.onPresentationSize(w, h, gen) }
        events.onLoadedRangesChanged = { [weak self] r, gen in
            guard let self else { return }
            // Per-item, and generation-gated so a range read for the previous item is not adopted
            // as this one's (round-3, #2). `onItem` clears the cache for the same reason
            // (round-4, #5) — an unbuffered new item must not inherit the old one's ranges.
            self.lock.lock(); if gen == self.itemGeneration { self.loadedRangesMs = r }; self.lock.unlock()
        }
        events.onAccessLogEntry = { [weak self] s in self?.onAccessLog(s) }
        events.onErrorLogEntry = { [weak self] s in self?.onErrorLog(s) }
        events.onTimeJumped = { [weak self] ms, gen in self?.onTimeJumped(ms, generation: gen) }
        events.onFailedToPlayToEnd = { [weak self] d, c, m in self?.onFatal(domain: d, code: c, message: m, detail: d) }
        events.onPeriodicTime = { [weak self] ms, gen in
            guard let self else { return }
            // It also SEEDS the playhead after an item change (round-4, #5) — but only for the
            // item it is FOR. Codex round-7, W7-I1: the registration behind this is player-level,
            // which is why it used to be applied ungated, but the position it carries is the
            // current item's. A tick read for A and delivered after B replaced it set B's
            // playhead to A's position AND marked it seeded, so B's first `timeJumped` was
            // differenced against A — a fabricated `seek` across the item boundary, exactly what
            // `playheadSeeded` exists to prevent — and the stats in between measured B's buffer
            // ahead from A's position. The facade now reads the position and the generation
            // together (`readTick()`), so this gate is enough; attaching the CURRENT generation
            // to an already-captured position would have preserved the bug.
            self.lock.lock()
            if gen == self.itemGeneration { self.playheadMs = ms; self.playheadSeeded = true }
            self.lock.unlock()
        }

        lock.lock()
        if attached { lock.unlock(); return true }       // a genuine double attach: the first wins
        guard facade.observe(events) else { lock.unlock(); return false }
        attached = true
        self.ctx = ctx
        keepSourceQuery = captureSourceQuery()
        // Whatever item registration is CURRENT when this seed is read is the one it describes.
        // The only read of `facade.currentItemGeneration` left (round-3, #2): every later
        // per-item callback carries its own, so nothing can be relabelled by a newer one. The
        // access-log pull below reports a generation too, but it reports the one it read the
        // counters under — it is compared against this, never a substitute for it.
        //
        // Codex round-6, W6-I2 — the generation is read BEFORE the state, and adopting it here
        // marks it INITIALISED. `observe()` installs a registration of its own, but an item
        // change already in flight can have bumped past it inside the facade and be parked on
        // this very lock: the seed then describes THAT item, under THAT generation, and the
        // parked `onItem` for it is a duplicate initialisation. `onItem` takes strictly newer
        // generations only (see there), so it can no longer clear `firstFrameSeen` and invent a
        // fresh `itemStartedAt` for an item this seed already reported as past its first frame —
        // which turned that item's next stall into a startup and let resumption emit a fabricated
        // startup measurement, exactly what ruling R11 forbids.
        //
        // Reading the generation first is what makes the pair coherent in the only direction that
        // matters: the state can be as new as the generation or newer, never older. When it is
        // newer, the change that produced it carries a HIGHER generation and is still accepted,
        // so it corrects the label; were the order reversed, older state would be labelled with a
        // newer generation and the correcting change would be the one suppressed.
        itemGeneration = facade.currentItemGeneration
        let t = now()
        let seed = facade.readState().map { seedFrom($0, at: t) } ?? []
        // Codex round-7, W7-I2 — the item may have been dropping frames long before we joined it,
        // and `droppedItemBaseline` starting at 0 charged this registration the item's WHOLE
        // history: join an item at 100 dropped frames, see 105, and the first `stats` reported
        // 105. The baseline is the cumulative total AS OF ATTACHMENT, so only frames observed
        // afterwards are counted — which is what Android's `onDroppedVideoFrames` listener gives
        // for free, since it is handed per-callback deltas from the moment it is added.
        //
        // Only when the log names the generation this seed adopted. A newer one means the item
        // changed under us, and a new item's log restarts at zero, so a baseline of 0 is already
        // the right answer for it (and `onItem` sets exactly that when the change arrives).
        if let log = facade.readAccessLog(), log.itemGeneration == itemGeneration {
            droppedItemBaseline = max(0, log.droppedFramesTotal)
        }
        outbox.append(contentsOf: seed.map { .emission(Queued(ctx: ctx, e: $0, t: t)) })
        lock.unlock()
        drainOutbox()
        return true
    }

    /// Under lock. Builds lastSource / play / rebuffer / DRM state from a player joined mid-flight.
    ///
    /// What counts as "past startup" on AVFoundation. Media3's third clause —
    /// STATE_BUFFERING on a non-live player whose position has advanced — is
    /// deliberately NOT ported. `AVPlayerItem` has no synchronous live signal
    /// (`isLive` here is only ever learned from a LATER access-log entry, whose
    /// `playbackType` is the one thing that says so), so that clause could only
    /// ever run with `isLive == false` and would classify every live stream
    /// still starting up — whose start position is nonzero by construction — as
    /// a rebuffer. It is also redundant: `AVPlayerItem.status` is a one-way
    /// latch, so an item that has ever been ready reads `.readyToPlay` even
    /// mid-stall, which is exactly the join-mid-rebuffer case the clause
    /// existed for on Media3.
    ///
    /// It touches NO per-item latch — `itemStartedAt` and `playIntentAt` stay nil
    /// (Media3Integration.kt's `seedSource`, and its `onFirstFrame` at :491-497,
    /// which emits `startup` only when `itemStartedAt != null`). A JOINED ITEM
    /// THEREFORE REPORTS NO ttff, EVER, on either platform. Attach time is not a
    /// substitute: the item began before we arrived, so a ttff measured from here
    /// is a fabricated near-zero, and a fabricated zero does not merely lose one
    /// data point — it drags the dashboard's p50 startup down for every session
    /// that attached mid-launch. Nothing is the honest answer. Whether this seed
    /// counts as past the first frame is a separate question, decided above, and
    /// it is what stops a joined item's LATER stalls being mistaken for startup.
    private func seedFrom(_ s: PlayerState, at t: Int64) -> [Emission] {
        var out: [Emission] = []
        playing = s.timeControl == .playing
        isFairPlay = s.isFairPlay; preferredPeakBitRate = s.preferredPeakBitRate
        width = s.presentationWidth; height = s.presentationHeight
        playheadMs = s.currentTimeMs; playheadSeeded = true; loadedRangesMs = s.loadedRangesMs
        if s.rate != 0 { lastNonZeroRate = s.rate }
        // Round-7, W7-I3 — ITEM PRESENCE, not a URL. An item whose asset carries no URL is still
        // an item and still has a source identity; it is `unknown`, exactly as Android's
        // `sanitizeSource(cfg?.uri?.toString())` reports it for a `MediaItem` with no URI.
        if let item = s.item {
            let san = sanitizeSource(item.url?.absoluteString, keepQuery: keepSourceQuery)
            lastSource = ["src": san.src, "protocol": san.protocol, "live": isLive]
            out.append((VitalsPlayerEventTypes.sourceChange, lastSource))
        }
        if s.timeControl == .playing && !playEmitted { playEmitted = true; out.append((VitalsPlayerEventTypes.play, nil)) }
        if s.timeControl == .playing || s.itemStatus == .readyToPlay { firstFrameSeen = true }
        if firstFrameSeen && s.timeControl == .waitingToPlay(toMinimizeStalls: true) && bufferStartAt == nil {
            bufferStartAt = t; out.append((VitalsPlayerEventTypes.bufferStart, nil))
        }
        // Round-5 #10: joined past the first frame, no further status change is
        // guaranteed, so a clear item has to be reported here or the player is
        // reported with unknown DRM forever.
        if firstFrameSeen && lastDrm == nil {
            lastDrm = ["keySystem": isFairPlay ? "fairplay" : "none"]; drmDescribed = true
            out.append((VitalsPlayerEventTypes.drm, lastDrm))
        }
        return out
    }

    /// Codex round-3, #2 — the item change carries the generation of the registration it was
    /// delivered FOR. Reading `facade.currentItemGeneration` here instead was the defect: A's
    /// callback installs A's observers, releases the facade lock and stalls; B's installs B's and
    /// delivers `onItem(B)`; A then delivers `onItem(A)`, which reset every per-item cache to A's
    /// values AND labelled them with B's generation — after which B's own access logs passed the
    /// generation check against state describing A. A change that is not NEWER than the one
    /// already applied is refused OUTRIGHT, inside the same critical section, so the per-item
    /// state and the generation labelling it can never disagree.
    ///
    /// Codex round-6, W6-I2 — STRICTLY newer, because an equal generation is one this integration
    /// has already initialised, and re-initialising it is destructive. Every generation the
    /// facade delivers here was minted by its own `observeItem` and delivered exactly once, so an
    /// equal one can only be the item change `attach()` read the facade's generation from while
    /// that change was parked on this lock (see `attach`). Accepting it cleared `firstFrameSeen`
    /// and stamped a new `itemStartedAt` over a seed that had just reported the item as playing.
    ///
    /// It also closes the variant the wave-2 re-review parked: two rapid `replaceCurrentItem`
    /// calls where the facade has already bumped to N+1 before the integration processes the
    /// N-th change. The integration now adopts N, not N+1, so N+1's access logs are dropped
    /// until N+1's own item change is processed, instead of N's being accepted against it.
    ///
    /// Codex round-7, W7-I3 — `item` is ITEM PRESENCE, and `lastSource` is cleared on every
    /// accepted transition. It used to be reset nowhere: `url == nil` was read as "playlist end",
    /// so the early return left the OUTGOING item's source cached. Two things went wrong with
    /// that. A replacement whose asset is not an `AVURLAsset` — an `AVMutableComposition`, say —
    /// also arrives with no URL, and it kept the previous item's identity, which the next
    /// `describe()` (a rotation or a re-enablement) then re-announced as the new item's source.
    /// And a genuine playlist end left a source cached for a player with no item at all, which
    /// the same `describe()` announced. Presence carried apart from the optional URL answers
    /// both: a present item announces `unknown` when it cannot be named, an absent one announces
    /// nothing and leaves nothing behind.
    private func onItem(item: ItemIdentity?, isFairPlay fp: Bool, preferredPeakBitRate peak: Double, generation gen: UInt64) {
        locked { t in
            var out: [Emission] = []
            guard gen > itemGeneration else { return out }
            if let e = closeBufferSpanLocked(at: t) { out.append(e) }
            itemGeneration = gen
            // Round-4, M9 — redeem a `.readyToPlay` that overtook this change. A hold naming a
            // generation this one has already passed is spent either way; one naming a LATER
            // generation is left for the change that adopts it.
            var readyHeld = false
            if let ready = pendingReadyGeneration, ready <= gen {
                pendingReadyGeneration = nil
                readyHeld = ready == gen
            }
            itemStartedAt = t; playIntentAt = nil; firstFrameSeen = false
            lastDrm = nil; drmDescribed = false; accessLogStartupMs = nil; isLive = false
            lastIndicatedBitrate = nil; isFairPlay = fp; preferredPeakBitRate = peak
            // Round-1, O4 — the resolution and the bandwidth estimate belong to the OLD item as
            // much as the indicated bitrate does; leaving them set smeared the previous item's
            // numbers over the first `stats` tick of the new one.
            width = 0; height = 0; observedBitrate = nil
            // Round-4, #5 — and so do the BUFFER and the PLAYHEAD, which the reset used to leave
            // alone. Item A at 60 s with 0–120 s loaded, replaced by an unbuffered B, reported
            // 60 s of buffer ahead on B's very first `stats` tick — and, with no loaded-range
            // notification yet for B, kept reporting it. The playhead is cleared UNSEEDED rather
            // than merely zeroed: the first position observation for B establishes the baseline,
            // so the `timeJumped` AVFoundation posts as B's timeline becomes valid is not
            // differenced against A's position (see `playheadSeeded`). Android takes the same
            // values from the player at snapshot time, which is the same answer by another route.
            loadedRangesMs = []; playheadMs = 0; playheadSeeded = false
            // Round-1, #10 — only the per-item BASELINE resets. `droppedTotal` is the lifetime
            // count and `droppedReported` is what the collector has already been told, so
            // frames observed but not yet sampled still fold into the next stats entry.
            droppedItemBaseline = 0
            // Round-7, W7-I3 — the outgoing item's identity dies with the transition, whatever
            // replaces it. Cleared BEFORE the presence check, so an absent item leaves none.
            lastSource = nil
            guard let item else { return out }       // no current item: latches reset, nothing to announce
            let san = sanitizeSource(item.url?.absoluteString, keepQuery: keepSourceQuery)
            lastSource = ["src": san.src, "protocol": san.protocol, "live": false]
            out.append((VitalsPlayerEventTypes.sourceChange, lastSource))
            // …after the source it belongs to, and with THIS item's key system (round-4, M9).
            if readyHeld, lastDrm == nil {
                lastDrm = ["keySystem": fp ? "fairplay" : "none"]; drmDescribed = true
                out.append((VitalsPlayerEventTypes.drm, lastDrm))
            }
            return out
        }
    }

    private func onTimeControl(_ tc: TimeControl) {
        locked { t in
            var out: [Emission] = []
            switch tc {
            case .playing:
                if let e = closeBufferSpanLocked(at: t) { out.append(e) }
                if !firstFrameSeen {
                    firstFrameSeen = true
                    // Codex round-3, #6 — an OBSERVED ITEM ORIGIN is the precondition, and it is
                    // `itemStartedAt`, exactly as in Media3Integration.onFirstFrame(). Taking
                    // `playIntentAt ?? itemStartedAt` let a JOINED item fabricate a ttff after
                    // all: attach to an item still `.unknown`, and the next nonzero rate or
                    // waiting-to-play sets `playIntentAt` while `itemStartedAt` is still nil, so
                    // the first `.playing` measured startup from an intent that has nothing to do
                    // with when the item began. Ruling R11 and Android both say a joined item
                    // reports NO startup: a fabricated near-zero does not lose one data point, it
                    // drags the dashboard's p50 down for every session that attached mid-launch.
                    // Only once an origin exists does the play intent become the better one of
                    // the two (it is what the customer actually waited from).
                    if itemStartedAt != nil, let intent = playIntentAt ?? itemStartedAt {
                        var d: [String: Any?] = ["ttffMs": t - intent]
                        if let a = accessLogStartupMs { d["accessLogStartupMs"] = a }
                        out.append((VitalsPlayerEventTypes.startup, d))
                    }
                    if lastDrm == nil { lastDrm = ["keySystem": isFairPlay ? "fairplay" : "none"]; drmDescribed = true; out.append((VitalsPlayerEventTypes.drm, lastDrm)) }
                }
                playing = true
                if !playEmitted { playEmitted = true; out.append((VitalsPlayerEventTypes.play, nil)) }
            case let .waitingToPlay(toMinimizeStalls):
                if playIntentAt == nil { playIntentAt = t }
                playing = false
                if playEmitted { playEmitted = false; out.append((VitalsPlayerEventTypes.pause, nil)) }
                if toMinimizeStalls && firstFrameSeen && bufferStartAt == nil { bufferStartAt = t; out.append((VitalsPlayerEventTypes.bufferStart, nil)) }
            case .paused:
                if let e = closeBufferSpanLocked(at: t) { out.append(e) }
                playing = false
                if playEmitted { playEmitted = false; out.append((VitalsPlayerEventTypes.pause, nil)) }
            }
            return out
        }
    }

    private func onRate(_ r: Float) {
        locked { t in
            guard r != 0 else { return [] }
            if playIntentAt == nil { playIntentAt = t }
            defer { lastNonZeroRate = r }
            if let last = lastNonZeroRate, last != r { return [(VitalsPlayerEventTypes.rateChange, ["rate": (Double(r) * 1000).rounded() / 1000])] }
            return []
        }
    }

    private func onItemStatus(_ s: ItemStatus, generation gen: UInt64?) {
        switch s {
        case .readyToPlay:
            locked { _ in
                // Per-item: `onItem` clears `lastDrm`, so a `.readyToPlay` for the PREVIOUS item
                // published this item's DRM before its own status ever arrived — and latched
                // `drmDescribed`, so nothing corrected it (round-3, #2). `.readyToPlay` only ever
                // comes from an ITEM registration, so a nil generation cannot reach here; the
                // player-level `status` observer reports `.failed` and nothing else.
                guard let gen else { return [] }
                // Round-4, M9 — AHEAD of what this integration has adopted means the item change
                // it belongs to is still in flight, not that it is stale. Hold it; `onItem`
                // redeems it once the new item's own `isFairPlay` is known.
                if gen > itemGeneration { pendingReadyGeneration = gen; return [] }
                guard gen == itemGeneration else { return [] }
                guard lastDrm == nil else { return [] }
                lastDrm = ["keySystem": isFairPlay ? "fairplay" : "none"]; drmDescribed = true
                return [(VitalsPlayerEventTypes.drm, lastDrm)]
            }
        // Player- OR item-level, and NOT gated on the generation: an error is emitted rather
        // than cached, so a late one is attributed slightly late — while dropping it would lose
        // a real playback fault whose only sin is arriving just after a source change.
        case let .failed(domain, code, message):
            onFatal(domain: domain, code: code, message: message, detail: domain)
        case .unknown: break
        }
    }

    private func onFatal(domain: String, code: Int, message: String, detail: String) {
        locked { _ in [(VitalsPlayerEventTypes.error, ["message": message, "code": "\(domain):\(code)", "fatal": true, "detail": detail])] }
    }

    private func onPresentationSize(_ w: Int, _ h: Int, _ gen: UInt64) {
        locked { _ in
            // `width`/`height` are reset by `onItem`, so a size read for the previous item would
            // be adopted as this one's — and re-emitted as its quality_change (round-2, #6).
            guard gen == itemGeneration else { return [] }
            guard w > 0, h > 0, w != width || h != height else { return [] }
            width = w; height = h
            return [(VitalsPlayerEventTypes.qualityChange, ["width": w, "height": h])]
        }
    }

    private func onAccessLog(_ s: AccessLogSnapshot) {
        locked { _ in
            var out: [Emission] = []
            // Codex round-2, #6 (and M2) — EVERY value below is per-item, and `onItem` has reset
            // the baseline and the bitrate cache for the new one. A snapshot read for the old
            // item and delivered after that reset added its whole total against a zero baseline
            // (the old `max()` under-counted instead, so this is new) and restored the old item's
            // bitrate and bandwidth estimate. The check sits inside the same critical section as
            // the mutations it guards.
            guard s.itemGeneration == itemGeneration else { return out }
            observedBitrate = s.observedBitrate > 0 ? Int64(s.observedBitrate) : nil
            // Round-3, #8 — the cap AS OF THIS READ. Cached only at attachment and item changes,
            // it went stale the moment the host app throttled the item it is already playing, and
            // every later change was still reported `reason: "abr"` (and, having removed a cap
            // configured up front, `"manual"` forever).
            preferredPeakBitRate = s.preferredPeakBitRate
            // Round-1, #10: the access log's total is per ITEM, so each positive difference from
            // the item's own baseline is added to the lifetime count. `max(droppedTotal, total)`
            // treated it as process-cumulative, and every item whose total stayed below the
            // running maximum — the normal case after one bad item — vanished from `stats`.
            // Round-3, #3 — and the baseline is MONOTONIC WITHIN THE ITEM. Two access-log
            // notifications for the SAME item can still overtake each other (the generation check
            // only tells items apart), and a delayed lower total used to move the baseline BACK:
            // 20, then a late 10, then 25 charged 20 + 0 + 15 = 35 for 25 actually-dropped
            // frames. Only a total that exceeds the baseline advances it, so a reordered
            // delivery contributes nothing instead of contributing twice. It is reset on an
            // ACCEPTED item transition and nowhere else.
            foldDroppedFramesLocked(s)
            if let st = s.startupTimeMs, accessLogStartupMs == nil { accessLogStartupMs = st }
            // Round-3, #7 — CORRECT THE TIMELINE, not just the cache. The first `source_change`
            // announces `live: false` (AVPlayerItem has no synchronous live signal; the access
            // log's `playbackType` is the only thing that ever says otherwise), and a recorded
            // entry is a value copy, so updating `lastSource` alone corrected nothing that had
            // already shipped. Ordinary playback runs no `describe()` until a rotation or a
            // re-enablement and `detach()` does not describe either, so a live stream's entire
            // first session could ship `live: false`. Queued only when the learned flag CHANGES,
            // which for a real stream's stable `playbackType` is at most once per item — a flag
            // pinning it to literally one would suppress a genuine later correction instead.
            //
            // Deliberate divergence from Media3Integration.refreshLive(), which updates the cache
            // only: on Android the flag is read synchronously from the player, so the FIRST
            // source_change already carries it and there is nothing to correct.
            if let pt = s.playbackType {
                let live = pt.uppercased() == "LIVE"
                if live != isLive {
                    isLive = live
                    if lastSource != nil {
                        lastSource?["live"] = live
                        out.append((VitalsPlayerEventTypes.sourceChange, lastSource))
                    }
                }
            }
            if s.indicatedBitrate > 0 {
                let br = Int(s.indicatedBitrate)
                if br != lastIndicatedBitrate {
                    lastIndicatedBitrate = br
                    var d: [String: Any?] = ["bitrate": br, "reason": preferredPeakBitRate > 0 ? "manual" : "abr"]
                    if width > 0 { d["width"] = width }
                    if height > 0 { d["height"] = height }
                    out.append((VitalsPlayerEventTypes.bitrateChange, d))
                }
            }
            return out
        }
    }

    /// Under lock. The ONE place a cumulative access-log total becomes lifetime dropped frames,
    /// shared by the new-entry notification and by the stats path's refresh (round-7, W7-I2) so
    /// there is one accumulation rule rather than two. Everything it relies on is documented at
    /// its call site in `onAccessLog`: per-ITEM totals differenced against a per-item baseline
    /// (round-1, #10), a baseline that only ever ADVANCES within the item so a reordered
    /// delivery contributes nothing instead of twice (round-3, #3), and the generation gate that
    /// drops a total read for an item this integration has already moved past (round-2, #6).
    ///
    /// It touches `droppedTotal`, never `droppedReported`: what has been REPORTED is committed
    /// only by an admitted `stats` emission, and folding more frames in cannot change that.
    private func foldDroppedFramesLocked(_ s: AccessLogSnapshot) {
        guard s.itemGeneration == itemGeneration else { return }
        let itemTotal = max(0, s.droppedFramesTotal)
        if itemTotal > droppedItemBaseline {
            droppedTotal += itemTotal - droppedItemBaseline
            droppedItemBaseline = itemTotal
        }
    }

    /// Codex round-3, #4 — the allowance is decided IMMEDIATELY BEFORE the emission, in the
    /// single drainer, and charged only against an accepted one.
    ///
    /// Checking it at queue time was not a limit at all under contention: while one thread owns a
    /// stalled drain, nothing is charged, so twenty error callbacks each read `count == 0`, each
    /// queued, and all twenty were admitted when the drain resumed. The gate closes that because
    /// the drainer is a single owner processing the queue in order — check, emit and charge for
    /// one entry cannot interleave with another entry's.
    ///
    /// The queue-time check is kept as a cheap early drop for the uncontended case (which is
    /// every case where the drain is keeping up), so a storm that is already over budget does not
    /// grow the outbox at all. It is an over-approximation, never the decision.
    private func onErrorLog(_ s: ErrorLogSnapshot) {
        lock.lock()
        let t = now()
        nonFatalTimes.removeAll { t - $0 >= Self.nonFatalWindowMs }
        guard nonFatalTimes.count < Self.nonFatalPerWindow else { lock.unlock(); return }
        let data: [String: Any?] = ["message": s.errorComment ?? "playback error", "code": String(s.errorStatusCode), "fatal": false,
                                    "detail": "\(s.errorDomain) \(s.uriHost ?? "")".trimmingCharacters(in: .whitespaces)]
        if let c = ctx {
            outbox.append(.emission(Queued(ctx: c, e: (VitalsPlayerEventTypes.error, data), t: t,
                                           onResult: { [weak self] accepted in
                                               guard accepted, let self else { return }
                                               self.lock.lock(); self.nonFatalTimes.append(t); self.lock.unlock()
                                           },
                                           gate: { [weak self] in
                                               guard let self else { return false }
                                               self.lock.lock(); defer { self.lock.unlock() }
                                               self.nonFatalTimes.removeAll { t - $0 >= Self.nonFatalWindowMs }
                                               return self.nonFatalTimes.count < Self.nonFatalPerWindow
                                           })))
        }
        lock.unlock()
        drainOutbox()
    }

    private func onTimeJumped(_ toMs: Int64, generation gen: UInt64) {
        locked { _ in
            // Per-item: the new item's playhead starts near zero, so a time jump read for the
            // PREVIOUS item both corrupted `playheadMs` and fabricated a `seek` across the item
            // boundary that never happened (round-3, #2).
            guard gen == itemGeneration else { return [] }
            let from = playheadMs
            let seeded = playheadSeeded
            playheadMs = toMs; playheadSeeded = true
            // Round-4, #5 — the FIRST position this item reports is its baseline, not a seek
            // from the previous item's playhead. AVFoundation posts `timeJumped` as a fresh
            // item's timeline becomes valid, so deriving a seek from an unseeded playhead
            // fabricated one across every item boundary (and, on a live stream starting far
            // from zero, one the size of the whole DVR window).
            guard seeded, abs(toMs - from) > Self.seekThresholdMs else { return [] }
            return [(VitalsPlayerEventTypes.seek, ["fromMs": from, "toMs": toMs])]
        }
    }

    /// Under lock. Emits buffer_end for an open rebuffer span, if any. `t` is the critical
    /// section's own instant, so `durationMs` and the summary's span arithmetic — which now sees
    /// the same `t` on the entry — agree exactly however late the drain runs (round-3, #5).
    private func closeBufferSpanLocked(at t: Int64) -> Emission? {
        guard let started = bufferStartAt else { return nil }
        bufferStartAt = nil
        return (VitalsPlayerEventTypes.bufferEnd, ["durationMs": t - started])
    }

    func snapshot(_ onResult: @escaping (PlayerSnapshot?) -> Bool) {
        // Codex round-7, W7-I2 — PULL the item's counters before reading the cache. The cache is
        // refreshed only by `AVPlayerItemNewAccessLogEntry`, which fires when a new ENTRY is
        // appended; dropped frames accumulate INTO the entry already at the end, so steady
        // playback inside one entry reported zero dropped frames at every 20-second sample.
        //
        // Read with NO lock of ours held, on purpose. `snapshot()` is the stats path, and taking
        // the facade's lock under this one would put a lock edge on the hottest path in the file
        // — the direction three waves have been removing. The read carries its own generation, so
        // an item change slipping in between it and the lock below is caught by the gate inside
        // `foldDroppedFramesLocked` and the stale total is dropped, exactly as a stale
        // notification has been since round 2.
        //
        // ONLY the counters are applied. Every other field in the snapshot produces an EMISSION
        // (`bitrate_change`, the `live` correction to `source_change`, the startup measurement),
        // and emitting from inside `snapshot()` would drain the outbox on the collector's own
        // callback thread, re-entering it. The accumulating counter is the one the notification
        // cannot deliver; the rest arrive with the entry that changes them.
        let live = facade.readAccessLog()
        lock.lock()
        guard attached else { lock.unlock(); _ = onResult(nil); return }
        guard facade.isAlive else { lock.unlock(); _ = onResult(nil); fireReleased(); return }
        guard lastSource != nil || playing else { lock.unlock(); _ = onResult(nil); return }
        if let live { foldDroppedFramesLocked(live) }
        // `at` is read AFTER the refresh and `droppedReported` is untouched until the collector
        // admits the entry, so the contract the refusal test pins is unchanged: a refused
        // emission leaves the whole delta — refreshed frames included — owed to the next tick.
        let at = droppedTotal
        let ahead = loadedRangesMs.first { $0.start <= playheadMs && playheadMs <= $0.end }.map { max(0, $0.end - playheadMs) } ?? 0
        let snap = PlayerSnapshot(bufferAheadMs: ahead, bandwidthEstimate: observedBitrate, bitrate: lastIndicatedBitrate,
                                  width: width > 0 ? width : nil, height: height > 0 ? height : nil, droppedFramesDelta: at - droppedReported)
        lock.unlock()
        if onResult(snap) { lock.lock(); droppedReported = at; lock.unlock() }
    }

    func startupTimings() -> StartupTimings? {
        lock.lock(); defer { lock.unlock() }
        // AVFoundation exposes none of the three timings; a detached integration
        // has no attachment to report for at all.
        return attached && firstFrameSeen ? StartupTimings() : nil
    }

    func describe(_ ctx: PlayerIntegrationContext) {
        lock.lock()
        // Codex round-5, W5-I5 — the instant the state below is READ, on the same clock every
        // other emission uses, captured inside the critical section that reads it.
        //
        // Round 3 left this at `t: nil` (stamped on arrival), which round 4 turned into a
        // defect: the transitions AROUND a describe now carry occurrence time, so a describe
        // queued behind a stalled drain opened its span at DELIVERY time while the pause that
        // closes it carried the earlier moment it happened. A rotation at 10 s, a pause at 15 s
        // and a drain that resumes at 20 s gave the accumulator `play(20)` closed by
        // `pause(15)`: a negative span, clamped to zero, losing the five seconds actually played
        // in the new session. Buffering behaved identically.
        //
        // Stamping the read instant does not reopen the staleness question round 3 was guarding:
        // this describe re-states the state as of `t`, and `Ctx.emit`'s announcement-bound
        // context still refuses it outright if the registration has been re-announced since.
        // Nor does it collide with round 4's origin refusal — a describe is only ever run AFTER
        // the session it reseeds into has started, so `t` is at or after that session's start
        // and the refusal (`origin < sessionStartedAt`) cannot fire on it.
        let t = now()
        var out: [Emission] = []
        if let s = lastSource { out.append((VitalsPlayerEventTypes.sourceChange, s)) }
        if let d = lastDrm { out.append((VitalsPlayerEventTypes.drm, d)) }
        if playing { out.append((VitalsPlayerEventTypes.play, nil)) }
        if bufferStartAt != nil { out.append((VitalsPlayerEventTypes.bufferStart, nil)) }
        // Round-1, #4: queued under the SAME acquisition that read the state, so a transition
        // landing while this describe is in flight cannot overtake the span it re-opens.
        outbox.append(contentsOf: out.map { .emission(Queued(ctx: ctx, e: $0, t: t)) })
        lock.unlock()
        drainOutbox()
    }

    func detach() { detach(barrier: nil) }

    /// The ASYNCHRONOUS form, and on this integration it really is asynchronous: `onComplete`
    /// runs from the outbox, strictly after this teardown's closing `buffer_end`/`pause` have
    /// been DELIVERED (codex round-2, #3). When this thread owns the drain that is still inside
    /// `detach(barrier:)`, exactly as before; when another thread owns it, that thread runs the
    /// barrier when it reaches it. Either way `player_detach` can no longer overtake the spans
    /// it closes. See `OutboxItem` for why nothing waits.
    func detach(onComplete: @escaping () -> Void) { detach(barrier: onComplete) }

    private func detach(barrier: (() -> Void)?) {
        lock.lock()
        // The teardown's own instant (round-3, #5): the closing spans below are queued behind
        // whatever another thread is still draining and may be delivered much later, so they
        // carry the time the player actually stopped rather than the time the drain got to them.
        let t = now()
        var out: [Emission] = []
        let wasAttached = attached
        attached = false
        let hadReleaseObserver = releaseObserved
        releaseObserved = false
        if let e = closeBufferSpanLocked(at: t) { out.append(e) }
        if playing { out.append((VitalsPlayerEventTypes.pause, nil)) }
        playing = false; playEmitted = false
        let c = ctx; ctx = nil
        // Codex round-1, #5 — take AND CLEAR the release hook here, in the same critical
        // section that clears `ctx`. `detach()` disarms the sentinel (`unobserveRelease()`), so
        // `fireReleased()` — the only other place that cleared this — can never run afterwards,
        // and the hook kept the whole graph alive: hook → holder → handle → registration →
        // integration → facade, plus a strong controller. The documented recommended path
        // (`handle.detach()`), `kill()` and a superseding `start()` all leaked one such graph
        // per tracked player. Released outside the lock, with the closure never invoked: the
        // player is alive, only our interest in it has ended.
        let hook = onReleased; onReleased = nil
        if let c { outbox.append(contentsOf: out.map { .emission(Queued(ctx: c, e: $0, t: t)) }) }
        lock.unlock()
        withExtendedLifetime(hook) {}   // ARC may drop a local after its last USE: pin it past the unlock
        // Observer teardown BEFORE the drain (round-2, #3): `ctx` is already nil, so `locked()`
        // queues nothing more, and unsubscribing here means the barrier appended below is
        // provably the LAST item this attachment can ever put in the outbox. Nothing is lost by
        // the reorder — the closing emissions are already queued, and a callback racing this
        // unobserve had nowhere to emit to either way.
        if wasAttached { facade.unobserve() }
        // Take-and-clear, the twin of Media3's `releaseObserver.getAndSet(null)`:
        // a second teardown for one subscription is a no-op, and a re-attach
        // cannot resurrect a stale one. Outside `wasAttached`, because the
        // declaration-time sentinel is installed BEFORE any drain — a
        // registration revoked, cancelled or refused before it ever attached
        // still owns a subscription on the customer's player (round-8 #1).
        if hadReleaseObserver { facade.unobserveRelease() }
        if let barrier { lock.lock(); outbox.append(.barrier(barrier)); lock.unlock() }
        drainOutbox()
    }

    /// See `AttachRollback`. `detach()` is still the whole teardown — the attachment has to come
    /// off, or a retry would hit `attach()`'s double-attach guard and keep the dead context — but
    /// the two DECLARATION-time resources it also drops are put back afterwards.
    ///
    /// `released` is re-read after the teardown rather than before it: a sentinel that fired
    /// while `detach()` was running has already taken the hook and latched the one-shot, and
    /// re-arming there would report a release for a player that is gone (or, on the other side,
    /// resurrect a hook the release just consumed). And the restore closes its own window —
    /// `observeRelease()` on a player that deallocated while the sentinel was off cannot
    /// subscribe, so it reports the release inline, which is exactly the right answer.
    func rollbackAttach() {
        lock.lock()
        let hook = onReleased
        let hadSentinel = releaseObserved
        lock.unlock()
        detach()
        lock.lock()
        let restore = !released
        if restore { onReleased = hook }
        lock.unlock()
        if restore && hadSentinel { observeRelease() }
    }

    // MARK: release

    /// Declaration-time release sentinel (Android round-7 #3 / round-8 #1): installed by
    /// trackPlayer() before any drain, and taken back off by `detach()` on every
    /// teardown path — including a detach on an integration that never attached,
    /// which is exactly the revoked/cancelled/refused registration this hook
    /// exists to unwind. Dropping the sentinel does NOT fire it: the player is
    /// alive, only our interest in it has ended.
    ///
    /// A facade that cannot subscribe (the player is already gone) reports the
    /// release immediately instead — that call is made from here, with no lock held.
    ///
    /// Codex round-1, Critical 2 — the sentinel fires from the `deinit` of whatever strong
    /// reference to the player dropped LAST, and that reference can be a temporary this
    /// integration is itself holding under `lock`: `facade.observe()`, `readState()` and
    /// `isAlive` all load the weak player, and `attach()`/`snapshot()` call them inside their
    /// critical sections. Running `fireReleased()` inline from there takes the same
    /// NONRECURSIVE lock on the same thread — a self-deadlock that hangs the drain and every
    /// later callback and teardown behind it. So the processing is ENQUEUED instead. `self` is
    /// captured strongly by the queued work (the sentinel belongs to the player, not to us, and
    /// the customer's last reference is going away at exactly this moment); `fireReleased()`'s
    /// own `released` latch keeps it one-shot however many times the sentinel is asked.
    func observeRelease() {
        lock.lock()
        guard !releaseObserved else { lock.unlock(); return }
        releaseObserved = true
        lock.unlock()
        if !facade.observeRelease({ [weak self] in
            guard let self else { return }
            self.releaseQueue.async { self.fireReleased() }
        }) { fireReleased() }
    }

    private func fireReleased() {
        lock.lock()
        guard !released else { lock.unlock(); return }
        released = true
        let hook = onReleased; onReleased = nil
        lock.unlock()
        detach()
        hook?()
    }
}
