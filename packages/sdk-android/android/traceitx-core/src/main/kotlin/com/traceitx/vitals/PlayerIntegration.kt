// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Platform twin of packages/sdk-core/src/vitals/player-integration.ts
// (spec 2026-09-05 §2). `describe()` is the Android addition: there is no DOM
// to rescan on session rotation, so each live integration re-emits what it
// knows (source_change, drm) — the controller re-emits player_attach itself.
package com.traceitx.vitals

interface PlayerIntegrationContext {
    /**
     * `type` is one of PlayerEventTypes; `data` is any JSON-encodable map; it is bounded before
     * it reaches the wire.
     *
     * Codex round-5, #9 — RETURNS whether the collector actually admitted the entry, exactly as
     * `PlayerIntegration.snapshot`'s `onResult` does. False for an unknown type, for a player
     * that has not been announced (or was announced into a collector/session that has since
     * moved on), for no collector at all, for a stopped one, and for an entry refused as
     * over-budget. An integration that spends a BUDGET on an emission — media3 rations non-fatal
     * load errors to ten a minute — must charge that budget only against a `true`, or ten errors
     * emitted while no collector exists suppress every error for the minute after one appears.
     */
    fun emit(type: String, data: Map<String, Any?>? = null, t: Long? = null): Boolean
    fun now(): Long
}

data class PlayerSnapshot(
    val bufferAheadMs: Long?,
    val bandwidthEstimate: Long?,
    val bitrate: Int?,
    val width: Int?,
    val height: Int?,
    val droppedFramesDelta: Int,
)

data class StartupTimings(val manifestMs: Long?, val licenseMs: Long?, val firstFragmentMs: Long?)

interface PlayerIntegration {
    /** ≤ 32 chars; free string on the wire (`media3`, or a customer's own). */
    val library: String
    val version: String?

    /**
     * Subscribe. Return false when the instance is not what this integration expects — the
     * registration is refused, the caller gets an INERT handle (empty id) and `detach()` is
     * called once, best-effort, in case a partial subscription happened (Codex round-1,
     * Important 3); a throwing `attach()` is treated identically. Called on the caller's
     * thread of trackPlayer(), with no controller lock held. It may subscribe to the player
     * and it SHOULD seed from the player's current state (an already-playing player must open
     * its `play` span, or the session reports zero playtime until the next transition —
     * round-1 I1/round-2 I11); the controller drops anything emitted before this player's
     * own `player_attach` is in the timeline, so emitting early is harmless, never wrong.
     *
     * Codex round-9, #2 — `true` means ACCEPTED, not necessarily FINISHED. An implementation
     * whose player state has a single writer thread may perform the whole transition there
     * (media3 posts it onto the player's application looper) and answer `true` for a post the
     * looper accepted. That is what makes a retry after a shutdown refusal correct: the
     * refusal's `detach()` and the retry's `attach()` are then two runnables on one thread,
     * ordered FIFO, instead of a caller-thread assignment a queued teardown wipes out. The
     * caller must therefore not assume anything is subscribed the instant this returns — the
     * announcement it triggers goes through [describe], which is documented to be equally free
     * to run asynchronously on that same thread.
     */
    fun attach(ctx: PlayerIntegrationContext): Boolean

    /**
     * Called on the sampler tick. Deliver on any thread, synchronously or later; null means
     * "idle, no stats this tick". Must never throw. A result delivered after this player was
     * detached, or after the collector that asked for it was replaced, is dropped (Codex
     * round-1, Important 8) — delivering late is safe, it just may not be recorded.
     *
     * `onResult` RETURNS whether the controller actually recorded the snapshot (Codex
     * round-2, Important 12). An integration reporting a DELTA — dropped frames, say —
     * must not commit that delta until it comes back `true`, or a snapshot rejected for
     * landing after a detach (or against a replaced collector) silently swallows it. A
     * null result is never recorded and always answers `false`.
     */
    fun snapshot(onResult: (PlayerSnapshot?) -> Boolean)

    fun startupTimings(): StartupTimings?

    /**
     * Rotation reseed: re-emit cached identity (source_change, drm) AND re-open whatever
     * spans are currently ongoing (play, buffer_start), so chunk 0 of a new session is
     * self-describing and its summary does not undercount playback. The controller re-emits
     * player_attach itself.
     *
     * Codex round-7, #1 — say TOO MUCH rather than too little. A `play` this player has
     * already opened in the target session is a no-op at `SummaryAccumulator`, whose union
     * spans track which players are inside them rather than counting opens; an ongoing span
     * left unstated is lost until the player's next transition, which for uninterrupted
     * playback never comes. This retired the controller's per-type suppression of whatever
     * the rotation-triggering entry carried, and media3's seed-ownership latches with it.
     *
     * Invoked from the collector's rotation callback AND from the controller's own
     * player-registration path (trackPlayer()/startCollector() announcing an already-live
     * player). Since the Codex round-1 fixes (Critical 4 and 5) NEITHER the collector's lock
     * NOR the controller's monitor is held while this runs, so it is free to take a player's
     * own lock. It still must not block for long or perform I/O: it runs inline on whichever
     * thread recorded the rotation-triggering entry (an app looper, the sampler thread, a
     * player's analytics thread) or on the thread that called `trackPlayer()`.
     *
     * Codex round-8, #2 — that "whichever thread" is exactly why an implementation MAY
     * emit asynchronously. Player state usually has one writer thread, and reading it here
     * while that thread writes is a race no idempotent set can repair: a valid `pause`
     * recorded by the player thread, followed by a stale `play` this describe read a moment
     * earlier, reopens a span that is legitimately closed. media3 therefore posts its reads
     * AND its emissions onto the player's own looper. [ctx] is bound to the announcement it
     * was made for (round-6, #4), so a run that lands after that announcement is superseded
     * is dropped by the controller — emitting late is safe, it just may not be recorded.
     */
    fun describe(ctx: PlayerIntegrationContext)

    /**
     * Codex round-8, #1 — MAY be called on an integration that NEVER ATTACHED.
     * A pending registration revoked by a `kill()`, one cancelled through its
     * deferred handle before the drain reached it, and one whose `attach()`
     * was refused all reach here without an announcement ever existing. It
     * must then be a safe no-op APART FROM RELEASING DECLARATION-TIME
     * RESOURCES, and it must emit nothing — there is no timeline to emit into.
     *
     * media3 is why this matters: `trackPlayer(exoPlayer)` subscribes a
     * release observer to the customer's player the moment it is called, long
     * before the drain calls `attach()`. Returning early on "not attached"
     * left one of those on every ExoPlayer that was declared and then revoked.
     */
    fun detach()

    /**
     * Codex round-3, Important 6 — the ASYNCHRONOUS completion form.
     *
     * An integration whose teardown has to hop to the player's own thread
     * (media3 does: `bufferStartAt`/`playing` have a single writer there)
     * cannot close its open `buffer_end`/`pause` spans before [detach]
     * returns. The controller used to record `player_detach` the moment
     * [detach] returned, so those closing events arrived AFTER the marker —
     * and during a controller shutdown the collector was already stopped by
     * then, so they were dropped outright.
     *
     * Implement this instead of [detach] when teardown is asynchronous, and
     * invoke [onComplete] EXACTLY ONCE, on whatever thread finishes the
     * teardown, after the last event this integration will ever emit. The
     * controller emits `player_detach` from that callback, and
     * `VitalsController.shutdown()` waits (briefly, bounded) for it before it
     * stops the collector. Never invoking it costs the `player_detach` marker
     * and one bounded wait at shutdown — never a hang.
     *
     * The default implementation is the synchronous one, so an existing
     * integration that only overrides [detach] keeps working unchanged.
     */
    fun detach(onComplete: () -> Unit) {
        try {
            detach()
        } finally {
            onComplete()
        }
    }
}

/**
 * Codex round-3, E2 — the difference between a TERMINAL disposal and a transient ATTACHMENT
 * ROLLBACK. Twin of `PlayerIntegration.swift`'s `AttachRollback` protocol.
 *
 * [VitalsController.trackPlayer] runs `attach()` BEFORE it publishes the registration, and the
 * publication can still be refused when that controller shut down in between. That refusal is
 * transient: `VitalsRuntime` retries THE SAME INTEGRATION against the next controller. The
 * rollback used to be a plain `detach()`, which is the wrong verb for it — a terminal teardown
 * throws away state the retry needs. For [RemotePlayerIntegration] that state is the HOST MODEL:
 * `detach()` clears `playing`/`buffering` (round-1, C1 made it close its spans), so the retry
 * announced the player into the next controller with no open spans and uninterrupted playback
 * went unmeasured. On iOS the same seam also protects the AVPlayer release hook, which
 * `attach()` never reinstalls.
 *
 * Deliberately NOT on [PlayerIntegration]: only an integration that holds state ACROSS an
 * attachment — installed before `attach()`, or fed in from outside like the RN bridge's model —
 * can tell the two apart, and the SDK's own are the only ones that do. A customer integration
 * builds everything in `attach()`, for which the terminal `detach()` is already right; not
 * implementing this leaves that behaviour exactly as it was.
 *
 * `internal`, like the Swift twin: [VitalsController] is the only caller, and a customer's
 * integration cannot implement it. [RemotePlayerIntegration] is public and implements it anyway
 * — a public class may carry an internal supertype; only its own public signatures are barred
 * from naming one, and none of them does.
 */
internal interface AttachRollback {
    /**
     * Undo `attach()`, keeping everything that was there before it. A terminal `detach()` still
     * follows on every path that ends the registration for good (revocation, cancellation, a
     * later `kill()`), so nothing is left subscribed if the retry never happens.
     */
    fun rollbackAttach()
}

interface PlayerHandle {
    val id: String
    /** Player-scoped custom entry (`trackVitals` with this player). */
    fun track(name: String, data: Any? = null)
    /** Emits player_detach, frees the registration. Idempotent; a stale handle is a no-op. */
    fun detach()
}
