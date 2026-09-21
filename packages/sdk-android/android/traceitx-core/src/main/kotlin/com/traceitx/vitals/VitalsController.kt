// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Android twin of packages/sdk-web/src/vitals/index.ts (spec 2026-09-05 §2).
// Owns the start gate, the collector/sampler lifecycle and the registry.
//
// Start gate (evaluated on every server-config change while not running):
//   server.vitalsEnabled && local.enabled != false && drawOnce(min(local.sampleRate ?: 1, server.rate))
// The draw is made once per controller and cached — a later refresh never re-rolls it.
package com.traceitx.vitals

import com.traceitx.config.VitalsConfig
import com.traceitx.envelope.txGuard
import com.traceitx.envelope.txGuardVoid
import com.traceitx.vitals.wire.PlayerEventTypes
import com.traceitx.vitals.wire.SessionSummaryDims
import com.traceitx.vitals.wire.VitalsCustomEntry
import com.traceitx.vitals.wire.VitalsEntry
import com.traceitx.vitals.wire.VitalsLimits
import com.traceitx.vitals.wire.VitalsPlayerEvent
import com.traceitx.vitals.wire.VitalsSample
import com.traceitx.vitals.wire.VitalsWireCodec

data class VitalsStamp(val sessionId: String, val entries: List<VitalsEntry>)

/**
 * ## Locking (Codex round-1, Critical 5)
 *
 * [lock] guards FIELD SWAPS AND REGISTRATION SNAPSHOTS ONLY. It is never held
 * across a call into customer code — not `PlayerIntegration.attach()`, not
 * `describe()`, not `detach()`, not `snapshot()` — and never across
 * `ResourceSampler.start()`/`VitalsLifecycleObserver.install()` either. Every
 * one of those used to run under the monitor, which made an integration that
 * waits on a thread re-entering `kill()`/`applyServerConfig` a permanent
 * shutdown hang.
 *
 * The shape every method here follows: take [lock], swap fields, snapshot
 * what has to be driven, drop [lock], THEN drive it. Anything that has to be
 * emitted into a collector this method just detached from the field is
 * emitted into a captured local reference, not through [collector].
 *
 * ## Generations (Codex round-2, Critical 2)
 *
 * Because the enable tail runs with the monitor DROPPED, a disable or a
 * `kill()` can complete in the middle of it. [generation] tags each transition
 * so the tail can tell, and undo itself.
 *
 * Lock order: this monitor may be taken while holding nothing else. It is
 * NEVER taken while holding `VitalsRuntime`'s monitor (`VitalsRuntime` drains
 * and shuts down outside its own monitor, by construction) nor
 * `VitalsCollector`'s lock (the rotation callback now runs after that lock is
 * released). [PlayerRegistry]'s own monitor is a leaf and may be taken under
 * this one.
 *
 * ## `announceLock` (Codex round-4, #1/#5/#6; round-5, #2/#3)
 *
 * A registration's `announceLock` orders that player's `player_attach`,
 * its `player_detach` and everything recorded between them. NO ROTATION
 * CALLBACK AND NO CUSTOMER CODE RUNS UNDER IT: every record made while
 * holding it uses `VitalsCollector.recordXDeferred`, and the returned
 * [VitalsCollector.Recorded] is fired only after `synchronized(announceLock)`
 * has exited. Round 3 fired the rotation inline from inside the record, so
 * `onRotate -> reseed -> describe()` — customer code that may block on a
 * player lock whose owner is itself waiting for this `announceLock` — ran
 * under it. `describe()` itself has always been invoked after the lock is
 * released; the rotation callback is the half that was missing.
 *
 * Round 5 closed the two remaining leaks of customer code into that critical
 * section, both of which read as SDK code and are not:
 *
 *  - `PlayerIntegration.library`/`version` are GETTERS the customer writes
 *    (#2). One that waits for the player's own lock, while the player thread
 *    holds it and is blocked on this same `announceLock` in `track()` or in
 *    completing a `detach()`, deadlocked both threads outright; one that threw
 *    escaped `trackPlayer()` after the registration was already published.
 *    Read once, `txGuard`ed, bounded, BEFORE the monitor — a throwing getter
 *    yields `"unknown"`/null and the player still announces.
 *  - the `data` map an integration emits is customer-owned (#3), and coercing
 *    it calls its own `entries`/`toString`. Every entry — `player_attach`, the
 *    `player_detach` marker, a describe-context emit, a handle's custom entry
 *    — is now BUILT before the monitor is taken and only RECORDED inside it.
 *
 * What remains under the lock is registry membership plus one deferred record.
 *
 * ## Where a player's events go (Codex round-5, #6/#7)
 *
 * `PlayerRegistry.Registration.announcedIn` — the collector that admitted this
 * player's `player_attach`, plus the session that attach LANDED in — is the
 * single answer, and EVERY player emission resolves through it: a describe
 * emit, a live player callback, a handle's custom entry, and the
 * `player_detach` marker. It is written only under `announceLock`, by every
 * announcement, so it always names the timeline the player is currently
 * visible in. It replaced two things that could not answer the question:
 *
 *  - a bare `announced` boolean, which said only that the player had been
 *    announced ONCE and was never cleared — so after a server-config disable
 *    stopped C1 and a re-enable published C2, a callback arriving before C2's
 *    announce tail recorded into C2 ahead of that player's own attach;
 *  - a detach-time pin, captured after the registry removal, which a rotation
 *    in that window could point at a session the player had already been
 *    excluded from reseeding into.
 *
 * The session id travels with every record as `expectedSessionId`, so
 * [VitalsCollector] compares it in the SAME critical section that admits the
 * entry; a check made beside the record had a window in which any other entry
 * could rotate the collector underneath it.
 *
 * Three consequences, all deliberate — the SDK drops rather than
 * misattributes: a callback landing between a rotation and that player's own
 * reseed is dropped (it would otherwise precede its `player_attach` in the new
 * session); a callback landing after a disable is refused by the stopped
 * collector rather than reaching the next one; and (Codex round-6, #3) a
 * callback that would ITSELF rotate the collector — a `player_detach`, or a
 * teardown's closing `buffer_end`, for a player idle past `maxIdleMs` — is
 * refused rather than carried across the boundary. The pin says "this session
 * or nowhere", and the session it named was finalized and sent the moment the
 * rotation happened. The same pin is what lets [shutdown] drain an
 * asynchronous teardown into the collector it is tearing down without holding
 * a separate reference to it.
 */
internal class VitalsController(private val deps: Deps) {
    class Deps(
        val localConfig: VitalsConfig,
        val dims: SessionSummaryDims,
        /**
         * Codex round-2, Important 14 — one sink per COLLECTOR, built when
         * this controller starts collecting and closed when that collector
         * stops. It used to be a bare `send: (String) -> Unit` closing over a
         * transport built once per `start()`, which had no close path at all:
         * a rapid start/kill cycle left every one of them holding its payload,
         * its delayed retry runnables and its in-flight calls until the epoch
         * check happened to fire, up to a minute later. The OkHttp client
         * behind it stays per-start (reusing one process-wide client is a
         * separate change).
         */
        val transport: () -> VitalsSink,
        val scheduler: VitalsScheduler,
        val samplerFactory: (onSample: (VitalsSample) -> Unit, onTick: () -> Unit) -> ResourceSampler,
        val lifecycle: (onForeground: () -> Unit, onBackground: () -> Unit) -> VitalsLifecycleObserver?,
        val now: () -> Long = System::currentTimeMillis,
        val random: () -> Double = { kotlin.random.Random.nextDouble() },
        val newSessionId: () -> String = { java.util.UUID.randomUUID().toString() },
        val collectorOverrides: (VitalsCollector.Deps) -> VitalsCollector.Deps = { it },
    )

    private val lock = Any()
    private val registry = PlayerRegistry()
    @Volatile private var collector: VitalsCollector? = null
    private var sampler: ResourceSampler? = null
    private var lifecycle: VitalsLifecycleObserver? = null
    private var sink: VitalsSink? = null

    private var draw: Boolean? = null
    private var shutdown = false

    /**
     * Codex round-2, Critical 2. Every enable/disable transition is tagged
     * with a value of this counter, taken under [lock]; a disable, a
     * re-enable and [shutdown] all bump it. The enable TAIL — `sampler.start()`
     * and `lifecycle.install()`, which by [lock]'s own discipline have to run
     * with the monitor dropped — re-checks its tag afterwards and immediately
     * stops/uninstalls what it just brought up if the generation has moved on.
     *
     * Without that re-check, a `kill()` (or a server-config disable) landing
     * inside the tail's window stopped the sampler it had CAPTURED and
     * returned, and the tail then started that same sampler and installed the
     * observer on `ProcessLifecycleOwner` — resurrecting resource sampling and
     * leaking a process-lifetime observer feeding a dead controller. Only
     * written under [lock].
     */
    private var generation = 0

    val isRunning: Boolean get() = collector != null

    // ---- gate ----

    /**
     * The state swap runs under [lock]; the work it schedules (announcing
     * players, starting the sampler, installing the lifecycle observer,
     * stopping all three) runs after the monitor is released.
     */
    fun applyServerConfig(cfg: VitalsServerConfig?) = txGuardVoid("VitalsController.applyServerConfig") {
        var after: (() -> Unit)? = null
        synchronized(lock) {
            if (!shutdown) {
                val wants = cfg != null && cfg.vitalsEnabled && deps.localConfig.enabled != false && drawOnce(cfg.vitalsSampleRate)
                when {
                    wants && collector == null -> after = startCollectorLocked()
                    !wants && collector != null -> after = stopCollectorLocked()
                }
            }
        }
        after?.invoke()
    }

    private fun drawOnce(serverRate: Double): Boolean {
        draw?.let { return it }
        val rate = minOf(deps.localConfig.sampleRate ?: 1.0, serverRate).coerceIn(0.0, 1.0)
        return (deps.random() < rate).also { draw = it }
    }

    /**
     * Called with [lock] HELD. Publishes the new collector and takes the
     * registration snapshot atomically with it — which is what makes the
     * announce exactly-once against a concurrent [trackPlayer] publishing
     * under the same monitor — and returns the customer-facing tail to run
     * once the monitor is dropped.
     *
     * Codex round-2, Important 6 — construction is TRANSACTIONAL. A throwing
     * `samplerFactory`/`lifecycle` used to leave the collector (and its flush
     * timer) already published with no sampler behind it, and because
     * `collector != null` from then on, no later config change would ever try
     * again: the controller was permanently half-started. Now nothing is
     * published unless all three parts were built, whatever WAS built is torn
     * down, and `collector` stays null so a later apply retries.
     */
    private fun startCollectorLocked(): (() -> Unit)? {
        var built: VitalsCollector? = null
        var s: ResourceSampler? = null
        var l: VitalsLifecycleObserver? = null
        var out: VitalsSink? = null
        try {
            // Round-2, Important 4: the rotation callback reseeds the collector
            // this rotation happened IN, captured here — never `collector` as
            // it reads at callback time. A rotation racing a stop/restart used
            // to reseed the NEWLY installed collector with the OLD one's live
            // players, announcing them a second time into a session that had
            // already announced them itself.
            var self: VitalsCollector? = null
            val sk = deps.transport()
            out = sk
            val base = VitalsCollector.Deps(
                dims = deps.dims,
                now = deps.now,
                send = { payload -> sk.send(VitalsWireCodec.encodeRequest(payload)) },
                newSessionId = deps.newSessionId,
                scheduler = deps.scheduler,
                onRotate = { trigger -> self?.let { reseed(it, trigger) } },
            )
            val c = VitalsCollector(deps.collectorOverrides(base))
            built = c
            self = c
            // Both the sampler and the lifecycle observer are bound to THIS
            // collector instance rather than re-reading the field, for the
            // same reason: a tick that survives into the next generation must
            // not record into it.
            val sam = deps.samplerFactory({ sample -> c.recordSample(sample) }, { collectStats() })
            s = sam
            l = deps.lifecycle({ sam.resume() }, { sam.pause(); c.flushNow() })
        } catch (t: Throwable) {
            com.traceitx.envelope.InternalLogger.recordSafeWrapFailure("VitalsController.startCollector", t)
            val rollbackCollector = built
            val rollbackSampler = s
            val rollbackSink = out
            // Fields were never written, so `collector` is still null and the
            // next `applyServerConfig` retries. The teardown runs outside the
            // monitor like every other one, and each step is guarded on its own.
            return {
                runCatching { rollbackSampler?.stop() }
                runCatching { rollbackCollector?.stop() }
                runCatching { rollbackSink?.close() }
            }
        }
        val c = built!!
        val sam = s!!
        val obs = l
        collector = c
        sampler = sam
        lifecycle = obs
        sink = out
        val gen = ++generation
        val existing = registry.live()
        return {
            for (r in existing) announce(c, r)
            sam.start()
            obs?.install()
            // Round-2, Critical 2: a disable/kill that landed while the two
            // calls above were running already stopped the sampler it captured
            // and returned. Undo what this tail just resurrected.
            if (synchronized(lock) { generation != gen }) {
                runCatching { obs?.uninstall() }
                runCatching { sam.stop() }
            }
        }
    }

    /**
     * Called with [lock] HELD; the returned tail stops everything outside it.
     *
     * Round-2, Important 6: each step is guarded independently. A throwing
     * `uninstall()` used to skip `sampler.stop()` and `collector.stop()`
     * entirely — leaking the sampling cadence AND losing the final summary.
     */
    private fun stopCollectorLocked(): () -> Unit {
        generation++
        val l = lifecycle; val s = sampler; val c = collector; val k = sink
        lifecycle = null; sampler = null; collector = null; sink = null
        return {
            runCatching { l?.uninstall() }
            runCatching { s?.stop() }
            runCatching { c?.stop() }
            // Round-2, Important 14: AFTER the collector's own stop(), so the
            // final summary still goes out before the sink stops accepting.
            runCatching { k?.close() }
        }
    }

    // ---- players ----

    /**
     * The customer-facing emit path.
     *
     * [boundAnnouncement] is the announcement this context belongs to — the
     * exact [PlayerRegistry.Registration.Announced] INSTANCE that
     * `announce()` published. Non-null for `describe()` during an
     * announce/reseed; null for `attach()` and for live player callbacks.
     *
     * Codex round-5, #6/#7 — where an emission actually GOES is
     * [PlayerRegistry.Registration.announcedIn] in both cases: the collector
     * that admitted this player's `player_attach` and the session that attach
     * landed in. A live callback no longer resolves "whatever collector is
     * current", which is how one could land in a session that had never seen
     * this player attach. [boundAnnouncement] is only the staleness check on
     * top of that: a describe whose announcement has since been superseded is
     * dropped.
     *
     * Codex round-6, #4 — that check is REFERENCE EQUALITY against the
     * announcement, not against its collector. It used to pin the collector
     * and re-read `reg.announcedIn` per emission, so a rotation during a slow
     * `describe()` let the reseed re-announce and re-describe the player, and
     * then the ORIGINAL describe resumed, still matched on collector identity
     * (a rotation keeps the same collector object) and emitted into the NEW
     * announcement as well — restating a superseded announcement's view of
     * the player into a timeline that had already been told the current one.
     * (Its duplicate `play`/`buffer_start` opens are no longer a corruption
     * in themselves — Codex round-7, #1 made the accumulator's spans
     * per-player idempotent — but the identity they travel with is stale, and
     * this check is what keeps a describe inside the announcement it was
     * called for.) A new
     * announcement is a new object even inside the same collector, which is
     * exactly the distinction identity makes and the collector cannot.
     */
    private inner class Ctx(
        private val reg: PlayerRegistry.Registration,
        private val boundAnnouncement: PlayerRegistry.Registration.Announced? = null,
    ) : PlayerIntegrationContext {
        override fun emit(type: String, data: Map<String, Any?>?, t: Long?): Boolean {
            // Round-2, Important 9. `type` is a free String from customer
            // code; anything outside the protocol enum makes ingest reject the
            // whole chunk it lands in, taking every other entry with it.
            if (type !in PlayerEventTypes.ALL) {
                com.traceitx.envelope.InternalLogger.recordSafeWrapFailure(
                    "VitalsController.emit.unknownType",
                    IllegalArgumentException(type.take(VitalsLimits.MAX_CUSTOM_NAME_LENGTH)),
                )
                return false
            }
            // Codex round-5, #6/#7 — WHERE this player is announced is the
            // whole answer. Round-2 Important 5's rule ("nothing this player
            // emits may precede its own `player_attach`") is now enforced per
            // collector AND per session rather than by a boolean that, once
            // set, stayed set across a disable, a re-enable and every
            // rotation. Never announced → dropped, not buffered.
            val a = reg.announcedIn ?: return false
            // Codex round-5, #3 — the entry, INCLUDING the coercion of the
            // customer's `data` map, is built before any lock is taken. The
            // describe path used to build it inside `announceLock`, so a map
            // backed by player-locked state (an `entries` getter that reaches
            // for the player's own lock) could wait for a thread that was
            // itself blocked on this `announceLock` in track/detach —
            // a permanent deadlock inside the SDK's own critical section.
            val entry = buildPlayerEvent(reg.id, type, data, t)
            if (boundAnnouncement != null) {
                // Codex round-6, #4 — a describe() context belongs to ONE
                // announcement, identified by the object itself. If this
                // registration has since been re-announced — a rotation
                // reseed, a collector restart — this emission is stale and
                // goes nowhere, even though the collector is the same object.
                if (a !== boundAnnouncement) return false
                // Codex round-4, #5 — an announce/reseed `describe()` context.
                // `announce()` records `player_attach`, releases the announce
                // monitor and only THEN calls `describe()`, so a detach
                // racing it can complete — unregister, tear the integration
                // down and record `player_detach` — before this delayed
                // emission arrives. It used to land anyway: source/DRM state
                // after the detach that closed the player, and an opening
                // `play`/`buffer_start` from another integration left a
                // summary span open for the rest of the session. Ordered
                // against the detach on the same monitor and dropped once the
                // registration is no longer live; the rotation it may trigger
                // is fired after the monitor is released (#1).
                val rec = synchronized(reg.announceLock) {
                    if (!registry.isLive(reg.token)) null
                    else a.collector.recordPlayerEventDeferred(entry, a.sessionId)
                } ?: return false
                rec.fireRotate()
                return rec.accepted
            }
            // A LIVE callback context. Deliberately not liveness-gated: an
            // integration's teardown legitimately emits its closing
            // `buffer_end`/`pause` after unregister (round-3, Important 6) —
            // and [PlayerRegistry.Registration.announcedIn] is what makes
            // those land in the collector and session the player was
            // announced in, never in a later one that never saw it attach.
            //
            // Codex round-7, #2 — but it IS ordered against the completion of
            // that teardown, on the same monitor `detachAndMark` records the
            // marker under. This callback read `announcedIn` and built its
            // entry outside every lock (it must: the customer's `data` map is
            // coerced there, round-5 #3), and a detach completing in that
            // window recorded `player_detach` into the very session this
            // entry is pinned to — so the pin still matched and an opening
            // `play` was admitted AFTER the marker that closed the player,
            // with nothing left attached to ever close it. The pin cannot
            // tell draining from done;
            // [PlayerRegistry.Registration.detached] can. Nothing but the
            // flag read and the deferred record happens under the monitor,
            // and the rotation is fired after it is released (round-4, #1).
            val rec = synchronized(reg.announceLock) {
                if (reg.detached) null else a.collector.recordPlayerEventDeferred(entry, a.sessionId)
            } ?: return false
            rec.fireRotate()
            return rec.accepted
        }
        override fun now(): Long = deps.now()
    }

    /**
     * Codex round-5, #3 — the entry, split out of the record so every
     * caller can build it BEFORE it takes a lock. `data` is a customer-owned
     * `Map`, and coercing it calls that map's own `entries`/`toString`; doing
     * so under a registration's `announceLock` handed customer code a lock the
     * player's own teardown thread blocks on. Pure: it touches no controller
     * state beyond the clock.
     */
    private fun buildPlayerEvent(playerId: String, type: String, data: Map<String, Any?>?, t: Long?): VitalsPlayerEvent =
        VitalsPlayerEvent(t = t ?: deps.now(), type = type, playerId = playerId, data = JsonCoerce.toJsonObject(data))

    /**
     * Never called under [lock] — `describe()` is customer code.
     *
     * Codex round-3, Important 5: the liveness re-check, the `player_attach`
     * record and the `announced` write are ONE critical section on the
     * registration's own [PlayerRegistry.Registration.announceLock]. A
     * registration unregistered before this gets in is never announced at all
     * (it produces no timeline, rather than an attach with no matching
     * detach); one unregistered while this is inside has its `player_detach`
     * ordered strictly after the attach, because the detach paths take the
     * same monitor. `describe()` runs after it is released — never under it.
     *
     * Codex round-5, #2/#3 — so do `integration.library`/`version` and the
     * whole `player_attach` entry. Those two are CUSTOMER GETTERS: one that
     * waits for the player's own lock while the player thread holds it and is
     * itself blocked on this `announceLock` (in `handle.track()`, or
     * completing a `detach()`) deadlocked both threads, and one that THREW
     * escaped `trackPlayer()` after the registration had already been
     * published. Read once, guarded, bounded, before the monitor; the
     * critical section then sees nothing but captured strings.
     */
    private fun announce(c: VitalsCollector, r: PlayerRegistry.Registration) {
        val library = txGuard("VitalsController.playerLibrary") {
            r.integration.library.take(VitalsLimits.MAX_PLAYER_LIBRARY_LENGTH)
        } ?: UNKNOWN_PLAYER_LIBRARY
        val version = txGuard("VitalsController.playerLibraryVersion") {
            r.integration.version?.take(VitalsLimits.MAX_PLAYER_LIBRARY_LENGTH)
        }
        val attach = buildPlayerEvent(
            r.id, PlayerEventTypes.PLAYER_ATTACH,
            mapOf("name" to r.name, "tag" to "video", "library" to library, "libraryVersion" to version)
                .filterValues { it != null },
            null,
        )
        // Codex round-6, #4 — the exact announcement this call publishes, so
        // the `describe()` below can be bound to THAT object rather than to
        // the collector it lives in. Written inside the critical section
        // below, read after it.
        var announced: PlayerRegistry.Registration.Announced? = null
        val recorded = synchronized(r.announceLock) {
            if (!registry.isLive(r.token)) {
                null
            } else {
                val rec = c.recordPlayerEventDeferred(attach)
                // Round-2, Important 5: the gate opens only once
                // `player_attach` is in the timeline, and it opens BEFORE
                // `describe()` so the reseed's own events get through.
                //
                // Codex round-5, #6/#7: the gate is the PIN. It names the
                // collector that admitted the attach and the session the
                // attach landed in — after any rotation the attach itself
                // triggered, which is why the session id comes back from the
                // record rather than being read beside it. A refused attach
                // leaves the previous pin untouched: this player is still
                // wherever it was last really announced, and nothing new is
                // claimed for it here.
                if (rec.accepted) {
                    val a = PlayerRegistry.Registration.Announced(c, rec.sessionId!!)
                    r.announcedIn = a
                    announced = a
                }
                rec
            }
        } ?: return
        // Codex round-4, #1: the attach may have rotated the session, and the
        // rotation callback reseeds every OTHER live player — customer
        // `describe()` code. It runs here, with this registration's
        // `announceLock` released, never inside it.
        recorded.fireRotate()
        // Nothing was announced, so there is nothing for a describe to belong
        // to; its emissions would all be refused anyway. Non-null exactly
        // when the attach was accepted.
        val bound = announced ?: return
        txGuardVoid("VitalsController.describe") { r.integration.describe(Ctx(r, bound)) }
    }

    /**
     * Session rotation: re-announce every live player into the fresh session.
     *
     * Codex round-1, Important 11 — `describe()` also re-opens ongoing
     * `play`/`buffer_start` spans, which the new session's accumulator would
     * otherwise never see.
     *
     * A DUPLICATE open is harmless (Codex round-7, #1). Rounds 1–6 carried a
     * per-type suppression here: when the entry that caused the rotation was
     * that player's own opening transition, it was already in the new
     * session, so
     * the reseed's re-open was suppressed for that player. The accumulator
     * counted opens and closes back then, so a second open left the union
     * span running to the end of the session. It now tracks WHICH players are
     * inside the span, and a repeat open from the same player is a no-op — so
     * the suppression is deleted rather than kept "for the contract". Round-6
     * #3 had already made it unreachable (a `play`/`buffer_start` carries a
     * session pin, and a pinned entry that would rotate is refused rather
     * than admitted into the new session), and a rule nothing exercises is a
     * rule nothing can keep correct. What suppression defended is now
     * defended at the accumulator, for every path at once.
     *
     * Codex round-5, #8 — the trigger's own player is skipped entirely when
     * the trigger IS its `player_attach`. That attach is already in the new
     * session (it is what rotated into it), and the `announce()` this
     * rotation was fired from goes on to `describe()` the player once the
     * callback returns. Re-announcing here gave that player a second
     * `player_attach` AND a second `describe()`. The duplicate attach is
     * wrong on its own — it puts one player into the timeline twice — which
     * is why this skip survives round-7 #1's retirement of the type
     * suppression: an accumulator that forgives a duplicate `play` says
     * nothing about a duplicate `player_attach`.
     */
    private fun reseed(c: VitalsCollector, trigger: VitalsEntry?) {
        val alreadyAnnouncing = (trigger as? VitalsPlayerEvent)
            ?.takeIf { it.type == PlayerEventTypes.PLAYER_ATTACH }?.playerId
        for (r in registry.live()) {
            if (r.id == alreadyAnnouncing) continue
            announce(c, r)
        }
    }

    /**
     * Codex round-1, Important 8 — a `snapshot()` that completes
     * asynchronously can land after its registration was detached, or after
     * the collector it was requested against was replaced. Both are checked
     * before the result is emitted, and the result is emitted into the
     * collector it was requested FROM, never into a later generation's.
     *
     * Codex round-6, #6 — those checks are made INSIDE the registration's
     * `announceLock`, in the same critical section as the record. Beside it
     * they were a TOCTOU: an async snapshot could pass `isLive()`, pause, and
     * resume after another thread had unregistered the player and recorded
     * its `player_detach`, and `stats` then landed after the marker that
     * closed the player.
     */
    private fun collectStats() {
        val c = collector ?: return
        for (r in registry.live()) {
            txGuardVoid("VitalsController.snapshot") {
                r.integration.snapshot { snap ->
                    // Round-2, Important 12: the return value is the integration's
                    // signal that a reported DELTA may be committed. Every refusal
                    // path answers false, so an unrecorded delta stays owed and
                    // folds into the next accepted snapshot instead of vanishing.
                    if (snap == null) return@snapshot false
                    // Codex round-5, residual of #6/#7 — a `stats` entry is a
                    // player emission like any other, so it resolves through
                    // the announcement rather than through the field. The
                    // `collector !== c` field comparison this replaces could
                    // not see a ROTATION: a tick landing between a rotation
                    // and this player's reseed passed it (same collector,
                    // new session) and put `stats` ahead of the reseeded
                    // `player_attach`. The session pin makes the collector
                    // refuse that entry — atomically with admission, under
                    // its own lock — and `accepted` then tells media3 to keep
                    // owing the dropped-frame delta.
                    //
                    // Codex round-6, #6 — but the LIVENESS half was still a
                    // TOCTOU. `isLive()` and the record were separate
                    // critical sections, so an asynchronous snapshot could
                    // pass the check, pause, and resume after another thread
                    // had unregistered the player and recorded its
                    // `player_detach`. The announcement still matched, so
                    // `stats` was admitted AFTER the detach that closed the
                    // player — and the integration committed its dropped-frame
                    // delta against it.
                    //
                    // Same shape as `PlayerHandle.track` (round-4, #6): the
                    // entry is BUILT outside the monitor (coercing a customer
                    // map must not run under it), the liveness decision, the
                    // announcement resolution and the deferred admission are
                    // ONE critical section on the same monitor both detach
                    // paths take, and the rotation it may cause is fired after
                    // that monitor is released (round-4, #1 — `reseed` calls
                    // customer `describe()`).
                    val entry = buildPlayerEvent(
                        r.id, PlayerEventTypes.STATS,
                        mapOf(
                            "bufferAheadMs" to (snap.bufferAheadMs ?: 0L), "bandwidthEstimate" to snap.bandwidthEstimate,
                            "bitrate" to snap.bitrate, "width" to snap.width, "height" to snap.height,
                            "droppedFrames" to snap.droppedFramesDelta,
                        ).filterValues { it != null },
                        null,
                    )
                    val rec = synchronized(r.announceLock) {
                        if (!registry.isLive(r.token)) null
                        else r.announcedIn
                            ?.takeIf { it.collector === c }
                            ?.let { a -> a.collector.recordPlayerEventDeferred(entry, a.sessionId) }
                    } ?: return@snapshot false
                    rec.fireRotate()
                    // Codex round-4, #7 — the COLLECTOR's answer, not a
                    // hardcoded true. A server-config disable can stop `c`
                    // before the record above lands, and a stopped collector
                    // refuses the entry outright (so does one that finds it
                    // over-budget). Answering true anyway let media3 advance
                    // `droppedReported` past frames that never reached the
                    // timeline, discarding them permanently across the later
                    // re-enable.
                    rec.accepted
                }
            }
        }
    }

    /**
     * Two-phase, and the reason is Codex round-1 Important 2/3 plus the
     * parked item N1:
     *
     *  - the registration is RESERVED (id minted, nothing visible) before
     *    `attach()` runs, so a collector starting concurrently cannot
     *    announce a `player_attach` for a player that has not finished
     *    attaching — or that is about to refuse;
     *  - a refused or throwing `attach()` gets a best-effort `detach()` (it
     *    may have subscribed halfway) and an INERT handle with an empty id,
     *    so `handle.track()` can never stamp custom entries with a player id
     *    the timeline never saw attach;
     *  - publication and the "which collector announces this" decision happen
     *    in ONE critical section, so exactly one of this thread and
     *    [startCollectorLocked] announces;
     *  - a [shutdown] that has begun refuses the registration outright (N1),
     *    both before `attach()` and at publication time — nothing can be left
     *    attached to a controller that has already detached everything.
     *
     * Codex round-8, #3 — those last two refusals are DIFFERENT ANSWERS, and
     * the caller has to be able to tell them apart:
     *
     *  - an INTEGRATION refusal is final. The customer's player is unusable,
     *    no other controller would do better, and the inert handle is the
     *    right permanent answer.
     *  - a SHUTDOWN refusal is transient. It means "not me" — another
     *    controller is, or is about to become, the current one — so it
     *    answers `null` and the caller re-selects or requeues. Committing the
     *    inert handle instead permanently consumed a registration no `kill()`
     *    had revoked: `VitalsRuntime`'s drain selected controller B, released
     *    its monitor, a superseding start shut B down and installed C, and
     *    the registration was written off to an inert delegate C never heard
     *    about — unrecoverable, since the entry was already out of `pending`.
     *
     * The publication-time refusal still runs its best-effort
     * `integration.detach()` before answering: `attach()` has run by then and
     * may have subscribed halfway.
     */
    fun trackPlayer(integration: PlayerIntegration, name: String?): PlayerHandle? {
        val r = synchronized(lock) { if (shutdown) null else registry.reserve(integration, name) }
            ?: return null

        val attached = txGuard("VitalsController.attach") { integration.attach(Ctx(r)) } == true
        if (!attached) return inertHandle(integration)

        val announceIn = synchronized(lock) {
            if (shutdown) null else { registry.publish(r); Box(collector) }
        } ?: run {
            // Codex round-3, E2 — a SHUTDOWN refusal is transient: `VitalsRuntime` retries THIS
            // SAME integration against the next controller, so this is an attachment ROLLBACK,
            // not a disposal. The terminal `detach()` throws away state the retry needs — for
            // the RN bridge's `RemotePlayerIntegration` the host model itself, whose
            // `playing`/`buffering` it clears (round-1, C1), leaving the retried registration
            // announced with no open spans and uninterrupted playback unmeasured. Twin of the
            // same branch in `VitalsController.swift`.
            txGuardVoid("PlayerIntegration.detach") {
                if (integration is AttachRollback) integration.rollbackAttach() else integration.detach()
            }
            return null
        }

        announceIn.value?.let { announce(it, r) }

        return object : PlayerHandle {
            override val id = r.id
            /**
             * Codex round-3, Important 11 — a DETACHED handle records
             * nothing. It keeps its nonblank id forever (callers hold it, and
             * an id that changes under them is worse), so without this gate a
             * `track()` after `detach()` kept stamping custom entries with a
             * player id the timeline had already said goodbye to — and if the
             * call landed after a session rotation, the NEW session received
             * entries for a player it never saw attach at all.
             */
            override fun track(name: String, data: Any?) = txGuardVoid("PlayerHandle.track") {
                // Codex round-4, #6 — the liveness DECISION and the record are
                // one critical section on the same monitor the detach paths
                // take. Round 3's bare `isLive()` check was a TOCTOU: a
                // concurrent `detach()` completing between the check and the
                // record landed this custom entry AFTER `player_detach`, and
                // if it rotated the session it carried a `playerId` into a
                // session that never announced that player. The entry is BUILT
                // outside the monitor (bounding JSON is customer data, and no
                // more of it runs under a lock than has to) and the rotation
                // it may cause is fired after the monitor is released (#1).
                val entry = buildCustomEntry(name, data, r.id)
                val rec = synchronized(r.announceLock) {
                    // Codex round-5, #6/#7 — into the collector and session
                    // this player is ANNOUNCED in, not into whatever is
                    // current. A disable/re-enable or a rotation between the
                    // last announcement and this call means the new timeline
                    // has not seen this player attach yet, and a custom entry
                    // carrying its id must not be the first thing it sees.
                    if (!registry.isLive(r.token)) null
                    else r.announcedIn?.let { a -> a.collector.recordCustomDeferred(entry, a.sessionId) }
                } ?: return@txGuardVoid
                rec.fireRotate()
            }
            override fun detach() = txGuardVoid("PlayerHandle.detach") {
                val removed = registry.unregister(r.token) ?: return@txGuardVoid
                // Codex round-5, #6: nothing is pinned here any more. Round 4
                // captured the current collector + session AFTER this
                // unregister, which is one rotation away from naming a session
                // this player had already been excluded from reseeding into;
                // `announcedIn` is the pin, and it was taken at announce time.
                //
                // Round-3, Important 6: the marker is emitted from the
                // integration's COMPLETION callback, not the instant detach()
                // returns — media3 closes its open spans on the player's own
                // thread, and those `buffer_end`/`pause` events used to land
                // after the `player_detach` that closes them.
                detachAndMark(removed) { }
            }
        }
    }

    /**
     * Codex round-3, Important 6 — runs an integration's teardown and emits
     * its `player_detach` marker exactly once, WHEN THAT TEARDOWN HAS ACTUALLY
     * FINISHED (see [PlayerIntegration.detach] with a completion callback),
     * then runs [then].
     *
     * [then] is how [shutdown] counts the drain down; it runs on whichever
     * thread completed the teardown, inside the same one-shot guard as the
     * marker, so a throwing marker cannot cost the count-down and a
     * throwing/never-completing `detach()` cannot leave it hanging: an
     * exception out of `detach()` fires the completion here instead.
     *
     * Where the marker lands is [PlayerRegistry.Registration.announcedIn]
     * (Codex round-5, #6) — the collector that admitted this player's
     * `player_attach`, and the session that attach landed in. Neither caller
     * pins anything here: round 4 captured the current collector after the
     * registry removal, which a rotation could turn into a session the player
     * had already been excluded from reseeding into. During [shutdown] that
     * pin still names the collector being drained, which is exactly why the
     * drain works without holding a separate `draining` reference.
     */
    private fun detachAndMark(
        r: PlayerRegistry.Registration,
        then: () -> Unit,
    ) {
        // Codex round-5, #3 — built before the monitor, like every other
        // record made under `announceLock`.
        val marker = buildPlayerEvent(r.id, PlayerEventTypes.PLAYER_DETACH, null, null)
        val fired = java.util.concurrent.atomic.AtomicBoolean(false)
        val complete = {
            if (fired.compareAndSet(false, true)) {
                try {
                    txGuardVoid("VitalsController.playerDetach") {
                        // Round-2, Important 5: a registration torn down before
                        // it was ever announced leaves NO timeline, not a
                        // detach-only one. Round-3, Important 5: under the
                        // registration's own monitor, so a `player_attach`
                        // racing this is ordered BEFORE the marker. Round-4,
                        // #1: the rotation the marker may trigger is fired
                        // AFTER that monitor is released — `reseed` calls
                        // `describe()`, which is customer code.
                        val rec = synchronized(r.announceLock) {
                            // Codex round-7, #2: the teardown is OVER, and it
                            // is recorded as over in the same critical
                            // section that records the marker — whether or
                            // not a marker was recorded (a never-announced
                            // registration gets none, and must not go on
                            // admitting live emissions either). A live
                            // callback that built its entry before this and
                            // arrives after it is refused instead of landing
                            // behind the marker.
                            r.detached = true
                            // Codex round-5, #6: the marker goes where the
                            // attach it closes went, and the collector checks
                            // that session in the same critical section that
                            // admits it. A registration that was never
                            // announced gets no marker at all.
                            r.announcedIn?.let { a -> a.collector.recordPlayerEventDeferred(marker, a.sessionId) }
                        }
                        rec?.fireRotate()
                    }
                } finally {
                    txGuardVoid("VitalsController.playerDetachDrain", then)
                }
            }
        }
        try {
            r.integration.detach(complete)
        } catch (t: Throwable) {
            com.traceitx.envelope.InternalLogger.recordSafeWrapFailure("PlayerIntegration.detach", t)
            complete()
        }
    }

    /** Distinguishes "no collector" from "shutdown" for the nullable-under-lock result above. */
    private class Box(val value: VitalsCollector?)

    /**
     * Codex round-8, #3 — an INTEGRATION refusal, and only that. A shutdown
     * refusal answers `null` instead, so the caller can hand the registration
     * to whichever controller is actually current.
     */
    private fun inertHandle(integration: PlayerIntegration): PlayerHandle {
        txGuardVoid("PlayerIntegration.detach") { integration.detach() }
        return object : PlayerHandle {
            override val id = ""
            override fun track(name: String, data: Any?) = Unit
            override fun detach() = Unit
        }
    }

    fun trackVitals(name: String, data: Any?, playerId: String?) = txGuardVoid("VitalsController.trackVitals") {
        val c = collector ?: return@txGuardVoid
        c.recordCustom(buildCustomEntry(name, data, playerId))
    }

    /**
     * Codex round-4, #6 — bounding and naming, split out of [trackVitals] so
     * the player-handle path can BUILD the entry outside the registration's
     * `announceLock` and record it inside. Pure: it touches no controller
     * state.
     */
    private fun buildCustomEntry(name: String, data: Any?, playerId: String?): VitalsCustomEntry {
        val bounded = boundJson(if (data == null) null else JsonCoerce.toJsonElement(data))
        return VitalsCustomEntry(
            t = deps.now(), name = name.take(VitalsLimits.MAX_CUSTOM_NAME_LENGTH).ifEmpty { "unnamed" },
            data = bounded.data, truncated = if (bounded.truncated) true else null,
            playerId = playerId?.take(VitalsLimits.MAX_PLAYER_ID_LENGTH),
        )
    }

    /** I4: one timed lock acquisition inside the collector stamps the id and the ring together. */
    fun currentStamp(): VitalsStamp? = collector?.stamp()

    /**
     * Critical 5: only the state swap and the registry snapshot are taken
     * under [lock]; every `detach()` and every `stop()` runs after it is
     * released. The detached players' `player_detach` entries are emitted
     * into the captured collector — the field is already null by then, which
     * is what makes `isRunning`/`currentStamp()` read false the instant a
     * concurrent thread can observe the shutdown.
     */
    fun shutdown() = txGuardVoid("VitalsController.shutdown") {
        var regs: List<PlayerRegistry.Registration> = emptyList()
        var c: VitalsCollector? = null
        var s: ResourceSampler? = null
        var l: VitalsLifecycleObserver? = null
        var k: VitalsSink? = null
        var alreadyDown = false
        synchronized(lock) {
            if (shutdown) {
                alreadyDown = true
            } else {
                shutdown = true
                // Round-2, Critical 2: supersede any enable tail still running
                // outside the monitor, so it stops/uninstalls what it started.
                generation++
                regs = registry.clear()
                c = collector; s = sampler; l = lifecycle; k = sink
                collector = null; sampler = null; lifecycle = null; sink = null
            }
        }
        if (alreadyDown) return@txGuardVoid
        // Round-3, Important 6: an integration that tears down on its own
        // thread finishes AFTER `detach()` returns. Stopping the collector
        // straight away threw its closing `buffer_end`/`pause` on the floor —
        // the union play/rebuffer spans then ran to the end of the session in
        // the summary. Wait, briefly and boundedly, for the drain.
        //
        // Codex round-5, #6: nothing here pins a target either. `collector` is
        // already null, but each registration's `announcedIn` still names the
        // collector it was announced in — the very one being drained, which is
        // not stopped until below — so the teardown's closing spans and the
        // markers reach it, and a rotation inside the drain window refuses
        // them instead of misfiling them. This is what retired the separate
        // `draining` field round 3 needed.
        val drained = java.util.concurrent.CountDownLatch(regs.size)
        for (r in regs) detachAndMark(r) { drained.countDown() }
        if (regs.isNotEmpty()) {
            val finished = try {
                drained.await(DETACH_DRAIN_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
            } catch (t: InterruptedException) {
                Thread.currentThread().interrupt()
                false
            }
            if (!finished) {
                // Never a hang: the collector stops regardless and whatever
                // that integration still had open is lost, exactly as before.
                com.traceitx.envelope.InternalLogger.recordSafeWrapFailure(
                    "VitalsController.shutdown.detachDrain",
                    java.util.concurrent.TimeoutException("player teardown did not complete within ${DETACH_DRAIN_TIMEOUT_MS}ms"),
                )
            }
        }
        // Round-2, Important 6: independently guarded — a throwing uninstall()
        // must not cost the final summary.
        runCatching { l?.uninstall() }
        runCatching { s?.stop() }
        runCatching { c?.stop() }
        runCatching { k?.close() }
    }

    companion object {
        /**
         * Round-3, Important 6. Long enough for a healthy player looper to run
         * one posted teardown (microseconds in practice), short enough that a
         * wedged one cannot hold up `kill()` — which is an emergency stop —
         * for anything a human would notice.
         */
        private const val DETACH_DRAIN_TIMEOUT_MS = 250L


        /**
         * Codex round-5, #2 — what a THROWING `PlayerIntegration.library`
         * getter reports. The player still announces (the alternative is a
         * timeline with no player in it at all); only the library name is
         * lost, and the throw is recorded internally.
         */
        private const val UNKNOWN_PLAYER_LIBRARY = "unknown"
    }
}
