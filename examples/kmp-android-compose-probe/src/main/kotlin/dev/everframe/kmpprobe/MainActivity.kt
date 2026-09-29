// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.kmpprobe

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import dev.everframe.kmp.AndroidEverframeDriver
import dev.everframe.kmp.EverframeKmp
import dev.everframe.kmp.EverframeKmpConfig
import dev.everframe.sensitive.txSensitive

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val client = EverframeKmp(AndroidEverframeDriver(applicationContext, this))
        setContent { ProbeScene(client) }
    }
}

@Composable
private fun ProbeScene(client: EverframeKmp) {
    var started by remember { mutableStateOf(false) }
    var screen by remember { mutableStateOf("A") }
    var status by remember { mutableStateOf("idle") }
    Column(
        Modifier.fillMaxSize().background(Color.White).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Android Compose screen $screen")
        Box(Modifier.size(160.dp, 80.dp).background(if (screen == "A") Color.Green else Color.Blue))
        // The native reporter can still take a manual screenshot when automatic capture is off.
        Box(Modifier.size(160.dp, 80.dp).txSensitive().background(Color.Magenta))
        Button(onClick = {
            started = client.start(EverframeKmpConfig(
                appId = "kmp-android-probe",
                sdkKey = "txx_live_" + "0".repeat(32),
            ))
            status = if (started) "started" else "start blocked"
        }) { Text("Start Everframe") }
        Button(onClick = {
            screen = if (screen == "A") "B" else "A"
            client.recordScreen("AndroidCompose-$screen")
            client.addBreadcrumb("next screen", kind = "tap")
        }, enabled = started) { Text("Next screen") }
        Button(onClick = {
            client.captureHandledError("catalog_load_failed")
            client.captureException(IllegalStateException("safe sample failure"))
            client.recordNetworkOperation("catalog_fetch", "GET", 503, 42)
            status = "context requested"
        }, enabled = started) { Text("Exercise KMP context") }
        Button(onClick = {
            client.openReporter { status = it.status }
        }, enabled = started) { Text("Open native reporter") }
        Button(onClick = {
            client.kill()
            started = false
            status = "killed"
        }, enabled = started) { Text("Kill") }
        Text(status)
    }
}
