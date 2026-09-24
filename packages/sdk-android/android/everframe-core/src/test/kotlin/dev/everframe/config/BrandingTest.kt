// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.config

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BrandingTest {
    @Test
    fun `watermark shows unless server confirms paid`() {
        // Fail closed: absent block, absent flag, and explicit true all show it.
        assertTrue(shouldShowWatermark(null))
        assertTrue(shouldShowWatermark(BrandingConfigWire()))
        assertTrue(shouldShowWatermark(BrandingConfigWire(watermark = true)))
        assertFalse(shouldShowWatermark(BrandingConfigWire(watermark = false)))
    }

    @Test
    fun `server signal starts null and resets`() {
        BrandingServerConfigSignal.flow.value = BrandingConfigWire(watermark = false)
        BrandingServerConfigSignal.resetForTesting()
        assertNull(BrandingServerConfigSignal.flow.value)
    }

    @Test
    fun `inline theme flow starts null and resets`() {
        BrandingInlineTheme.flow.value = ReporterThemeOptions(accent = "#336699")
        BrandingInlineTheme.resetForTesting()
        assertNull(BrandingInlineTheme.flow.value)
    }
}
