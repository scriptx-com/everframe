// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// After Send the reporter leaves the screen while its report uploads. An open
// in that window must neither join the upload nor present a second reporter.
// TXReporterPresenterSingleFlightTest covers the presenter with fake dialogs;
// only the real dialog tells the presenter that Send happened, so these tests
// fill in the real dialog and press its Send button.

package dev.everframe.ui

import android.app.Activity
import android.graphics.Bitmap
import android.os.Looper
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import dev.everframe.Everframe
import dev.everframe.capture.ScreenshotCapture
import dev.everframe.config.CaptureConfig
import dev.everframe.config.EverframeConfig
import dev.everframe.config.ReportResult
import dev.everframe.transport.MultipartUploader
import dev.everframe.transport.ReportSubmitter
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
// The host-image entry point decodes a real PNG, which legacy graphics cannot.
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ReporterDialogSingleFlightTest {
    @get:Rule val compose = createEmptyComposeRule()

    @After fun cleanup() {
        ReporterDialog.__submitterFactoryForTesting = null
        Everframe.kill(); Everframe.clearExtra(); resetReporterTestState()
    }

    @Test fun openDuringTheUploadIsRejectedAfterSend() = assertOpensDuringTheUploadAreRejected { host ->
        TXReporterPresenter(captureScreenshot = { _, _ -> screenshot() }).openReporter(host)
    }

    @Test fun openDuringAHostImageReportUploadIsRejectedAfterSend() = assertOpensDuringTheUploadAreRejected { host ->
        EFReporterFromImage.open(host, png())
    }

    private fun assertOpensDuringTheUploadAreRejected(open: suspend (Activity) -> ReportResult) = runBlocking {
        val host = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        host.get().setContentView(FrameLayout(host.get()))
        startSdk(host.get())
        val upload = CountDownLatch(1)
        holdUploads(upload)
        val first = async(Dispatchers.Main.immediate) { open(host.get()) }
        var joined: Deferred<ReportResult>? = null
        try {
            compose.waitUntil(5_000) { compose.onAllNodesWithText("Title *").fetchSemanticsNodes(atLeastOneRootRequired = false).isNotEmpty() }
            joined = async(Dispatchers.Main.immediate) { openElsewhere(host.get()) }
            assertFalse("an open while the reporter is on screen joins it", joined.isCompleted)

            compose.onNodeWithText("Title *").performTextInput("Checkout froze")
            // The button's own click action, as a tap or TalkBack runs it.
            compose.onNodeWithText("Send report").performSemanticsAction(SemanticsActions.OnClick)
            assertTurnedAway(async(Dispatchers.Main.immediate) { openElsewhere(host.get()) })
            // The report uploads, which outlives its activity.
            host.pause().stop().destroy()
            val next = Robolectric.buildActivity(Activity::class.java).setup().get()
            assertTurnedAway(async(Dispatchers.Main.immediate) { openElsewhere(next) })
            assertFalse("the first report is still uploading", first.isCompleted)

            upload.countDown()
            awaitIdling(first, joined)
            assertTrue(first.await() is ReportResult.Queued)
            assertEquals("a caller that joined before Send receives the report's outcome", first.await(), joined.await())
        } finally {
            upload.countDown()
            first.cancel(); joined?.cancel()
        }
    }

    /** An open while the report uploads resolves at once, without joining it or presenting. */
    private suspend fun assertTurnedAway(open: Deferred<ReportResult>) {
        try {
            assertTrue("an open after Send must resolve without waiting for the upload", open.isCompleted)
            assertEquals(ReportResult.Cancelled("already_presenting"), open.await())
        } finally { open.cancel() }
    }

    /** An open from another entry point. It presents only if the first reporter no longer counts. */
    private suspend fun openElsewhere(activity: Activity) = TXReporterPresenter(
        captureScreenshot = { _, _ -> screenshot() },
        showDialog = { _, _, _, _, _ -> ReportResult.Cancelled("second_reporter") },
    ).openReporter(activity)

    private fun screenshot(): ScreenshotCapture.CaptureResult =
        ScreenshotCapture.CaptureResult(Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888), 2, 2, byteArrayOf(1))

    /** A real 1x1 PNG: the host-image entry point checks its signature and decodes it. */
    private fun png(): ByteArray = Base64.getDecoder().decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    )

    /** Holds every upload until [upload] opens, then fails it so the report is queued. */
    private fun holdUploads(upload: CountDownLatch) {
        val outbox = testOutbox()
        val held = OkHttpClient.Builder().addInterceptor {
            upload.await(30, TimeUnit.SECONDS)
            throw java.io.IOException("offline test")
        }.build()
        ReporterDialog.__submitterFactoryForTesting = { cfg, _ -> ReportSubmitter(cfg, outbox, uploader = MultipartUploader(held)) }
    }

    private fun awaitIdling(vararg results: Deferred<*>) {
        val deadline = System.nanoTime() + 30_000_000_000L
        while (results.any { !it.isCompleted } && System.nanoTime() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(5)
        }
        assertTrue("the upload did not settle the reporter result", results.all { it.isCompleted })
    }

    private fun startSdk(activity: Activity) {
        Everframe.start(
            activity,
            EverframeConfig(appId = "a", sdkKey = "txx_live_test1234567890", capture = CaptureConfig(logs = false)),
        )
        val field = Everframe::class.java.getDeclaredField("_replaySession").apply { isAccessible = true }
        val deadline = System.nanoTime() + 5_000_000_000L
        while (field.get(null) == null && System.nanoTime() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(5)
        }
        assertNotNull("public start must install its coordinator", field.get(null))
    }
}
