// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Debug-only unit test source set: this test assigns core's debug
// `EndpointOverride`, which the release variant exposes only as an immutable
// null. The debug ingest URL itself is a build-time constant that differs
// between machines, so the test chooses its own unreachable endpoint instead.
@file:Suppress("INVISIBLE_MEMBER", "INVISIBLE_REFERENCE")
package dev.everframe.ui

import android.graphics.Bitmap
import dev.everframe.Everframe
import dev.everframe.capture.ScreenshotCapture
import dev.everframe.capture.sharedResourceBuffer
import dev.everframe.config.EndpointOverride
import dev.everframe.config.Environment
import dev.everframe.config.EverframeConfig
import dev.everframe.ui.details.ReporterIncludes
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class ReporterDeliveryDiagnosticsTest {
    private val previousEndpoint = EndpointOverride.current

    @After
    fun tearDown() {
        ReporterDialog.__submitterFactoryForTesting = null
        Everframe.kill()
        Everframe.__replayConfigOverrideForTesting = null
        sharedResourceBuffer.clear()
        EndpointOverride.current = previousEndpoint
    }

    @Test
    fun `production reporter publishes live submission diagnostics`() {
        // Exercise the default factory against a loopback port that was just
        // closed, so the report can never reach an external service.
        val closedPort = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { it.localPort }
        EndpointOverride.current = "http://127.0.0.1:$closedPort"
        ReporterDialog.__submitterFactoryForTesting = null
        val controller = Robolectric.buildActivity(android.app.Activity::class.java).create()
        val activity = controller.get()
        Everframe.start(activity.applicationContext, EverframeConfig(
            appId = "test-app-id", sdkKey = "txx_live_test1234567890",
            environment = Environment.production,
        ))
        val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
        val png = ByteArrayOutputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
            it.toByteArray()
        }
        val capture = ScreenshotCapture.CaptureResult(bitmap, 2, 2, png)
        val captured = Everframe.captureSessionSnapshot()
        val completed = java.util.concurrent.CountDownLatch(1)
        val failure = AtomicReference<Throwable?>(null)
        CoroutineScope(Dispatchers.IO).launch {
            try {
                ReporterDialog.submitBaked(
                    reportCapture = Everframe.__replayFreeze(), activity = activity,
                    capture = capture,
                    shots = listOf(SubmittedShot(bitmap, emptyList())),
                    title = "Delivery diagnostics", description = "Local test",
                    capturedSession = captured, hostExtra = null, includes = ReporterIncludes(),
                )
            } catch (error: Throwable) {
                failure.set(error)
            } finally {
                completed.countDown()
            }
        }
        val deadline = System.currentTimeMillis() + 30_000
        while (completed.count > 0 && System.currentTimeMillis() < deadline) {
            shadowOf(android.os.Looper.getMainLooper()).idle()
            Thread.sleep(5)
        }
        assertEquals("submit did not finish: ${failure.get()}", 0L, completed.count)
        val status = Everframe.getReportDeliveryStatus()
        assertEquals(1, status.transport.getValue("live-submit").settledAttempts)
        assertEquals(1, status.transport.getValue("live-submit").outcomes.getValue("network-failure"))
        controller.destroy()
    }
}
