// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.probe

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.material.Button
import androidx.compose.material.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.awt.SwingPanel
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.application
import androidx.compose.ui.window.rememberWindowState
import java.awt.Rectangle
import java.nio.file.Files
import javax.imageio.ImageIO
import javax.swing.JComponent
import javax.swing.JPanel
import kotlinx.coroutines.delay

private val sensitive = Rectangle(40, 140, 160, 80)

fun main(args: Array<String>) = application {
    val autoProbe = "--auto-probe" in args
    val state = remember { ProbeSceneState() }
    Window(
        onCloseRequest = ::exitApplication,
        title = "Everframe Compose desktop probe",
        state = rememberWindowState(size = DpSize(800.dp, 600.dp)),
    ) {
        ProbeScene(state)
        if (autoProbe) {
            LaunchedEffect(window) {
                val component = window.contentPane as? JComponent
                if (component == null) {
                    println("EVERFRAME_COMPOSE_PROBE=BLOCKED:no-jcomponent")
                    exitApplication()
                    return@LaunchedEffect
                }
                delay(1000)
                val first = captureMaskedFrame(component, listOf(sensitive))
                state.next()
                delay(500)
                val second = captureMaskedFrame(component, listOf(sensitive))
                if (first == null || second == null) {
                    println("EVERFRAME_COMPOSE_PROBE=BLOCKED:no-safe-frame")
                    exitApplication()
                    return@LaunchedEffect
                }
                val directory = Files.createTempDirectory("everframe-compose-macos-")
                Files.write(directory.resolve("renderer-a.png"), first)
                Files.write(directory.resolve("renderer-b.png"), second)
                val image = ImageIO.read(first.inputStream())
                val publicA = fraction(first, 40, Color(0xFF00CC00))
                val publicB = fraction(second, 40, Color(0xFF0066FF))
                val sensitiveA = fraction(first, 140, Color.Black)
                val sensitiveB = fraction(second, 140, Color.Black)
                val nativeA = fraction(first, 240, Color(0xFFFF8800))
                val nativeB = fraction(second, 240, Color(0xFFFF8800))
                val distinctFrames = !first.contentEquals(second)
                val capabilities = classifyRendererEvidence(
                    width = image.width,
                    height = image.height,
                    publicA = publicA,
                    publicB = publicB,
                    sensitiveA = sensitiveA,
                    sensitiveB = sensitiveB,
                    nativeA = nativeA,
                    nativeB = nativeB,
                    distinctFrames = distinctFrames,
                )
                val evidence = """{
  "size": [${image.width}, ${image.height}],
  "publicA": $publicA,
  "publicB": $publicB,
  "sensitiveA": $sensitiveA,
  "sensitiveB": $sensitiveB,
  "nativeA": $nativeA,
  "nativeB": $nativeB,
  "distinctFrames": $distinctFrames,
  "capabilities": {
    "screenshot": "${capabilities["screenshot"]}",
    "masking": "${capabilities["masking"]}",
    "nativeView": "${capabilities["nativeView"]}",
    "visualReplay": "${capabilities["visualReplay"]}"
  }
} """.trimIndent()
                Files.writeString(directory.resolve("renderer-evidence.json"), evidence)
                println("EVERFRAME_COMPOSE_PROBE_DIR=$directory")
                exitApplication()
            }
        }
    }
}

@Composable
fun ProbeScene(state: ProbeSceneState) {
    Box(Modifier.fillMaxSize().background(Color.White)) {
        Box(Modifier.offset(40.dp, 40.dp).size(160.dp, 80.dp).background(state.publicColor))
        Box(Modifier.offset(40.dp, 140.dp).size(160.dp, 80.dp).background(state.sensitiveColor))
        SwingPanel(
            factory = { JPanel().apply { background = java.awt.Color(255, 136, 0) } },
            modifier = Modifier.offset(40.dp, 240.dp).size(160.dp, 80.dp),
        )
        Text("Screen ${state.screen}", Modifier.offset(300.dp, 40.dp))
        Button(onClick = state::next, modifier = Modifier.offset(300.dp, 100.dp)) {
            Text("Next screen")
        }
    }
}

private fun fraction(png: ByteArray, top: Int, expected: Color): Double {
    val image = ImageIO.read(png.inputStream()) ?: return 0.0
    if (image.width < 192 || image.height < top + 72) return 0.0
    val red = (expected.red * 255).toInt()
    val green = (expected.green * 255).toInt()
    val blue = (expected.blue * 255).toInt()
    var matches = 0
    var total = 0
    for (y in top + 8 until top + 72) {
        for (x in 48 until 192) {
            val pixel = image.getRGB(x, y)
            if (kotlin.math.abs((pixel ushr 16 and 0xFF) - red) <= 16 &&
                kotlin.math.abs((pixel ushr 8 and 0xFF) - green) <= 16 &&
                kotlin.math.abs((pixel and 0xFF) - blue) <= 16
            ) matches++
            total++
        }
    }
    return matches.toDouble() / total
}
