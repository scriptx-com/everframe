// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.os.Looper
import android.os.PowerManager
import androidx.test.core.app.ApplicationProvider
import dev.everframe.Everframe
import dev.everframe.capture.replay.ReplaySession
import dev.everframe.config.ConfigFetcher
import dev.everframe.config.ReplayConfigProvider
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class VideoDeviceConditionsTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val power get() = shadowOf(context.getSystemService(PowerManager::class.java))

    private fun powerSaveChanged(on: Boolean) {
        power.setIsPowerSaveMode(on)
        context.sendBroadcast(Intent(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED))
        shadowOf(Looper.getMainLooper()).idle()
    }

    @Test fun batterySaverPausesThroughItsChangeBroadcast() {
        val conditions = AndroidVideoDeviceConditions(context)
        assertFalse(conditions.pauseRecording())
        power.setIsPowerSaveMode(true)
        assertFalse("ticks read the cached value, never a binder call", conditions.pauseRecording())
        powerSaveChanged(true); assertTrue(conditions.pauseRecording())
        powerSaveChanged(false); assertFalse(conditions.pauseRecording())
    }

    @Test fun thermalModerateAndAbovePauseAndLightDoesNot() {
        val conditions = AndroidVideoDeviceConditions(context)
        for ((status, paused) in listOf(
            PowerManager.THERMAL_STATUS_LIGHT to false,
            PowerManager.THERMAL_STATUS_MODERATE to true,
            PowerManager.THERMAL_STATUS_SEVERE to true,
            PowerManager.THERMAL_STATUS_NONE to false,
        )) {
            power.setCurrentThermalStatus(status)
            assertEquals("thermal=$status", paused, conditions.pauseRecording())
        }
    }

    @Test fun lowRamComesFromActivityManager() {
        assertFalse(AndroidVideoDeviceConditions(context).lowRamDevice)
        shadowOf(context.getSystemService(ActivityManager::class.java)).setIsLowRamDevice(true)
        assertTrue(AndroidVideoDeviceConditions(context).lowRamDevice)
    }

    @Test fun lowRamDeviceNeverConstructsARecorder() = runBlocking {
        dev.everframe.shared.SharedData.init(context)
        Everframe.captureGate = true
        try {
            for (lowRam in listOf(true, false)) {
                var constructed = 0
                val scheduler = object : VideoCaptureScheduler {
                    override fun main(block: () -> Unit) = Unit
                    override fun worker(block: () -> Unit) = block()
                    override fun later(delayMs: Long, block: () -> Unit): () -> Unit = {}
                    override fun isWorkerThread() = false
                    override fun nowNanos() = 0L
                }
                val session = ReplaySession(sdkKey = "k", context = context, provider = ReplayConfigProvider.make("https://a.test", "k",
                    ConfigFetcher { request ->
                        Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("test")
                            .body("""{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,"nativeVideo":{"framesPerSecond":2}}"""
                                .toResponseBody("application/json".toMediaType())).build()
                    }))
                session.videoStartupAdmission = VideoStartupAdmission(scheduler) { _, _ -> true }
                session.videoDeviceConditions = object : VideoDeviceConditions {
                    override fun pauseRecording() = false
                    override val lowRamDevice = lowRam
                }
                session.recorderFactory = { _, owner, _ ->
                    constructed++
                    NativeVideoRecorder(owner, scheduler, { block -> block(); true }, { null }, { null },
                        { _, _, _ -> error("no encoder in this test") }, { _, _ -> null })
                }
                try {
                    session.refreshConfigNow()
                    assertEquals("lowRam=$lowRam", if (lowRam) 0 else 1, constructed)
                    assertEquals(if (lowRam) NativeVideoRecorder.State.DISABLED else NativeVideoRecorder.State.BUFFERING,
                        session.__lifecycleStateForTesting())
                } finally { session.teardown() }
            }
        } finally { Everframe.captureGate = false }
    }
}
