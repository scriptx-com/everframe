// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.ui

import android.graphics.Bitmap
import android.os.Looper
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import dev.everframe.Everframe
import dev.everframe.capture.ScreenshotCapture
import dev.everframe.config.ReportResult
import dev.everframe.config.EverframeConfig
import dev.everframe.config.CaptureConfig
import dev.everframe.capture.sharedBreadcrumbBuffer
import dev.everframe.capture.video.FrozenReportCapture
import kotlinx.coroutines.*
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
@LooperMode(LooperMode.Mode.PAUSED)
class ReporterDialogLifecycleTest {
    @Before fun setup() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun cleanup() { Everframe.kill(); resetReporterTestState(); Dispatchers.resetMain() }

    @Test fun destroyingMountedHostSettlesResultAndRemovesReporter() = runBlocking {
        val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        val activity = controller.get()
        activity.setContentView(android.widget.FrameLayout(activity))
        val content = activity.findViewById<ViewGroup>(android.R.id.content)
        val originalChildren = content.childCount
        val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
        val capture = Everframe.__replayFreeze()
        val result = async(Dispatchers.Main) {
            ReporterDialog.show(activity, ScreenshotCapture.CaptureResult(bitmap, 2, 2, byteArrayOf(1)), capture)
        }
        try {
            assertEquals(originalChildren + 1, content.childCount)
            assertFalse(result.isCompleted)
            controller.pause().stop().destroy()
            shadowOf(Looper.getMainLooper()).idle()
            assertTrue("Destroying the mounted host must settle the reporter result", result.isCompleted)
            assertEquals(ReportResult.Cancelled("activity_destroyed"), result.await())
            assertEquals(originalChildren, content.childCount)
        } finally { result.cancelAndJoin(); capture.cancel() }
    }

    @Test fun destructionReleasesPresentingAndCaptureAndAllowsAnotherOpen() = runBlocking {
        val host = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        host.get().setContentView(android.widget.FrameLayout(host.get()))
        startCapture(host.get())
        var owned: FrozenReportCapture? = null
        val presenter = TXReporterPresenter(
            captureScreenshot = { _, _ -> screenshot() },
            showDialog = { activity, screenshot, capture, extra ->
                owned = capture
                ReporterDialog.show(activity, screenshot, capture, extra)
            },
        )
        val first = async(Dispatchers.Main) { presenter.openReporter(host.get()) }
        try {
            assertTrue(Everframe.report.isPresenting.value)
            host.pause().stop().destroy()
            assertTrue(first.isCompleted)
            assertEquals(ReportResult.Cancelled("activity_destroyed"), first.await())
            assertFalse(Everframe.report.isPresenting.value)
            assertNull("Destroyed report must release its frozen evidence", owned!!.takeBreadcrumbs())

            val next = Robolectric.buildActivity(ComponentActivity::class.java).setup()
            next.get().setContentView(android.widget.FrameLayout(next.get()))
            val reopened = async(Dispatchers.Main) { presenter.openReporter(next.get()) }
            try {
                assertTrue(Everframe.report.isPresenting.value)
                assertFalse(reopened.isCompleted)
                next.pause().stop().destroy()
                assertEquals(ReportResult.Cancelled("activity_destroyed"), reopened.await())
                assertFalse(Everframe.report.isPresenting.value)
            } finally { reopened.cancelAndJoin() }
        } finally { first.cancelAndJoin() }
    }

    @Test fun unrelatedDestructionAndBackgroundingLeaveDialogOpenButCallerCancellationCleansUp() = runBlocking {
        val host = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        val activity = host.get()
        activity.setContentView(android.widget.FrameLayout(activity))
        val content = activity.findViewById<ViewGroup>(android.R.id.content)
        val originalChildren = content.childCount
        startCapture(activity)
        val capture = Everframe.__replayFreeze()
        val result = async(Dispatchers.Main) { ReporterDialog.show(activity, screenshot(), capture) }
        try {
            Robolectric.buildActivity(ComponentActivity::class.java).setup().pause().stop().destroy()
            host.pause().stop()
            assertFalse(result.isCompleted)
            assertEquals(originalChildren + 1, content.childCount)
            result.cancelAndJoin()
            assertEquals(originalChildren, content.childCount)
            assertNull(capture.takeBreadcrumbs())
            host.destroy()
            Unit
        } finally { result.cancelAndJoin(); capture.cancel() }
    }

    @Test fun sendTransfersCaptureAndResultOwnershipBeforeActivityDestruction() = runBlocking {
        val host = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        startCapture(host.get())
        val capture = Everframe.__replayFreeze()
        val result = CompletableDeferred<ReportResult>()
        var dismissed = 0
        lateinit var lifecycle: ReporterDialogLifecycle
        lifecycle = ReporterDialogLifecycle(host.get(), capture, result) {
            dismissed++
            lifecycle.cancel("reentrant_dismiss")
        }
        try {
            assertTrue(lifecycle.beginSubmit())
            assertEquals(1, dismissed)
            host.pause().stop().destroy()
            lifecycle.cancel("late_cancel")
            assertFalse(lifecycle.beginSubmit())
            assertEquals(1, dismissed)
            assertFalse("Destruction cannot replace an in-flight submission result", result.isCompleted)
            assertEquals(listOf("owned-evidence"), capture.takeBreadcrumbs()!!.map { it.message })
            // Submission, rather than lifecycle teardown, settles its result.
            result.complete(ReportResult.Cancelled("submission_result"))
            assertEquals(ReportResult.Cancelled("submission_result"), result.await())
        } finally { capture.finishConsumption() }
    }

    @Test fun destroyedHostCannotMountAReporter() = runBlocking {
        val host = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        host.get().setContentView(android.widget.FrameLayout(host.get()))
        val content = host.get().findViewById<ViewGroup>(android.R.id.content)
        val originalChildren = content.childCount
        host.pause().stop().destroy()
        val capture = Everframe.__replayFreeze()
        try {
            assertEquals(ReportResult.Cancelled("activity_destroyed"), ReporterDialog.show(host.get(), screenshot(), capture))
            assertEquals(originalChildren, content.childCount)
        } finally { capture.cancel() }
    }

    private fun screenshot(): ScreenshotCapture.CaptureResult {
        val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
        return ScreenshotCapture.CaptureResult(bitmap, 2, 2, byteArrayOf(1))
    }

    private fun startCapture(activity: ComponentActivity) {
        Everframe.start(activity, EverframeConfig(appId = "lifecycle-fixture", sdkKey = "ef_fixture_only", capture = CaptureConfig(logs = false)))
        val session = Everframe::class.java.getDeclaredField("_replaySession").apply { isAccessible = true }
        val deadline = System.nanoTime() + 5_000_000_000L
        while (session.get(null) == null && System.nanoTime() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(5)
        }
        assertNotNull("Capture must be initialized for ownership assertions", session.get(null))
        sharedBreadcrumbBuffer.clear()
        Everframe.addBreadcrumb("owned-evidence")
    }

}
