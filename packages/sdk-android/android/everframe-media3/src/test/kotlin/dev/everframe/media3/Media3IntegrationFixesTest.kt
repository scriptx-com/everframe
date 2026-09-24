// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.media3

import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import dev.everframe.vitals.PlayerIntegrationContext
import dev.everframe.vitals.PlayerSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.IOException

/** Codex round-1 adversarial-review fixes: I7, I9, I10, I12, I13, I14, M1, M2 and N2. */
@UnstableApi
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class Media3IntegrationFixesTest {
    private var now = 10_000L
    private val facade = FakeFacade()
    private val ctx = RecordingContext { now }
    private val posts = ArrayDeque<Runnable>()
    private fun drain() { while (posts.isNotEmpty()) posts.removeFirst().run() }
    private fun inline(): (Runnable) -> Boolean = { it.run(); true }
    private fun deferred(): (Runnable) -> Boolean = { posts.addLast(it); true }
    private fun rejecting(): (Runnable) -> Boolean = { false }

    private fun integration(
        keepQuery: () -> Boolean = { false },
        post: (Runnable) -> Boolean = inline(),
    ) = Media3Integration(facade, keepQuery, post, { now })

    private fun attached(keepQuery: () -> Boolean = { false }) =
        integration(keepQuery).also { assertTrue(it.attach(ctx)) }

    private fun drmItem() = MediaItem.Builder().setUri("https://h/m.mpd").setMimeType("application/dash+xml")
        .setDrmConfiguration(MediaItem.DrmConfiguration.Builder(C.WIDEVINE_UUID).build()).build()

    // ---- I7: listener mutation is serialized on the player thread ----

    @Test
    fun `the analytics listener is added and removed on the player thread, never on the caller's`() {
        val i = integration(post = deferred())
        assertTrue(i.attach(ctx))
        assertNull("subscription must be posted, not made on the caller's thread", facade.listener)
        drain()
        assertSame(i.listener, facade.listener)

        i.detach()
        assertNotNull("removal must be posted too", facade.listener)
        drain()
        assertNull(facade.listener)
    }

    @Test
    fun `a detach that throws still runs the release hook and still clears the attachment state`() {
        // I7: onPlayerReleased used to skip the hook — the only thing that
        // unregisters the player from the vitals registry — when detach()
        // threw, leaking a live registration for a released player.
        var releases = 0
        var failNextPost = false
        val i = Media3Integration(
            facade,
            { false },
            { r -> if (failNextPost) throw IllegalStateException("dead looper") else { r.run(); true } },
            { now },
        )
        i.onReleased = { releases++ }
        assertTrue(i.attach(ctx))
        failNextPost = true
        facade.listener!!.onPlayerReleased(eventTime())
        assertEquals(1, releases)
        // Re-attaching is possible again, i.e. `attached` was cleared.
        failNextPost = false
        assertTrue(i.attach(ctx))
    }

    // ---- I9 / M2: bitrate_change hygiene ----

    @Test
    fun `an unknown bitrate is never emitted and unknown dimensions are omitted`() {
        val i = attached()
        val unknownBitrate = Format.Builder().setWidth(1280).setHeight(720).setSampleMimeType("video/avc").build()
        assertEquals(Format.NO_VALUE, unknownBitrate.bitrate)
        facade.listener!!.onDownstreamFormatChanged(
            eventTime(), loadData(C.DATA_TYPE_MEDIA, C.TRACK_TYPE_VIDEO, unknownBitrate, C.SELECTION_REASON_ADAPTIVE),
        )
        assertTrue("a negative bitrate would sink the whole summary", ctx.emitted.none { it.type == "bitrate_change" })

        val noDimensions = Format.Builder().setAverageBitrate(900_000).setPeakBitrate(900_000).setSampleMimeType("video/avc").build()
        facade.listener!!.onDownstreamFormatChanged(
            eventTime(), loadData(C.DATA_TYPE_MEDIA, C.TRACK_TYPE_VIDEO, noDimensions, C.SELECTION_REASON_ADAPTIVE),
        )
        assertEquals(mapOf("bitrate" to 900_000, "reason" to "abr"), ctx.last("bitrate_change").data)
        assertNotNull(i)
    }

    @Test
    fun `only a real manual selection is reported as manual`() {
        attached()
        var bitrate = 1_000_000
        fun select(reason: Int) {
            bitrate += 100_000
            facade.listener!!.onDownstreamFormatChanged(
                eventTime(), loadData(C.DATA_TYPE_MEDIA, C.TRACK_TYPE_VIDEO, videoFormat(bitrate, 640, 360), reason),
            )
        }
        select(C.SELECTION_REASON_INITIAL)
        assertFalse("an initial selection is not a viewer's choice", ctx.last("bitrate_change").data!!.containsKey("reason"))
        select(C.SELECTION_REASON_UNKNOWN)
        assertFalse(ctx.last("bitrate_change").data!!.containsKey("reason"))
        select(C.SELECTION_REASON_TRICK_PLAY)
        assertFalse(ctx.last("bitrate_change").data!!.containsKey("reason"))
        select(C.SELECTION_REASON_ADAPTIVE)
        assertEquals("abr", ctx.last("bitrate_change").data!!["reason"])
        select(C.SELECTION_REASON_MANUAL)
        assertEquals("manual", ctx.last("bitrate_change").data!!["reason"])
    }

    // ---- I10: open spans are closed, never dropped ----

    @Test
    fun `a source transition closes the open rebuffer span before it resets`() {
        attached()
        val l = facade.listener!!
        l.onMediaItemTransition(eventTime(), hlsItem(), Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED)
        l.onRenderedFirstFrame(eventTime(), Any(), 0L)
        l.onPlaybackStateChanged(eventTime(), Player.STATE_BUFFERING)
        now += 500
        l.onMediaItemTransition(eventTime(), hlsItem("https://cdn.example.com/vod/b.m3u8"), Player.MEDIA_ITEM_TRANSITION_REASON_AUTO)
        // The buffer_end lands BEFORE the new source_change, so the
        // accumulator's union span closes instead of running to session end.
        val types = ctx.types()
        assertEquals(1, types.count { it == "buffer_end" })
        assertEquals(500L, ctx.last("buffer_end").data!!["durationMs"])
        assertTrue(types.indexOf("buffer_end") < types.lastIndexOf("source_change"))
    }

    @Test
    fun `detach closes an open play and an open rebuffer span`() {
        val i = attached()
        val l = facade.listener!!
        l.onMediaItemTransition(eventTime(), hlsItem(), Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED)
        l.onRenderedFirstFrame(eventTime(), Any(), 0L)
        l.onIsPlayingChanged(eventTime(), true)
        l.onPlaybackStateChanged(eventTime(), Player.STATE_BUFFERING)
        now += 250
        i.detach()
        val tail = ctx.types().takeLast(2)
        assertEquals(setOf("buffer_end", "pause"), tail.toSet())
        assertEquals(250L, ctx.last("buffer_end").data!!["durationMs"])
    }

    @Test
    fun `a released player closes its spans too`() {
        attached()
        val l = facade.listener!!
        l.onIsPlayingChanged(eventTime(), true)
        l.onPlayerReleased(eventTime())
        assertEquals(1, ctx.types().count { it == "pause" })
    }

    // ---- Round-2, I12: dropped frames are a cumulative counter with an
    // acknowledged watermark, not a read-and-zero ----

    @Test
    fun `an unsampled item's dropped frames fold into the next stats instead of being discarded`() {
        // Round-1's I12 zeroed the counter at every media-item boundary, which
        // this test used to assert. That inverted the loss: the outgoing
        // item's frames were thrown away without ever being emitted. Nothing
        // in the protocol attributes `stats.droppedFrames` to an item, so
        // carrying them is strictly more honest than deleting them.
        val i = attached()
        val l = facade.listener!!
        l.onMediaItemTransition(eventTime(), hlsItem(), Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED)
        facade.state = Media3PlayerState(0, 0, videoFormat(1_000_000, 640, 360), false, hlsItem())
        l.onDroppedVideoFrames(eventTime(), 9, 1000)
        l.onMediaItemTransition(eventTime(), hlsItem("https://cdn.example.com/vod/b.m3u8"), Player.MEDIA_ITEM_TRANSITION_REASON_AUTO)
        var got: PlayerSnapshot? = null
        i.snapshot { got = it; true }
        assertEquals(9, got!!.droppedFramesDelta)
        // ...and once acknowledged, they are not reported twice.
        i.snapshot { got = it; true }
        assertEquals(0, got!!.droppedFramesDelta)
    }

    @Test
    fun `a snapshot the controller refuses leaves its dropped-frame delta owed`() {
        // Codex round-2, Important 12. The delta used to be zeroed at read
        // time, so a snapshot the controller then dropped — landing after a
        // detach, or against a replaced collector — silently swallowed those
        // frames. The counter is cumulative now and its watermark only moves
        // on an accepted result.
        val i = attached()
        val l = facade.listener!!
        l.onMediaItemTransition(eventTime(), hlsItem(), Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED)
        facade.state = Media3PlayerState(0, 0, videoFormat(1_000_000, 640, 360), false, hlsItem())
        l.onDroppedVideoFrames(eventTime(), 4, 1000)

        var got: PlayerSnapshot? = null
        i.snapshot { got = it; false }        // the controller rejected it
        assertEquals(4, got!!.droppedFramesDelta)

        l.onDroppedVideoFrames(eventTime(), 3, 1000)
        i.snapshot { got = it; true }         // ...and this one is accepted
        assertEquals("the refused delta must fold into the next accepted one", 7, got!!.droppedFramesDelta)

        i.snapshot { got = it; true }
        assertEquals(0, got!!.droppedFramesDelta)
    }

    // ---- Round-2, I10: a subscription that never happened is not an attach ----

    @Test
    fun `attach returns false when the listener subscription throws`() {
        facade.failAddListener = true
        val i = integration()
        assertFalse("a player with no analytics listener must not be registered", i.attach(ctx))
        assertNull(facade.listener)
        assertEquals("nothing may be emitted for a refused attach", 0, ctx.emitted.size)
        // A refused attach leaves nothing attached, so a later detach is inert
        // and a retry (once the player is healthy) is still possible.
        i.detach()
        facade.failAddListener = false
        assertTrue(i.attach(ctx))
    }

    @Test
    fun `attach returns false when the player thread rejects the post`() {
        // `Handler.post` answers false once the looper is quitting. The
        // registration used to survive that as a live, permanently
        // un-unsubscribable player.
        val i = integration(post = rejecting())
        assertFalse(i.attach(ctx))
        assertNull(facade.listener)
    }

    @Test
    fun `an asynchronous subscription failure releases the registration instead of orphaning it`() {
        // attach() has already returned true by the time a POSTED
        // addAnalyticsListener throws, so the failure routes through the same
        // release hook a real onPlayerReleased uses — which is what
        // unregisters the player from the vitals registry.
        var releases = 0
        val i = integration(post = deferred())
        i.onReleased = { releases++ }
        assertTrue("the failure is not yet visible", i.attach(ctx))
        facade.failAddListener = true
        drain()
        assertEquals("the orphaned registration must be released", 1, releases)
        assertNull(facade.listener)
    }

    // ---- Round-2, I11: a seed that joins a playing player opens the span ----

    @Test
    fun `attaching to a playing player emits play exactly once`() {
        facade.state = Media3PlayerState(0, 0, videoFormat(1_000_000, 640, 360), false, hlsItem(), isPlaying = true)
        val i = attached()
        assertEquals(1, ctx.types().count { it == "play" })

        // A real callback arriving afterwards must not re-open the span. Since
        // Codex round-7, #1 a duplicate open is a no-op at the accumulator
        // rather than a span left running to the end of the session, but the
        // timeline is still the record of what the player DID: one continuous
        // playback is one `play`, not one per listener callback.
        facade.listener!!.onIsPlayingChanged(eventTime(), true)
        assertEquals(1, ctx.types().count { it == "play" })

        // ...and a real pause closes it and re-arms the latch.
        facade.listener!!.onIsPlayingChanged(eventTime(), false)
        facade.listener!!.onIsPlayingChanged(eventTime(), true)
        assertEquals(listOf("play", "pause", "play"), ctx.types().filter { it == "play" || it == "pause" })
        assertNotNull(i)
    }

    // ---- Round-2, I13: detach's span closes run on the player thread ----

    @Test
    fun `detach closes its open spans on the player thread, not on the caller's`() {
        // The closes used to be non-atomic read-then-clear pairs run from the
        // shutdown thread against fields the player thread writes, so a
        // concurrent READY / isPlaying=false could make both threads emit the
        // same buffer_end or pause and double-close a union span.
        val i = integration(post = deferred())
        assertTrue(i.attach(ctx))
        drain()
        val l = facade.listener!!
        l.onMediaItemTransition(eventTime(), hlsItem(), Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED)
        l.onRenderedFirstFrame(eventTime(), Any(), 0L)
        l.onIsPlayingChanged(eventTime(), true)
        l.onPlaybackStateChanged(eventTime(), Player.STATE_BUFFERING)
        now += 250

        i.detach()
        assertTrue(
            "nothing may be emitted on the detaching thread",
            ctx.types().none { it == "buffer_end" || it == "pause" },
        )
        assertNotNull("the listener is still installed until the post runs", facade.listener)

        drain()
        assertEquals(setOf("buffer_end", "pause"), ctx.types().takeLast(2).toSet())
        assertEquals(250L, ctx.last("buffer_end").data!!["durationMs"])
        assertNull(facade.listener)
    }

    @Test
    fun `a detach whose post is rejected still closes its spans and clears the attachment`() {
        var looperAlive = true
        val i = Media3Integration(facade, { false }, { r -> if (looperAlive) { r.run(); true } else false }, { now })
        assertTrue(i.attach(ctx))
        facade.listener!!.onIsPlayingChanged(eventTime(), true)
        looperAlive = false
        i.detach()   // the post is refused: a dead looper cannot be racing us
        assertEquals(1, ctx.types().count { it == "pause" })
        // Re-attaching is possible again, i.e. `attached`/`ctx` were cleared.
        looperAlive = true
        assertTrue(i.attach(ctx))
    }

    // ---- I13: the source-query option is resolved at attach time ----

    @Test
    fun `captureSourceQuery is resolved when the integration attaches, not when it was constructed`() {
        var enabled = false
        val i = integration(keepQuery = { enabled })
        // The registration was made while no configuration existed (pre-start
        // / post-kill); the option only becomes true by the time the runtime
        // drains it into a controller.
        enabled = true
        assertTrue(i.attach(ctx))
        facade.listener!!.onMediaItemTransition(eventTime(), hlsItem(), Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED)
        assertEquals("https://cdn.example.com/live/master.m3u8?token=abc", ctx.last("source_change").data!!["src"])
    }

    // ---- I14: DRM seeded from the item being joined ----

    @Test
    fun `a seeded drm scheme does not swallow the first real keys-loaded callback`() {
        // Codex round-3, Important 8. `attach()`'s seed (and onFirstFrame's
        // `{keySystem: "none"}`) set `lastDrm`, and the keys-loaded guard used
        // to key on THAT — so the first real callback bailed out and the
        // measured `licenseMs` was never emitted at all. A separate latch lets
        // the real callback enrich and re-emit the seed.
        facade.state = Media3PlayerState(0, 0, videoFormat(1_000_000, 640, 360), false, drmItem(), isPlaying = true)
        val i = attached()
        assertEquals("widevine", ctx.last("drm").data!!["keySystem"])
        assertFalse(ctx.last("drm").data!!.containsKey("licenseMs"))

        val l = i.listener
        l.onDrmSessionAcquired(eventTime(), 0)
        now += 120
        l.onDrmKeysLoaded(eventTime())

        val drm = ctx.last("drm").data!!
        assertEquals("widevine", drm["keySystem"])
        assertEquals("the measured license time must reach the timeline", 120L, drm["licenseMs"])
        assertEquals("exactly two drm events: the seed and the measured one", 2, ctx.types().count { it == "drm" })

        // A later key rotation still folds into the first measurement.
        l.onDrmKeysLoaded(eventTime())
        assertEquals(2, ctx.types().count { it == "drm" })
    }

    @Test
    fun `attaching mid-rebuffer opens the buffer span that media3 will never replay`() {
        // Codex round-3, Important 9. Media3 does not replay the
        // `STATE_BUFFERING` transition for a listener added mid-stall, so a
        // player joined while it was already rebuffering contributed neither
        // the event nor its duration to the session.
        facade.state = Media3PlayerState(
            0, 0, videoFormat(1_000_000, 640, 360), false, hlsItem(),
            isPlaying = true, playbackState = Player.STATE_BUFFERING,
        )
        val i = attached()
        assertTrue("the in-progress rebuffer must be opened", ctx.types().contains("buffer_start"))

        now += 700
        i.listener.onPlaybackStateChanged(eventTime(), Player.STATE_READY)
        assertEquals(700L, ctx.last("buffer_end").data!!["durationMs"])
    }

    @Test
    fun `attaching before the first frame treats buffering as startup, not as a rebuffer`() {
        // The other side of Important 9: buffering before the first frame IS
        // startup, and `onFirstFrame()` reports it. Opening a rebuffer span
        // there would double-count the launch as a stall.
        facade.state = Media3PlayerState(0, 0, null, false, hlsItem(), isPlaying = false, playbackState = Player.STATE_BUFFERING)
        attached()
        assertFalse(ctx.types().contains("buffer_start"))
    }

    @Test
    fun `an off-thread detach closes its spans and only then reports completion`() {
        // Codex round-3, Important 6. `detach()` used to post the closes and
        // return, so the controller recorded `player_detach` first and the
        // `buffer_end`/`pause` landed after it — or, during a shutdown, never,
        // because the collector was already stopped. One runnable now closes
        // the spans AND signals completion, and the controller emits its
        // marker from that callback.
        val i = integration(post = deferred())
        assertTrue(i.attach(ctx))
        drain()
        val l = facade.listener!!
        l.onMediaItemTransition(eventTime(), hlsItem(), Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED)
        l.onRenderedFirstFrame(eventTime(), Any(), 0L)
        l.onIsPlayingChanged(eventTime(), true)
        l.onPlaybackStateChanged(eventTime(), Player.STATE_BUFFERING)

        var completed = 0
        i.detach { completed++ }
        assertEquals("completion may not be reported before the teardown runs", 0, completed)

        drain()
        assertEquals(1, completed)
        assertTrue(ctx.types().contains("buffer_end"))
        assertTrue(ctx.types().contains("pause"))
    }

    @Test
    fun `a detach whose post is rejected still reports completion, and so does a second detach`() {
        // Important 6: the completion callback fires on EVERY path, or the
        // controller's shutdown drain would wait out its whole timeout and the
        // `player_detach` marker would never be recorded.
        var reject = false
        val i = Media3Integration(facade, { false }, { r -> if (reject) false else { r.run(); true } }, { now })
        assertTrue(i.attach(ctx))
        reject = true

        var completed = 0
        i.detach { completed++ }
        assertEquals("a dead looper runs the teardown here and still completes", 1, completed)

        var second = 0
        i.detach { second++ }
        assertEquals("detaching an already-detached integration completes immediately", 1, second)
    }

    @Test
    fun `attaching to a player whose keys already loaded seeds the drm scheme without inventing timings`() {
        facade.state = Media3PlayerState(0, 0, videoFormat(1_000_000, 640, 360), false, drmItem(), isPlaying = true)
        attached()
        val drm = ctx.last("drm").data!!
        assertEquals("widevine", drm["keySystem"])
        assertFalse("license timing is measured, never guessed", drm.containsKey("licenseMs"))
    }

    @Test
    fun `a clear item still starting up seeds no drm on attach`() {
        // Before the first frame `onFirstFrame()` is what reports
        // `keySystem: "none"`, and it will still run — so the seed leaves it
        // alone. (Codex round-5, #10 is the other half: past the first frame
        // that callback never comes.)
        facade.state = Media3PlayerState(
            0, 0, null, false, hlsItem(),
            isPlaying = false, playbackState = Player.STATE_BUFFERING,
        )
        val i = attached()
        assertTrue(ctx.emitted.none { it.type == "drm" })

        i.listener.onMediaItemTransition(eventTime(), hlsItem(), Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED)
        i.listener.onRenderedFirstFrame(eventTime(), Any(), 0L)
        assertEquals("none", ctx.last("drm").data!!["keySystem"])
    }

    @Test
    fun `a clear item joined past its first frame is reported as keySystem none`() {
        // Codex round-5, #10. `attach()`'s seed only ever seeded DRM when the
        // item declared a scheme, and Media3 does not replay
        // `onRenderedFirstFrame` for a listener added mid-playback — so
        // joining a clear stream already on screen left `lastDrm` null
        // forever: unknown DRM in the timeline, and nothing to reseed on a
        // session rotation.
        facade.state = Media3PlayerState(
            0, 0, videoFormat(1_000_000, 640, 360), false, hlsItem(),
            isPlaying = false, playbackState = Player.STATE_READY,
        )
        attached()

        val drm = ctx.emitted.filter { it.type == "drm" }
        assertEquals("exactly one drm entry, not one per later event", 1, drm.size)
        assertEquals("none", drm[0].data!!["keySystem"])
        assertFalse("license timing is measured, never guessed", drm[0].data!!.containsKey("licenseMs"))
    }

    // ---- N2: the seed never re-arms a latch a real transition already reset ----

    @Test
    fun `a seed arriving after a real transition does not suppress the new item's startup`() {
        // N2: `firstFrameSeen` used to be set ABOVE the "a real transition
        // beat me to it" bail, so a late seed re-armed it from the player's
        // PRE-transition state and the new item never reported startup.
        facade.state = Media3PlayerState(0, 0, videoFormat(1_000_000, 640, 360), false, hlsItem(), isPlaying = true)
        val i = integration(post = deferred())
        assertTrue(i.attach(ctx))
        // The transition lands first (the seed is still queued).
        i.listener.onMediaItemTransition(eventTime(), hlsItem(), Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED)
        drain()
        now += 700
        i.listener.onRenderedFirstFrame(eventTime(), Any(), 0L)
        assertEquals(700L, ctx.last("startup").data!!["ttffMs"])
    }

    // ---- M1: the non-fatal error limiter is a rolling window ----

    @Test
    fun `the non-fatal error limiter never allows twenty errors inside one rolling minute`() {
        attached()
        val l = facade.listener!!
        fun loadError() = l.onLoadError(eventTime(), loadInfo("https://h/s.ts"), loadData(C.DATA_TYPE_MEDIA), IOException("x"), false)
        fun count() = ctx.emitted.count { it.type == "error" && it.data!!["fatal"] == false }

        val t0 = now
        repeat(6) { loadError() }
        assertEquals(6, count())
        now = t0 + 59_000
        repeat(6) { loadError() }
        assertEquals("the window is full at ten", 10, count())

        // A fixed window would reset wholesale here and allow ten more; the
        // rolling one only frees the six that have actually aged out.
        now = t0 + 60_001
        repeat(10) { loadError() }
        assertEquals(16, count())
    }

    @Test
    fun `a rejected load error costs nothing from the ten-a-minute allowance`() {
        // Codex round-5, #9. The allowance was charged before the emission was
        // made, so ten load errors while no collector existed — before remote
        // config enables vitals, say — left the ring and the summary empty AND
        // suppressed every error for the rest of that minute, which is exactly
        // the minute worth capturing.
        attached()
        val l = facade.listener!!
        fun loadError() = l.onLoadError(eventTime(), loadInfo("https://h/s.ts"), loadData(C.DATA_TYPE_MEDIA), IOException("x"), false)
        fun accepted() = ctx.emitted.count { it.type == "error" && it.data!!["fatal"] == false }

        ctx.accepts = false
        repeat(10) { loadError() }
        assertEquals("precondition: every one of them was attempted", 10, accepted())

        // The collector appears (vitals just got enabled) — the very next
        // error must still get through.
        ctx.accepts = true
        loadError()
        assertEquals("a rejected error must not consume the allowance", 11, accepted())
    }

    // ---- Codex round-4, #9: a selected videoFormat is not proof of a
    // rendered frame ----

    @Test
    fun `attaching during startup does not treat the launch buffer as a rebuffer`() {
        // ExoPlayer resolves `videoFormat` during track selection, long before
        // the first frame reaches the screen. The seed used to read that as
        // "past startup", so joining a player mid-LAUNCH recorded the launch's
        // own STATE_BUFFERING as a rebuffer and made the later
        // `onRenderedFirstFrame` return early — the `startup` event and its
        // ttff were lost outright while rebuffer metrics counted a stall that
        // never happened.
        facade.state = Media3PlayerState(
            0, 0, videoFormat(1_000_000, 640, 360), false, hlsItem(),
            isPlaying = false, playbackState = Player.STATE_BUFFERING,
        )
        val i = attached()

        assertFalse("startup buffering is not a rebuffer", ctx.types().contains("buffer_start"))
        assertNull("...and the first frame has NOT been seen", i.startupTimings())

        // The real callback still closes startup, and reports it.
        i.listener.onMediaItemTransition(eventTime(), hlsItem(), Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED)
        now += 900
        i.listener.onRenderedFirstFrame(eventTime(), Any(), 0L)
        assertEquals(900L, ctx.last("startup").data!!["ttffMs"])
    }

    @Test
    fun `attaching to a live stream still starting up does not treat its buffer as a rebuffer`() {
        // The position heuristic below is deliberately NOT applied to live
        // streams: their start position is nonzero by construction, so it
        // would always pass and re-open exactly the hole this closes.
        facade.state = Media3PlayerState(
            30_000, 30_000, videoFormat(1_000_000, 640, 360), true, hlsItem(),
            isPlaying = false, playbackState = Player.STATE_BUFFERING,
        )
        val i = attached()
        assertFalse(ctx.types().contains("buffer_start"))
        assertNull(i.startupTimings())
    }

    @Test
    fun `attaching mid-rebuffer to a VOD player whose position has advanced still opens the span`() {
        // Round-3, Important 9 must survive #9. A VOD player stalled at a
        // position past zero has demonstrably played, so this stall IS a
        // rebuffer — that is the documented heuristic standing in for the
        // "first frame rendered" getter ExoPlayer does not expose.
        facade.state = Media3PlayerState(
            4_500, 5_000, videoFormat(1_000_000, 640, 360), false, hlsItem(),
            isPlaying = false, playbackState = Player.STATE_BUFFERING,
        )
        val i = attached()

        assertTrue("the in-progress rebuffer must still be opened", ctx.types().contains("buffer_start"))
        now += 700
        i.listener.onPlaybackStateChanged(eventTime(), Player.STATE_READY)
        assertEquals(700L, ctx.last("buffer_end").data!!["durationMs"])
    }

    @Test
    fun `attaching to a ready player counts as past the first frame`() {
        // A video renderer only reports READY once it has rendered a frame.
        facade.state = Media3PlayerState(
            0, 0, videoFormat(1_000_000, 640, 360), false, hlsItem(),
            isPlaying = false, playbackState = Player.STATE_READY,
        )
        val i = attached()
        assertNotNull("STATE_READY is first-frame evidence", i.startupTimings())

        // ...so the NEXT buffering is a rebuffer, not startup.
        i.listener.onPlaybackStateChanged(eventTime(), Player.STATE_BUFFERING)
        assertTrue(ctx.types().contains("buffer_start"))
    }

    // ---- Codex round-7, #1: nobody owns the initial opening spans ----

    /**
     * An already-playing player. `attach()`'s seed opens the `play` span the
     * player is already inside (round-2 I11) — Media3 never replays
     * `onIsPlayingChanged(true)` for a listener added mid-playback.
     */
    private fun alreadyPlaying() {
        facade.state = Media3PlayerState(
            currentPositionMs = 4_000,
            bufferedPositionMs = 9_000,
            videoFormat = videoFormat(1_600_000, 854, 480),
            isLive = true,
            currentMediaItem = hlsItem(),
            isPlaying = true,
        )
    }

    private fun plays(c: RecordingContext) = c.types().count { it == "play" }

    @Test
    fun `a seed landing between the announce and the describe leaves both free to open the span`() {
        // Codex round-6 #5, re-ruled by round-7 #1. `attach()` posts the seed
        // to the player thread and the registering thread records
        // `player_attach` and calls `describe()` right after; when the seed
        // lands in between, BOTH emit `play` into the same announcement. Three
        // rounds of latches tried to decide which one should stay silent, and
        // each left an ordering where the span was lost instead. The duplicate
        // is now absorbed by `SummaryAccumulator`, whose union span tracks
        // which players are inside it rather than counting opens — so the
        // integration says everything it knows, every time, and the rotation
        // reseed (the case a silent describe used to break) is guaranteed.
        alreadyPlaying()
        // `accepts == false` is "not announced yet": the controller refuses a
        // player emission until that player's own `player_attach` is in the
        // timeline.
        ctx.accepts = false
        val i = integration(post = deferred())
        assertTrue(i.attach(ctx))

        ctx.accepts = true      // player_attach accepted — the announcement exists
        drain()                 // ...and the seed lands inside it
        assertEquals("precondition: the seed opened the span", 1, plays(ctx))

        val describeCtx = RecordingContext { now }
        i.describe(describeCtx)
        drain()                 // round-8, #2: the describe runs on the player thread

        assertEquals("the first describe re-states the open; the accumulator absorbs it", 1, plays(describeCtx))
        assertTrue("...along with identity", describeCtx.types().contains("source_change"))

        // A ROTATION reseed is what this must never miss: the new session's
        // accumulator has never seen this span, so it has to be re-opened.
        val reseedCtx = RecordingContext { now }
        i.describe(reseedCtx)
        drain()
        assertEquals("a rotation reseed must re-open the ongoing span", 1, plays(reseedCtx))
    }

    @Test
    fun `a describe issued while the seed is queued runs after it and states the full picture`() {
        // Ordering: announce -> describe -> seed. Round 7 had `describe()`
        // run on the announcing thread, so it could only report what was
        // known THEN — `playing` still false, `lastSource` still null — and
        // it retained the context for the seed to replay.
        //
        // Codex round-8, #2: the describe is POSTED to the player thread, the
        // same looper the seed was posted to, so the looper's FIFO orders it
        // after the seed and it simply reads the seeded state. No replay, no
        // latch: the "describe arrived mid-seed" case cannot occur.
        alreadyPlaying()
        val i = integration(post = deferred())
        assertTrue(i.attach(ctx))

        val describeCtx = RecordingContext { now }
        i.describe(describeCtx)
        assertTrue("nothing is emitted before the post runs", describeCtx.emitted.isEmpty())

        drain() // the seed, then the describe

        assertTrue("the describe states identity", describeCtx.types().contains("source_change"))
        assertEquals("...and opens the ongoing span", 1, plays(describeCtx))
    }

    @Test
    fun `a describe cannot reopen a span the player thread just closed`() {
        // THE round-8 #2 finding. `describe()` runs for a server re-enable on
        // the config thread and used to read `playing` there; between that
        // read and its emission the player thread could record a `pause`, and
        // the describe then recorded a stale `play` into the SAME
        // announcement. No idempotent set rejects a valid close followed by a
        // stale open, so the summary went on accruing playtime for a player
        // the viewer had paused.
        //
        // Scripted as the real interleaving: the describe is issued while the
        // player is playing, the player thread handles the pause first, and
        // the describe then runs — on that same thread, so it reads
        // `playing == false` and says nothing about playback.
        alreadyPlaying()
        val i = integration(post = deferred())
        assertTrue(i.attach(ctx))
        drain()
        assertEquals("precondition: the seed opened the span", 1, plays(ctx))

        val describeCtx = RecordingContext { now }
        i.describe(describeCtx) // announced on another thread; queued

        // The player thread gets there first and legitimately closes the span.
        i.listener.onIsPlayingChanged(eventTime(), false)
        assertTrue(ctx.types().contains("pause"))

        drain() // ...and only now does the describe read the state

        assertEquals("a describe must never reopen a span the player thread closed", 0, plays(describeCtx))
        assertTrue("...though identity is still restated", describeCtx.types().contains("source_change"))
    }

    @Test
    fun `a describe cannot reopen a rebuffer span the player thread just closed`() {
        // The same race through `bufferStartAt`, which the finding names
        // alongside `playing`.
        facade.state = Media3PlayerState(4_000, 9_000, null, false, hlsItem(), isPlaying = true)
        val i = integration(post = deferred())
        assertTrue(i.attach(ctx))
        drain()
        i.listener.onPlaybackStateChanged(eventTime(), Player.STATE_BUFFERING)
        assertTrue("precondition: a rebuffer span is open", ctx.types().contains("buffer_start"))

        val describeCtx = RecordingContext { now }
        i.describe(describeCtx)

        i.listener.onPlaybackStateChanged(eventTime(), Player.STATE_READY)
        assertTrue(ctx.types().contains("buffer_end"))

        drain()

        assertFalse(
            "a describe must never reopen a rebuffer span the player thread closed",
            describeCtx.types().contains("buffer_start"),
        )
    }

    @Test
    fun `a describe onto a dead looper emits nothing`() {
        // A rejected post means the looper is gone: the player is unusable and
        // nothing can truthfully be said about its state, so the describe says
        // nothing rather than reporting from another thread what only the
        // player thread may read.
        alreadyPlaying()
        var alive = true
        val i = Media3Integration(facade, { false }, { r -> if (alive) { r.run(); true } else false }, { now })
        assertTrue(i.attach(ctx))
        assertEquals("precondition: the player is playing and its identity is known", 1, plays(ctx))

        alive = false // the looper quits
        val describeCtx = RecordingContext { now }
        i.describe(describeCtx)

        assertTrue(describeCtx.emitted.isEmpty())
    }

    @Test
    fun `an inline seed emitted before the announcement leaves the open to the first describe`() {
        // The common case: `trackPlayer()` called on the player thread runs
        // the seed INLINE, inside `attach()` — before the player has been
        // announced, so every emission it makes is refused. The first
        // `describe()` is then the only chance to open the span, and it must
        // take it. It runs inline too (the post is inline), so the ordering is
        // trivially serial.
        alreadyPlaying()
        ctx.accepts = false
        val i = integration(post = inline())
        assertTrue(i.attach(ctx))
        // The attempt is recorded either way; what matters is that the
        // controller REFUSED it, which `accepts = false` is standing in for.
        assertEquals("precondition: the inline seed did attempt the open", 1, plays(ctx))

        ctx.accepts = true
        val describeCtx = RecordingContext { now }
        i.describe(describeCtx)

        assertEquals("the announce describe must open the span the refused seed could not", 1, plays(describeCtx))
    }

    @Test
    fun `a re-attach describes the new attachment's own seeded state`() {
        // `closeAndTearDown` forgets everything the previous attachment knew,
        // and the next `attach()` posts a fresh seed. A describe issued
        // against the new attachment must report what THAT seed found — which
        // the looper guarantees by ordering it behind the seed, with no
        // reconciliation machinery of any kind.
        facade.state = Media3PlayerState(0, 0, null, false, hlsItem(), isPlaying = false)
        val i = integration(post = deferred())
        assertTrue(i.attach(ctx))
        drain()
        i.detach()
        drain()

        alreadyPlaying() // the player is playing by the time it is re-attached
        assertTrue(i.attach(ctx))
        val describeCtx = RecordingContext { now }
        i.describe(describeCtx)

        drain() // the second seed reads the player, then the describe runs

        assertEquals("the describe carries the span the new seed discovered", 1, plays(describeCtx))
    }

    // ---- Codex round-9, #2: the whole attach transition runs on the player thread ----

    @Test
    fun `a re-attach queued behind a refused attachment's teardown keeps the replacement's context`() {
        // Codex round-9, #2. `VitalsController.trackPlayer` answers null when
        // it was shut down between reserving and publishing, and
        // `VitalsRuntime` retries THE SAME integration against the replacement
        // controller (round-8, #3). That refusal path calls
        // `integration.detach()`, which only POSTS its teardown and returns —
        // so the retry's `attach()` used to write the new `ctx` on the
        // caller's thread and have the still-queued teardown clear it a moment
        // later, while the retry's own posted subscription restored nothing.
        // The handle reported attached and every later callback disappeared
        // from timeline AND summary.
        //
        // The three posts below are exactly that interleaving: attach(A),
        // detach (the refusal), attach(B), all queued before the looper runs
        // any of them.
        val ctxB = RecordingContext { now }
        val i = integration(post = deferred())
        assertTrue("the runtime hands this player to controller A", i.attach(ctx))
        i.detach()                                  // A refuses for shutdown; teardown is POSTED
        assertTrue("...and the runtime retries against B", i.attach(ctxB))

        drain()

        assertSame("the replacement's subscription must survive the queued teardown", i.listener, facade.listener)
        facade.listener!!.onIsPlayingChanged(eventTime(), true)
        assertEquals("playback must reach the replacement's context", 1, plays(ctxB))
        assertEquals("nothing may reach the superseded one", 0, plays(ctx))

        // ...and the integration really is attached, not merely holding a
        // context: `snapshot()` refuses outright when it is not.
        var got: PlayerSnapshot? = null
        i.snapshot { got = it; true }
        drain()
        assertNotNull("a live attachment must still report stats", got)
    }

    @Test
    fun `a plain re-attach after a fully drained detach still attaches`() {
        // The ordinary case the fix must not break: nothing is left queued, so
        // the second attach starts from a clean teardown.
        val i = integration(post = deferred())
        assertTrue(i.attach(ctx))
        drain()
        i.detach()
        drain()
        assertNull("precondition: the player is left clean", facade.listener)

        val ctxB = RecordingContext { now }
        assertTrue(i.attach(ctxB))
        drain()

        assertSame(i.listener, facade.listener)
        facade.listener!!.onIsPlayingChanged(eventTime(), true)
        assertEquals(1, plays(ctxB))
        assertEquals(0, plays(ctx))
    }

    @Test
    fun `a second attach while one is already live leaves the first attachment alone`() {
        // The caller-thread `if (attached) return true` early return was the
        // race, so the guard moved INTO the runnable, where the player thread
        // decides it. A genuine double attach still wins for the first one.
        val i = integration(post = deferred())
        assertTrue(i.attach(ctx))
        drain()
        val ctxB = RecordingContext { now }
        assertTrue("the post is accepted", i.attach(ctxB))
        drain()

        assertEquals("a double attach must not subscribe twice", 1, facade.listeners.size)
        facade.listener!!.onIsPlayingChanged(eventTime(), true)
        assertEquals("the first attachment's context is the live one", 1, plays(ctx))
        assertEquals(0, plays(ctxB))
    }
}
