// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Registration is TWO-PHASE (Codex round-1, Important 2/3): [reserve] mints
// the id without publishing it, and [publish] makes it visible to [live].
// A one-phase register left a registration reachable by `startCollector()`'s
// announce loop while `PlayerIntegration.attach()` was still running on
// another thread — announcing a `player_attach` for a player that might then
// refuse (or throw out of) attach, and double-announcing when it did not.
package com.traceitx.vitals

import com.traceitx.vitals.wire.VitalsLimits

internal class PlayerRegistry {
    class Registration(val id: String, val name: String?, val integration: PlayerIntegration, val token: Any) {
        /**
         * Codex round-5, #6/#7 — WHERE this registration is announced, which
         * replaced round-2's bare `announced` boolean and round-4's
         * separate detach pin.
         *
         * Non-null once a `player_attach` for this registration has actually
         * been ADMITTED, naming both the collector that admitted it and the
         * session the entry landed in. Written only under [announceLock], and
         * re-written by every re-announcement (a rotation reseed, or a
         * collector restart) so it always names the timeline this player is
         * currently visible in.
         *
         * It is the single answer to "where does this player's next event
         * go?", and every player emission resolves through it — a describe
         * emit, a live callback, a handle's custom entry and the
         * `player_detach` marker alike. The two things it replaced could not
         * answer that:
         *
         *  - the boolean said only THAT the player had once been announced,
         *    never into what. It was never cleared, so after a server-config
         *    disable stopped C1 and a re-enable published C2, a player
         *    callback arriving before C2's announce tail reached this
         *    registration passed the gate and recorded into C2 AHEAD of that
         *    player's own `player_attach` (#7). Now the pin still names the
         *    stopped C1, which refuses the entry, and it can never name C2
         *    before C2's own announce sets it.
         *  - the detach pin was captured at DETACH time, after the registry
         *    removal — so a rotation in that window could pin a session the
         *    player had already been excluded from reseeding into (#6). The
         *    pin is taken at ANNOUNCE time instead, and the session id
         *    travels with every record as `expectedSessionId`, where
         *    `VitalsCollector` checks it in the same critical section that
         *    admits the entry.
         *
         * Two documented consequences, both deliberate and both lossy in the
         * same direction the SDK has always chosen — drop rather than
         * misattribute:
         *
         *  - a callback landing between a rotation and that player's own
         *    reseed is DROPPED. It would otherwise precede the player's
         *    `player_attach` in the new session, which is round-2 I5's rule.
         *  - a callback landing after a disable is refused by the stopped C1
         *    and can never reach C2 before C2's own announce.
         *
         * Codex round-6, #3 added a third, on the same rule: an emission that
         * would itself ROTATE the pinned collector (a `player_detach`, or a
         * teardown's closing `buffer_end`, for a player idle past
         * `maxIdleMs`) is refused rather than admitted into the new session.
         * The pin means "this session or nowhere", and the session it names
         * was finalized and sent the moment the rotation happened.
         *
         * `@Volatile` because it is written by whichever thread announced
         * (the registering thread, or a collector start on another one) and
         * read by the player's own callback thread.
         */
        @Volatile var announcedIn: Announced? = null

        /** The collector a `player_attach` was admitted into, and the session it landed in. */
        class Announced(val collector: VitalsCollector, val sessionId: String)

        /**
         * Codex round-7, #2 — this registration's teardown has COMPLETED and
         * its `player_detach` marker has been recorded (or was declined
         * because the player was never announced). Written only under
         * [announceLock], in the very critical section that records the
         * marker, and read there by the live-emission path.
         *
         * The session pin alone could not tell "draining" from "done". A live
         * player callback reads [announcedIn], builds its entry outside every
         * lock — which is exactly where a customer-owned `data` map has to be
         * coerced (round-5, #3) — and can be descheduled there while the
         * detach completes and records the marker; the pinned session is
         * still current, so the entry was admitted AFTER the `player_detach`
         * that closed the player. An opening `play` landing there is never
         * closed by anything, since the integration is already torn down.
         *
         * Deliberately NOT a liveness check on the registry: the teardown's
         * OWN closing `buffer_end`/`pause` are emitted by the integration
         * before it signals completion (round-3, Important 6), so they arrive
         * while this is still false and must still land.
         */
        @Volatile var detached = false

        /**
         * Codex round-3, Important 5 — the monitor that ORDERS this
         * registration's `player_attach` against its `player_detach`.
         *
         * [announcedIn] alone was not enough (it was a bare boolean then, but
         * the argument is identical). An enable transition snapshots `live()`
         * under [lock] and announces after dropping it, so a concurrent
         * `unregister` could remove the registration while it was still
         * unannounced: the detach path emitted nothing (there was no attach
         * yet, by its reading) and the announce then went ahead and recorded
         * `player_attach` + called `describe()` on an already-detached
         * integration — a ghost player in the timeline and in the summary,
         * attached forever, never detached.
         *
         * `VitalsController.announce` holds this across [live]-membership
         * re-check + the `player_attach` record + the [announcedIn] write,
         * and both detach paths hold it across the `player_detach` record —
         * which now READS [announcedIn] inside the same section. So exactly
         * one of two things happens: the detach wins the registry removal and
         * the announce skips entirely (no timeline at all), or the announce is
         * already inside and the detach marker is emitted strictly AFTER the
         * attach it belongs to.
         *
         * Lock order: `announceLock` -> [lock] (via `isLive`), never the
         * reverse — [unregister]/[clear] release [lock] before the emitting
         * path takes this. NO ROTATION CALLBACK AND NO CUSTOMER CODE RUNS
         * UNDER IT (Codex round-4, #1): `describe()` is invoked after it is
         * released, and every record made while holding it uses
         * `VitalsCollector.recordXDeferred` so the rotation notification —
         * which reseeds every live player through `describe()` — is fired
         * outside it too.
         *
         * Codex round-5, #2/#3 finished that rule. `integration.library` and
         * `integration.version` are customer GETTERS and were read inside this
         * monitor; so was the coercion of the customer-owned `data` map every
         * record carries. Both are now done before it is taken, so what runs
         * under it is registry membership plus one deferred record — SDK code
         * only, start to finish.
         */
        val announceLock = Any()
    }

    private val lock = Any()
    private var counter = 0
    private val live = LinkedHashMap<Any, Registration>()

    /** Mint an id + token. NOT visible to [live] until [publish]. */
    fun reserve(integration: PlayerIntegration, name: String?): Registration = synchronized(lock) {
        counter++
        Registration("p$counter", name?.take(VitalsLimits.MAX_CUSTOM_NAME_LENGTH), integration, Any())
    }

    fun publish(r: Registration) = synchronized(lock) { live[r.token] = r }

    fun unregister(token: Any): Registration? = synchronized(lock) { live.remove(token) }

    fun isLive(token: Any): Boolean = synchronized(lock) { live.containsKey(token) }

    fun live(): List<Registration> = synchronized(lock) { live.values.toList() }

    fun clear(): List<Registration> = synchronized(lock) {
        val all = live.values.toList()
        live.clear()
        all
    }
}
