// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.probe

import kotlin.test.Test
import kotlin.test.assertEquals

class RendererEvidenceTest {
    @Test
    fun nativeOnlyFramesDoNotCountAsScreenshotsOrReplay() {
        val result = classifyRendererEvidence(
            width = 800,
            height = 600,
            publicA = 0.0,
            publicB = 0.0,
            sensitiveA = 1.0,
            sensitiveB = 1.0,
            nativeA = 1.0,
            nativeB = 1.0,
            distinctFrames = false,
        )
        assertEquals("BLOCKED", result["screenshot"])
        assertEquals("BLOCKED", result["masking"])
        assertEquals("PASS", result["nativeView"])
        assertEquals("BLOCKED", result["visualReplay"])
    }

    @Test
    fun requiresVisibleDistinctPublicFramesToPass() {
        val result = classifyRendererEvidence(
            width = 800,
            height = 600,
            publicA = 1.0,
            publicB = 1.0,
            sensitiveA = 1.0,
            sensitiveB = 1.0,
            nativeA = 1.0,
            nativeB = 1.0,
            distinctFrames = true,
        )
        assertEquals("PASS", result["screenshot"])
        assertEquals("PASS", result["masking"])
        assertEquals("PASS", result["visualReplay"])
    }
}
