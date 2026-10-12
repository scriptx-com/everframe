// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Crash-only sessions (spec 2026-10-12): `report.open()` throws before the presenter is reached, so this
// guards the callers that build a presenter directly, such as EFReporterFromImage (Flutter and KMP).

package dev.everframe.ui

import android.app.Activity
import android.graphics.Bitmap
import dev.everframe.Everframe
import dev.everframe.capture.ScreenshotCapture
import dev.everframe.config.CaptureConfig
import dev.everframe.config.EverframeConfig
import dev.everframe.config.ReportResult
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class TXReporterPresenterCrashOnlyTest {
    @Before fun reset() { TXReporterPresenter.__resetSingleFlightForTesting() }
    @After fun close() { Everframe.kill(); Everframe.clearExtra(); TXReporterPresenter.__resetSingleFlightForTesting() }

    @Test fun aCrashOnlySessionNeverCapturesOrPresents() = runBlocking {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        Everframe.start(activity, EverframeConfig(appId = "a", sdkKey = "txx_live_test1234567890",
            capture = CaptureConfig(logs = false), reporterEnabled = false))
        val captured = AtomicInteger(0)
        val presented = AtomicInteger(0)
        val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
        val presenter = TXReporterPresenter(
            captureScreenshot = { _, _ -> captured.incrementAndGet(); ScreenshotCapture.CaptureResult(bitmap, 2, 2, byteArrayOf(1)) },
            showDialog = { _, _, _, _, _ -> presented.incrementAndGet(); ReportResult.Cancelled("user") },
        )

        assertEquals(ReportResult.Cancelled("reporter_disabled"), presenter.openReporter(activity))
        assertEquals(0, captured.get())
        assertEquals(0, presented.get())
        assertFalse(Everframe.report.isPresenting.value)
    }
}
