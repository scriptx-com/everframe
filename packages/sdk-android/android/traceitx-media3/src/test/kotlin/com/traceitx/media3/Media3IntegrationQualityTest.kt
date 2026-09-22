// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.media3

import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.drm.DrmSession
import com.traceitx.vitals.PlayerSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.IOException

@UnstableApi
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class Media3IntegrationQualityTest {
    private var now = 10_000L
    private val facade = FakeFacade()
    private val ctx = RecordingContext { now }
    private var released = 0
    private fun integration() = Media3Integration(facade, captureSourceQuery = { false }, postOnPlayerThread = { it.run(); true }, now = { now })
        .also { it.onReleased = { released++ }; assertTrue(it.attach(ctx)) }
    private val l get() = facade.listener!!

    @Test
    fun `video format change emits bitrate_change with reason, unchanged format is suppressed`() {
        integration()
        val f = videoFormat(2_800_000, 1280, 720)
        l.onDownstreamFormatChanged(eventTime(), loadData(C.DATA_TYPE_MEDIA, C.TRACK_TYPE_VIDEO, f, C.SELECTION_REASON_ADAPTIVE))
        l.onDownstreamFormatChanged(eventTime(), loadData(C.DATA_TYPE_MEDIA, C.TRACK_TYPE_VIDEO, f, C.SELECTION_REASON_ADAPTIVE))
        l.onDownstreamFormatChanged(eventTime(), loadData(C.DATA_TYPE_MEDIA, C.TRACK_TYPE_AUDIO, videoFormat(128_000, 0, 0), C.SELECTION_REASON_ADAPTIVE))
        l.onDownstreamFormatChanged(eventTime(), loadData(C.DATA_TYPE_MEDIA, C.TRACK_TYPE_VIDEO, videoFormat(1_000_000, 640, 360), C.SELECTION_REASON_MANUAL))
        val b = ctx.emitted.filter { it.type == "bitrate_change" }
        assertEquals(2, b.size)
        assertEquals(mapOf("bitrate" to 2_800_000, "width" to 1280, "height" to 720, "reason" to "abr"), b[0].data)
        assertEquals("manual", b[1].data!!["reason"])
    }

    @Test
    fun `video size change emits quality_change`() {
        integration()
        l.onVideoSizeChanged(eventTime(), VideoSize(1920, 1080))
        assertEquals(mapOf("width" to 1920, "height" to 1080), ctx.last("quality_change").data)
    }

    @Test
    fun `drm acquired then keys loaded emits drm once per item with licenseMs and the mapped key system`() {
        integration()
        val item = MediaItem.Builder().setUri("https://h/m.mpd").setMimeType("application/dash+xml")
            .setDrmConfiguration(MediaItem.DrmConfiguration.Builder(C.WIDEVINE_UUID).build()).build()
        l.onMediaItemTransition(eventTime(), item, Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED)
        l.onDrmSessionAcquired(eventTime(), DrmSession.STATE_OPENED)
        now += 180
        l.onDrmKeysLoaded(eventTime()); l.onDrmKeysLoaded(eventTime())
        val d = ctx.emitted.filter { it.type == "drm" }
        assertEquals(1, d.size); assertEquals(mapOf("keySystem" to "widevine", "licenseMs" to 180L), d[0].data)
        l.onRenderedFirstFrame(eventTime(), Any(), 0L)
        assertEquals(1, ctx.emitted.count { it.type == "drm" })          // no 'none' fallback after a real drm
        assertEquals(180L, ctx.last("startup").data!!["licenseMs"])
    }

    @Test
    fun `fatal player error and rate-limited non-fatal load errors`() {
        integration()
        l.onPlayerError(eventTime(), PlaybackException("Source error", IOException("boom"), PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED))
        val fatal = ctx.last("error").data!!
        assertEquals("Source error", fatal["message"]); assertEquals("ERROR_CODE_IO_NETWORK_CONNECTION_FAILED", fatal["code"]); assertEquals(true, fatal["fatal"])
        repeat(15) { l.onLoadError(eventTime(), loadInfo("https://cdn.example.com/live/seg-$it.ts?token=x"), loadData(C.DATA_TYPE_MEDIA), IOException("timeout"), false) }
        l.onLoadError(eventTime(), loadInfo("https://h/c.ts"), loadData(C.DATA_TYPE_MEDIA), IOException("cancelled"), true)
        val nonFatal = ctx.emitted.filter { it.type == "error" && it.data!!["fatal"] == false }
        assertEquals(10, nonFatal.size)
        assertEquals("cdn.example.com/live/seg-0.ts", nonFatal[0].data!!["detail"])
        now += 60_001
        l.onLoadError(eventTime(), loadInfo("https://h/d.ts"), loadData(C.DATA_TYPE_MEDIA), IOException("timeout"), false)
        assertEquals(11, ctx.emitted.count { it.type == "error" && it.data!!["fatal"] == false })
    }

    @Test
    fun `snapshot reads on the player thread, returns null while idle, and reports dropped frame deltas`() {
        val i = integration()
        var got: PlayerSnapshot? = PlayerSnapshot(0, 0, 0, 0, 0, 0)
        i.snapshot { got = it; true }
        assertNull(got)
        l.onMediaItemTransition(eventTime(), hlsItem(), Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED)
        facade.state = Media3PlayerState(5_000, 17_400, videoFormat(2_800_000, 1280, 720), true, hlsItem())
        l.onBandwidthEstimate(eventTime(), 1000, 650_000, 5_200_000)
        l.onDroppedVideoFrames(eventTime(), 2, 1000); l.onDroppedVideoFrames(eventTime(), 1, 1000)
        i.snapshot { got = it; true }
        assertEquals(PlayerSnapshot(12_400, 5_200_000, 2_800_000, 1280, 720, 3), got)
        i.snapshot { got = it; true }
        assertEquals(0, got!!.droppedFramesDelta)
    }

    @Test
    fun `player release emits player_detach through the hook and removes the listener`() {
        val i = integration()
        l.onPlayerReleased(eventTime())
        assertEquals(1, released); assertNull(facade.listener)
        i.detach()   // idempotent after release
        assertEquals(1, released)
    }

    @Test
    fun `describe re-emits cached source and drm only`() {
        val i = integration()
        l.onMediaItemTransition(eventTime(), hlsItem(), Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED)
        l.onRenderedFirstFrame(eventTime(), Any(), 0L)
        val fresh = RecordingContext { now }
        i.describe(fresh)
        assertEquals(listOf("source_change", "drm"), fresh.types())
    }


    @Test
    fun `attaching to a player that is already playing seeds the source and reports stats without a transition`() {
        // Final review, I1. snapshot() used to refuse whenever lastSource was
        // null, and only onMediaItemTransition ever set it — so a player
        // attached after its first media item reported no stats for its whole
        // life. attach() now seeds from the facade.
        facade.state = Media3PlayerState(
            currentPositionMs = 4_000,
            bufferedPositionMs = 9_000,
            videoFormat = videoFormat(1_600_000, 854, 480),
            isLive = true,
            currentMediaItem = hlsItem(),
            isPlaying = true,
        )
        val i = Media3Integration(facade, captureSourceQuery = { false }, postOnPlayerThread = { it.run(); true }, now = { now })
        assertTrue(i.attach(ctx))

        // The seed announces the source the player is already on, and opens
        // the play span it is already inside (Codex round-2, Important 11 —
        // Media3 never replays onIsPlayingChanged(true) for a late listener).
        // The `drm` between them is Codex round-5, #10: this is a CLEAR item
        // joined past its first frame, so `onRenderedFirstFrame` — which is
        // what normally reports `keySystem: "none"` — will never come.
        assertEquals(listOf("play", "drm", "source_change"), ctx.types())
        assertEquals("none", ctx.last("drm").data!!["keySystem"])
        val src = ctx.last("source_change").data!!
        assertEquals("https://cdn.example.com/live/master.m3u8", src["src"])
        assertEquals("hls", src["protocol"])
        assertEquals(true, src["live"])

        // ...and stats flow with no transition callback at all.
        var got: PlayerSnapshot? = null
        i.snapshot { got = it; true }
        assertEquals(PlayerSnapshot(5_000, null, 1_600_000, 854, 480, 0), got)

        // The seed must NOT restart startup measurement: a BUFFERING now is a
        // rebuffer, and no `startup` is invented at the next rendered frame.
        facade.listener!!.onPlaybackStateChanged(eventTime(), Player.STATE_BUFFERING)
        assertTrue(ctx.types().contains("buffer_start"))
        facade.listener!!.onRenderedFirstFrame(eventTime(), Any(), 0L)
        assertTrue(ctx.emitted.none { it.type == "startup" })
    }

    @Test
    fun `a null media item resets the latches without announcing a source`() {
        val i = integration()
        l.onMediaItemTransition(eventTime(), hlsItem(), Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED)
        val before = ctx.emitted.count { it.type == "source_change" }
        l.onMediaItemTransition(eventTime(), null, Player.MEDIA_ITEM_TRANSITION_REASON_AUTO)
        // M6: no `source_change {src: "unknown"}` at playlist end, and the
        // last real source stays cached for describe()/snapshot().
        assertEquals(before, ctx.emitted.count { it.type == "source_change" })
        val fresh = RecordingContext { now }
        i.describe(fresh)
        assertEquals("https://cdn.example.com/live/master.m3u8", fresh.last("source_change").data!!["src"])
    }

    @Test
    fun `rate_change rounds the float speed to three decimals`() {
        integration()
        l.onPlaybackParametersChanged(eventTime(), PlaybackParameters(1.5f))
        assertEquals(1.5, ctx.last("rate_change").data!!["rate"])
        l.onPlaybackParametersChanged(eventTime(), PlaybackParameters(0.3333f))
        assertEquals(0.333, ctx.last("rate_change").data!!["rate"])
    }
}
