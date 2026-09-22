// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package com.traceitx.trigger

import android.content.res.Configuration
import android.hardware.SensorManager
import com.traceitx.config.TraceItXConfig
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ShakeToReportTest {
    @Test
    fun `local option defaults enabled`() {
        assertTrue(TraceItXConfig(appId = "app", sdkKey = "key").shakeToReportEnabled)
    }

    @Test
    fun `react native pattern triggers after eight alternating impulses`() {
        val detector = ShakeGestureDetector()
        val force = SensorManager.GRAVITY_EARTH * 1.5f

        repeat(7) { index ->
            val direction = if (index % 2 == 0) force else -force
            assertFalse(detector.onAcceleration(index * 20_000_000L, direction, 0f, SensorManager.GRAVITY_EARTH))
        }
        assertTrue(detector.onAcceleration(140_000_000L, -force, 0f, SensorManager.GRAVITY_EARTH))
    }

    @Test
    fun `sub-threshold movement and samples faster than twenty milliseconds do not count`() {
        val detector = ShakeGestureDetector()
        val force = SensorManager.GRAVITY_EARTH * 1.5f

        assertFalse(detector.onAcceleration(0L, SensorManager.GRAVITY_EARTH, 0f, SensorManager.GRAVITY_EARTH))
        repeat(8) { index ->
            val direction = if (index % 2 == 0) force else -force
            assertFalse(detector.onAcceleration((index + 1) * 10_000_000L, direction, 0f, SensorManager.GRAVITY_EARTH))
        }
    }

    @Test
    fun `z acceleration removes earth gravity before thresholding`() {
        val detector = ShakeGestureDetector()

        repeat(8) { index ->
            assertFalse(
                detector.onAcceleration(
                    index * 20_000_000L,
                    0f,
                    0f,
                    SensorManager.GRAVITY_EARTH,
                ),
            )
        }
    }

    @Test
    fun `shake count expires after the react native three second window`() {
        val detector = ShakeGestureDetector()
        val force = SensorManager.GRAVITY_EARTH * 1.5f

        repeat(4) { index ->
            val direction = if (index % 2 == 0) force else -force
            assertFalse(detector.onAcceleration(index * 20_000_000L, direction, 0f, SensorManager.GRAVITY_EARTH))
        }
        assertFalse(detector.onAcceleration(3_100_000_000L, 0f, 0f, SensorManager.GRAVITY_EARTH))
        repeat(4) { index ->
            val direction = if (index % 2 == 0) force else -force
            assertFalse(
                detector.onAcceleration(
                    3_120_000_000L + index * 20_000_000L,
                    direction,
                    0f,
                    SensorManager.GRAVITY_EARTH,
                ),
            )
        }
    }

    @Test
    fun `local and dashboard switches must both be enabled`() {
        val gate = ShakeToReportGate(localEnabled = true)
        gate.foreground = true

        assertFalse(gate.tryBegin(presenting = false))
        gate.remoteEnabled = true
        assertTrue(gate.tryBegin(presenting = false))
        assertFalse(gate.tryBegin(presenting = false))
        gate.complete()
        assertFalse(gate.tryBegin(presenting = true))

        gate.remoteEnabled = false
        assertFalse(gate.tryBegin(presenting = false))
        gate.remoteEnabled = true
        gate.localEnabled = false
        assertFalse(gate.tryBegin(presenting = false))
    }

    @Test
    fun `television devices are excluded by ui mode or system feature`() {
        assertTrue(
            ShakeToReportTrigger.isTelevision(
                Configuration.UI_MODE_TYPE_TELEVISION,
                hasLeanback = false,
                hasTelevisionFeature = false,
            ),
        )
        assertTrue(
            ShakeToReportTrigger.isTelevision(
                Configuration.UI_MODE_TYPE_NORMAL,
                hasLeanback = true,
                hasTelevisionFeature = false,
            ),
        )
        assertFalse(
            ShakeToReportTrigger.isTelevision(
                Configuration.UI_MODE_TYPE_NORMAL,
                hasLeanback = false,
                hasTelevisionFeature = false,
            ),
        )
    }
}
