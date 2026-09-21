// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.vitals

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class VitalsDimsTest {
    @Test
    fun `isTv true maps to androidtv`() {
        val d = vitalsDimsFrom(mapOf("isTv" to true, "appVersion" to "1.2.3"), "0.9.0")
        assertEquals("androidtv", d.platform)
    }

    @Test
    fun `isTv false or absent maps to android`() {
        assertEquals("android", vitalsDimsFrom(mapOf("isTv" to false), "0.9.0").platform)
        assertEquals("android", vitalsDimsFrom(emptyMap(), "0.9.0").platform)
    }

    @Test
    fun `missing appVersion falls back to 0-dot-0-dot-0`() {
        assertEquals("0.0.0", vitalsDimsFrom(emptyMap(), "0.9.0").appVersion)
    }

    @Test
    fun `sdkVersion, model and osVersion pass through`() {
        val d = vitalsDimsFrom(mapOf("model" to "Pixel", "osVersion" to "14"), "0.9.0")
        assertEquals("0.9.0", d.sdkVersion)
        assertEquals("Pixel", d.deviceModel)
        assertEquals("14", d.osVersion)
    }

    @Test
    fun `missing model and osVersion are null`() {
        val d = vitalsDimsFrom(emptyMap(), "0.9.0")
        assertNull(d.deviceModel)
        assertNull(d.osVersion)
    }
}
