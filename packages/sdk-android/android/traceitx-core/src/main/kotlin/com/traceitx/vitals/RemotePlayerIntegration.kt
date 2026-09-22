// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Event-fed PlayerIntegration (RN spec 2026-09-06 §2). The player lives
// somewhere this SDK cannot see (a React Native view, a foreign runtime);
// its host translates its events into the phase-4 vocabulary and feeds them
// through `record`/`updateStats`. This class forwards, keeps the model that
// `describe()` (rotation reseed) and `attach()` (seed) need, and serves
// `snapshot()` from the host-fed cache. Nothing library-specific lives here.
//
// EMISSION OUTBOX (codex round-1, C2) — mirrors AVPlayerIntegration.swift,
// including its completion BARRIER since codex round-2 D1.
// Every emission, wherever it comes from (`record`, the `attach` seed,
// `describe`, `detach`), is appended to a FIFO *inside the same critical
// section that mutated the model*, together with the context it is owed to
// and its own timestamp; the queue is drained OUTSIDE the lock by whichever
// thread finds no drainer running. Because the model update and the enqueue
// are one critical section, emission order equals model order.
//
// What that fixes: `describe()` used to copy `playing = true`, unlock, and
// emit. A concurrent `record("pause")` could slip in between, emit its
// `pause`, and leave the stale reseed to emit `play` LAST — the accumulator
// then opened a play span for a paused player and accrued playtime to the end
// of the session, with no later transition to close it. The same window
// existed between `record`'s model update and its own emit.
package com.traceitx.vitals

import com.traceitx.vitals.wire.PlayerEventTypes

class RemotePlayerIntegration(
    override val library: String,
    override val version: String?,
    private val captureSourceQuery: () -> Boolean,
    /**
     * Clock for the emissions this class originates itself — the `attach`/`describe`
     * seeds and the closing spans `detach()` emits. Host-fed events carry the host's
     * own `t` and never use this. Injected so the fixture-parity driver and the unit
     * tests can pin it; production uses the system clock, the same base
     * `PlayerIntegrationContext.now()` reports.
     */
    private val now: () -> Long = { System.currentTimeMillis() },
) : PlayerIntegration, AttachRollback {
    private val lock = Any()
    private var ctx: PlayerIntegrationContext? = null
    private var keepSourceQuery = false
    // Model — RAW data as received; source_change is sanitised on every emission.
    private var source: Map<String, Any?>? = null
    private var drm: Map<String, Any?>? = null
    /**
     * HOST TRUTH — what the host last told us through [record], independent of any
     * announcement. Codex round-4, F1: this is the half that must survive a teardown.
     * A [detach] unbinds the announcement; it does not stop the player. The SAME
     * integration object is bound again on every path that re-attaches it — a deferred
     * registration retried after an attach rollback, a controller that re-announces the
     * player against a new session — and the seed of that next attach is only as good as
     * what we still remember the player to be doing. Before the split, [detach] cleared
     * `playing`/`buffering` (round-1, C1 made it close its spans), so the re-attached
     * registration announced a playing player with NO open span — and for uninterrupted
     * playback no later transition ever comes.
     *
     * Codex round-5: the RN reconfigure path no longer goes through this object at all.
     * The registry's blanket re-registration is gone; a restarted SDK is now followed by
     * the JS hooks detaching the old token and tracking a FRESH one, i.e. a NEW
     * integration. The rule above still holds for every in-session re-attach, which is
     * where it was always load-bearing.
     */
    private var hostPlaying = false
    private var hostBuffering = false
    /**
     * ANNOUNCED span state — what is currently OPEN in the bound [ctx], which is not the same
     * question as what the player is doing. Only these two decide what [detach] has to close:
     * closing a span the bound ctx never heard opened would fabricate a `pause` or a
     * `buffer_end` out of nothing, and leaving one open that it did hear accrues to the end of
     * the session. Seeded from host truth by [attach]/[describe], moved by [record] only while
     * a ctx is bound, cleared by [detach]/[rollbackAttach].
     */
    private var spanPlaying = false
    private var spanBuffering = false
    private var stats: Map<String, Any?>? = null
    private var statsSeq = 0L
    private var servedSeq = 0L
    private var droppedCommitted = 0L
    /**
     * The timestamp of the most recent `attach`/`describe` SEED, 0 until the first one.
     * Written under [lock] inside [seedLocked], with the same `now()` the seed entries carry.
     * See [reseedFloor] for what it is for. Twin of the Swift `lastSeedAt`.
     */
    private var lastSeedAt = 0L

    /** One queued emission and the context it is owed to. Guarded by `lock`. */
    private class Queued(
        val ctx: PlayerIntegrationContext,
        val type: String,
        val data: Map<String, Any?>?,
        val t: Long,
    )

    /**
     * The outbox carries two kinds of work, in ONE order.
     *
     * Codex round-2, D1 — a [OutboxItem.Barrier] is an ORDERED COMPLETION, and it is what
     * makes `detach(onComplete)` honest. [detach] queues its closing `buffer_end`/`pause`
     * and then calls [drainOutbox], which RETURNS IMMEDIATELY when another thread already
     * owns the drain; the inherited `PlayerIntegration.detach(onComplete)` signalled
     * completion there and then, so `VitalsController` marked the registration detached and
     * recorded `player_detach` while the closing `pause` was still sitting in the queue —
     * and the controller's own `reg.detached` check then REFUSED it when the drain finally
     * reached it. The player's play span never closed and kept accruing playtime to the end
     * of the session, which is exactly the harm the outbox was added to prevent.
     *
     * Putting the completion IN the queue, behind those emissions, makes the ordering
     * structural: whoever owns the drain delivers the closing events and only then runs the
     * barrier, exactly once. Nothing waits and no lock is held across it, so a drain owned
     * by another thread can never block — or be blocked by — the thread that is detaching.
     * Twin of `RemotePlayerIntegration.swift`'s `OutboxItem` / `AVPlayerIntegration`'s.
     */
    private sealed interface OutboxItem {
        class Emission(val q: Queued) : OutboxItem
        class Barrier(val run: () -> Unit) : OutboxItem
    }
    private val outbox = ArrayList<OutboxItem>()
    private var draining = false

    /**
     * Drain until empty, one owner at a time and never with `lock` held. A caller that
     * finds another thread already draining returns immediately — its entries are in the
     * queue and the owner will deliver them. Re-entrant emissions (a host that calls
     * `record` from inside `emit`) land at the BACK of the queue and are picked up by the
     * re-check below rather than jumping the line. A [OutboxItem.Barrier] is run in its
     * queue position, on whichever thread owns the drain when it is reached (round-2, D1).
     */
    private fun drainOutbox() {
        while (true) {
            val batch = synchronized(lock) {
                if (draining || outbox.isEmpty()) return
                draining = true
                ArrayList(outbox).also { outbox.clear() }
            }
            for (item in batch) when (item) {
                is OutboxItem.Emission -> item.q.ctx.emit(item.q.type, item.q.data, item.q.t)
                is OutboxItem.Barrier -> item.run()
            }
            val more = synchronized(lock) { draining = false; outbox.isNotEmpty() }
            if (!more) return
        }
    }

    /**
     * Host-fed event. Updates the model AND queues the emission in one critical section;
     * the queue is drained outside the lock.
     * Silently ignored (model untouched, nothing emitted) when `type` is not a wire-valid
     * player event, or is one of the two lifecycle markers the controller reserves for
     * itself — `player_attach`/`player_detach` are stamped by `VitalsController` alone; a
     * forged one from a host would otherwise fabricate an attach/detach boundary no
     * registration ever crossed.
     */
    fun record(type: String, t: Long, data: Map<String, Any?>?) {
        if (type !in HOST_EVENT_TYPES) return
        synchronized(lock) {
            when (type) {
                // Codex round-1, C8/C12 — a source change ends the OLD source's story. Both
                // the host-fed stats cache and the cached DRM describe the outgoing source;
                // a new source's `drm` arrives AFTER its own `source_change` if there is one
                // at all, so keeping the old one made the next `describe()` re-announce a key
                // system the current source may not use, and keeping the old stats let a
                // sampler tick report the previous source's buffer/bitrate/resolution.
                "source_change" -> { source = data; drm = null; stats = null }
                "drm" -> drm = data
                "play" -> hostPlaying = true
                "pause" -> hostPlaying = false
                "buffer_start" -> hostBuffering = true
                "buffer_end" -> hostBuffering = false
            }
            val target = ctx
            if (target != null) {
                // The ANNOUNCED state moves with the EMISSION, never with the model alone: an
                // event recorded while nothing is bound updates host truth and leaves the
                // announced state exactly as the last bound ctx heard it (round-4, F1).
                when (type) {
                    "play" -> spanPlaying = true
                    "pause" -> spanPlaying = false
                    "buffer_start" -> spanBuffering = true
                    "buffer_end" -> spanBuffering = false
                }
                outbox += OutboxItem.Emission(Queued(target, type, if (type == "source_change") sanitised(data, keepSourceQuery) else data, reseedFloor(type, t)))
            }
        }
        drainOutbox()
    }

    /**
     * Codex round-3, E1 — the RESEED FLOOR, for span transitions only.
     *
     * The bridge is asynchronous: a JS `pause` stamped at t=1900 can still be in flight when the
     * native side rotates the session at t=2000 and [describe] seeds `play` into the new one at
     * 2000. The `pause` then arrives carrying 1900, which PREDATES the session it would land in,
     * and the collector drops it (`t < sessionStartedAt`, round-4 #3). The play span the reseed
     * just opened is never closed — and a later [detach] emits nothing to close it either,
     * because the model's `playing` went false the moment the `pause` was recorded. The session
     * accrues playtime to its end for a player that has been paused throughout.
     *
     * So a span transition that predates the seed which re-opened its span is stamped AT the
     * seed: the earliest instant the new session can represent, and never earlier than the open
     * it closes. The span is measured as zero-length rather than lost entirely, which is the
     * truth as this session can express it. Only `play`/`pause`/`buffer_start`/`buffer_end` are
     * clamped — they are the four the accumulator opens and closes spans with. Every other event
     * type keeps the host's own `t` untouched: a `seek` or an `error` that lands late is a point
     * in time, and moving it would misreport WHEN it happened for no gain. The MODEL update is
     * unaffected either way; this only moves the emission's stamp.
     */
    private fun reseedFloor(type: String, t: Long): Long =
        if (type in SPAN_TYPES) maxOf(t, lastSeedAt) else t

    fun updateStats(stats: Map<String, Any?>) {
        synchronized(lock) { this.stats = stats; statsSeq++ }
    }

    override fun attach(ctx: PlayerIntegrationContext): Boolean {
        val keep = try { captureSourceQuery() } catch (t: Throwable) { false }
        synchronized(lock) {
            this.ctx = ctx; keepSourceQuery = keep
            seedLocked(ctx, now())
        }
        drainOutbox()
        return true
    }

    override fun describe(ctx: PlayerIntegrationContext) {
        synchronized(lock) { seedLocked(ctx, now()) }
        drainOutbox()
    }

    /**
     * Under lock. Identity first, then open spans — say too much rather than too little.
     * `t` is the instant the state was READ, captured in this same critical section: a
     * drain that runs late must not stamp a span's open with delivery time while the
     * transition that closes it carries the earlier moment it happened.
     */
    private fun seedLocked(target: PlayerIntegrationContext, t: Long) {
        // Unconditionally, even when nothing is seeded: the floor describes the SESSION boundary
        // this integration was last (re)seeded across, not what it happened to have to say at
        // the time. Plain assignment, not `maxOf` — the floor tracks the LATEST seed, so a wall
        // clock corrected backwards leaves it on the same base as the session start the
        // collector compares against, instead of pinning it to a stale future reading.
        // See [reseedFloor].
        lastSeedAt = t
        val src = source
        if (src != null) outbox += OutboxItem.Emission(Queued(target, "source_change", sanitised(src, keepSourceQuery), t))
        val d = drm
        if (d != null) outbox += OutboxItem.Emission(Queued(target, "drm", d, t))
        if (hostPlaying) outbox += OutboxItem.Emission(Queued(target, "play", null, t))
        if (hostBuffering) outbox += OutboxItem.Emission(Queued(target, "buffer_start", null, t))
        // The seed IS the announcement, so the announced state becomes host truth exactly
        // (round-4, F1) — including the false side: a seed that opened nothing leaves nothing
        // for a later [detach] to close.
        spanPlaying = hostPlaying; spanBuffering = hostBuffering
    }

    override fun snapshot(onResult: (PlayerSnapshot?) -> Boolean) {
        val snap: PlayerSnapshot?
        val cumulative: Long?
        synchronized(lock) {
            val s = stats
            if (s == null || statsSeq == servedSeq) { snap = null; cumulative = null } else {
                servedSeq = statsSeq
                cumulative = nonNegLong(s["droppedFrames"])
                snap = PlayerSnapshot(
                    bufferAheadMs = nonNegLong(s["bufferAheadMs"]),
                    bandwidthEstimate = nonNegLong(s["bandwidthEstimate"]),
                    bitrate = nonNegLong(s["bitrate"])?.let { it.coerceAtMost(Int.MAX_VALUE.toLong()).toInt() },
                    width = nonNegLong(s["width"])?.let { it.coerceAtMost(Int.MAX_VALUE.toLong()).toInt() },
                    height = nonNegLong(s["height"])?.let { it.coerceAtMost(Int.MAX_VALUE.toLong()).toInt() },
                    droppedFramesDelta = ((cumulative ?: 0L) - droppedCommitted).coerceIn(0L, Int.MAX_VALUE.toLong()).toInt(),
                )
            }
        }
        val recorded = onResult(snap)
        if (recorded && cumulative != null) synchronized(lock) { droppedCommitted = maxOf(droppedCommitted, cumulative) }
    }

    override fun startupTimings(): StartupTimings? = null

    /**
     * Codex round-1, C1 — `detach()` CLOSES the accounting spans it opened.
     *
     * `player_detach` is not a closer at the accumulator: only `pause` closes a play span
     * and only `buffer_end` closes a buffer span. A host that navigates away (or a Metro
     * reload, which runs `detachAll()`) while its player is playing or stalled therefore
     * left an open span accruing to the end of the SESSION — the very harm the outbox
     * exists to prevent, arriving by another route.
     *
     * `buffer_end` first, then `pause`: a rebuffer is inside the play span, so closing the
     * inner one first keeps the two spans properly nested. Both go through the outbox,
     * queued before `ctx` is cleared, so they are ordered behind everything already queued
     * and ahead of nothing. Idempotent (the latches are cleared here), and an integration
     * that never attached queues nothing at all — there is no timeline to emit into.
     */
    override fun detach() = detachInternal(barrier = null)

    /**
     * The ASYNCHRONOUS form, and on this integration it really is asynchronous:
     * [onComplete] runs from the outbox, strictly after this teardown's closing
     * `buffer_end`/`pause` have been DELIVERED (codex round-2, D1). When this thread owns
     * the drain that is still inside `detach(barrier)`; when another thread owns it, that
     * thread runs the barrier when it reaches it. Either way `player_detach` — and the
     * `reg.detached` flag the controller sets with it — can no longer overtake the spans
     * this teardown closes. Nothing blocks the caller. See [OutboxItem].
     *
     * The synchronous [detach] keeps its previous behaviour exactly: it queues the closers
     * and no completion.
     */
    override fun detach(onComplete: () -> Unit) = detachInternal(barrier = onComplete)

    // Named apart from `detach` on purpose: `detach((() -> Unit)?)` and
    // `detach(() -> Unit)` erase to the SAME JVM signature and clash.
    private fun detachInternal(barrier: (() -> Unit)?) {
        synchronized(lock) {
            val target = ctx
            if (target != null) {
                val t = now()
                if (spanBuffering) outbox += OutboxItem.Emission(Queued(target, "buffer_end", null, t))
                if (spanPlaying) outbox += OutboxItem.Emission(Queued(target, "pause", null, t))
            }
            // Only the ANNOUNCED state is cleared (round-4, F1). Host truth is what the
            // player is doing, and a detach does not stop it: the next [attach] — a deferred
            // registration retried after a rollback, or a re-announcement against a new
            // session — seeds from it.
            spanPlaying = false; spanBuffering = false
            ctx = null
            // Queued in the SAME critical section as the closers above, so nothing this
            // attachment could still enqueue can land between them and the completion.
            if (barrier != null) outbox += OutboxItem.Barrier(barrier)
        }
        drainOutbox()
    }

    /**
     * Codex round-3, E2 — see [AttachRollback]. An attachment rollback is NOT a teardown.
     *
     * [VitalsController.trackPlayer] attaches before it publishes, and a `start()` that
     * supersedes the controller in between refuses the publication. That refusal is transient:
     * `VitalsRuntime` retries THE SAME integration against the next controller. Running the
     * terminal [detach] there clears `playing`/`buffering` (round-1, C1 made detach close its
     * spans), so the retry announced the player into controller B with NO open spans — a host
     * whose playback never paused went unmeasured until its next transition, which for
     * uninterrupted playback never comes. The host model is exactly what the retry needs.
     *
     * So: drop the attachment (`ctx`) and nothing else. `source`, `drm`, `playing`, `buffering`,
     * `stats` and `lastSeedAt` all survive, and the next [attach] seeds from them. Emits nothing
     * — there is no timeline that would accept it.
     *
     * Entries this attachment already queued are LEFT in the outbox rather than filtered out.
     * They are bound to a registration the controller never published, and `VitalsController`'s
     * `Ctx.emit` refuses those outright (never announced → dropped, not buffered), so they cost
     * a drain and nothing else. Filtering would only ever be best-effort anyway — a concurrent
     * drainer already holds its batch and cannot be reached — so leaving them keeps both paths
     * identical instead of making one of them look reliable.
     */
    override fun rollbackAttach() {
        // Round-4, F1 — the announced state belongs to the attachment being rolled back, so it
        // goes with it; host truth is untouched, exactly as before. (This is now the SAME
        // clearing [detach] does, minus the closing emissions — which is what makes E2's "the
        // retry re-seeds the open spans" behaviour fall out of the split rather than needing a
        // rule of its own.)
        synchronized(lock) { ctx = null; spanPlaying = false; spanBuffering = false }
    }

    /**
     * `mime`, when the host supplies it, wins over the URL-extension guess — an
     * extensionless manifest URL (routine for HLS/DASH) would otherwise sanitise to
     * `protocol: "unknown"` even though the host already knows the real protocol.
     * Mirrors `Media3Integration`'s `protocolForMime(mime) ?: s.protocol`.
     */
    private fun sanitised(data: Map<String, Any?>?, keep: Boolean): Map<String, Any?>? {
        if (data == null) return null
        val s = sanitizeSource(data["src"] as? String, keep)
        val protocol = protocolForMime(data["mime"] as? String) ?: s.protocol
        return data + mapOf("src" to s.src, "protocol" to protocol)
    }

    private companion object {
        /**
         * The wire allowlist minus the two markers `VitalsController` alone may stamp
         * (`player_attach`/`player_detach`) — a host-fed event forging either would
         * otherwise fabricate an attach/detach boundary no registration ever crossed.
         */
        val HOST_EVENT_TYPES: Set<String> = PlayerEventTypes.ALL - setOf(PlayerEventTypes.PLAYER_ATTACH, PlayerEventTypes.PLAYER_DETACH)

        /** The four types the accumulator opens and closes spans with. See [reseedFloor]. */
        val SPAN_TYPES: Set<String> = setOf("play", "pause", "buffer_start", "buffer_end")

        /**
         * Finite, non-negative, fits a Long — else null. Kotlin's `as? Number` already
         * refuses a `Boolean`; the Swift twin has to say so explicitly (`CFBooleanGetTypeID`),
         * because an ObjC bool bridges to `NSNumber`. The upper bound is the SAME literal on
         * both platforms (codex round-1, C13): `Long.MAX_VALUE.toDouble()` rounds UP to
         * 9223372036854775808.0, so `d > that` admitted values the twin rejected and the two
         * SDKs disagreed on the boundary.
         */
        fun nonNegLong(v: Any?): Long? {
            val d = (v as? Number)?.toDouble() ?: return null
            if (d.isNaN() || d.isInfinite() || d < 0 || d >= 9.2e18) return null
            return d.toLong()
        }
    }
}
