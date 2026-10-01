// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.probe

fun classifyRendererEvidence(
    width: Int,
    height: Int,
    publicA: Double,
    publicB: Double,
    sensitiveA: Double,
    sensitiveB: Double,
    nativeA: Double,
    nativeB: Double,
    distinctFrames: Boolean,
): Map<String, String> {
    val screenshot = width >= 640 && height >= 360 && publicA >= 0.8 && publicB >= 0.8
    return mapOf(
        "screenshot" to if (screenshot) "PASS" else "BLOCKED",
        "masking" to if (screenshot && sensitiveA >= 0.95 && sensitiveB >= 0.95) "PASS" else "BLOCKED",
        "nativeView" to if (nativeA >= 0.8 && nativeB >= 0.8) "PASS" else "BLOCKED",
        "visualReplay" to if (screenshot && distinctFrames) "PASS" else "BLOCKED",
    )
}
