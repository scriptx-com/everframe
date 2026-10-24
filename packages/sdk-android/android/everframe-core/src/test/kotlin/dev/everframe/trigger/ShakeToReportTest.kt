// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.trigger

import android.app.Application
import android.content.Context
import android.content.res.Configuration
import android.hardware.Sensor
import android.hardware.SensorManager
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import dev.everframe.Everframe
import dev.everframe.config.CaptureHotkeyConfigWire
import dev.everframe.config.EverframeConfig
import dev.everframe.devicelink.DeviceLink
import dev.everframe.quickcapture.CaptureGesture
import dev.everframe.quickcapture.QuickCapture
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowSensor

@RunWith(RobolectricTestRunner::class)
class ShakeToReportTest {
    @After
    fun tearDownGesture() {
        ShakeToReportTrigger.teardown()
        ShakeToReportTrigger.__resetForTesting()
        shadowOf(Looper.getMainLooper()).idle()
        CaptureGesture.__resetForTesting()
        QuickCapture.teardown()
        QuickCapture.__resetForTesting()
        DeviceLink.__resetForTesting()
    }

    @Test
    fun `local option defaults enabled`() {
        assertTrue(EverframeConfig(appId = "app", sdkKey = "key").shakeToReportEnabled)
        assertTrue(ShakeToReportTrigger.localEnabled(EverframeConfig(appId = "app", sdkKey = "key")))
    }

    @Test
    fun `a crash-only session turns shake off whatever its own switch says`() {
        val crashOnly = EverframeConfig(appId = "app", sdkKey = "key", reporterEnabled = false)
        assertFalse(ShakeToReportTrigger.localEnabled(crashOnly))
        assertFalse(ShakeToReportTrigger.localEnabled(crashOnly.copy(shakeToReportEnabled = true)))
        assertFalse(ShakeToReportTrigger.localEnabled(EverframeConfig(appId = "app", sdkKey = "key", shakeToReportEnabled = false)))
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
    fun `an in-flight quick capture holds shake off`() {
        val gate = ShakeToReportGate(localEnabled = true)
        gate.foreground = true
        gate.remoteEnabled = true

        assertFalse(gate.tryBegin(presenting = false, quickCaptureInFlight = true))
        assertTrue(gate.tryBegin(presenting = false, quickCaptureInFlight = false))
        gate.complete()
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

    @Test
    fun `Fire TV is a television by Amazon's system feature alone`() {
        assertTrue(
            ShakeToReportTrigger.isTelevision(
                Configuration.UI_MODE_TYPE_NORMAL,
                hasLeanback = false,
                hasTelevisionFeature = false,
                hasFireTvFeature = true,
            ),
        )
        val app = ApplicationProvider.getApplicationContext<Application>()
        assertFalse(ShakeToReportTrigger.isTelevision(app))
        shadowOf(app.packageManager).setSystemFeature("amazon.hardware.fire_tv", true)
        assertTrue(ShakeToReportTrigger.isTelevision(app))
    }

    // ---- real-device quick capture: shake for capture and linking ----

    @Test
    fun `shake listens while gesture armed even with shake-to-report off`() {
        val gate = ShakeToReportGate(localEnabled = false)
        gate.remoteEnabled = false
        gate.foreground = true
        assertFalse(gate.shouldListen())
        gate.gestureArmed = true
        assertTrue(gate.shouldListen())
        // Armed shake never opens the reporter by itself: that still needs both shake-to-report switches.
        assertFalse(gate.tryBegin(presenting = false))
    }

    @Test
    fun `shake does not listen in background or when nothing wants it`() {
        val gate = ShakeToReportGate(localEnabled = true)
        gate.remoteEnabled = true
        gate.gestureArmed = true
        assertFalse("background", gate.shouldListen())
        gate.foreground = true
        assertTrue(gate.shouldListen())
        gate.gestureArmed = false
        assertTrue("shake-to-report alone", gate.shouldListen())
        gate.remoteEnabled = false
        assertFalse("nothing wants it", gate.shouldListen())
        gate.remoteEnabled = null
        gate.localEnabled = false
        assertFalse(gate.shouldListen())
    }

    @Test
    fun `crash-only session never installs shake`() {
        val app: Application = ApplicationProvider.getApplicationContext()
        val sensors = addAccelerometer(app)
        ShakeToReportTrigger.install(app, localEnabled = false, reporterEnabled = false, currentActivity = null, isCurrent = { true })
        idleMain()
        ShakeToReportTrigger.publishGestureArmed(true) { true }
        ShakeToReportTrigger.__setForegroundForTesting(true)
        idleMain()
        assertFalse(shadowOf(sensors).hasListener(ShakeToReportTrigger))

        // The same session with the reporter on (shake-to-report off) does listen while armed.
        ShakeToReportTrigger.install(app, localEnabled = false, reporterEnabled = true, currentActivity = null, isCurrent = { true })
        idleMain()
        ShakeToReportTrigger.__setForegroundForTesting(true)
        ShakeToReportTrigger.publishGestureArmed(true) { true }
        idleMain()
        assertTrue(shadowOf(sensors).hasListener(ShakeToReportTrigger))
        ShakeToReportTrigger.publishGestureArmed(false) { true }
        idleMain()
        assertFalse(shadowOf(sensors).hasListener(ShakeToReportTrigger))
        ShakeToReportTrigger.publishGestureArmed(true) { false }
        idleMain()
        assertFalse("a stale publish changes nothing", shadowOf(sensors).hasListener(ShakeToReportTrigger))
    }

    @Test
    fun `shake on unlinked release phone opens the reporter only when shake-to-report allows it`() {
        val app: Application = ApplicationProvider.getApplicationContext()
        Everframe.captureGate = true
        try {
            DeviceLink.__setCurrentForTesting(null, enabled = true)
            QuickCapture.install(app, localEnabled = true, debug = false)
            QuickCapture.publishRemote(CaptureHotkeyConfigWire(enabled = true))
            var hellos = 0
            var captures = 0
            var opens = 0
            CaptureGesture.helloSender = { hellos++ }
            CaptureGesture.captureTrigger = { captures++ }
            ShakeToReportTrigger.reporterOpener = { opens++ }

            for (shakeToReport in listOf(true, false)) {
                ShakeToReportTrigger.install(app, localEnabled = shakeToReport, reporterEnabled = true, currentActivity = null, isCurrent = { true })
                idleMain()
                ShakeToReportTrigger.publishRemote(true) { true }
                ShakeToReportTrigger.__setForegroundForTesting(true)
                idleMain()
                ShakeToReportTrigger.onShake()
                idleMain()
            }
            assertEquals("a hello on every shake", 2, hellos)
            assertEquals("never a capture on an unlinked release phone", 0, captures)
            assertEquals("the reporter only with shake-to-report on", 1, opens)
        } finally {
            Everframe.captureGate = false
        }
    }

    @Test
    fun `shake while a quick capture is in flight is ignored`() {
        val app: Application = ApplicationProvider.getApplicationContext()
        Everframe.captureGate = true
        try {
            DeviceLink.__setCurrentForTesting(null, enabled = true)
            QuickCapture.install(app, localEnabled = true, debug = true)
            QuickCapture.publishRemote(CaptureHotkeyConfigWire(enabled = true))
            var hellos = 0
            var captures = 0
            var opens = 0
            CaptureGesture.helloSender = { hellos++ }
            CaptureGesture.captureTrigger = { captures++ }
            ShakeToReportTrigger.reporterOpener = { opens++ }
            ShakeToReportTrigger.install(app, localEnabled = true, reporterEnabled = true, currentActivity = null, isCurrent = { true })
            idleMain()
            ShakeToReportTrigger.publishRemote(true) { true }
            ShakeToReportTrigger.__setForegroundForTesting(true)

            QuickCapture.__setCapturingForTesting(true)
            ShakeToReportTrigger.onShake()
            idleMain()
            assertEquals(0, captures + hellos + opens)

            QuickCapture.__setCapturingForTesting(false)
            ShakeToReportTrigger.onShake()
            idleMain()
            assertEquals("debug build: a shared capture and a hello", 1, captures)
            assertEquals(1, hellos)
            assertEquals("no reporter when the shake captured", 0, opens)
        } finally {
            QuickCapture.__setCapturingForTesting(false)
            Everframe.captureGate = false
        }
    }

    private fun addAccelerometer(context: Context): SensorManager {
        val sensors = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
        if (sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) == null) {
            shadowOf(sensors).addSensor(ShadowSensor.newInstance(Sensor.TYPE_ACCELEROMETER))
        }
        return sensors
    }

    private fun idleMain() = shadowOf(Looper.getMainLooper()).idle()
}
