// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// DeviceMetadata unit tests — Robolectric. Confirms every key is present in
// the snapshot and that os == "Android".
package dev.everframe.capture

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class DeviceMetadataTest {

    private val ctx get() = ApplicationProvider.getApplicationContext<android.content.Context>()

    @Test
    fun `collect returns expected keys`() {
        val m = DeviceMetadata.collect(ctx)
        val expected = setOf(
            "os", "osVersion", "sdkInt", "model", "manufacturer", "brand",
            "appVersion", "appBuild", "bundleIdentifier", "locale", "timezone",
            "screenWidthDp", "screenHeightDp", "smallestScreenWidthDp",
            "isTv", "isTablet",
        )
        for (key in expected) {
            assertTrue("missing key: $key", m.containsKey(key))
        }
    }

    @Test
    fun `os field is Android`() {
        val m = DeviceMetadata.collect(ctx)
        assertEquals("Android", m["os"])
    }

    @Test
    fun `sdkInt is positive`() {
        val m = DeviceMetadata.collect(ctx)
        val sdkInt = m["sdkInt"] as Int
        assertTrue("sdkInt should be > 0, got $sdkInt", sdkInt > 0)
    }

    @Test
    fun `locale tag is non-empty`() {
        val m = DeviceMetadata.collect(ctx)
        val locale = m["locale"] as? String
        assertNotNull(locale)
        assertTrue(locale!!.isNotEmpty())
    }

    @Test
    fun `bundleIdentifier matches packageName`() {
        val m = DeviceMetadata.collect(ctx)
        assertEquals(ctx.packageName, m["bundleIdentifier"])
    }

    @Test
    fun `timezone is a non-empty string`() {
        val m = DeviceMetadata.collect(ctx)
        val tz = m["timezone"] as? String
        assertNotNull(tz)
        assertTrue(tz!!.isNotEmpty())
    }

    @Test
    fun `isTv and isTablet are booleans`() {
        val m = DeviceMetadata.collect(ctx)
        assertTrue(m["isTv"] is Boolean)
        assertTrue(m["isTablet"] is Boolean)
    }
}
