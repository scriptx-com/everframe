// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.media3

import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@UnstableApi
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class Media3IntegrationStateTest {
    private var now = 10_000L
    private val facade = FakeFacade()
    private val ctx = RecordingContext { now }
    private fun integration(keepQuery: Boolean = false) =
        Media3Integration(facade, captureSourceQuery = { keepQuery }, postOnPlayerThread = { it.run(); true }, now = { now }).also { assertTrue(it.attach(ctx)) }
    private val l get() = facade.listener!!
    private fun position(ms: Long) = Player.PositionInfo(null, 0, null, null, 0, ms, ms, C.INDEX_UNSET, C.INDEX_UNSET)

    @Test
    fun `attach emits nothing until an event, and registers exactly one listener`() {
        integration()
        assertEquals(0, ctx.emitted.size)
        assertTrue(facade.listener != null)
    }

    @Test
    fun `media item transition emits a sanitised source_change with protocol from the mime type`() {
        integration()
        facade.state = facade.state.copy(isLive = true)
        l.onMediaItemTransition(eventTime(), hlsItem(), Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED)
        val e = ctx.last("source_change")
        assertEquals("https://cdn.example.com/live/master.m3u8", e.data!!["src"])
        assertEquals("hls", e.data["protocol"]); assertEquals("application/x-mpegURL", e.data["mime"]); assertEquals(true, e.data["live"])
    }

    @Test
    fun `captureSourceQuery keeps the query`() {
        integration(keepQuery = true)
        l.onMediaItemTransition(eventTime(), hlsItem(), Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED)
        assertEquals("https://cdn.example.com/live/master.m3u8?token=abc", ctx.last("source_change").data!!["src"])
    }

    @Test
    fun `startup is measured from the transition, with manifest and first fragment timings, once per item`() {
        integration()
        l.onMediaItemTransition(eventTime(), hlsItem(), Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED)
        now += 210; l.onLoadCompleted(eventTime(), loadInfo("https://h/m.m3u8"), loadData(C.DATA_TYPE_MANIFEST))
        now += 430; l.onLoadCompleted(eventTime(), loadInfo("https://h/seg1.ts"), loadData(C.DATA_TYPE_MEDIA, C.TRACK_TYPE_VIDEO))
        now += 660; l.onRenderedFirstFrame(eventTime(), Any(), 0L)
        l.onRenderedFirstFrame(eventTime(), Any(), 0L)
        val s = ctx.emitted.filter { it.type == "startup" }
        assertEquals(1, s.size)
        assertEquals(1300L, s[0].data!!["ttffMs"]); assertEquals(210L, s[0].data!!["manifestMs"]); assertEquals(640L, s[0].data!!["firstFragmentMs"])
        assertEquals("none", ctx.last("drm").data!!["keySystem"])  // clear item → drm none on first frame
    }

    @Test
    fun `no per-segment entries ever`() {
        integration()
        l.onMediaItemTransition(eventTime(), hlsItem(), Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED)
        repeat(50) { l.onLoadCompleted(eventTime(), loadInfo("https://h/seg$it.ts"), loadData(C.DATA_TYPE_MEDIA, C.TRACK_TYPE_VIDEO)) }
        assertEquals(listOf("source_change"), ctx.types())
    }

    @Test
    fun `buffering before first frame is startup, after first frame it is a rebuffer with durationMs`() {
        integration()
        l.onMediaItemTransition(eventTime(), hlsItem(), Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED)
        l.onPlaybackStateChanged(eventTime(), Player.STATE_BUFFERING)
        l.onPlaybackStateChanged(eventTime(), Player.STATE_READY)
        l.onRenderedFirstFrame(eventTime(), Any(), 0L)
        assertTrue(ctx.types().none { it == "buffer_start" })
        l.onPlaybackStateChanged(eventTime(), Player.STATE_BUFFERING)
        now += 800
        l.onPlaybackStateChanged(eventTime(), Player.STATE_READY)
        assertEquals(800L, ctx.last("buffer_end").data!!["durationMs"])
        assertEquals(1, ctx.types().count { it == "buffer_start" })
    }

    @Test
    fun `play pause seek and rate`() {
        integration()
        l.onIsPlayingChanged(eventTime(), true); l.onIsPlayingChanged(eventTime(), false)
        l.onPositionDiscontinuity(eventTime(), position(9800), position(60000), Player.DISCONTINUITY_REASON_SEEK)
        l.onPositionDiscontinuity(eventTime(), position(1), position(2), Player.DISCONTINUITY_REASON_AUTO_TRANSITION)
        l.onPlaybackParametersChanged(eventTime(), PlaybackParameters(1.5f))
        assertEquals(listOf("play", "pause", "seek", "rate_change"), ctx.types())
        assertEquals(9800L, ctx.last("seek").data!!["fromMs"]); assertEquals(60000L, ctx.last("seek").data!!["toMs"])
        assertEquals(1.5, (ctx.last("rate_change").data!!["rate"] as Number).toDouble(), 0.0001)
    }

    @Test
    fun `detach removes the listener and startupTimings is null before first frame`() {
        val i = integration()
        assertNull(i.startupTimings())
        i.detach()
        assertNull(facade.listener)
    }
}
