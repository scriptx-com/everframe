// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.health

import dev.everframe.config.ReleaseHealthBundleStatus
import org.junit.Assert.*
import org.junit.Test
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

class NativeExposurePointerTest {
    @Test fun `timestamps stay exact UTC milliseconds under non US default locale and timezone`() {
        val locale = Locale.getDefault(); val zone = TimeZone.getDefault()
        try {
            Locale.setDefault(Locale.forLanguageTag("ar-EG")); TimeZone.setDefault(TimeZone.getTimeZone("Pacific/Auckland"))
            assertEquals("1970-01-01T00:00:00.000Z", NativeExposurePointer.timestamp(0))
            assertEquals("2026-10-09T10:00:00.001Z", NativeExposurePointer.timestamp(1_791_540_000_001))
        } finally { Locale.setDefault(locale); TimeZone.setDefault(zone) }
    }
    @Test fun `timestamp validation rejects normalization offsets and invalid calendar dates`() {
        fun pointer(time: String) = NativeExposurePointer(UUID.randomUUID().toString(), UUID.randomUUID().toString(),
            time, "native", null, ReleaseHealthBundleStatus.NOT_APPLICABLE)
        for (time in listOf("2026-02-29T10:00:00.000Z", "2026-10-09T10:00:00Z", "2026-10-09T10:00:00.000+00:00", "2026-10-09T25:00:00.000Z", "2026-10-09T10:00:00.000Zgarbage")) {
            assertFalse(time, pointer(time).valid())
        }
        assertTrue(pointer("2024-02-29T10:00:00.000Z").valid())
    }
}
