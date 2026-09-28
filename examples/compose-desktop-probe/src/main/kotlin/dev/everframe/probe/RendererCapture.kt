// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.probe

import androidx.compose.runtime.tooling.ComposeToolingApi
import androidx.compose.ui.awt.ComposeWindow
import java.awt.Color
import java.awt.Rectangle
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import javax.imageio.ImageIO
import javax.swing.JComponent
import javax.swing.SwingUtilities
import kotlin.math.ceil
import kotlin.math.floor

/** Reads the live Compose renderer rather than asking AWT to print its host. */
@OptIn(ComposeToolingApi::class)
fun captureMaskedFrame(window: ComposeWindow, sensitiveRects: List<Rectangle>): ByteArray? {
    val content = window.contentPane
    if (content.width <= 0 || content.height <= 0) return null
    return try {
        var captured: BufferedImage? = null
        val read = { captured = window.captureContentToImage() }
        if (SwingUtilities.isEventDispatchThread()) read() else SwingUtilities.invokeAndWait(read)
        val image = captured ?: return null
        val scaleX = image.width.toDouble() / content.width
        val scaleY = image.height.toDouble() / content.height
        if (!scaleX.isFinite() || !scaleY.isFinite() || scaleX <= 0 || scaleY <= 0) return null
        val scaledRects = sensitiveRects.map { rect ->
            val left = floor(rect.x * scaleX).toInt()
            val top = floor(rect.y * scaleY).toInt()
            Rectangle(
                left,
                top,
                ceil((rect.x + rect.width) * scaleX).toInt() - left,
                ceil((rect.y + rect.height) * scaleY).toInt() - top,
            )
        }
        maskAndEncode(image, scaledRects)
    } catch (_: Exception) {
        null
    }
}

/** Legacy AWT candidate retained as a comparison control. */
fun captureMaskedFrame(component: JComponent, sensitiveRects: List<Rectangle>): ByteArray? {
    val width = component.width
    val height = component.height
    if (width <= 0 || height <= 0) return null
    return try {
        val image = BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB)
        val paint = {
            val graphics = image.createGraphics()
            try {
                graphics.color = Color.WHITE
                graphics.fillRect(0, 0, width, height)
                component.printAll(graphics)
            } finally {
                graphics.dispose()
            }
        }
        if (SwingUtilities.isEventDispatchThread()) paint() else SwingUtilities.invokeAndWait(paint)

        maskAndEncode(image, sensitiveRects)
    } catch (_: Exception) {
        null
    }
}

private fun maskAndEncode(image: BufferedImage, sensitiveRects: List<Rectangle>): ByteArray? {
    val width = image.width
    val height = image.height
    if (width <= 0 || height <= 0 || sensitiveRects.any {
            it.width <= 0 || it.height <= 0 || it.x < 0 || it.y < 0 ||
                it.x.toLong() + it.width > width || it.y.toLong() + it.height > height
        }) return null
    val graphics = image.createGraphics()
    try {
        graphics.color = Color.BLACK
        sensitiveRects.forEach { graphics.fillRect(it.x, it.y, it.width, it.height) }
    } finally {
        graphics.dispose()
    }
    for (y in 0 until height) {
        for (x in 0 until width) {
            val pixel = image.getRGB(x, y)
            val red = pixel ushr 16 and 0xFF
            val green = pixel ushr 8 and 0xFF
            val blue = pixel and 0xFF
            if (red >= 239 && green <= 16 && blue >= 239) return null
        }
    }
    return ByteArrayOutputStream().use { output ->
        if (ImageIO.write(image, "png", output)) output.toByteArray() else null
    }
}
