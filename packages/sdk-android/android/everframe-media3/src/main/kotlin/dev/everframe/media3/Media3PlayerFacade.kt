// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.media3

import android.os.Looper
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.analytics.AnalyticsListener

internal data class Media3PlayerState(
    val currentPositionMs: Long,
    val bufferedPositionMs: Long,
    val videoFormat: Format?,
    val isLive: Boolean,
    val currentMediaItem: MediaItem?,
    /**
     * Final review, I1: needed only by `attach()`'s seed, which has to decide
     * whether the player it is joining is already past its first frame (so a
     * later BUFFERING counts as a rebuffer, not startup). Trailing with a
     * default so existing positional construction is unaffected.
     */
    val isPlaying: Boolean = false,
    /**
     * Codex round-3, Important 9: needed by `attach()`'s seed to notice that
     * the player it is joining is CURRENTLY rebuffering. Media3 does not
     * replay the preceding `onPlaybackStateChanged(STATE_BUFFERING)` for a
     * listener added mid-stall, so without it the whole rebuffer — and its
     * duration — disappeared from the session. Trailing with a default so
     * existing positional construction is unaffected.
     */
    val playbackState: Int = Player.STATE_IDLE,
)

/** The slice of ExoPlayer the integration touches — a seam so tests never need a real player. */
@UnstableApi
internal interface Media3PlayerFacade {
    fun addAnalyticsListener(l: AnalyticsListener)
    fun removeAnalyticsListener(l: AnalyticsListener)
    val applicationLooper: Looper?
    /** Player thread only. */
    fun readState(): Media3PlayerState
}

@UnstableApi
internal class ExoPlayerFacade(private val player: ExoPlayer) : Media3PlayerFacade {
    override fun addAnalyticsListener(l: AnalyticsListener) = player.addAnalyticsListener(l)
    override fun removeAnalyticsListener(l: AnalyticsListener) = player.removeAnalyticsListener(l)
    override val applicationLooper: Looper get() = player.applicationLooper
    override fun readState() = Media3PlayerState(
        currentPositionMs = player.currentPosition,
        bufferedPositionMs = player.bufferedPosition,
        videoFormat = player.videoFormat,
        isLive = player.isCurrentMediaItemLive,
        currentMediaItem = player.currentMediaItem,
        isPlaying = player.isPlaying,
        playbackState = player.playbackState,
    )
}
