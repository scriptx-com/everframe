// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.probe

import androidx.compose.ui.graphics.Color
import kotlin.test.Test
import kotlin.test.assertEquals

class ProbeSceneStateTest {
    @Test
    fun publicTileChangesFromGreenToBlueAndSensitiveTileStaysMagenta() {
        val scene = ProbeSceneState()
        assertEquals(Color(0xFF00CC00), scene.publicColor)
        assertEquals(Color(0xFFFF00FF), scene.sensitiveColor)
        scene.next()
        assertEquals(Color(0xFF0066FF), scene.publicColor)
        assertEquals(Color(0xFFFF00FF), scene.sensitiveColor)
    }
}
