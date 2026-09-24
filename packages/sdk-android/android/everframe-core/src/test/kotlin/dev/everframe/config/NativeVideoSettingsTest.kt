// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.config

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NativeVideoSettingsTest {
    @Test
    fun `effective settings require API 29 a successful refresh and enabled replay`() {
        val enabled = ReplayConfig(true, 30, 1.0, nativeVideo = NativeVideoSettings(5))

        assertNull(effectiveNativeVideo(enabled, true, sdkInt = 28))
        assertEquals(5, effectiveNativeVideo(enabled, true, sdkInt = 29)?.framesPerSecond)
        assertNull(effectiveNativeVideo(enabled, false, sdkInt = 29))
        assertNull(effectiveNativeVideo(enabled, true, locallyDisabled = true, sdkInt = 29))
        assertNull(effectiveNativeVideo(enabled.copy(replayEnabled = false), true, sdkInt = 29))
        assertNull(effectiveNativeVideo(enabled.copy(nativeVideo = null), true, sdkInt = 29))
        assertEquals(
            10,
            effectiveNativeVideo(
                enabled.copy(nativeVideo = NativeVideoSettings(10)),
                true,
                sdkInt = 35,
            )?.framesPerSecond,
        )
    }

    @Test
    fun `effective settings reject unsupported programmatic frame rates`() {
        for (framesPerSecond in listOf(0, 6, 60)) {
            val config = ReplayConfig(
                true,
                30,
                1.0,
                nativeVideo = NativeVideoSettings(framesPerSecond),
            )

            assertNull(effectiveNativeVideo(config, true, sdkInt = 29))
        }
    }
}
