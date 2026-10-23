// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.qualification.quickcapture

import android.app.Activity
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView

/**
 * TV key-delivery measurements: which remote keys reach the Activity window callback, and what a long press
 * looks like. A list of 20 focusable buttons beside a Media3 [PlayerView] over an [ExoPlayer] with no media
 * item. Every key event the window delivers is logged under [TAG], one line each; so is every play/pause
 * the player is asked for. Start with `--es focus player` to focus the player instead of the list. Never logs
 * the SDK key.
 */
@UnstableApi
class SpikeActivity : Activity() {
    private var player: ExoPlayer? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val buttons = (1..20).map { n -> Button(this).apply { text = "Item $n"; isFocusable = true } }
        buttons.forEach { list.addView(it) }
        val exo = ExoPlayer.Builder(this).build()
        player = exo
        exo.addListener(
            object : Player.Listener {
                override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                    Log.i(TAG, "playWhenReady=$playWhenReady reason=$reason t=${SystemClock.uptimeMillis()}")
                }
            },
        )
        // Counts every play/pause request the controller makes, even when playWhenReady does not change.
        val counted = object : ForwardingPlayer(exo) {
            override fun play() {
                Log.i(TAG, "player.play t=${SystemClock.uptimeMillis()}")
                super.play()
            }

            override fun pause() {
                Log.i(TAG, "player.pause t=${SystemClock.uptimeMillis()}")
                super.pause()
            }
        }
        val playerView = PlayerView(this).apply {
            useController = true
            this.player = counted
            isFocusable = true
            isFocusableInTouchMode = true
        }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(ScrollView(this@SpikeActivity).apply { addView(list) }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
            addView(playerView, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 2f))
        }
        setContentView(root)
        val focusTarget: View = if (intent?.getStringExtra("focus") == "player") playerView else buttons.first()
        focusTarget.post { focusTarget.requestFocus() }
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        Log.i(
            TAG,
            "key=${event.keyCode} name=${KeyEvent.keyCodeToString(event.keyCode)} action=${event.action} " +
                "repeat=${event.repeatCount} longPress=${event.isLongPress} canceled=${event.isCanceled} " +
                "held=${event.eventTime - event.downTime} meta=0x${Integer.toHexString(event.metaState)} " +
                "flags=0x${Integer.toHexString(event.flags)} t=${event.eventTime} focus=${currentFocus?.javaClass?.simpleName}",
        )
        return super.dispatchKeyEvent(event)
    }

    override fun onDestroy() {
        player?.release()
        player = null
        super.onDestroy()
    }

    private companion object {
        const val TAG = "EvfTvSpike"
    }
}
