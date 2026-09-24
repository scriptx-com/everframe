// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Live preview + shot stash for companion (spec 2026-07-17 §3).
//
// One wire contract answers three kinds of device (web/iOS/Android), and the
// phone cannot tell which it is talking to — but as of this file, no web or
// iOS counterpart to this specific class exists in this codebase yet (an
// earlier revision of this comment claimed one did; false — see task-11
// review round 2). Do not cite either as a reference implementation until
// one actually ships.
//
// THE RULE THAT MATTERS MOST (task-11-brief.md): a preview must never
// outlive the thing that authorised it. Four triggers stop it — explicit
// `preview.stop` (-> stopSilently(), routed from RelayWSClient so the peer
// that just told us to stop is never echoed a stop back), the 2-minute
// device-side cap (-> stop(TIME_CAP)), phone disconnect and pair expiry
// (both -> stopSilently() + clearStash(), routed from RelayWSClient). Two
// MORE triggers were found missing by task-11 review round 2 and are now
// wired from RelayWSClient too: the client's own full teardown (-> teardown(),
// permanent) and the process backgrounding (-> stopSilently() + clearStash(),
// resumable — the same client instance reconnects on foreground). A device
// that keeps reading the user's screen after the session ended is the
// failure this whole feature's privacy budget exists to prevent.
package dev.everframe.companion

import dev.everframe.protocol.generated.PreviewFrame
import dev.everframe.protocol.generated.PreviewStop
import dev.everframe.protocol.generated.RelayMessage
import dev.everframe.protocol.generated.ShotAssembled
import dev.everframe.protocol.generated.ShotFailed
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Authorisation epoch for companion capture — the Kotlin twin of iOS's
 * `CompanionAuthEpoch`, and needed for the same reason on a different
 * mechanism.
 *
 * Coroutine cancellation is COOPERATIVE: once `captureShot()` returns, the
 * header+binary sequence that follows contains no suspension point, so a
 * `cancel()` arriving after that last suspension cannot stop it. A rapid
 * re-bond could therefore deliver the previous phone's report-grade
 * screenshot to a different phone. `RelayWSClient` bumps this the moment
 * authorisation ends, and the send checks it.
 */
/**
 * Live-preview default for production sessions — OFF everywhere (product call
 * 2026-08-27), matching the web SDK's `capture-profile.ts` `livePreview`.
 */
internal const val LIVE_PREVIEW_ENABLED: Boolean = false

internal object CompanionAuthEpoch {
    @Volatile
    private var value: Long = 0

    @Synchronized
    fun invalidate() { value++ }

    val current: Long get() = value
}

/**
 * Serializes every outbound sequence whose binary frames belong to the header
 * that preceded them.
 *
 * Both the relay and the phone frame binaries as "the next one belongs to the
 * latest header", so ANY interleave between two such sequences mis-assigns
 * bytes. The preview loop and the shot path already shared one dispatcher, but
 * `CompanionCaptureBridge` writes `report.assembled` + screenshot
 * straight from the WebSocket reader thread — a different thread entirely. A
 * preview frame landing between that header and its screenshot could install a
 * low-resolution preview as the report's primary evidence, or drop the real
 * screenshot. The single-dispatcher guarantee only ever covered one of the two
 * senders; this lock covers both.
 *
 * Hold it for the WHOLE sequence, never per frame.
 */
internal object CompanionWireLock {
    private val lock = Any()
    fun <T> framed(body: () -> T): T = synchronized(lock) { body() }
}

/** [mime] travels with the bytes so nothing downstream has to guess or hardcode an encoding. */
data class PreviewCapture(val bytes: ByteArray, val width: Int, val height: Int, val mime: String) {
    override fun equals(other: Any?): Boolean =
        other is PreviewCapture && bytes.contentEquals(other.bytes) &&
            width == other.width && height == other.height && mime == other.mime
    override fun hashCode(): Int = ((bytes.contentHashCode() * 31 + width) * 31 + height) * 31 + mime.hashCode()
}

data class NormalizedRect(val x: Double, val y: Double, val w: Double, val h: Double)

/**
 * Wire values for `preview.stop`'s `reason` — `packages/protocol/src/relay/messages.ts`'s
 * `PreviewStop` schema is `reason: z.enum(['user', 'time_cap', 'capture_unavailable'])`.
 * An unconstrained `String` here (round-1 shape) can send an off-enum reason,
 * which the relay treats as a malformed frame and closes the socket 4006 for
 * — found by task-11 review round 2.
 */
enum class PreviewStopReason(val wireValue: String) {
    USER("user"),
    TIME_CAP("time_cap"),
    CAPTURE_UNAVAILABLE("capture_unavailable"),
}

/**
 * The subset of [CompanionPreviewSession] `RelayWSClient` depends on.
 * Extracted (task-11 review round 2) so `RelayWSClientTest` can inject a
 * recording double and assert the ROUTING is correct — which frame type
 * calls which method, with which arguments — without driving the real
 * capture loop's async timing through Robolectric.
 */
interface CompanionPreviewSessionApi {
    val isRunning: Boolean
    fun start(correlationId: String)
    fun stop(reason: PreviewStopReason)
    fun stopSilently()
    fun clearStash()
    fun clearStashFor(correlationId: String)
    fun requestShot(correlationId: String, shotId: String, rect: NormalizedRect?)

    /**
     * Permanent shutdown — cancels the underlying scope so no future
     * `start()`/`requestShot()` can ever launch again. Only for a `RelayWSClient`
     * that is itself being torn down for good (`stop()`); the resumable
     * background case uses [stopSilently] + [clearStash] instead, because the
     * SAME client (and therefore the same session) reconnects on foreground.
     */
    fun teardown()
}

class CompanionPreviewSession(
    private val send: (RelayMessage) -> Unit,
    private val sendBinary: (ByteArray) -> Unit,
    /** 2 fps loop capture — low-res (spec: ~480p JPEG q~60), never used for a shot. */
    private val capturePreview: suspend () -> PreviewCapture?,
    /**
     * Shot-stash capture — REPORT grade: the same shaping as the report's own
     * screenshot (PNG, longest edge capped at `ScreenshotCapture.MAX_EDGE_PX`),
     * not the preview's ~854px JPEG.
     *
     * A SEPARATE seam from [capturePreview] (task-11 review round 2,
     * IMPORTANT 4): reusing one seam for both silently shipped preview-grade
     * pixels as report evidence, mislabeled with a hardcoded mime.
     *
     * Named `captureShot` rather than `captureFull` since the task-11b review
     * (finding 4): every caller routes to the 2048-capped path, so "full"
     * described something that has never existed here. The cap is deliberate —
     * a shot is evidence attached to a report and should match the primary
     * screenshot — but the old name invited the next port to build an uncapped
     * path chasing a promise the Android side does not make.
     */
    private val captureShot: suspend () -> PreviewCapture?,
    private val crop: (PreviewCapture, NormalizedRect) -> PreviewCapture = ::defaultCrop,
    private val intervalMs: Long = 500,
    private val maxDurationMs: Long = 120_000,
    /**
     * Live-preview master switch, default OFF (product call 2026-08-27):
     * every frame is a full screen capture — a continuous CPU tax on the
     * device for a nice-to-have viewfinder, felt hardest on TVs. `start()`
     * still authorizes the shot stash and then declines with
     * `capture_unavailable`; the phone shows its standard "live view
     * unavailable" fallback and single-shot capture keeps working. The loop
     * machinery stays proven under tests so re-enabling is this one flag.
     */
    private val livePreviewEnabled: Boolean = LIVE_PREVIEW_ENABLED,
    /**
     * Wall-clock source for the 2-minute cap. Defaults to the real clock;
     * tests inject a fake advanced in lockstep with capture calls (mirrors
     * `ReplaySessionRefreshLoopTest`'s `clock: () -> Long` seam in this same
     * module). Round-1 shape counted TICKS (`elapsed += intervalMs`), which
     * ignores capture duration entirely — a slow `capturePreview`/`captureShot`
     * call let the cap overrun by the total accumulated capture cost
     * (task-11 review round 2, IMPORTANT 5).
     */
    private val nowMs: () -> Long = { System.currentTimeMillis() },
    /**
     * Single dispatcher for EVERYTHING this session sends. Both the loop's
     * `preview.frame` + binary pair and [requestShot]'s `shot.assembled` +
     * binary pair funnel through here. That single-dispatcher property is
     * what makes each header+binary pair atomic: neither `send`+`sendBinary`
     * call pair ever suspends between the two calls, so on ONE dispatcher
     * (whether that's the real Android main thread or a test's
     * single-threaded `TestDispatcher`) no other coroutine on this scope can
     * interpose a frame between a header and its own binary. Round-1 shape
     * ran the loop here but `handleShotRequest` on a SEPARATE `Dispatchers.IO`
     * scope owned by `RelayWSClient` — a `shot.assembled` could land between
     * a `preview.frame` header and ITS binary, delivering preview JPEG bytes
     * into the phone's `await-shot` slot (task-11 review round 2, CRITICAL 3
     * — the phone's own comment calls that the single worst outcome in that
     * file).
     */
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.Main + SupervisorJob()),
) : CompanionPreviewSessionApi {
    private var job: Job? = null
    private var correlationId: String? = null
    private var seq = 0

    /** Report-grade captures keyed by shot_id; a known id is re-cropped, never re-captured. */
    private val stash = mutableMapOf<String, PreviewCapture>()

    /**
     * Hard ceiling on distinct shot_ids held for one report cycle — a bound on
     * DEVICE MEMORY, deliberately NOT the same number as the submit ceiling.
     *
     * `report.submit.shots` is capped at 3 (what ingest accepts: envelope + 5
     * file slots, minus the primary screenshot and the session replay). Making
     * the stash 3 as well looked tidy and was wrong: the phone can capture
     * three, DELETE one and capture a replacement, which is four distinct ids
     * for three submitted shots. Every replacement was then refused
     * `too_many_shots` with no way to recover, because a removal is phone-local
     * and no protocol frame releases a device-side slot.
     *
     * Eight leaves room for that churn while still bounding the map — without
     * it a peer looping over fresh ids grew it without limit, each entry a
     * report-grade PNG of the user's screen.
     */
    private val maxStashedShots = 8

    /**
     * Shot ids whose capture is in flight right now.
     *
     * Reserved BEFORE `captureShot()` suspends, so the cap counts work in
     * progress as well as work already stashed, and released once the shot
     * finishes.
     */
    private val inFlightShotIds = java.util.Collections.synchronizedSet(mutableSetOf<String>())

    /**
     * Which correlation id — i.e. which report cycle — the [stash] belongs to.
     *
     * This is what reconciles task-11 review round 2's IMPORTANT 7 with the
     * carried follow-up F1, which pull in opposite directions:
     *
     *  - IMPORTANT 7: a capture must not survive into a LATER, UNRELATED
     *    session and be re-croppable there. Real, and the reason the stash is
     *    cleared at all.
     *  - F1: the phone sends `preview.stop` immediately after EVERY snap, so
     *    clearing on the preview loop stopping meant no shot ever outlived the
     *    preview that produced it. A later re-crop would MISS, silently
     *    re-capture the CURRENT screen, and announce it under the original
     *    shot's id.
     *
     * Both hold once "unrelated" is read the way the wire actually expresses
     * it: a new report cycle carries a NEW correlation id. So the stash is
     * scoped to the correlation id rather than to the loop's lifetime — it
     * survives any number of stop/start cycles within one report, and is
     * dropped the moment a different report cycle begins (plus on
     * [clearStash] and [teardown]).
     */
    private var stashCorrelationId: String? = null

    /**
     * Drops the stash if [correlationId] belongs to a different report cycle
     * than the one it was captured for. Called from every entry point that can
     * introduce a correlation id — [start] and [handleShotRequest] — because a
     * shot can legitimately arrive without a preview ever having run.
     */
    private fun adoptStashCorrelation(correlationId: String) {
        if (stashCorrelationId != null && stashCorrelationId != correlationId) {
            stash.clear()
            previewAuthorizedForStash = false
        }
        stashCorrelationId = correlationId
    }

    /**
     * Whether `start()` has been called for [stashCorrelationId] at some point
     * since it was last adopted — irrespective of whether that preview is
     * still RUNNING right now. Gates a FRESH capture (an unknown `shot_id`) in
     * [handleShotRequest]: a re-crop of a KNOWN id is exempt (see `known`
     * there), since that is the documented re-crop contract, not a new
     * capture.
     *
     * Finding A (companion-window-polish codex review round 2): round-1 shape
     * of this fix accepted `shot.request` unconditionally — no preview or
     * report needed at all. Combined with the stash being scoped to a
     * peer-chosen `correlationId` (see [stashCorrelationId]), rotating the id
     * cleared the stash and reset the eight-shot ceiling every time, and
     * because the on-device "Sharing screen" indicator that used to sit in
     * this exact path was deliberately removed (see the companion-window-polish
     * CHANGELOG entry — NOT reintroduced here), that unlimited pull was also
     * silent.
     *
     * Deliberately NOT `isRunning` at check-time: the web client's `snapShot`
     * sends `shot.request` and then IMMEDIATELY `preview.stop` under the same
     * correlation id (see `ReporterSurface.tsx`'s `snapShot`/`closePreview`),
     * and both frames are processed on the SAME reader thread the loop's own
     * job hangs off of — so a real, legitimate request can arrive (or start
     * executing on [scope]) after `preview.stop` has already cancelled the
     * job and nulled [correlationId]. Gating on "was this id EVER started",
     * not "is it running THIS INSTANT", is what survives that ordering.
     * Cleared only where [stashCorrelationId] itself resets — an id change
     * (above), [clearStash] (pair loss / backgrounding), and [teardown] — so
     * a NEW pairing must send a fresh `preview.start` before it can pull a
     * fresh capture, exactly like a legitimate client already does.
     */
    private var previewAuthorizedForStash = false

    override val isRunning: Boolean get() = job?.isActive == true

    override fun start(correlationId: String) {
        adoptStashCorrelation(correlationId)
        // Starting IS the authorization event a fresh capture is gated on —
        // see [previewAuthorizedForStash]. Set unconditionally (even on the
        // idempotent same-id branch below) rather than only on a genuine
        // (re)start, so a repeat `preview.start` for an id already authorized
        // is a harmless no-op here too.
        previewAuthorizedForStash = true
        if (!livePreviewEnabled) {
            // Declined AFTER the stash authorization above — the phone's
            // add-shot flow still gets single-shot captures, just no stream.
            send(PreviewStop(correlationId = correlationId, reason = PreviewStopReason.CAPTURE_UNAVAILABLE.wireValue))
            return
        }
        if (isRunning) {
            // Same id: already running this exact preview — idempotent (see
            // the loop's own comment below). A DIFFERENT id means a new
            // report cycle started while an old one was still live; round-1
            // shape's bare `if (isRunning) return` silently kept the OLD
            // loop running under the OLD id forever, so every frame it kept
            // emitting failed the phone's correlation-id filter and the
            // preview looked dead until the cap (task-11 review round 2,
            // IMPORTANT 6). Cancel the stale run and restart under the new
            // identity instead of ignoring the request.
            if (this.correlationId == correlationId) return
            cancelInternal()
        }
        this.correlationId = correlationId
        seq = 0
        val startedAt = nowMs()
        // The loop is bound to the epoch as of when the phone asked, not just
        // to the boolean gate: kill() lowers the gate and a later start()
        // raises it again, so a tick suspended across both never observes
        // `false`. The epoch is monotonic and cannot be resurrected.
        val authAtStart = CompanionAuthEpoch.current
        job = scope.launch {
            // Cap check BEFORE the interval delay so the very first tick
            // still happens promptly, and re-checked using [nowMs] AFTER
            // each full delay+capture cycle — the wall-clock fix for
            // IMPORTANT 5 above.
            while (nowMs() - startedAt < maxDurationMs) {
                delay(intervalMs)
                try {
                    // DEFE-03 kill switch. `kill()` closes the capture gate but
                    // leaves this client and session alive, so without this the
                    // loop kept reading the user's screen for up to two minutes
                    // AFTER the host invoked the emergency stop — the one
                    // control that must beat everything else.
                    if (!dev.everframe.Everframe.captureGate ||
                        CompanionAuthEpoch.current != authAtStart
                    ) {
                        stop(PreviewStopReason.CAPTURE_UNAVAILABLE)
                        return@launch
                    }
                    val frame = capturePreview() ?: throw IllegalStateException("capture_unavailable")
                    // Re-checked AFTER the capture: `capturePreview()` suspends,
                    // and a kill() landing inside that window would otherwise
                    // still put the bytes it produced on the wire.
                    if (!dev.everframe.Everframe.captureGate ||
                        CompanionAuthEpoch.current != authAtStart
                    ) {
                        stop(PreviewStopReason.CAPTURE_UNAVAILABLE)
                        return@launch
                    }
                    val corrId = this@CompanionPreviewSession.correlationId
                    if (corrId != null) {
                        // One sequence, one lock — see [CompanionWireLock].
                        CompanionWireLock.framed {
                            send(
                                PreviewFrame(
                                    correlationId = corrId,
                                    height = frame.height.toLong(),
                                    mime = frame.mime,
                                    seq = seq.toLong(),
                                    width = frame.width.toLong(),
                                ),
                            )
                            seq++
                            sendBinary(frame.bytes)
                        }
                    }
                } catch (t: Throwable) {
                    stop(PreviewStopReason.CAPTURE_UNAVAILABLE)
                    return@launch
                }
            }
            stop(PreviewStopReason.TIME_CAP)
        }
    }

    /** Explicit stop — announces `preview.stop` with [reason] to the peer. */
    override fun stop(reason: PreviewStopReason) {
        val corrId = correlationId
        if (!cancelInternal()) return
        corrId?.let { send(PreviewStop(correlationId = it, reason = reason.wireValue)) }
    }

    /**
     * Same cancel-and-clear body as [stop], without the outbound frame.
     * Used when the STOP itself originated from the peer (`preview.stop`,
     * so echoing one back would be nonsensical) or from a signal that means
     * nobody is left to receive frames at all (`phone.disconnected`,
     * `pair.expired`, process backgrounding) — sending a frame into that
     * void is pointless and the relay may already have torn down the route.
     */
    override fun stopSilently() {
        cancelInternal()
    }

    /**
     * Cancels the running job and clears the live session state. Returns false
     * (no-op) if nothing was running.
     *
     * Does NOT clear the stash. Round-1 shape left the stash untouched here,
     * so a report-grade screen capture survived `preview.stop` and even
     * `time_cap` indefinitely, available to re-crop on a LATER, unrelated
     * preview session for the same pair (task-11 review round 2, IMPORTANT 7).
     * Clearing it here over-corrected: the phone sends `preview.stop`
     * immediately after EVERY snap, so no stashed shot ever outlived the
     * preview that produced it, and a later re-crop would MISS the stash,
     * re-capture whatever was on screen at that moment, and announce those
     * pixels under the original shot's id (carried follow-up F1).
     *
     * The privacy intent is kept by clearing on the triggers that actually
     * mean the pairing is over, rather than on the preview loop stopping:
     * [clearStash] — which `RelayWSClient` already calls explicitly alongside
     * [stopSilently] for `phone.disconnected`, `pair.expired` and
     * backgrounding — and [teardown].
     */
    private fun cancelInternal(): Boolean {
        val wasRunning = job != null
        job?.cancel()
        job = null
        // Shots are NOT cancelled here. The phone's snap flow sends
        // `shot.request` and then `preview.stop` immediately — so cancelling
        // in-flight shots on an ordinary stop cancels the very capture the
        // user just asked for, and an ordinary snap never produces
        // `shot.assembled` at all. Authorisation-loss paths ([teardown],
        // pair loss) cancel them via [cancelShots]; a preview ending does not.
        correlationId = null
        return wasRunning
    }

    override fun clearStash() {
        // Pair loss / backgrounding routes here: the authorisation is gone, so
        // any capture still running must stop with it.
        cancelShots()
        stash.clear()
        stashCorrelationId = null
        previewAuthorizedForStash = false
    }

    /**
     * Clears the stash only if it belongs to [correlationId].
     *
     * Correlation-scoped on purpose: a submit deliberately outlives the bond
     * that started it, so a SUPERSEDED report can finish while a newer one is
     * already live (PR-fix 7). An unconditional clear there would drop the live
     * report's captures.
     */
    override fun clearStashFor(correlationId: String) {
        if (stashCorrelationId == correlationId) clearStash()
    }

    /**
     * Fire-and-forget entry point for `RelayWSClient` — launches
     * [handleShotRequest] on THIS session's own [scope], which is what
     * gives the header+binary atomicity guarantee documented on [scope]
     * above. `RelayWSClient` must call this, never spin up its own separate
     * scope to run [handleShotRequest] on (that separate-scope shape was
     * CRITICAL 3 and, together with never cancelling that scope, half of
     * CRITICAL 2).
     */
    override fun requestShot(correlationId: String, shotId: String, rect: NormalizedRect?) {
        // Read HERE, when the phone asked — not inside the coroutine, which may
        // not start until after authorisation has already ended.
        val authAtRequest = CompanionAuthEpoch.current
        // Tracked, so a stop actually stops it. `cancelInternal()` used to
        // cancel only the preview [job]; a shot launched here outlived it and
        // kept capturing after the preview stopped. The phone's own flow —
        // `shot.request` immediately followed by `preview.stop` — hits that
        // ordering every single time.
        val handle = scope.launch { handleShotRequest(correlationId, shotId, rect, authAtRequest) }
        shotJobs += handle
        handle.invokeOnCompletion { shotJobs -= handle }
    }

    /** In-flight shot captures, cancelled with the preview — see [requestShot]. */
    private val shotJobs = java.util.Collections.synchronizedSet(mutableSetOf<Job>())

    /**
     * [correlationId] is the id carried on the INCOMING `shot.request` frame
     * itself, not read from this session's own live state. Round-1 shape
     * read `this.correlationId ?: this.lastCorrelationId ?: return` — and
     * `lastCorrelationId` was never assigned by any production code path, so
     * a `shot.request` that arrived (or was still being handled on this
     * session's own scope) after `this.correlationId` had already been
     * nulled by a `preview.stop` handled synchronously on the WS reader
     * thread — a real, demonstrated ordering: the phone's snapshot flow
     * sends `shot.request` then immediately `preview.stop` — silently
     * dropped the shot: no `shot.assembled`, no `shot.failed`, the phone's
     * shot stranded at `pending` with no way to retry it (task-11 review
     * round 2, CRITICAL 1). `lastCorrelationId` has been deleted entirely
     * rather than assigned somewhere — every caller already has the right id
     * in hand (the message that triggered the call), so there is nothing for
     * a fallback field to usefully cover.
     */
    suspend fun handleShotRequest(correlationId: String, shotId: String, rect: NormalizedRect?) =
        handleShotRequest(correlationId, shotId, rect, CompanionAuthEpoch.current)

    /** [authAtRequest] is the epoch as of when the phone asked — see [requestShot]. */
    suspend fun handleShotRequest(
        correlationId: String,
        shotId: String,
        rect: NormalizedRect?,
        authAtRequest: Long,
    ) {
        var reserved = false
        try {
            // DEFE-03 kill switch — see the loop above. A shot is the most
            // sensitive capture this session takes; it must not survive kill().
            if (!dev.everframe.Everframe.captureGate) {
                send(ShotFailed(correlationId = correlationId, reason = "capture_unavailable", shotId = shotId))
                return
            }
            adoptStashCorrelation(correlationId)
            // A KNOWN id re-crops from the stash and is always allowed — the cap
            // governs how many distinct captures are held, not how often each
            // is re-cropped.
            // The cap counts captures ALREADY held plus those being taken right
            // now. `captureShot()` suspends, and the stash is only written
            // afterwards, so counting `stash.size` alone let a burst of
            // requests all read the same empty stash and launch an unbounded
            // number of report-grade captures — the ceiling existed but never
            // bound anything under concurrency. The id is reserved BEFORE the
            // suspension and released in the `finally`.
            // A DUPLICATE id already being captured is refused outright. The
            // reservation is a Set, so two concurrent requests for one id both
            // passed the cap (it counted one), each launched its own PixelCopy
            // + PNG encode, and the first to finish removed the shared id
            // while the other was still reading the screen. Coalescing is not
            // possible here without a promise per id; refusing is, and the
            // phone never legitimately re-requests an id whose capture is
            // still outstanding.
            if (inFlightShotIds.contains(shotId)) {
                send(ShotFailed(correlationId = correlationId, reason = "shot_in_flight", shotId = shotId))
                return
            }
            val known = stash.containsKey(shotId)
            if (!known) {
                // Finding A: a FRESH capture (unknown shot_id) must not
                // proceed unless a preview was authorised for this exact
                // correlation id at some point — see [previewAuthorizedForStash]
                // for what "authorised" means and why it does not require the
                // preview to still be running right now. A known id re-crops
                // from the stash above and is exempt: that is the documented
                // contract, not a new capture, and must keep working even
                // long after the authorising preview stopped.
                if (!previewAuthorizedForStash) {
                    send(ShotFailed(correlationId = correlationId, reason = "no_active_session", shotId = shotId))
                    return
                }
                if (stash.size + inFlightShotIds.size >= maxStashedShots) {
                    send(ShotFailed(correlationId = correlationId, reason = "too_many_shots", shotId = shotId))
                    return
                }
            }
            reserved = inFlightShotIds.add(shotId)
            val source = stash.getOrPut(shotId) {
                captureShot() ?: throw IllegalStateException("capture_unavailable")
            }
            // Re-checked AFTER the capture, for the same reason as the loop:
            // a kill() inside the suspension must not ship the pixels it
            // produced, and a shot is the most sensitive capture here.
            if (!dev.everframe.Everframe.captureGate) {
                stash.remove(shotId)
                send(ShotFailed(correlationId = correlationId, reason = "capture_unavailable", shotId = shotId))
                return
            }
            // Coroutine cancellation is cooperative and there is no suspension
            // point left between here and the wire, so a cancel arriving after
            // the capture cannot stop the send. This is the check that can.
            if (CompanionAuthEpoch.current != authAtRequest) {
                stash.remove(shotId)
                return
            }
            val out = if (rect == null) source else crop(source, rect)
            CompanionWireLock.framed {
                send(
                    ShotAssembled(
                        correlationId = correlationId,
                        height = out.height.toLong(),
                        mime = out.mime,
                        shotId = shotId,
                        size = out.bytes.size.toLong(),
                        width = out.width.toLong(),
                    ),
                )
                sendBinary(out.bytes)
            }
        } catch (t: Throwable) {
            // Scoped to this shot — never ReportFailed.
            send(ShotFailed(correlationId = correlationId, reason = t.message ?: "capture_failed", shotId = shotId))
        } finally {
            if (reserved) inFlightShotIds.remove(shotId)
        }
    }

    /** Cancels in-flight shot captures — for authorisation loss only. */
    private fun cancelShots() {
        synchronized(shotJobs) { shotJobs.toList() }.forEach { it.cancel() }
        shotJobs.clear()
    }

    override fun teardown() {
        cancelShots()
        cancelInternal()
        // Explicit, because cancelInternal() deliberately no longer clears it
        // (see its doc). A permanent teardown is exactly the trigger that
        // should: report-grade pixels of the user's screen must not outlive
        // the client that was authorised to hold them.
        stash.clear()
        stashCorrelationId = null
        previewAuthorizedForStash = false
        scope.cancel()
    }
}

/**
 * Denormalizes [rect] against [source]'s own pixel dimensions, re-encodes,
 * and PRESERVES [source]'s mime (task-11 review round 2, IMPORTANT 4) rather
 * than forcing a fixed output format — a full-resolution stash capture might
 * be PNG or JPEG depending on what [CompanionPreviewSession]'s `captureShot`
 * seam actually produced, and a crop of it must not silently relabel it.
 * Falls back to WebP only when [source]'s mime isn't one `Bitmap.CompressFormat`
 * already knows how to write.
 */
private fun defaultCrop(source: PreviewCapture, rect: NormalizedRect): PreviewCapture {
    val bitmap = android.graphics.BitmapFactory.decodeByteArray(source.bytes, 0, source.bytes.size)
        ?: return source
    val x = (rect.x * bitmap.width).toInt().coerceIn(0, maxOf(0, bitmap.width - 1))
    val y = (rect.y * bitmap.height).toInt().coerceIn(0, maxOf(0, bitmap.height - 1))
    val w = (rect.w * bitmap.width).toInt().coerceIn(1, bitmap.width - x)
    val h = (rect.h * bitmap.height).toInt().coerceIn(1, bitmap.height - y)
    val cropped = android.graphics.Bitmap.createBitmap(bitmap, x, y, w, h)
    val out = java.io.ByteArrayOutputStream()
    val format = when (source.mime) {
        "image/png" -> android.graphics.Bitmap.CompressFormat.PNG
        "image/jpeg" -> android.graphics.Bitmap.CompressFormat.JPEG
        "image/webp" -> if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
            android.graphics.Bitmap.CompressFormat.WEBP_LOSSY
        } else {
            @Suppress("DEPRECATION")
            android.graphics.Bitmap.CompressFormat.WEBP
        }
        else -> if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
            android.graphics.Bitmap.CompressFormat.WEBP_LOSSY
        } else {
            @Suppress("DEPRECATION")
            android.graphics.Bitmap.CompressFormat.WEBP
        }
    }
    val quality = if (source.mime == "image/png") 100 else 90
    cropped.compress(format, quality, out)
    return PreviewCapture(out.toByteArray(), cropped.width, cropped.height, source.mime)
}
