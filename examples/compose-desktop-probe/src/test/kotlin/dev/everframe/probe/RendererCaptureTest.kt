// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.probe

import java.awt.Color
import java.awt.Rectangle
import java.io.ByteArrayInputStream
import javax.imageio.ImageIO
import javax.swing.JPanel
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class RendererCaptureTest {
    @Test
    fun masksSensitivePixelsBeforeEncodingAndKeepsPublicPixels() {
        val root = JPanel(null).apply {
            setSize(800, 600)
            background = Color.WHITE
            add(JPanel().apply { background = Color(0, 204, 0); setBounds(40, 40, 160, 80) })
            add(JPanel().apply { background = Color.MAGENTA; setBounds(40, 140, 160, 80) })
        }
        val safe = captureMaskedFrame(root, listOf(Rectangle(40, 140, 160, 80)))
        assertNotNull(safe)
        val image = ImageIO.read(ByteArrayInputStream(safe))
        assertEquals(Color(0, 204, 0).rgb, image.getRGB(50, 50))
        assertEquals(Color.BLACK.rgb, image.getRGB(50, 150))
        assertEquals(Color.WHITE.rgb, image.getRGB(250, 300))
        assertNull(captureMaskedFrame(root, listOf(Rectangle(-1, 140, 160, 80))))
    }
}
