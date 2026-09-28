// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.probe

import java.awt.Color
import java.awt.Rectangle
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import javax.imageio.ImageIO
import javax.swing.JComponent
import javax.swing.SwingUtilities

fun captureMaskedFrame(component: JComponent, sensitiveRects: List<Rectangle>): ByteArray? {
    val width = component.width
    val height = component.height
    if (width <= 0 || height <= 0) return null
    if (sensitiveRects.any {
            it.width <= 0 || it.height <= 0 || it.x < 0 || it.y < 0 ||
                it.x.toLong() + it.width > width || it.y.toLong() + it.height > height
        }) return null

    return try {
        val image = BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB)
        val paint = {
            val graphics = image.createGraphics()
            try {
                graphics.color = Color.WHITE
                graphics.fillRect(0, 0, width, height)
                component.printAll(graphics)
                graphics.color = Color.BLACK
                sensitiveRects.forEach { graphics.fillRect(it.x, it.y, it.width, it.height) }
            } finally {
                graphics.dispose()
            }
        }
        if (SwingUtilities.isEventDispatchThread()) paint() else SwingUtilities.invokeAndWait(paint)

        for (y in 0 until height) {
            for (x in 0 until width) {
                val pixel = image.getRGB(x, y)
                val red = pixel ushr 16 and 0xFF
                val green = pixel ushr 8 and 0xFF
                val blue = pixel and 0xFF
                if (red >= 239 && green <= 16 && blue >= 239) return null
            }
        }
        ByteArrayOutputStream().use { output ->
            if (ImageIO.write(image, "png", output)) output.toByteArray() else null
        }
    } catch (_: Exception) {
        null
    }
}
