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
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.awt.SwingPanel
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.application
import androidx.compose.ui.window.rememberWindowState
import java.nio.file.Files
import javax.imageio.ImageIO
import javax.swing.JPanel
import kotlinx.coroutines.delay
import kotlin.math.roundToInt

fun main(args: Array<String>) = application {
    val autoProbe = "--auto-probe" in args
    val state = remember { ProbeSceneState() }
    val sensitiveBounds = remember { SensitiveBoundsRegistry() }
    Window(
        onCloseRequest = ::exitApplication,
        title = "Everframe Compose desktop probe",
        state = rememberWindowState(size = DpSize(800.dp, 600.dp)),
    ) {
        ProbeScene(state, sensitiveBounds)
        if (autoProbe) {
            LaunchedEffect(window) {
                delay(1000)
                val firstBounds = sensitiveBounds.snapshot()
                val first = firstBounds?.let { captureMaskedFrame(window, listOf(it)) }
                state.next()
                delay(500)
                val secondBounds = sensitiveBounds.snapshot()
                val second = secondBounds?.let { captureMaskedFrame(window, listOf(it)) }
                if (first == null || second == null || firstBounds == secondBounds) {
                    println("EVERFRAME_COMPOSE_PROBE_BOUNDS first=$firstBounds second=$secondBounds firstFrame=${first != null} secondFrame=${second != null} content=${window.contentPane.width}x${window.contentPane.height}")
                    println("EVERFRAME_COMPOSE_PROBE=BLOCKED:no-safe-frame")
                    exitApplication()
                    return@LaunchedEffect
                }
                val directory = Files.createTempDirectory("everframe-compose-macos-")
                Files.write(directory.resolve("renderer-a.png"), first)
                Files.write(directory.resolve("renderer-b.png"), second)
                val image = ImageIO.read(first.inputStream())
                val scaleX = image.width.toDouble() / window.contentPane.width
                val scaleY = image.height.toDouble() / window.contentPane.height
                val publicA = fraction(first, 40, Color(0xFF00CC00), scaleX, scaleY)
                val publicB = fraction(second, 40, Color(0xFF0066FF), scaleX, scaleY)
                val sensitiveA = fraction(first, (firstBounds!!.y / scaleY).roundToInt(), Color.Black, scaleX, scaleY)
                val sensitiveB = fraction(second, (secondBounds!!.y / scaleY).roundToInt(), Color.Black, scaleX, scaleY)
                val nativeA = fraction(first, 240, Color(0xFFFF8800), scaleX, scaleY)
                val nativeB = fraction(second, 240, Color(0xFFFF8800), scaleX, scaleY)
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
  "sensitiveTop": [${firstBounds.y}, ${secondBounds.y}],
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
fun ProbeScene(state: ProbeSceneState, sensitiveBounds: SensitiveBoundsRegistry) {
    DisposableEffect(sensitiveBounds) { onDispose { sensitiveBounds.clear() } }
    Box(Modifier.fillMaxSize().background(Color.White)) {
        Box(Modifier.offset(40.dp, 40.dp).size(160.dp, 80.dp).background(state.publicColor))
        Box(Modifier.offset(40.dp, if (state.screen == ProbeScreen.A) 140.dp else 340.dp)
            .size(160.dp, 80.dp)
            .onGloballyPositioned { coordinates ->
                val rect = coordinates.boundsInRoot()
                sensitiveBounds.update(rect.left, rect.top, rect.width, rect.height)
            }
            .background(state.sensitiveColor))
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

private fun fraction(png: ByteArray, top: Int, expected: Color, scaleX: Double, scaleY: Double): Double {
    val image = ImageIO.read(png.inputStream()) ?: return 0.0
    val left = (48 * scaleX).roundToInt()
    val right = (192 * scaleX).roundToInt()
    val sampleTop = ((top + 8) * scaleY).roundToInt()
    val bottom = ((top + 72) * scaleY).roundToInt()
    if (left < 0 || sampleTop < 0 || right > image.width || bottom > image.height || left >= right || sampleTop >= bottom) return 0.0
    val red = (expected.red * 255).toInt()
    val green = (expected.green * 255).toInt()
    val blue = (expected.blue * 255).toInt()
    var matches = 0
    var total = 0
    for (y in sampleTop until bottom) {
        for (x in left until right) {
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
