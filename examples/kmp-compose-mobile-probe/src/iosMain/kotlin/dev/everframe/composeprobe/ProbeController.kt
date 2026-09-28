// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.composeprobe

import androidx.compose.ui.window.ComposeUIViewController
import platform.UIKit.UIViewController

fun makeProbeController(
    onScreen: (String) -> Unit,
    onSensitiveRect: (Float, Float, Float, Float) -> Unit,
): UIViewController = ComposeUIViewController {
    ProbeScene(onScreen, onSensitiveRect)
}
