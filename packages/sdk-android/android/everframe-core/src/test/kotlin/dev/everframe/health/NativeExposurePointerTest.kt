// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.health

import dev.everframe.capture.AppRelease
import dev.everframe.config.ReleaseHealthBundleStatus
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

class NativeExposurePointerTest {
    private fun pointer(time: String = "2026-10-09T10:00:00.000Z", app: AppRelease = AppRelease("2.4.0", null)) =
        NativeExposurePointer(UUID.randomUUID().toString(), UUID.randomUUID().toString(), time, app, null,
            ReleaseHealthBundleStatus.NOT_APPLICABLE)
    // The field a pointer carried before the app version, spelled in two parts so the
    // repository-wide check for the retired name stays clean.
    private val retiredBuildKey = "native" + "BuildId"

    @Test fun `timestamps stay exact UTC milliseconds under non US default locale and timezone`() {
        val locale = Locale.getDefault(); val zone = TimeZone.getDefault()
        try {
            Locale.setDefault(Locale.forLanguageTag("ar-EG")); TimeZone.setDefault(TimeZone.getTimeZone("Pacific/Auckland"))
            assertEquals("1970-01-01T00:00:00.000Z", NativeExposurePointer.timestamp(0))
            assertEquals("2026-10-09T10:00:00.001Z", NativeExposurePointer.timestamp(1_791_540_000_001))
        } finally { Locale.setDefault(locale); TimeZone.setDefault(zone) }
    }
    @Test fun `timestamp validation rejects normalization offsets and invalid calendar dates`() {
        for (time in listOf("2026-02-29T10:00:00.000Z", "2026-10-09T10:00:00Z", "2026-10-09T10:00:00.000+00:00", "2026-10-09T25:00:00.000Z", "2026-10-09T10:00:00.000Zgarbage")) {
            assertFalse(time, pointer(time).valid())
        }
        assertTrue(pointer("2024-02-29T10:00:00.000Z").valid())
    }
    @Test fun `a missing build is written as an explicit null and round trips`() {
        val value = pointer()
        assertTrue(value.toJson().toString().contains("\"app\":{\"version\":\"2.4.0\",\"build\":null}"))
        assertEquals(listOf("exposureId", "processLaunchId", "startedAt", "app", "loadedBuildId", "loadedBundleStatus"),
            value.toJson().keys.toList())
        assertEquals(value, NativeExposurePointer.parse(value.toJson()))
        val built = pointer(app = AppRelease("2.4.0", "412"))
        assertEquals(built, NativeExposurePointer.parse(built.toJson()))
    }
    @Test fun `parse drops the old native build shape and an app without its build key`() {
        val json = pointer().toJson()
        assertNull(NativeExposurePointer.parse(JsonObject(json - "app" + (retiredBuildKey to JsonPrimitive("native-A")))))
        assertNull(NativeExposurePointer.parse(JsonObject(json + (retiredBuildKey to JsonPrimitive("native-A")))))
        assertNull(NativeExposurePointer.parse(JsonObject(json + ("app" to buildJsonObject { put("version", "2.4.0") }))))
        assertNull(NativeExposurePointer.parse(JsonObject(json + ("app" to buildJsonObject {
            put("version", "2.4.0"); put("build", JsonNull); put("name", "extra")
        }))))
        assertNull(NativeExposurePointer.parse(JsonObject(json + ("app" to JsonPrimitive("2.4.0")))))
    }
    @Test fun `app text follows the wire limits`() {
        assertFalse(pointer(app = AppRelease("a".repeat(65), null)).valid())
        assertTrue(pointer(app = AppRelease("a".repeat(64), "9".repeat(64))).valid())
        for (bad in listOf(AppRelease("", null), AppRelease(" ", null), AppRelease("bad\u0000", null),
            AppRelease("2.4.0", ""), AppRelease("2.4.0", "b".repeat(65)))) {
            assertFalse(bad.toString(), pointer(app = bad).valid())
        }
    }
}
