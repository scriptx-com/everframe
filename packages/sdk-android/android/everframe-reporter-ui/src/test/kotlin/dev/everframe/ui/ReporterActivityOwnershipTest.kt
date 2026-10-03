// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.ui

import android.app.Activity
import android.graphics.Bitmap
import dev.everframe.Everframe
import dev.everframe.capture.ScreenshotCapture
import dev.everframe.capture.sharedBreadcrumbBuffer
import dev.everframe.config.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class ReporterActivityOwnershipTest {
    @After fun close() { Everframe.kill(); resetReporterTestState() }
    @Test fun activityLostDuringScreenshotCancelsOwnedCapture() = runBlocking {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val next = Robolectric.buildActivity(Activity::class.java).setup().get()
        val config = EverframeConfig(appId = "old", sdkKey = "ef_fixture_only", capture = CaptureConfig(logs = false))
        Everframe.start(activity, config)
        awaitSession()
        ActivityRegistry.seed(activity.application, activity)
        var mounted = false
        var replacement: dev.everframe.capture.video.FrozenReportCapture? = null
        val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
        val presenter = TXReporterPresenter(
            captureScreenshot = { _, _ ->
                ActivityRegistry.onActivityPaused(activity)
                ActivityRegistry.seed(next.application, next)
                Everframe.start(next, config.copy(appId = "new"))
                awaitSession()
                sharedBreadcrumbBuffer.clear()
                Everframe.addBreadcrumb("new-owner")
                replacement = Everframe.__replayFreeze()
                ScreenshotCapture.CaptureResult(bitmap, 2, 2, byteArrayOf(1))
            },
            showDialog = { _, _, _, _ -> mounted = true; ReportResult.Cancelled("unexpected_mount") },
        )
        val result = presenter.openReporter(activity) { ActivityRegistry.isCurrent(activity) }
        assertEquals(ReportResult.Cancelled("no_active_activity"), result)
        assertFalse(mounted)
        assertEquals(listOf("new-owner"), replacement!!.takeBreadcrumbs()!!.map { it.message })
        replacement!!.cancel()
        assertFalse(Everframe.report.isPresenting.value)
    }
    private fun awaitSession() {
        val field = Everframe::class.java.getDeclaredField("_replaySession").apply { isAccessible = true }
        val deadline = System.nanoTime() + 5_000_000_000L
        while (field.get(null) == null && System.nanoTime() < deadline) {
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
            Thread.sleep(5)
        }
        assertNotNull(field.get(null))
    }
}
