// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.composeprobe

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material.Button
import androidx.compose.material.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.LocalDensity

/** Fixed UI scene for checking Compose pixels and a real tap transition. */
@Composable
fun ProbeScene(
    onScreen: (String) -> Unit,
    onSensitiveRect: (Float, Float, Float, Float) -> Unit,
) {
    var screen by remember { mutableStateOf("A") }
    val density = LocalDensity.current.density
    Column(
        Modifier.fillMaxSize().background(Color.White),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Compose screen $screen")
        Box(Modifier.size(160.dp, 80.dp).background(if (screen == "A") Color.Green else Color.Blue))
        // Sentinel content must be masked by any future replay collector.
        Box(Modifier.size(160.dp, 80.dp).onGloballyPositioned { coordinates ->
            val origin = coordinates.positionInRoot()
            onSensitiveRect(
                origin.x / density,
                origin.y / density,
                coordinates.size.width / density,
                coordinates.size.height / density,
            )
        }.background(Color.Magenta))
        Button(onClick = {
            screen = if (screen == "A") "B" else "A"
            onScreen("Compose-$screen")
        }) { Text("Next screen") }
    }
}
