// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.media3

import android.net.Uri
import android.os.Looper
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.Timeline
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.source.LoadEventInfo
import androidx.media3.exoplayer.source.MediaLoadData
import androidx.media3.datasource.DataSpec
import com.traceitx.vitals.PlayerIntegrationContext

@UnstableApi
internal class FakeFacade : Media3PlayerFacade {
    /**
     * Codex round-8, #1 — a LIST. A tracked player carries two subscriptions
     * for a while: the declaration-time release observer
     * (`Media3Integration.observeRelease`, installed inside `trackPlayer()`)
     * and the integration's own analytics listener (installed by `attach()`).
     * A single-slot field silently modelled the second as replacing the first,
     * which is exactly the leak this round is about.
     */
    val listeners = ArrayList<AnalyticsListener>()

    /**
     * The most recently added listener — the integration's own once `attach()`
     * has run, which is what every pre-round-8 test means by `facade.listener`.
     * Null once nothing is subscribed at all, so `assertNull(facade.listener)`
     * still reads as "this player is left clean".
     */
    val listener: AnalyticsListener? get() = listeners.lastOrNull()

    var state = Media3PlayerState(0, 0, null, false, null)
    /** Codex round-2, Important 10: a player whose looper is gone rejects the subscription. */
    var failAddListener = false
    override fun addAnalyticsListener(l: AnalyticsListener) {
        if (failAddListener) throw IllegalStateException("player released")
        listeners.add(l)
    }
    override fun removeAnalyticsListener(l: AnalyticsListener) { listeners.remove(l) }
    override val applicationLooper: Looper? = null
    override fun readState() = state
}

internal class RecordingContext(private val clock: () -> Long) : PlayerIntegrationContext {
    data class Emitted(val type: String, val data: Map<String, Any?>?, val t: Long?)
    val emitted = ArrayList<Emitted>()
    /**
     * Codex round-5, #9 — what the controller would answer. `false` stands in
     * for "no collector / stopped / over-budget": the emission is still
     * recorded here so a test can see it was attempted, but the integration
     * must treat it as never having reached the timeline.
     */
    var accepts = true
    override fun emit(type: String, data: Map<String, Any?>?, t: Long?): Boolean {
        emitted.add(Emitted(type, data, t))
        return accepts
    }
    override fun now() = clock()
    fun types() = emitted.map { it.type }
    fun last(type: String) = emitted.last { it.type == type }
}

@UnstableApi
internal fun eventTime(): AnalyticsListener.EventTime =
    AnalyticsListener.EventTime(0L, Timeline.EMPTY, 0, null, 0L, Timeline.EMPTY, 0, null, 0L, 0L)

@UnstableApi
internal fun loadData(dataType: Int, trackType: Int = C.TRACK_TYPE_UNKNOWN, format: Format? = null, reason: Int = C.SELECTION_REASON_UNKNOWN) =
    MediaLoadData(dataType, trackType, format, reason, null, 0L, 0L)

@UnstableApi
internal fun loadInfo(uri: String) = LoadEventInfo(0L, DataSpec(Uri.parse(uri)), Uri.parse(uri), emptyMap(), 0L, 0L, 0L)

internal fun videoFormat(bitrate: Int, width: Int, height: Int): Format =
    Format.Builder().setAverageBitrate(bitrate).setPeakBitrate(bitrate).setWidth(width).setHeight(height).setSampleMimeType("video/avc").build()

internal fun hlsItem(uri: String = "https://cdn.example.com/live/master.m3u8?token=abc") =
    MediaItem.Builder().setUri(uri).setMimeType("application/x-mpegURL").build()
