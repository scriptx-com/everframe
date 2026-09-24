// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Session Vitals demo: a Media3 PlayerView attached with trackPlayer(). The
// "Throttle" toggle swaps the stream to provoke source_change / rebuffers /
// bitrate_change; "Log ad break" feeds the custom lane. Disposal releases the
// player, which self-detaches (player_detach).
package com.example.composesample.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import dev.everframe.Everframe
import dev.everframe.media3.trackPlayer

private const val MAIN_STREAM = "https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8"
private const val THROTTLED_STREAM = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
@Composable
fun SamplePlaybackScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    var throttled by remember { mutableStateOf(false) }
    var adBreaks by remember { mutableStateOf(0) }
    val player = remember {
        ExoPlayer.Builder(context).build().apply {
            setMediaItem(MediaItem.Builder().setUri(MAIN_STREAM).setMimeType(MimeTypes.APPLICATION_M3U8).build())
            prepare()
            playWhenReady = true
        }
    }
    DisposableEffect(player) {
        val handle = Everframe.trackPlayer(player, name = "main")
        onDispose {
            player.release()   // Media3 fires onPlayerReleased → player_detach
            handle.detach()    // idempotent; harmless after the release hook
        }
    }
    Column(modifier = Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Session Vitals — playback")
        AndroidView(
            factory = { PlayerView(it).apply { this.player = player } },
            modifier = Modifier.fillMaxWidth().aspectRatio(16f / 9f),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = {
                throttled = !throttled
                val uri = if (throttled) THROTTLED_STREAM else MAIN_STREAM
                player.setMediaItem(MediaItem.Builder().setUri(uri).setMimeType(MimeTypes.APPLICATION_M3U8).build())
                player.prepare(); player.playWhenReady = true
            }) { Text(if (throttled) "Restore stream" else "Throttle") }
            OutlinedButton(onClick = {
                adBreaks++
                Everframe.trackVitals("ad_break", mapOf("position" to "midroll", "index" to adBreaks, "positionMs" to player.currentPosition))
            }) { Text("Log ad break") }
        }
        OutlinedButton(onClick = onBack) { Text("Back") }
    }
}
