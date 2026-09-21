// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Token → registration map for host-fed players (RN spec 2026-09-06 §2).
// Tokens are minted by the host; `PlayerHandle.id` (the wire playerId) is
// minted by PlayerRegistry as for any integration. Every method is a silent
// no-op for an unknown token — a bridge must never throw into a host.
//
// TEARDOWN FENCE (codex round-1, C5). `register()` runs OUTSIDE the lock —
// it may run `attach()`, which calls into the controller and the host — so a
// `detachAll()` on another thread (the RN module instance being torn down by
// a Metro/OTA reload) could land in the middle of a `track()` and leave the
// registration it was building in the map, alive and accumulating against a
// bundle that no longer exists. Two things fence it: a GENERATION counter
// read before `register()` and re-checked after it under the lock, and a
// terminal `closed` flag. The generation catches the in-flight registration;
// the flag makes the state final, because this registry is owned by ONE
// module instance and a torn-down instance never revives.
package com.traceitx.vitals

import kotlinx.serialization.json.Json

class RemotePlayerRegistry(
    private val register: (PlayerIntegration, String?) -> PlayerHandle,
    private val sessionTrack: (String, Any?) -> Unit,
    private val captureSourceQuery: () -> Boolean,
) {
    private class Entry(val handle: PlayerHandle, val integration: RemotePlayerIntegration)
    private val lock = Any()
    private val live = HashMap<String, Entry>()
    /** Bumped by `detachAll()`. A `track()` whose `register()` straddled a bump is refused. */
    private var generation = 0L
    /** Terminal: set by `detachAll()` and never cleared. See the file header. */
    private var closed = false

    fun track(token: String, library: String, name: String?, libraryVersion: String?): Boolean {
        val gen = synchronized(lock) {
            if (closed || live.containsKey(token) || live.size >= MAX_TOKENS) return false
            generation
        }
        val integration = RemotePlayerIntegration(library, libraryVersion, captureSourceQuery)
        val handle = register(integration, name)            // outside the lock: may run attach()
        val raced = synchronized(lock) {
            // The generation check is what catches a `detachAll()` that ran DURING `register()`:
            // the map is empty again by then, so the duplicate/cap checks alone would happily
            // publish the loser and leave it live past the teardown that was meant to end it.
            if (closed || generation != gen || live.containsKey(token) || live.size >= MAX_TOKENS) true
            else { live[token] = Entry(handle, integration); false }
        }
        if (raced) handle.detach()                          // outside the lock: detach() runs host code
        return !raced
    }

    fun detach(token: String): Boolean {
        val e = synchronized(lock) { live.remove(token) } ?: return false
        e.handle.detach()
        return true
    }

    /**
     * TERMINAL teardown: drop every registration, detaching each handle (which
     * emits `player_detach` and, since codex round-1 C1, closes any open
     * play/buffer span), and CLOSE the registry for good. Idempotent.
     *
     * Exists for the RN bridge's instance teardown: a Metro/OTA reload builds
     * a fresh JS bundle whose token counter restarts at `rp1`, so without this
     * the previous bundle's registrations both keep accumulating time natively
     * and SHADOW the re-minted tokens (`track` refuses a token that is still
     * live). Not called by `kill()` — hooks own detach in the normal lifecycle.
     *
     * Codex round-1, C5 — the tokens do NOT become re-trackable, and every
     * other entry point no-ops afterwards (round-8 J1: `trackVitals` too). This registry belongs to one RN
     * module instance; the reload that runs this teardown constructs a NEW
     * instance with a NEW registry for the new bundle, so a revivable registry
     * could only ever be revived by a caller from the dead bundle — an
     * in-flight `track()` whose `register()` was still running, or a late
     * `record` from a listener the old bundle never unsubscribed. Both are
     * exactly what the fence exists to refuse.
     */
    fun detachAll() {
        val entries = synchronized(lock) {
            closed = true
            generation++
            live.values.toList().also { live.clear() }
        }
        for (e in entries) e.handle.detach()   // outside the lock: detach() runs host code
    }

    fun record(token: String, type: String, t: Double, data: Map<String, Any?>?): Boolean {
        val at = safeEpochMs(t) ?: return false
        val e = synchronized(lock) { if (closed) null else live[token] } ?: return false
        e.integration.record(type, at, data)
        return true
    }

    fun updateStats(token: String, stats: Map<String, Any?>): Boolean {
        val e = synchronized(lock) { if (closed) null else live[token] } ?: return false
        e.integration.updateStats(stats)
        return true
    }

    /**
     * Unparseable JSON → the line is recorded WITHOUT data, never dropped.
     *
     * Codex round-8, J1 — a CLOSED registry drops the line entirely, token or not. It used
     * to fall through to `sessionTrack` (the reasoning being that a custom vitals line is
     * session-scoped by nature, so a closed registry simply had no player to attribute it
     * to), but `sessionTrack` is process-global: after a Metro/OTA reload the live session
     * belongs to the NEW module instance, so a late line from the dead bundle — a listener
     * the old bundle never unsubscribed, a queued callback — landed in a session it has
     * nothing to do with, silently attributed to whatever the new bundle is doing. Closing
     * is terminal for every entry point, this one included. The unknown-token fallback to
     * `sessionTrack` stays exactly as it was while the registry is OPEN.
     */
    fun trackVitals(name: String, dataJson: String?, token: String?) {
        val e = synchronized(lock) {
            if (closed) return                     // terminal: the line is dropped, not re-homed
            token?.let { live[it] }
        }
        val data: Any? = dataJson?.let { try { Json.parseToJsonElement(it) } catch (t: Throwable) { null } }
        if (e != null) e.handle.track(name, data) else sessionTrack(name, data)
    }

    companion object {
        const val MAX_TOKENS = 32
        /** A finite, non-negative epoch-ms double that fits a Long, else null. */
        fun safeEpochMs(d: Double): Long? =
            if (d.isNaN() || d.isInfinite() || d < 0 || d > 9.0e15) null else d.toLong()
    }
}
