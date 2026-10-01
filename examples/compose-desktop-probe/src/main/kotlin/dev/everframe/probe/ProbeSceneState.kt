// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.probe

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color

enum class ProbeScreen { A, B }

class ProbeSceneState {
    var screen by mutableStateOf(ProbeScreen.A)
        private set

    val publicColor: Color
        get() = if (screen == ProbeScreen.A) Color(0xFF00CC00) else Color(0xFF0066FF)

    val sensitiveColor: Color = Color(0xFFFF00FF)

    fun next() {
        screen = if (screen == ProbeScreen.A) ProbeScreen.B else ProbeScreen.A
    }
}
