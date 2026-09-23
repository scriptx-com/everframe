// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// One AnalyticsListener → the vitals player vocabulary (spec 2026-09-05 §3).
// Never an entry per segment load. Player state is read on the player's
// application thread only (`postOnPlayerThread`).
//
// Codex round-9, #2 — so is every ATTACHMENT-state write. `attached`, `ctx`
// and `keepSourceQuery` are written inside `attach()`'s posted runnable and
// inside `closeAndTearDown()`, never on the thread that called `attach()` or
// `detach()`. That single-writer looper is what makes an attach that is
// retried against a replacement controller land AFTER the refused
// attachment's queued teardown instead of being erased by it.
package dev.everframe.media3

import android.os.Handler
import android.util.Log
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaLibraryInfo
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.source.LoadEventInfo
import androidx.media3.exoplayer.source.MediaLoadData
import dev.everframe.vitals.PlayerIntegration
import dev.everframe.vitals.PlayerIntegrationContext
import dev.everframe.vitals.PlayerSnapshot
import dev.everframe.vitals.StartupTimings
import dev.everframe.vitals.protocolForMime
import dev.everframe.vitals.sanitizeSource
import dev.everframe.vitals.wire.PlayerEventTypes
import java.io.IOException

@UnstableApi
class Media3Integration internal constructor(
    private val facade: Media3PlayerFacade,
    /**
     * Codex round-1, Important 13 — a PROVIDER, resolved once at [attach]
     * time and cached in [keepSourceQuery]. Resolving it at
     * `trackPlayer()` call time froze `false` for every registration made
     * before `start()` or after `kill()` (there is no current configuration
     * then), so a queued player drained into a later controller whose config
     * DID enable the option silently kept stripping the query string for the
     * rest of its life. `attach()` runs at drain time, under the owning
     * controller's configuration.
     */
    private val captureSourceQuery: () -> Boolean,
    /**
     * Codex round-2, Important 10 — returns whether the runnable was ACCEPTED
     * (`Handler.post` answers false once the looper is quitting). A rejected
     * post used to be indistinguishable from a successful one, so `attach()`
     * reported success for a player whose analytics listener was never
     * installed: it stayed registered forever, announced on every rotation and
     * snapshotted on every tick, with no `onPlayerReleased` ever coming to
     * unregister it.
     */
    private val postOnPlayerThread: (Runnable) -> Boolean,
    private val now: () -> Long,
) : PlayerIntegration {
    override val library = "media3"
    override val version: String = MediaLibraryInfo.VERSION

    /**
     * Codex round-9, #2 — PLAYER-THREAD-ONLY writes, together with [attached]
     * and [keepSourceQuery]. `@Volatile` for the reads that come from other
     * threads (`snapshot()` on the sampler thread, `describe()`/`detach()` on
     * whatever thread the controller uses); the WRITES happen only inside
     * [attach]'s posted runnable and inside [closeAndTearDown], which is
     * itself posted (or runs on a dead looper, where nothing can race it).
     *
     * That is the whole of the round-9 fix. `attach()` used to assign `ctx`
     * and `attached` synchronously on the caller's thread and only POST the
     * subscription and the seed. When a controller shutdown refusal made
     * `VitalsRuntime` retry the SAME integration against a replacement
     * controller, the refusal's `integration.detach()` had merely QUEUED its
     * `closeAndTearDown`; the replacement's `attach()` then wrote the new
     * `ctx` on the caller thread and the queued teardown promptly cleared it.
     * The handle looked attached, and every later playback and error callback
     * vanished from both the timeline and the summary. Writing the whole
     * transition inside the posted runnable makes it serialize FIFO on the
     * player looper BEHIND that teardown, so the replacement's context is the
     * last thing written and survives.
     */
    @Volatile private var ctx: PlayerIntegrationContext? = null
    @Volatile private var keepSourceQuery: Boolean = false

    // Written on the player thread, read on the sampler thread by snapshot(); volatile for
    // visibility — each is replaced, never mutated.
    @Volatile private var attached = false
    @Volatile private var lastSource: Map<String, Any?>? = null
    @Volatile private var lastDrm: Map<String, Any?>? = null
    /**
     * Final review, I1: `snapshot()` used to refuse whenever `lastSource` was
     * null, and `lastSource` was only ever set by `onMediaItemTransition` —
     * so a player attached AFTER its first media item never reported stats at
     * all. `attach()` now seeds `lastSource` from the facade, and this flag is
     * the second half of the fix: a player that is already playing reports
     * stats even if the seed could not name a source.
     */
    @Volatile private var playing = false

    /**
     * Codex round-2, Important 11. Set whenever a `play` has been emitted and
     * not yet closed by a `pause`. `attach()`'s seed emits `play` for a player
     * that is ALREADY playing — Media3 does not replay
     * `onIsPlayingChanged(true)` just because a listener was added, so
     * playtime stayed zero until the next real transition, which for an
     * uninterrupted playback is never — and this latch is what stops a real
     * `onIsPlayingChanged(true)` arriving afterwards from opening the span a
     * second time. A real `false` clears it.
     */
    @Volatile private var playEmitted = false

    // per media item
    private var itemStartedAt: Long? = null
    private var manifestMs: Long? = null
    private var firstFragmentMs: Long? = null
    private var firstFrameSeen = false

    // buffering. `@Volatile` (I10/I11): written on the player thread, read by
    // `describe()` (rotation reseed, any thread) and by `detach()` (the
    // controller's thread), both of which have to see an open span.
    @Volatile private var bufferStartAt: Long? = null

    /**
     * Task 15 wires this to the handle's detach(); fired once from
     * onPlayerReleased. `@Volatile` (M3): it is written by `trackPlayerWith`
     * on the caller's thread and read/cleared on the player's analytics
     * thread.
     */
    @Volatile internal var onReleased: (() -> Unit)? = null

    /**
     * Codex round-8, #1 — the DECLARATION-TIME release observer, or null.
     * Installed by [observeRelease] and taken off by [closeAndTearDown],
     * which every teardown path funnels through.
     *
     * An `AtomicReference` rather than a `@Volatile` field because both ends
     * are compare-and-set: the install must not subscribe twice, and the
     * removal must not run twice for one subscription. It is written on the
     * declaring thread ([observeRelease] runs on whatever thread called
     * `trackPlayer()`) and cleared on the player thread.
     */
    private val releaseObserver = java.util.concurrent.atomic.AtomicReference<AnalyticsListener?>(null)

    private var lastFormatKey: String? = null
    /**
     * Codex round-3, Important 8 — the "a real `onDrmKeysLoaded` has already
     * been handled for this item" latch, distinct from `lastDrm` being
     * non-null. `attach()`'s seed and `onFirstFrame()` both SEED `lastDrm`
     * (from the media item's declared scheme, or `{keySystem: "none"}`), and
     * the old guard keyed on that seed: the first real keys-loaded callback
     * then bailed out, so the measured `licenseMs` was never emitted and
     * startup permanently omitted it for every DRM stream the SDK attached to
     * before its keys loaded. Per media item — reset in [onItem].
     */
    private var keysLoadedHandled = false
    private var drmAcquiredAt: Long? = null
    private var licenseMs: Long? = null
    private var drmKeySystem: String? = null
    private var bandwidthEstimate: Long? = null
    /**
     * Codex round-2, Important 12 — CUMULATIVE, never zeroed. `snapshot()`
     * reports `droppedTotal - droppedReported` and only advances
     * [droppedReported] once the controller says it recorded the result.
     * Zeroing at read time lost the delta whenever the controller then
     * rejected the snapshot (a detach or a replaced collector), and zeroing on
     * a media-item transition threw away the outgoing item's unsampled frames
     * outright. They now fold into the next accepted stats entry instead.
     * Player-thread only.
     */
    private var droppedTotal = 0
    private var droppedReported = 0
    /**
     * M1 — the timestamps of the non-fatal errors emitted in the last
     * [NON_FATAL_WINDOW_MS], pruned on every candidate. Bounded by
     * [NON_FATAL_PER_WINDOW] entries by construction. Player-thread only.
     *
     * Codex round-5, #9: an entry is appended only once the collector has
     * ACCEPTED the emission, so errors thrown away for want of a collector
     * cost nothing and the ten-a-minute allowance measures what actually
     * reached the timeline.
     */
    private val nonFatalTimes = ArrayDeque<Long>()

    internal val listener: AnalyticsListener = object : AnalyticsListener {
        override fun onMediaItemTransition(eventTime: AnalyticsListener.EventTime, mediaItem: MediaItem?, reason: Int) = guard { onItem(mediaItem) }
        override fun onTimelineChanged(eventTime: AnalyticsListener.EventTime, reason: Int) = guard { refreshLive() }
        override fun onLoadCompleted(eventTime: AnalyticsListener.EventTime, loadEventInfo: LoadEventInfo, mediaLoadData: MediaLoadData) = guard { onLoad(mediaLoadData) }
        override fun onRenderedFirstFrame(eventTime: AnalyticsListener.EventTime, output: Any, renderTimeMs: Long) = guard { onFirstFrame() }
        override fun onPlaybackStateChanged(eventTime: AnalyticsListener.EventTime, state: Int) = guard { onState(state) }
        override fun onIsPlayingChanged(eventTime: AnalyticsListener.EventTime, isPlaying: Boolean) =
            guard {
                playing = isPlaying
                if (isPlaying) {
                    // I11: the attach seed may already have opened this span.
                    if (playEmitted) return@guard
                    playEmitted = true
                    emit(PlayerEventTypes.PLAY)
                } else {
                    playEmitted = false
                    emit(PlayerEventTypes.PAUSE)
                }
            }
        override fun onPositionDiscontinuity(eventTime: AnalyticsListener.EventTime, oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) = guard {
            if (reason == Player.DISCONTINUITY_REASON_SEEK) emit(PlayerEventTypes.SEEK, mapOf("fromMs" to oldPosition.positionMs, "toMs" to newPosition.positionMs))
        }
        // M5: `speed` is a Float, so `1.5f.toDouble()` is 1.5000000596046448 —
        // a wire value that reads as noise and costs bytes for nothing.
        // Rounded to 3 decimals, which is finer than any UI rate picker.
        override fun onPlaybackParametersChanged(eventTime: AnalyticsListener.EventTime, playbackParameters: PlaybackParameters) =
            guard { emit(PlayerEventTypes.RATE_CHANGE, mapOf("rate" to roundRate(playbackParameters.speed))) }
        override fun onDownstreamFormatChanged(eventTime: AnalyticsListener.EventTime, mediaLoadData: MediaLoadData) = guard {
            if (mediaLoadData.trackType != C.TRACK_TYPE_VIDEO) return@guard
            val f = mediaLoadData.trackFormat ?: return@guard
            // I9: Media3 reports an unknown bitrate as `Format.NO_VALUE`
            // (-1). Emitting that produced a negative `bitrate` on the wire
            // and accumulated into a NEGATIVE `bitrateMean`, which the
            // protocol rejects (the field is nonnegative) — one unknown
            // format could therefore sink every summary for the session.
            // Suppressed until the bitrate is genuinely positive; unknown
            // width/height are omitted rather than sent as -1.
            val bitrate = f.bitrate
            if (bitrate <= 0) return@guard
            val key = "$bitrate/${f.width}x${f.height}"
            if (key == lastFormatKey) return@guard
            lastFormatKey = key
            val data = linkedMapOf<String, Any?>("bitrate" to bitrate)
            f.width.takeIf { it > 0 }?.let { data["width"] = it }
            f.height.takeIf { it > 0 }?.let { data["height"] = it }
            // M2: only a real manual selection is reported as manual. Initial,
            // unknown and trick-play selections carry no reason at all rather
            // than being mislabelled as a viewer's quality choice.
            selectionReason(mediaLoadData.trackSelectionReason)?.let { data["reason"] = it }
            emit(PlayerEventTypes.BITRATE_CHANGE, data)
        }
        override fun onVideoSizeChanged(eventTime: AnalyticsListener.EventTime, videoSize: VideoSize) =
            guard { emit(PlayerEventTypes.QUALITY_CHANGE, mapOf("width" to videoSize.width, "height" to videoSize.height)) }
        override fun onDrmSessionAcquired(eventTime: AnalyticsListener.EventTime, state: Int) = guard { if (drmAcquiredAt == null) drmAcquiredAt = now() }
        override fun onDrmKeysLoaded(eventTime: AnalyticsListener.EventTime) = guard {
            // Round-3, Important 8: gated on the KEYS-LOADED latch, not on
            // `lastDrm`. A seeded `lastDrm` records only the key system; the
            // first real callback is what MEASURES `licenseMs`, and it must be
            // allowed to enrich and re-emit the seed. Later callbacks (key
            // rotation) still fold into the first one, as before.
            if (keysLoadedHandled) return@guard
            keysLoadedHandled = true
            licenseMs = drmAcquiredAt?.let { now() - it }
            val seeded = lastDrm?.get("keySystem") as? String
            val data = linkedMapOf<String, Any?>(
                "keySystem" to (drmKeySystem ?: seeded?.takeIf { it != "none" } ?: "unknown"),
            )
            licenseMs?.let { data["licenseMs"] = it }
            lastDrm = data
            emit(PlayerEventTypes.DRM, data)
        }
        override fun onPlayerError(eventTime: AnalyticsListener.EventTime, error: PlaybackException) = guard {
            emit(
                PlayerEventTypes.ERROR,
                mapOf("message" to (error.message ?: error.errorCodeName), "code" to error.errorCodeName, "fatal" to true, "detail" to error.cause?.javaClass?.name),
            )
        }
        override fun onLoadError(eventTime: AnalyticsListener.EventTime, loadEventInfo: LoadEventInfo, mediaLoadData: MediaLoadData, error: IOException, wasCanceled: Boolean) = guard {
            if (wasCanceled) return@guard
            val t = now()
            // M1: a rolling window, not a fixed one. The fixed window let ten
            // errors land just before a boundary and ten just after — twenty
            // inside one rolling minute, twice the documented cap.
            while (nonFatalTimes.isNotEmpty() && t - nonFatalTimes.first() >= NON_FATAL_WINDOW_MS) nonFatalTimes.removeFirst()
            if (nonFatalTimes.size >= NON_FATAL_PER_WINDOW) return@guard
            val uri = loadEventInfo.uri
            // Codex round-5, #9: the allowance is charged only against an
            // ACCEPTED emission. Ten errors while no collector exists — before
            // remote config enables vitals, say — used to leave the timeline
            // empty and then suppress every error for the minute after
            // enablement, which is precisely the minute worth capturing.
            val accepted = emit(
                PlayerEventTypes.ERROR,
                mapOf("message" to (error.message ?: "load error"), "code" to "load_error", "fatal" to false, "detail" to "${uri.host ?: ""}${uri.path ?: ""}"),
            )
            if (accepted) nonFatalTimes.addLast(t)
        }
        override fun onDroppedVideoFrames(eventTime: AnalyticsListener.EventTime, droppedFrames: Int, elapsedMs: Long) = guard { this@Media3Integration.droppedTotal += droppedFrames }
        override fun onBandwidthEstimate(eventTime: AnalyticsListener.EventTime, totalLoadTimeMs: Int, totalBytesLoaded: Long, bitrateEstimate: Long) = guard { bandwidthEstimate = bitrateEstimate }
        override fun onPlayerReleased(eventTime: AnalyticsListener.EventTime) = guard { fireReleased() }
    }

    // `dev.everframe.envelope.InternalLogger.recordSafeWrapFailure` is `internal` to
    // :everframe-core — Kotlin's `internal` is module-scoped, so it is invisible here
    // even though this module depends on core via `api(project(":everframe-core"))`.
    // Log-and-swallow with the platform logger instead, same as any other host-facing
    // callback boundary that must never throw back into ExoPlayer's analytics thread.
    private inline fun guard(block: () -> Unit) {
        try { block() } catch (t: Throwable) { Log.w("Everframe", "Media3Integration listener callback failed", t) }
    }

    /**
     * Codex round-5, #9 — RETURNS whether the collector admitted the entry.
     * Only [onLoadError] acts on it: it rations non-fatal errors to ten a
     * minute, and a rejected emission must not spend that budget.
     */
    private fun emit(type: String, data: Map<String, Any?>? = null): Boolean = ctx?.emit(type, data) == true

    private fun onItem(item: MediaItem?) {
        // I10: close the open rebuffer span BEFORE the reset below drops it.
        // Clearing `bufferStartAt` silently meant the accumulator never saw
        // the matching `buffer_end`, so the union rebuffer span stayed open
        // to the end of the session and inflated `rebufferDurationMs` — for
        // every player, since the spans are unioned.
        closeBufferSpan()
        itemStartedAt = now()
        manifestMs = null; firstFragmentMs = null; firstFrameSeen = false; lastDrm = null; bufferStartAt = null
        // Round-3, Important 8: per item, exactly like `lastDrm` beside it.
        keysLoadedHandled = false
        // Round-2, Important 12: the counters are deliberately NOT reset here.
        // Zeroing them discarded whatever the outgoing item dropped since the
        // last sampler tick without ever emitting it; folding those frames
        // into the next accepted `stats` is the lesser inaccuracy, and it is
        // the only one that keeps the running total honest.
        resetItemExtras()
        // M6 — playlist end. The latch resets above still apply (whatever
        // plays next measures its own startup cleanly), but there is no source
        // to announce: the old code emitted `source_change {src: "unknown",
        // protocol: "unknown"}` here, which is timeline noise. `lastSource` is
        // deliberately left holding the last REAL source so `describe()` (the
        // rotation reseed) and `snapshot()` stay meaningful.
        if (item == null) return
        drmKeySystem = item.localConfiguration?.drmConfiguration?.scheme?.let { keySystemName(it) }
        val cfg = item.localConfiguration
        val uri = cfg?.uri?.toString()
        val mime = cfg?.mimeType
        val s = sanitizeSource(uri, keepSourceQuery)
        val protocol = protocolForMime(mime) ?: s.protocol
        val data = linkedMapOf<String, Any?>("src" to s.src, "protocol" to protocol)
        if (mime != null) data["mime"] = mime
        data["live"] = runCatching { facade.readState().isLive }.getOrDefault(false)
        lastSource = data
        emit(PlayerEventTypes.SOURCE_CHANGE, data)
    }

    /**
     * I1 — `attach()`'s seed. Builds and caches `lastSource` exactly as
     * [onItem] does, and emits `source_change` so the timeline knows what is
     * already playing, but touches NONE of the per-item latches
     * (`itemStartedAt`, `manifestMs`, `firstFragmentMs`, `lastDrm`,
     * `drmKeySystem`, `bufferStartAt`). Routing through `onItem` instead would
     * restart this item's startup measurement mid-playback and produce a
     * bogus `startup { ttffMs }` at the next rendered frame.
     *
     * `firstFrameSeen` IS set when the player is visibly past startup: the
     * flag's only job is to make a later STATE_BUFFERING count as a rebuffer
     * rather than as startup, and joining a running player is exactly the case
     * where that distinction matters.
     *
     * Codex round-5, #10 — it is also what decides whether this seed owes the
     * timeline a DRM entry. Past the first frame, `onFirstFrame()` will never
     * run again for this item, so a CLEAR item has to be reported as
     * `keySystem: "none"` here or the player is reported with unknown DRM
     * forever. Before the first frame, the real callback still does it.
     *
     * Codex round-4, #9 — what counts as "past startup". A selected
     * `videoFormat` does NOT: ExoPlayer resolves the format during track
     * selection, well before the first frame reaches the screen, so attaching
     * during a normal launch treated the launch's own STATE_BUFFERING as a
     * rebuffer, and the real `onRenderedFirstFrame` then returned early — the
     * `startup` event and its ttff were lost outright while rebuffer metrics
     * counted a stall that never happened. ExoPlayer exposes no "first frame
     * rendered" getter, so the evidence is playback progress instead:
     *
     *  - `isPlaying` — frames are on screen;
     *  - `STATE_READY` — a video renderer only reports ready once it has
     *    rendered a frame;
     *  - `STATE_BUFFERING` on a VOD player whose position has ADVANCED past
     *    zero. This is the documented heuristic that keeps round-3 I9 (join a
     *    player mid-rebuffer) alive: a position greater than zero means
     *    playback has happened, so this stall is a rebuffer. It is
     *    deliberately NOT applied to live streams, whose start position is
     *    nonzero by construction and would therefore always pass.
     *
     * Anything else — BUFFERING at position 0, or any live stream still
     * starting up — leaves the flag false so the real `onRenderedFirstFrame`
     * closes startup, which is what it is for.
     */
    private fun seedSource(s: Media3PlayerState) {
        playing = s.isPlaying
        // Codex round-2, Important 11 — open the play span the player is
        // already inside. Media3 does not replay `onIsPlayingChanged(true)`
        // for a listener added mid-playback, so without this the accumulator
        // saw no `play` at all and reported zero playtime until the next real
        // transition. ABOVE the "a transition beat me to it" bail, because
        // this is exactly the join-a-running-player case; the latch is what
        // stops a real callback arriving afterwards from opening it twice.
        if (s.isPlaying && !playEmitted) {
            playEmitted = true
            // Round-7, #1: emitted unconditionally, and nothing records
            // whether it landed. An inline seed runs before the player is
            // announced and is refused, so the first `describe()` opens the
            // span instead; a posted seed lands inside the announcement and
            // describe's own open is then a duplicate the accumulator
            // discards. Both orderings are correct with no latch at all.
            emit(PlayerEventTypes.PLAY)
        }
        // A real onMediaItemTransition beat the posted seed to it — leave its
        // (authoritative, latch-resetting) work alone.
        //
        // N2: `firstFrameSeen` is set BELOW this bail, not above it. Above it,
        // a seed that arrived after a real transition had already reset the
        // latch re-set it from the player's pre-transition state, which
        // suppressed the NEW item's `startup` entry entirely (and downgraded
        // its opening buffer to a rebuffer). `playing` stays unconditional:
        // it is the live playback flag, not a per-item latch.
        if (lastSource != null) return
        // Round-4, #9 — see the KDoc. Still an `if`, not an assignment: N2's
        // rule is that this seed only ever SETS the latch, never re-arms one a
        // real callback has already closed.
        if (
            s.isPlaying ||
            s.playbackState == Player.STATE_READY ||
            (s.playbackState == Player.STATE_BUFFERING && !s.isLive && s.currentPositionMs > 0)
        ) {
            firstFrameSeen = true
        }
        // Codex round-3, Important 9 — the player may be rebuffering RIGHT
        // NOW. Media3 does not replay the `STATE_BUFFERING` transition that
        // opened it for a listener added mid-stall, so without this the whole
        // rebuffer (and its duration, which is exactly what a viewer felt)
        // vanished from the session. Only past startup: before the first
        // frame, buffering is startup, and `onFirstFrame()` reports that.
        if (firstFrameSeen && s.playbackState == Player.STATE_BUFFERING && bufferStartAt == null) {
            bufferStartAt = now()
            // Round-7, #1 — as for `play` above.
            emit(PlayerEventTypes.BUFFER_START)
        }
        val item = s.currentMediaItem ?: return
        // I14 — seed the DRM scheme from the item we are joining. Attaching
        // after the keys have already loaded means no further
        // `onDrmKeysLoaded` is guaranteed, so without this the player never
        // emitted or reseeded DRM information at all. No license timing is
        // fabricated: `licenseMs` is only ever measured, never guessed.
        val scheme = item.localConfiguration?.drmConfiguration?.scheme
        if (scheme != null) {
            drmKeySystem = keySystemName(scheme)
            if (lastDrm == null) {
                val drm = mapOf<String, Any?>("keySystem" to drmKeySystem)
                lastDrm = drm
                emit(PlayerEventTypes.DRM, drm)
            }
        } else if (firstFrameSeen && lastDrm == null) {
            // Codex round-5, #10 — a CLEAR item joined past its first frame.
            // `onFirstFrame()` is what reports `keySystem: "none"`, and Media3
            // does not replay `onRenderedFirstFrame` for a listener added
            // afterwards, so a player attached mid-playback stayed at "DRM
            // unknown" for the rest of its life — and reseeded nothing on
            // rotation either. Before the first frame this is still
            // `onFirstFrame()`'s job, as it always was.
            val drm = mapOf<String, Any?>("keySystem" to "none")
            lastDrm = drm
            emit(PlayerEventTypes.DRM, drm)
        }
        val cfg = item.localConfiguration
        val san = sanitizeSource(cfg?.uri?.toString(), keepSourceQuery)
        val mime = cfg?.mimeType
        val data = linkedMapOf<String, Any?>("src" to san.src, "protocol" to (protocolForMime(mime) ?: san.protocol))
        if (mime != null) data["mime"] = mime
        data["live"] = s.isLive
        lastSource = data
        emit(PlayerEventTypes.SOURCE_CHANGE, data)
    }

    private fun refreshLive() {
        val src = lastSource ?: return
        val live = runCatching { facade.readState().isLive }.getOrNull() ?: return
        if (src["live"] != live) lastSource = src + ("live" to live)
    }

    private fun onLoad(d: MediaLoadData) {
        val start = itemStartedAt ?: return
        when (d.dataType) {
            C.DATA_TYPE_MANIFEST -> if (manifestMs == null) manifestMs = now() - start
            C.DATA_TYPE_MEDIA -> if (firstFragmentMs == null) firstFragmentMs = now() - start
        }
    }

    private fun onFirstFrame() {
        if (firstFrameSeen) return
        firstFrameSeen = true
        val start = itemStartedAt
        if (start != null) {
            val data = linkedMapOf<String, Any?>("ttffMs" to (now() - start))
            manifestMs?.let { data["manifestMs"] = it }
            firstFragmentMs?.let { data["firstFragmentMs"] = it }
            licenseMsForStartup()?.let { data["licenseMs"] = it }
            emit(PlayerEventTypes.STARTUP, data)
        }
        if (lastDrm == null) { lastDrm = mapOf("keySystem" to "none"); emit(PlayerEventTypes.DRM, lastDrm) }
    }

    private fun onState(state: Int) {
        when (state) {
            Player.STATE_BUFFERING -> if (firstFrameSeen && bufferStartAt == null) { bufferStartAt = now(); emit(PlayerEventTypes.BUFFER_START) }
            Player.STATE_READY, Player.STATE_ENDED, Player.STATE_IDLE -> closeBufferSpan()
        }
    }

    internal fun resetItemExtras() {
        lastFormatKey = null; drmAcquiredAt = null; licenseMs = null; drmKeySystem = null
    }
    internal fun licenseMsForStartup(): Long? = licenseMs

    /**
     * Codex round-9, #2 — the WHOLE attach transition happens inside the
     * posted runnable: `attached`, `ctx`, `keepSourceQuery`, the subscription
     * and the seed, in that order. Nothing about the attachment is written on
     * the caller's thread any more.
     *
     * The race that forced it: `VitalsController.trackPlayer` answers null
     * when it has been shut down between reserving and publishing, and
     * `VitalsRuntime` then RETRIES THE SAME INTEGRATION against the
     * replacement controller (round-8, #3). The refusal path calls
     * `integration.detach()`, which only POSTS `closeAndTearDown` and
     * returns, so the retry's `attach()` ran while that teardown was still
     * queued. Two silent failure shapes followed — a caller-thread
     * `if (attached) return true` that reported success without ever writing
     * the new context, and, once it was written, a queued teardown that
     * cleared it a moment later while the retry's own posted subscription
     * restored nothing. Either way the handle looked attached and every later
     * playback/error callback disappeared from timeline AND summary.
     *
     * Posting the transition puts it FIFO behind any queued teardown on the
     * player's own looper, which is the only thread that writes this state,
     * so "detach A, then attach B" always lands in that order. The double-
     * attach guard moves in with it: the runnable is a no-op if `attached` is
     * already true WHEN IT RUNS (a genuine double attach — the first wins),
     * which is a decision only the player thread can make correctly.
     *
     * I13 — `captureSourceQuery` is still resolved at ATTACH time, not at
     * `trackPlayer()` time, so a registration queued before `start()` picks up
     * the configuration of the controller that actually drains it.
     *
     * I1 — the seed reads the player's CURRENT state, because Media3 replays
     * nothing for a listener added mid-playback. `readState()` is
     * player-thread-only, which is another reason the whole transition belongs
     * here.
     *
     * I7 — `Player.addAnalyticsListener` is documented as callable from the
     * application thread; `detach()` posts its removal the same way, so the
     * two serialize in order on that looper.
     *
     * Round-2, Important 10 — a subscription that never happened must not be
     * reported as a successful attach. What this method can answer is whether
     * the POST was accepted; a rejected post (`Handler.post` answers false
     * once the looper is quitting) is a refused attach. Beyond that there are
     * still two shapes:
     *
     *  - INLINE (`postOnPlayerThread` runs the runnable itself, because the
     *    caller already IS the player thread): the failure is visible before
     *    this method returns, so it returns FALSE and the controller refuses
     *    the registration outright.
     *  - ASYNC: this method has already returned true by the time the add
     *    throws, so the runnable routes through [fireReleased] — the same path
     *    a real `onPlayerReleased` takes — which unregisters the player
     *    instead of leaving it orphaned in the registry.
     *
     * On either shape the runnable UNDOES its own writes first, on the thread
     * that made them, so a refused attach leaves nothing attached and a later
     * retry against a healthy player is still possible.
     */
    override fun attach(ctx: PlayerIntegrationContext): Boolean {
        val postReturned = java.util.concurrent.atomic.AtomicBoolean(false)
        val subscribeFailed = java.util.concurrent.atomic.AtomicBoolean(false)
        val accepted = try {
            postOnPlayerThread(
                Runnable {
                    // A genuine double attach: the first one wins, and this
                    // must not disturb the context it installed.
                    if (attached) return@Runnable
                    attached = true
                    this.ctx = ctx
                    keepSourceQuery = try { captureSourceQuery() } catch (t: Throwable) { false }
                    val ok = try {
                        facade.addAnalyticsListener(listener)
                        true
                    } catch (t: Throwable) {
                        Log.w("Everframe", "Media3Integration addAnalyticsListener failed", t)
                        false
                    }
                    if (!ok) {
                        subscribeFailed.set(true)
                        attached = false
                        this.ctx = null
                        // Only the async arm cleans up after itself; the inline
                        // arm is handled by this method's own return below. A
                        // benign double-teardown in the narrow interleaving
                        // where both see themselves as responsible is harmless:
                        // the handle a refused attach yields is inert and its
                        // detach() is a no-op.
                        if (postReturned.get()) fireReleased()
                        return@Runnable
                    }
                    // Codex round-8, #2 — nothing reconciles a describe
                    // against this seed any more, and nothing has to.
                    // `describe()` is now POSTED to this same looper, so a
                    // describe issued while this runnable is still queued is
                    // ordered strictly after it by FIFO and reads the seeded
                    // state directly. Round 7's retain-and-replay of a
                    // describe context, and the seed-completion latch that
                    // drove it, existed only to cover an ordering that can no
                    // longer occur, and are deleted.
                    guard { runCatching { facade.readState() }.getOrNull()?.let { seedSource(it) } }
                },
            )
        } catch (t: Throwable) {
            Log.w("Everframe", "Media3Integration attach seed failed", t)
            false
        }
        postReturned.set(true)
        return accepted && !subscribeFailed.get()
    }

    /**
     * Codex round-7, #3, re-homed by round-8, #1 — a DECLARATION-TIME release
     * observer, independent of this integration's own [listener].
     *
     * `trackPlayer(exoPlayer)` before `start()` only QUEUES the registration:
     * [attach] runs at drain time, so until a `start()` that may never come,
     * nothing is subscribed to this player and its `onPlayerReleased` reaches
     * nobody. The deferred handle went on holding the released `ExoPlayer` for
     * the lifetime of the process, and every repeated declaration added
     * another. This listener overrides nothing but the release callback, so it
     * costs one subscription and no per-event work, and it routes to exactly
     * the same place the integration's own release path does — a double
     * `detach()` is idempotent at every layer.
     *
     * Round-8, #1 — the observer belongs to the INTEGRATION, not to a handle
     * wrapped around the one `register` returns. Round 7 removed it in such a
     * wrapper, which only the CALLER's `detach()` ever reaches: `kill()`, a
     * superseding `start()`, a revoked or cancelled pending registration all
     * go straight to [detach] and bypassed it, so on a long-lived ExoPlayer
     * each start/track/kill cycle left one more observer behind — retaining
     * the handle, its delegate and the dead controller behind that.
     * [closeAndTearDown] is the one point every teardown path shares, so that
     * is where the removal lives now.
     *
     * Idempotent: a second call finds the reference already set and does
     * nothing. Installed through [postOnPlayerThread] like every other
     * listener mutation (I7's looper rule). A rejected post means the looper
     * is gone — the player is already unusable — so the declaration is
     * released immediately instead of being left observed by nothing.
     */
    internal fun observeRelease() {
        val obs = object : AnalyticsListener {
            override fun onPlayerReleased(eventTime: AnalyticsListener.EventTime) = guard { fireReleased() }
        }
        if (!releaseObserver.compareAndSet(null, obs)) return
        val installed = try {
            postOnPlayerThread(
                Runnable {
                    try {
                        facade.addAnalyticsListener(obs)
                    } catch (t: Throwable) {
                        Log.w("Everframe", "Media3Integration release observer subscription failed", t)
                    }
                },
            )
        } catch (t: Throwable) {
            Log.w("Everframe", "Media3Integration release observer post failed", t)
            false
        }
        if (!installed) {
            releaseObserver.compareAndSet(obs, null)
            fireReleased()
        }
    }

    /**
     * I7 — the release hook is what unregisters the player from the vitals
     * registry. A `detach()` that throws (a dead looper rejecting the listener
     * removal, say) used to skip it entirely and leak a live registration for
     * a released player: announced on every rotation, snapshotted on every
     * tick, forever. Round-2, Important 10 routes a failed asynchronous
     * subscription through here too, for the same reason.
     */
    private fun fireReleased() {
        val hook = onReleased
        onReleased = null
        try {
            detach()
        } finally {
            hook?.invoke()
        }
    }

    override fun snapshot(onResult: (PlayerSnapshot?) -> Boolean) {
        // I1: "no source AND not playing" is the real idle test. `lastSource`
        // alone refused stats for any player attached after its first media
        // item, since only `onMediaItemTransition` ever set it.
        if (!attached || (lastSource == null && !playing)) { onResult(null); return }
        val posted = try {
            postOnPlayerThread(Runnable {
                // Round-2, Important 12: the delta is COMPUTED here but only
                // COMMITTED once the controller confirms it recorded the
                // result. A snapshot dropped for landing after a detach (or
                // against a replaced collector) used to take the frames it had
                // already zeroed with it.
                val at = droppedTotal
                val result = try {
                    val s = facade.readState()
                    PlayerSnapshot(
                        bufferAheadMs = (s.bufferedPositionMs - s.currentPositionMs).coerceAtLeast(0),
                        bandwidthEstimate = bandwidthEstimate,
                        bitrate = s.videoFormat?.bitrate?.takeIf { it > 0 },
                        width = s.videoFormat?.width?.takeIf { it > 0 },
                        height = s.videoFormat?.height?.takeIf { it > 0 },
                        droppedFramesDelta = at - droppedReported,
                    )
                } catch (_: Throwable) { null }
                val recorded = try { onResult(result) } catch (_: Throwable) { false }
                if (recorded) droppedReported = at
            })
        } catch (_: Throwable) { false }
        if (!posted) onResult(null)
    }

    override fun startupTimings(): StartupTimings? =
        if (!firstFrameSeen) null else StartupTimings(manifestMs, licenseMsForStartup(), firstFragmentMs)

    /**
     * I11 — the reseed re-opens ONGOING spans as well as re-describing
     * identity. A session rotation resets the accumulator, so a player that
     * was mid-play (or mid-rebuffer) across the boundary contributed nothing
     * to the new session's playtime/rebuffer duration until its next
     * transition, which for a long uninterrupted playback is never.
     *
     * Codex round-7, #1 — it NEVER returns early and it owes nobody
     * deference. It states what it knows right now: [lastSource], [lastDrm],
     * [playing] and [bufferStartAt]. A duplicate `play`/`buffer_start` — the
     * seed's open re-stated by the first describe, or the other way round —
     * is a no-op at `SummaryAccumulator`, which tracks the union span per
     * player rather than counting opens. That single change retired the seed
     * latches of rounds 5 and 6 AND the controller's `suppressedFor`; a
     * describe that says too little (the old early return) is the failure
     * that cannot be recovered from, because for uninterrupted playback no
     * further transition ever comes.
     *
     * Codex round-8, #2 — THE LOOPER IS THE SERIALIZATION. This method is
     * called on whichever thread announced the player: a server re-enable
     * announces from the config thread, a rotation from whichever thread
     * recorded the triggering entry. [playing] and [bufferStartAt] have a
     * single writer — the player thread — so reading them anywhere else is a
     * race whose losing interleaving is unrecoverable: the player thread
     * records a valid `pause`, and this describe, holding a `playing == true`
     * it read a moment earlier, then records a stale `play` into the SAME
     * announcement. No idempotent set can reject a valid close followed by a
     * stale open, so the summary goes on accruing playtime for a player that
     * is paused. The equivalent race reopens a closed rebuffer span through
     * [bufferStartAt].
     *
     * Posting [describeNow] onto the player thread — inline when this already
     * IS that thread, as [postOnPlayerThread] always does — makes the read
     * and the emission one step on the only thread that writes those fields.
     * The describe context is announcement-bound (round-6, #4), so a run that
     * lands late, into a superseded announcement, is dropped by the
     * controller rather than mis-stated.
     *
     * It also retires round-7's retain-and-replay of a describe context —
     * and the seed-completion latch that drove it — outright, which is why
     * this round removes code rather than adding it: `attach()`'s seed is
     * posted to this same looper, so a
     * describe issued while the seed is still queued is ordered AFTER it by
     * FIFO and simply reads the seeded state. The "describe arrived mid-seed"
     * case the replay existed for cannot happen any more.
     *
     * A rejected post means the looper is gone — the player is unusable and
     * nothing can be true of it — so nothing is emitted.
     */
    override fun describe(ctx: PlayerIntegrationContext) {
        try {
            postOnPlayerThread(Runnable { guard { describeNow(ctx) } })
        } catch (t: Throwable) {
            Log.w("Everframe", "Media3Integration describe post failed", t)
        }
    }

    /** Player-thread only: the state read and its emissions, as one step. */
    private fun describeNow(ctx: PlayerIntegrationContext) {
        lastSource?.let { ctx.emit(PlayerEventTypes.SOURCE_CHANGE, it) }
        lastDrm?.let { ctx.emit(PlayerEventTypes.DRM, it) }
        if (playing) ctx.emit(PlayerEventTypes.PLAY)
        if (bufferStartAt != null) ctx.emit(PlayerEventTypes.BUFFER_START)
    }

    /**
     * I10 — closes whatever spans are still open before it goes quiet.
     * Silently dropping `playing`/`bufferStartAt` meant the accumulator never
     * received the matching `pause`/`buffer_end`, so a detached (or released)
     * player's union play/rebuffer span ran to the end of the session.
     *
     * I7 — the listener removal is posted onto the player's application
     * thread, paired with `attach()`'s posted subscription so the two
     * serialize in order on that looper.
     *
     * Codex round-2, Important 13 — the span CLOSES are posted with it. They
     * used to run on the shutdown thread as non-atomic read-then-clear pairs
     * against `bufferStartAt`/`playing`, both of which the player thread
     * writes: a concurrent READY or `isPlaying=false` callback could make both
     * threads emit the same `buffer_end`/`pause`, double-closing a union span
     * the accumulator counts by open/close pairs. Running the whole close +
     * remove + teardown transition on the player's own thread makes that
     * looper the single writer — which, since Codex round-9 #2, is exactly
     * what `attach()`'s WHOLE transition is too, not just its seed. The two
     * are now one FIFO sequence on one thread. It runs INLINE when the caller
     * is already that thread (the `onPlayerReleased` path), so nothing about
     * that case changes.
     *
     * A REJECTED post is the one case where the transition runs here. The
     * looper is quitting, so the player is being released; a runnable ALREADY
     * queued (`Looper.quitSafely()` still dispatches those) can in principle
     * run after this arm and re-attach — a listener nothing will remove — but
     * only on a player whose lifetime is ending, so the leak is bounded by
     * the player's own. Leaving the integration half-attached with a stale
     * `ctx` would be worse.
     */
    override fun detach() = detach(onComplete = {})

    /**
     * Codex round-3, Important 6 — ONE posted runnable closes the spans AND
     * signals completion, so the controller's `player_detach` marker is
     * recorded after the `buffer_end`/`pause` it closes rather than before
     * them. Round 2 posted the closes and returned immediately: the marker
     * went out first, and during a controller shutdown the collector was
     * already stopped by the time the runnable ran, so those events were lost
     * entirely.
     *
     * [onComplete] fires exactly once on every path — inline when the caller
     * is already the player thread (the `onPlayerReleased` case), from the
     * looper when it is not, and here when the post is rejected (the looper is
     * gone, so no player callback can be racing us).
     *
     * Codex round-8, #1 — there is NO "never attached, nothing to do" early
     * return any more. [observeRelease] subscribes a release observer at
     * DECLARATION time, long before the drain calls [attach], so a
     * registration that is revoked, cancelled or refused before it ever
     * attached still owns a subscription on the customer's player; the early
     * return dropped every one of them on the floor. The teardown below emits
     * nothing when nothing was attached (`ctx` is null, no span is open) —
     * all it does is release what the declaration took.
     *
     * Codex round-9, #2 — and `attached` is no longer cleared HERE. It is
     * read and cleared inside [closeAndTearDown], on the player thread, for
     * the same reason [attach] now writes it there: with a caller-thread
     * clear, a detach posted ahead of a not-yet-run attach runnable captured
     * `wasAttached == false`, so the teardown that ran AFTER that attach
     * (FIFO) left the listener it had just installed subscribed. Reading the
     * flag where it is written makes "detach A, then attach B" exact in both
     * directions.
     */
    override fun detach(onComplete: () -> Unit) {
        val posted = try {
            postOnPlayerThread(
                Runnable {
                    try {
                        closeAndTearDown(onPlayerThread = true)
                    } finally {
                        guard { onComplete() }
                    }
                },
            )
        } catch (t: Throwable) {
            Log.w("Everframe", "Media3Integration detach post failed", t)
            false
        }
        if (!posted) {
            try {
                closeAndTearDown(onPlayerThread = false)
            } finally {
                guard { onComplete() }
            }
        }
    }

    /**
     * Player-thread (or dead-looper) transition: close open spans, unsubscribe, forget everything.
     *
     * [onPlayerThread] is false only when the post was REJECTED — the looper
     * is quitting, so no listener can be removed from the player. Clearing
     * [attached] on that arm is best-effort: an attach runnable that was
     * already queued may still dispatch afterwards (`quitSafely` drains the
     * queue) and re-set it, which is acceptable only because the player is
     * being released — see [detach]'s note on the same arm.
     *
     * Codex round-9, #2 — `wasAttached` is READ HERE rather than passed in
     * from the caller's thread: whether the main [listener] is subscribed is
     * player-thread state, and a detach posted before an attach runnable that
     * has not run yet would otherwise capture a stale `false` and leave that
     * attach's subscription behind. The declaration-time release observer is
     * taken off regardless, since it is installed before any attach
     * (round-8, #1).
     */
    private fun closeAndTearDown(onPlayerThread: Boolean) {
        val wasAttached = attached
        attached = false
        try {
            guard { closeBufferSpan() }
            guard { if (playing) emit(PlayerEventTypes.PAUSE) }
            // Take-and-null, so a second teardown for one subscription is a
            // no-op and a re-`attach()` cannot resurrect a stale reference.
            val observer = releaseObserver.getAndSet(null)
            if (onPlayerThread) {
                if (wasAttached) guard { facade.removeAnalyticsListener(listener) }
                if (observer != null) guard { facade.removeAnalyticsListener(observer) }
            }
        } finally {
            playing = false
            playEmitted = false
            bufferStartAt = null
            keysLoadedHandled = false
            ctx = null
        }
    }

    /** Emits the `buffer_end` for an open rebuffer span, if there is one. */
    private fun closeBufferSpan() {
        val started = bufferStartAt ?: return
        bufferStartAt = null
        emit(PlayerEventTypes.BUFFER_END, mapOf("durationMs" to (now() - started)))
    }

    private fun roundRate(speed: Float): Double = Math.round(speed * 1000.0) / 1000.0

    /** M2: null means "do not claim a reason" (initial, unknown, trick-play). */
    private fun selectionReason(reason: Int): String? = when (reason) {
        C.SELECTION_REASON_MANUAL -> "manual"
        C.SELECTION_REASON_ADAPTIVE -> "abr"
        else -> null
    }

    private fun keySystemName(uuid: java.util.UUID): String = when (uuid) {
        C.WIDEVINE_UUID -> "widevine"
        C.PLAYREADY_UUID -> "playready"
        C.CLEARKEY_UUID -> "clearkey"
        else -> uuid.toString()
    }

    private companion object {
        const val NON_FATAL_WINDOW_MS = 60_000L
        const val NON_FATAL_PER_WINDOW = 10
    }
}
