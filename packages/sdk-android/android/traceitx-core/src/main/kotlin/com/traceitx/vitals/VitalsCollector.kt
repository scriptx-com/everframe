// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Port of packages/sdk-core/src/vitals/collector.ts. Session lifecycle,
// chunk buffering, idle/age rotation, summary cadence, recent ring. Read that
// file's comments for the reasoning behind every constant here.
//
// ## Locking
// `deps.send` is invoked while the collector holds its own internal lock: it
// must be non-blocking and must not acquire any other lock — hand the payload
// to an async transport (enqueue) and return.
//
// `deps.onRotate` is NOT (Codex round-1, Critical 4). It is invoked by the
// `recordX` entry point AFTER the lock has been released, with the entry that
// triggered the rotation. It used to run under the lock, which made
// `onRotate -> reseed -> PlayerIntegration.describe` — customer code that may
// reach for a player's own lock — a genuine deadlock against any thread
// holding that player lock while emitting into this collector. It must still
// not block for long: the rotation callback runs on whichever thread recorded
// the triggering entry (an app looper, the sampler thread, a player's
// analytics thread).
//
// Codex round-4, #1: releasing THIS collector's lock is not enough, because
// the CALLER may hold a lock of its own — `VitalsController` records
// `player_attach`/`player_detach`/a handle's custom entry while holding that
// registration's `announceLock`. `onRotate` fired from inside `recordX` then
// ran `reseed -> describe()` — customer code — under a lock the customer's own
// teardown thread may be waiting for. Every such caller uses the DEFERRED form
// (`recordPlayerEventDeferred`/`recordCustomDeferred`) and fires the returned
// [VitalsCollector.Recorded] once it holds no locks at all. The eager
// `recordPlayerEvent`/`recordCustom` are the same thing with an immediate
// fire, kept for callers that hold nothing.
//
// Codex round-5, #6: both deferred forms take an optional `expectedSessionId`.
// The comparison against it and the admission are ONE critical section on this
// collector's lock, and `Recorded.sessionId` reports which session the entry
// actually landed in. A caller that pinned a session and then recorded in a
// second step had a window in which another entry could rotate this collector
// underneath it; see `admit`.
//
// Codex round-6, #3 REVERSED round 5's reading of what a pinned entry may do to
// a rotation. Round 5 let the entry that TRIGGERS a rotation land in the new
// session and reported that session back. For an unpinned entry that is still
// the rule. For a PINNED one it contradicted the pin: `expectedSessionId` says
// "this session or nowhere", and a `player_detach` — or a teardown's closing
// `buffer_end` — for a player idle past `maxIdleMs` therefore rotated the
// collector and landed in a brand-new session that had never announced that
// player. `admit` now decides, under the same lock, whether the entry WOULD
// rotate and refuses it outright if it would.
package com.traceitx.vitals

import com.traceitx.envelope.txGuard
import com.traceitx.envelope.txGuardVoid
import com.traceitx.vitals.wire.SessionSummaryDims
import com.traceitx.vitals.wire.VitalsChunk
import com.traceitx.vitals.wire.VitalsCustomEntry
import com.traceitx.vitals.wire.VitalsEntry
import com.traceitx.vitals.wire.VitalsIngestPayload
import com.traceitx.vitals.wire.VitalsLimits
import com.traceitx.vitals.wire.VitalsPlayerEvent
import com.traceitx.vitals.wire.VitalsSample
import com.traceitx.vitals.wire.VitalsWireCodec
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

class VitalsCollector(private val deps: Deps) {
    class Deps(
        val dims: SessionSummaryDims,
        val now: () -> Long,
        /**
         * Invoked under the collector's lock. Must be non-blocking and must
         * not acquire any other lock — hand the payload to an async
         * transport (enqueue) and return.
         */
        val send: (VitalsIngestPayload) -> Unit,
        val newSessionId: () -> String,
        val scheduler: VitalsScheduler,
        val flushIntervalMs: Long = 30_000,
        val maxEntriesPerChunk: Int = 50,
        val maxBufferBytes: Int = 65_536,
        val summaryEveryChunks: Int = 5,
        val maxIdleMs: Long = 1_800_000,
        val maxSessionMs: Long = 86_400_000,
        /**
         * Invoked AFTER the collector's lock is released (Codex round-1,
         * Critical 4), once the triggering entry has been recorded into the
         * NEW session, with that entry as its argument. Free to call back
         * into this collector (`recent()`, `recordX`) and free to take other
         * locks — but it runs inline on whichever thread recorded the entry,
         * so it must still not block for long.
         *
         * The trigger is passed so the reseed can tell which player is
         * ALREADY being announced into the new session and must not be
         * announced a second time — see `VitalsController.reseed`. It is NULL
         * for a rotation no entry caused: the seq-cap check a background
         * flush makes (Codex round-2, Important 7), where every live player
         * is reseeded. (It used to carry a second duty — naming the opening
         * transition the reseed must not re-emit — which Codex round-7, #1
         * retired: a duplicate open is a no-op at the accumulator.)
         *
         * Codex round-6, #3 narrowed what a trigger can be: only an UNPINNED
         * record rotates now, so of the player events only `player_attach`
         * can appear here. A player's own `play`/`buffer_start` arriving
         * after a long idle gap is pinned, and is refused rather than
         * rotating (see `admit`).
         */
        val onRotate: ((trigger: VitalsEntry?) -> Unit)? = null,
        /**
         * Codex round-1, Important 6. The protocol caps both `seq` fields at
         * `VitalsLimits.MAX_SEQ` (inclusive), and a 24-hour session at a few
         * hundred entries per second reaches it — after which every chunk is
         * rejected by ingest validation for the rest of the session. The
         * session is rotated one short of the cap instead, which keeps
         * `finalizeSession`'s own trailing chunk + summary (each of which
         * consumes at most one more of each counter) inside it. Injectable
         * only so a test does not have to send a million chunks.
         */
        val maxSeq: Int = VitalsLimits.MAX_SEQ,
    )

    private val lock = ReentrantLock()
    @Volatile private var _sessionId = deps.newSessionId()
    private var seq = 0
    private var summarySeq = 0
    private var stopped = false
    private var chunksSinceSummary = 0

    /**
     * Entries of ANY kind recorded since the last summary went out —
     * including samples, which are not transported but do move
     * memPeak/memAvg. Gates [bumpSummaryCadence] so an idle collector stays
     * silent. See that function for why this exists.
     */
    private var entriesSinceSummary = 0
    private var lastEntryAt: Long? = null
    private var sessionStartedAt = deps.now()
    private var pending = ArrayList<VitalsEntry>()
    /**
     * Running lower bound on [pending]'s framed size — the sum of each
     * entry's own encoded length plus its separator comma. Short by exactly
     * the chunk envelope (~70 bytes), which [EXACT_COST_MARGIN_BYTES] covers
     * many times over. Reset with [pending], recomputed after an eviction.
     */
    private var pendingApproxBytes = 0
    private val ring = ArrayDeque<VitalsEntry>()
    private var accumulator = SummaryAccumulator(_sessionId, sessionStartedAt, deps.dims)
    private val timer: AutoCloseable

    /** Only ever written under [lock]; read here without it — a crash-handler
     * caller must never block on the collector's lock just to read the id. */
    val sessionId: String get() = _sessionId

    /**
     * Test seam for I5: how many times the EXACT framed encode has run. The
     * regression it guards is a performance one — a correctness assertion
     * cannot see the difference between the running estimate and the old
     * encode-every-time loop, only this counter can.
     */
    @androidx.annotation.VisibleForTesting
    internal var exactCostCalls = 0
        private set

    init {
        timer = deps.scheduler.repeat(deps.flushIntervalMs) {
            txGuardVoid("VitalsCollector.tick") {
                // Round-2, Important 7: the cap check runs BEFORE the send, not
                // only on `addEntry` — a quiet session whose only traffic is
                // periodic flushes reaches the seq cap without ever adding an
                // entry, after which every chunk is rejected by ingest.
                val rotated = lock.withLock {
                    if (stopped) return@withLock false
                    val r = rotateIfSeqExhausted()
                    if (pending.isNotEmpty()) sendChunk() else bumpSummaryCadence()
                    r
                }
                if (rotated) fireRotate(null)
            }
        }
        txGuardVoid("VitalsCollector.init") { lock.withLock { sendSummary(final = false) } }
    }

    // ---- locked helpers ----

    private fun sendSummary(final: Boolean, at: Long = deps.now()) {
        val s = accumulator.snapshot(final = final, now = at, seq = summarySeq)
        // Send before advancing seq: a throwing send must not burn a seq
        // value nothing on the wire ever used.
        deps.send(s)
        summarySeq++
        // Reset AFTER the send, matching this file's send-then-advance
        // discipline: a throwing transport must leave the collector believing it
        // still owes a summary, or the throw silently discards the fact that
        // anything was accumulated and the next periodic summary never fires.
        entriesSinceSummary = 0
    }

    private fun sendChunk() {
        if (pending.isEmpty()) return
        val chunk = VitalsChunk(sessionId = _sessionId, seq = seq, entries = pending)
        // Send before clearing/advancing: a throwing send leaves `pending`
        // (and `seq`) untouched, so the same entries retry under the same
        // seq on the next tick instead of being silently dropped. `chunk`
        // itself becomes unreachable on a throw, so retaining `pending`
        // here can't alias a chunk object anything else still holds — the
        // rebind below (`pending = ArrayList()`) only ever runs after
        // `deps.send` has actually returned.
        deps.send(chunk)
        pending = ArrayList()
        pendingApproxBytes = 0
        seq++
        bumpSummaryCadence()
    }

    /**
     * Advances the periodic non-final summary cadence by one interval.
     *
     * Called from [sendChunk] AND from the flush tick when there was nothing
     * to send. Both matter: the cadence used to live inside [sendChunk] alone,
     * and [sendChunk] returns early on an empty buffer — so once samples
     * stopped being transported, a session with no playback activity produced
     * no chunks and therefore no periodic summaries at all. That silently
     * broke two things: memPeak/memAvg only reached the server if the session
     * ended cleanly (an app killed by the OS lost them entirely), and the
     * server's `lastSeenAt` stopped advancing while the session was still
     * live, which is what drives stale-session detection and retention.
     *
     * Gated on [entriesSinceSummary] so a collector on a genuinely dead
     * session stays silent rather than heartbeating forever. Samples count as
     * accumulation even though they are not transported — reporting their
     * memPeak/memAvg is the whole reason this path exists.
     */
    private fun bumpSummaryCadence() {
        if (entriesSinceSummary == 0) return
        chunksSinceSummary++
        if (chunksSinceSummary >= deps.summaryEveryChunks) {
            chunksSinceSummary = 0
            sendSummary(final = false)
        }
    }

    private fun finalizeSession(at: Long) {
        sendChunk()
        sendSummary(final = true, at = at)
    }

    private fun startNewSession(startedAt: Long) {
        _sessionId = deps.newSessionId()
        seq = 0
        summarySeq = 0
        chunksSinceSummary = 0
        sessionStartedAt = startedAt
        accumulator = SummaryAccumulator(_sessionId, startedAt, deps.dims)
        ring.clear()
        sendSummary(final = false)
    }

    /**
     * The EXACT framed cost. `Int.MAX_VALUE` on any throw (M2, matching web):
     * a chunk that cannot be encoded cannot be sent either, so it must read
     * as over-budget and be evicted rather than silently pass the cap check
     * and fail later on the wire.
     */
    private fun chunkCost(): Int {
        exactCostCalls++
        return try {
            VitalsWireCodec.utf8Length(VitalsWireCodec.encodeChunk(VitalsChunk(_sessionId, seq, pending)))
        } catch (t: Throwable) {
            Int.MAX_VALUE
        }
    }

    /** A single entry's contribution to [pendingApproxBytes]: its own encoding plus one separator. */
    private fun entryCost(entry: VitalsEntry): Int = try {
        VitalsWireCodec.utf8Length(VitalsWireCodec.encodeEntry(entry)) + 1
    } catch (t: Throwable) {
        // Unencodable: force the exact path, which will read Int.MAX_VALUE
        // and evict. Half of Int.MAX_VALUE so the running sum cannot overflow.
        APPROX_BYTES_CAP
    }

    private fun pruneRing(cutoff: Long) {
        while (ring.isNotEmpty() && ring.first().t < cutoff) ring.removeFirst()
    }

    /**
     * Codex round-2, Important 7. The protocol caps both `seq` fields at
     * [Deps.maxSeq] INCLUSIVE, and [addEntry] is not the only thing that burns
     * them: the periodic tick's `sendChunk`, `flushNow`'s chunk+summary pair
     * and the every-5th-chunk summary all advance a counter with no entry
     * involved. A session with a live player and a slow trickle of flushes
     * could therefore walk `summarySeq` past the cap and have every subsequent
     * payload rejected by ingest validation for the rest of its life.
     *
     * Rotates one short of the cap, exactly like [addEntry]'s own branch, so
     * [finalizeSession]'s trailing chunk + final summary (one more of each
     * counter, at most) still fit inside it. Called with the lock HELD;
     * the caller fires `onRotate` outside it.
     *
     * @return true when it rotated.
     */
    private fun rotateIfSeqExhausted(): Boolean {
        if (seq < deps.maxSeq - 1 && summarySeq < deps.maxSeq - 1) return false
        val at = deps.now()
        finalizeSession(at)
        startNewSession(at)
        return true
    }

    /**
     * Codex round-4, #1/#7. What [addEntry] actually decided, both halves of
     * which the caller needs:
     *
     *  - [rotated] — this entry started a new session, so `onRotate` has to be
     *    fired OUTSIDE the lock (and, since round 4, outside the CALLER's
     *    locks too — see [Recorded]);
     *  - [accepted] — the entry is really in the timeline. False when the
     *    transport refused it for size (it reaches neither the ring nor the
     *    accumulator) and false when the collector was already stopped. An
     *    integration reporting a DELTA must not commit it unless this is true,
     *    or a snapshot the collector rejected silently swallows those frames.
     */
    private class AddResult(val rotated: Boolean, val accepted: Boolean)

    /**
     * Codex round-4, #1 — a record whose rotation notification has NOT been
     * fired yet. [fireRotate] must be invoked by the caller once it holds no
     * lock of its own; it is a no-op when this record caused no rotation.
     */
    class Recorded internal constructor(
        /** Whether the entry actually reached the timeline — see [AddResult.accepted]. */
        val accepted: Boolean,
        /**
         * Codex round-5, #6 — the session the entry LANDED in, read under
         * this collector's lock AFTER [addEntry], so it names the session
         * after any rotation the entry itself triggered. Non-null exactly
         * when [accepted] is true.
         *
         * `VitalsController` pins a player's announcement to it, and every
         * later emission for that player is admitted only into that same
         * session — which is why the check has to be made where the
         * admission is, not before it.
         *
         * Codex round-6, #3 — a record that CARRIES a pin can no longer
         * rotate anything, so this differs from the caller's
         * `expectedSessionId` only on the UNPINNED paths. `player_attach` is
         * the one that matters there: it may rotate, and the announcement is
         * then pinned to the session it actually landed in.
         */
        val sessionId: String?,
        private val rotate: (() -> Unit)?,
    ) {
        fun fireRotate() { rotate?.invoke() }
    }

    /**
     * Codex round-6, #3 — the three rotation predicates [addEntry] applies,
     * as ONE value, so [admit] can ask "would this entry rotate?" against
     * exactly the same rules the admission then uses. Two copies of these
     * conditions would be a silent correctness bug the moment either moved.
     *
     * Computed under [lock], from state only [lock] guards.
     */
    private class RotationTrigger(val idleGap: Boolean, val maxAge: Boolean, val seqExhausted: Boolean) {
        val any: Boolean get() = idleGap || maxAge || seqExhausted
    }

    private fun rotationTrigger(nowT: Long): RotationTrigger {
        val last = lastEntryAt
        return RotationTrigger(
            idleGap = last != null && nowT - last > deps.maxIdleMs,
            maxAge = nowT - sessionStartedAt >= deps.maxSessionMs,
            // I6: rotate one short of the cap, so the finalize in [addEntry]
            // (one more chunk, one more summary) still fits inside it.
            seqExhausted = seq >= deps.maxSeq - 1 || summarySeq >= deps.maxSeq - 1,
        )
    }

    /** @return what the entry did — the caller fires `onRotate` OUTSIDE the lock. */
    private fun addEntry(
        entry: VitalsEntry,
        nowT: Long = deps.now(),
        rot: RotationTrigger = rotationTrigger(nowT),
    ): AddResult {
        val last = lastEntryAt
        // Exactly one of the three branches runs, so a rotation is never
        // counted twice.
        var rotated = false
        if (rot.idleGap) {
            finalizeSession(last!!)
            startNewSession(nowT)
            rotated = true
        } else if (rot.maxAge) {
            finalizeSession(sessionStartedAt + deps.maxSessionMs)
            startNewSession(nowT)
            rotated = true
        } else if (rot.seqExhausted) {
            finalizeSession(nowT)
            startNewSession(nowT)
            rotated = true
        }
        lastEntryAt = nowT

        // CPU/memory samples feed the accumulator (so memPeak/memAvg still land
        // on the summary) and count as activity above (so rotation and
        // lastEntryAt are unchanged) — but they are never transported.
        // Resource consumption is covered by the report resource window
        // (TraceItX/Resources): a 2-second-resolution ring attached to the
        // report or crash that explains it, which is both finer than this
        // 30-second stream and actually aligned to the failure. Measured
        // server-side, 79% of stored chunks came from sessions where no video
        // ever played; the API now discards samples on arrival, so shipping
        // them only spends the device's battery and the customer's bandwidth.
        val transported = entry !is VitalsSample
        var transportRefused = false
        if (transported) {
            val cost = entryCost(entry)
            pending.add(entry)
            pendingApproxBytes = (pendingApproxBytes.toLong() + cost).coerceAtMost(APPROX_BYTES_CAP.toLong()).toInt()
            val budget = deps.maxBufferBytes - REQUEST_WRAPPER_RESERVE_BYTES
            // I5: the exact framed encode is O(chunk) and used to run on EVERY
            // addEntry on the app looper — O(n²) per chunk for a check that fires
            // only at the cap. The running estimate is a lower bound short only by
            // the chunk envelope, so staying EXACT_COST_MARGIN_BYTES clear of the
            // budget proves the real cost is under it without encoding anything.
            if (pendingApproxBytes >= budget - EXACT_COST_MARGIN_BYTES && chunkCost() > budget) {
                // Codex round-2, Important 8 — FLUSH BEFORE ADMIT. The old policy
                // evicted the OLDEST pending entries until the chunk fit, but their
                // ring entries and their summary contributions survived: a handful
                // of near-8 KB player errors before a flush silently deleted
                // earlier errors from the timeline while `errorCount` went on
                // counting them. Nothing that was accepted is ever deleted now.
                // The over-budget entry is pulled back out, whatever already fits
                // is SENT as its own chunk, and the entry is then re-admitted into
                // the empty buffer.
                pending.removeAt(pending.size - 1)
                if (pending.isNotEmpty()) sendChunk()
                pending.add(entry)
                pendingApproxBytes = cost.coerceAtMost(APPROX_BYTES_CAP)
                if (chunkCost() > budget) {
                    // It does not fit even alone: the only entry that is ever
                    // dropped. It must reach neither the ring nor the accumulator,
                    // so the summary cannot count something the timeline never got.
                    pending.removeAt(pending.size - 1)
                    pendingApproxBytes = 0
                    transportRefused = true
                }
            }

            if (!transportRefused) {
                // The ring is stamped verbatim into a bug/crash report, so an entry
                // that is not transported must not enter it either — a sample
                // riding into a report is what the resource window replaces.
                ring.addLast(entry)
                while (ring.size > MAX_RING_ENTRIES) ring.removeFirst()
            }
        }
        pruneRing(nowT - RECENT_WINDOW_MS)
        // Marked HERE, beside the accumulator call that gives it meaning,
        // not up beside `lastEntryAt`. FLUSH BEFORE ADMIT can send a chunk —
        // and therefore a summary — in the middle of this function, before
        // the triggering entry has been applied; marking dirty earlier let
        // that summary clear the flag out from under an entry it had not yet
        // counted, leaving the entry's own contribution with nothing to push
        // it out periodically. A transport-refused entry reaches neither the
        // accumulator nor this counter, which is the same rule.
        if (!transportRefused) {
            accumulator.onEntry(entry)
            entriesSinceSummary++
        }

        if (transported && pending.size >= deps.maxEntriesPerChunk) sendChunk()
        return AddResult(rotated = rotated, accepted = !transportRefused)
    }

    /**
     * Critical 4: the rotation callback, run with NO lock held. `txGuardVoid`
     * still contains a throwing customer callback.
     */
    private fun fireRotate(trigger: VitalsEntry?) {
        deps.onRotate?.let { cb -> txGuardVoid("VitalsCollector.onRotate") { cb(trigger) } }
    }

    // ---- public API ----

    fun recordSample(s: VitalsSample) = txGuardVoid("VitalsCollector.recordSample") {
        // Unchanged (round-4 #1 does not touch it): the sampler thread holds
        // nothing of its own, so the rotation may fire inline.
        val r = lock.withLock { if (stopped) null else addEntry(s) }
        if (r != null && r.rotated) fireRotate(s)
    }

    /**
     * Codex round-4, #1 — records the entry and hands the rotation
     * notification BACK, unfired. Use this from anywhere that holds a lock
     * (`VitalsController` holds a registration's `announceLock` across its
     * `player_attach`/`player_detach`/handle-`track` records) and call
     * [Recorded.fireRotate] once every one of those locks is released.
     */
    fun recordPlayerEventDeferred(e: VitalsPlayerEvent, expectedSessionId: String? = null): Recorded =
        txGuard("VitalsCollector.recordPlayerEvent") {
            val bounded = boundStructuredJson(e.data, VitalsLimits.MAX_PLAYER_EVENT_DATA_BYTES)
            val entry = e.copy(data = bounded.data, truncated = if (bounded.truncated) true else e.truncated)
            admit(entry, expectedSessionId)
        } ?: REFUSED

    /** @return whether the collector actually admitted the entry (Codex round-4, #7). */
    fun recordPlayerEvent(e: VitalsPlayerEvent): Boolean =
        recordPlayerEventDeferred(e).also { it.fireRotate() }.accepted

    /** See [recordPlayerEventDeferred] — the custom-entry twin (Codex round-4, #1/#6). */
    fun recordCustomDeferred(e: VitalsCustomEntry, expectedSessionId: String? = null): Recorded =
        txGuard("VitalsCollector.recordCustom") { admit(e, expectedSessionId) } ?: REFUSED

    fun recordCustom(e: VitalsCustomEntry): Boolean =
        recordCustomDeferred(e).also { it.fireRotate() }.accepted

    /**
     * Codex round-5, #6 — the session CHECK and the admission are ONE
     * critical section on this collector's lock, and the session the entry
     * landed in is read inside it too.
     *
     * `VitalsController` used to compare a pinned session id against
     * [sessionId] and only then call `recordX`. Between the two, another
     * event could rotate this collector, and the entry was then admitted
     * into a session that had never announced its player.
     *
     * ## What a pin means (Codex round-6, #3 — this REPLACES round 5's rule)
     *
     * A non-null [expectedSessionId] means **this session or nowhere**. The
     * entry is admitted only if it lands in that exact session:
     *
     *  - the collector has since moved on → REFUSED (round-5's half);
     *  - the entry would itself ROTATE the session → also REFUSED. Nothing is
     *    admitted, nothing rotates, and the entry reaches neither the ring
     *    nor the accumulator.
     *
     * Round 5 documented the opposite for that second case ("the entry that
     * triggers a rotation passes the check against the old session and lands
     * in the new one — the intended trigger semantics"). That is right for an
     * UNPINNED entry and wrong for a pinned one, and it defeated the pin at
     * precisely the moment the pin exists for: a `player_detach`, or a
     * teardown's closing `buffer_end`, for a player idle past
     * [Deps.maxIdleMs] rotated the collector and landed in a brand-new
     * session that had never announced that player — the exact defect
     * `expectedSessionId` was introduced to prevent.
     *
     * The consequence is deliberate and lossy in the direction this SDK
     * always chooses: a closing marker for a player whose session has aged
     * out is DROPPED. That session was finalized and sent the moment the
     * rotation happened; there is no longer anywhere truthful to put the
     * marker. The player's own reseed re-opens its ongoing spans in the new
     * session.
     *
     * Unpinned trigger semantics are unchanged — a `player_attach`, a sample
     * and a `trackVitals` custom entry all still rotate and land in the new
     * session, and [Recorded.sessionId] reports where they landed.
     */
    private fun admit(entry: VitalsEntry, expectedSessionId: String?): Recorded {
        var landedIn: String? = null
        val r = lock.withLock {
            if (stopped || (expectedSessionId != null && _sessionId != expectedSessionId)) {
                null
            } else {
                // One `deps.now()` for both the would-rotate decision and the
                // admission, so the entry cannot be judged against one clock
                // reading and recorded against another.
                val nowT = deps.now()
                val rot = rotationTrigger(nowT)
                if (expectedSessionId != null && rot.any) null
                else addEntry(entry, nowT, rot).also { landedIn = _sessionId }
            }
        }
        return recorded(r, landedIn) { fireRotate(entry) }
    }

    /** A refused entry ([AddResult] null) accepted nothing, landed nowhere and rotated nothing. */
    private fun recorded(r: AddResult?, landedIn: String?, rotate: () -> Unit): Recorded =
        if (r == null) REFUSED
        else Recorded(r.accepted, if (r.accepted) landedIn else null, if (r.rotated) rotate else null)

    /**
     * The recent ring, pruned to [windowMs]. Bounded: if the lock cannot be
     * taken within [lockTimeoutMs] the ring is treated as empty — this is the
     * crash-handler guarantee from spec §2 ("if the lock is held by a thread
     * that died, the guard times out and the crash ships without vitals").
     */
    fun recent(windowMs: Long = RECENT_WINDOW_MS, lockTimeoutMs: Long = RECENT_LOCK_TIMEOUT_MS): List<VitalsEntry> =
        txGuard("VitalsCollector.recent") {
            if (!lock.tryLock(lockTimeoutMs, TimeUnit.MILLISECONDS)) return@txGuard emptyList()
            try {
                pruneRing(deps.now() - windowMs)
                ring.toList()
            } finally {
                lock.unlock()
            }
        } ?: emptyList()

    /**
     * Codex round-1, Important 4: the session id and the ring, taken under
     * ONE timed lock acquisition. Reading `sessionId` and then calling
     * [recent] separately could straddle a rotation and produce a stamp
     * carrying the OLD session's id alongside the NEW session's entries —
     * an envelope pointing at a session whose timeline never contained it.
     *
     * Same crash-handler guarantee as [recent]: on lock-acquisition timeout
     * the entries are empty (the id is read without the lock, as it always
     * has been), rather than blocking a dying thread.
     */
    fun stamp(windowMs: Long = RECENT_WINDOW_MS, lockTimeoutMs: Long = RECENT_LOCK_TIMEOUT_MS): VitalsStamp =
        txGuard("VitalsCollector.stamp") {
            if (!lock.tryLock(lockTimeoutMs, TimeUnit.MILLISECONDS)) return@txGuard VitalsStamp(_sessionId, emptyList())
            try {
                pruneRing(deps.now() - windowMs)
                VitalsStamp(_sessionId, ring.toList())
            } finally {
                lock.unlock()
            }
        } ?: VitalsStamp(_sessionId, emptyList())

    fun flushNow() = txGuardVoid("VitalsCollector.flushNow") {
        val rotated = lock.withLock {
            if (stopped) return@withLock false
            // Round-2, Important 7 — see rotateIfSeqExhausted().
            val r = rotateIfSeqExhausted()
            sendChunk()
            sendSummary(final = false)
            r
        }
        if (rotated) fireRotate(null)
    }

    fun stop() = txGuardVoid("VitalsCollector.stop") {
        lock.withLock {
            if (stopped) return@withLock
            stopped = true
            runCatching { timer.close() }
            try {
                // Round-2, Important 7: a session already at the cap would
                // otherwise emit a final summary the server rejects. Rotating
                // first costs one extra (accepted) summary and keeps the
                // final one inside the protocol's range.
                rotateIfSeqExhausted()
                finalizeSession(deps.now())
            } catch (t: Throwable) {
                com.traceitx.envelope.InternalLogger.recordSafeWrapFailure("VitalsCollector.stop.finalize", t)
            } finally {
                // Codex round-1, Important 5. A crash stamp that captured this
                // collector just before kill()/stop() could block on the lock
                // for the duration of the final send and then still walk away
                // with pre-kill evidence. The ring is capture evidence, so it
                // is zeroized here — in a `finally`, so a throwing final send
                // cannot leave it populated either.
                ring.clear()
            }
        }
    }

    companion object {
        const val RECENT_WINDOW_MS = 60_000L
        const val MAX_RING_ENTRIES = 800
        /** Headroom for the transport's `{"payload":…}` wrapper (12 bytes), rounded up. */
        const val REQUEST_WRAPPER_RESERVE_BYTES = 32
        /** Crash-handler guard: [recent] gives up after this long rather than risk a dead lock holder. */
        const val RECENT_LOCK_TIMEOUT_MS = 100L
        /**
         * How close the running estimate must come to the budget before the
         * exact framed encode is worth paying for. Two orders of magnitude
         * more than the ~70-byte envelope the estimate omits, and larger than
         * any single entry the caps allow, so the estimate can never cross
         * the budget between two consecutive checks.
         */
        const val EXACT_COST_MARGIN_BYTES = 4096
        /** Nothing recorded, nothing to fire — a stopped collector, or a throw inside `txGuard`. */
        private val REFUSED = Recorded(accepted = false, sessionId = null, rotate = null)
        /** Saturation point for the running sum — keeps it clear of Int overflow. */
        private const val APPROX_BYTES_CAP = Int.MAX_VALUE / 2
    }
}
