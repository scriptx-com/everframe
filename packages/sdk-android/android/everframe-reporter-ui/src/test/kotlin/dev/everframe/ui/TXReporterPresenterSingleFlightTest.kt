// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Two opens at once (e.g. the SDK's shake trigger plus a host shake listener
// firing on the same gesture) must present ONE reporter. Before single-flight,
// the second presenter froze an empty replay capture and was the dialog on top,
// so the submitted report silently lost its session replay.

package dev.everframe.ui

import android.app.Activity
import android.graphics.Bitmap
import dev.everframe.Everframe
import dev.everframe.capture.ScreenshotCapture
import dev.everframe.config.CaptureConfig
import dev.everframe.config.EverframeConfig
import dev.everframe.config.ReportResult
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class TXReporterPresenterSingleFlightTest {
    @Before fun reset() { TXReporterPresenter.__resetSingleFlightForTesting() }
    @After fun close() { Everframe.kill(); Everframe.clearExtra(); TXReporterPresenter.__resetSingleFlightForTesting() }

    @Test fun concurrentOpensPresentOneReporterAndShareItsResult() = runBlocking {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        Everframe.start(
            activity,
            EverframeConfig(appId = "a", sdkKey = "txx_live_test1234567890", capture = CaptureConfig(logs = false)),
        )
        awaitSession()

        val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
        val presented = AtomicInteger(0)
        val userSends = CompletableDeferred<ReportResult>()
        fun presenter() = TXReporterPresenter(
            captureScreenshot = { _, _ -> ScreenshotCapture.CaptureResult(bitmap, 2, 2, byteArrayOf(1)) },
            showDialog = { _, _, _, _, _ ->
                presented.incrementAndGet()
                userSends.await()
            },
        )

        // Separate presenter instances, as separate entry points create them.
        val first = async { presenter().openReporter(activity) }
        awaitPresented(presented, 1)
        assertTrue("the first open is still showing", first.isActive)
        val second = async { presenter().openReporter(activity) }
        yield()
        assertEquals("a second open while one is showing must not present again", 1, presented.get())

        val result = ReportResult.Cancelled("user")
        userSends.complete(result)
        assertSame(result, first.await())
        assertSame("the joining caller receives the open report's result", result, second.await())
        assertFalse(Everframe.report.isPresenting.value)

        // Once the report is closed, the next open presents normally.
        val next = presenter().openReporter(activity)
        assertEquals(2, presented.get())
        assertSame(result, next)
    }

    @Test fun destroyedOwnerActivityDoesNotBlockTheNextOpen() = runBlocking {
        val owner = Robolectric.buildActivity(Activity::class.java).setup()
        startSdk(owner.get())
        val presented = AtomicInteger(0)
        // A dialog destroyed with its activity never settles its open. Its owner
        // runs outside that activity's lifecycle, as SDK shake and bridge opens do.
        val ownerScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        try {
            ownerScope.launch { presenter(presented) { awaitCancellation() }.openReporter(owner.get()) }
            assertEquals(1, presented.get())
            val joined = async { presenter(presented) { error("a joining open must not present") }.openReporter(owner.get()) }
            yield()
            assertFalse(joined.isCompleted)

            owner.pause().stop().destroy()
            val next = Robolectric.buildActivity(Activity::class.java).setup().get()
            val result = withTimeout(5_000) {
                presenter(presented) { ReportResult.Cancelled("next") }.openReporter(next)
            }

            assertEquals("the next open presents its own reporter", ReportResult.Cancelled("next"), result)
            assertEquals(2, presented.get())
            assertEquals(ReportResult.Cancelled("activity_destroyed"), withTimeout(5_000) { joined.await() })
        } finally {
            ownerScope.cancel()
        }
    }

    @Test fun joiningCallerDropsItsPendingExtra() = runBlocking {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        startSdk(activity)
        val presented = AtomicInteger(0)
        val extras = mutableListOf<String?>()
        val userSends = CompletableDeferred<ReportResult>()
        val first = async { presenter(presented) { extras += extra; userSends.await() }.openReporter(activity) }
        awaitPresented(presented, 1)

        // The host's own open arrives second, carrying its extra, and joins.
        Everframe.setExtra("joiner-extra")
        val joined = async { presenter(presented) { error("a joining open must not present") }.openReporter(activity) }
        yield()
        userSends.complete(ReportResult.Cancelled("user"))
        first.await()
        joined.await()

        presenter(presented) { extras += extra; ReportResult.Cancelled("later") }.openReporter(activity)
        assertEquals("a later, unrelated report must not inherit the joining caller's extra", listOf(null, null), extras)
    }

    @Test fun openAfterSendDoesNotJoinTheUploadingReport() = runBlocking {
        val owner = Robolectric.buildActivity(Activity::class.java).setup()
        startSdk(owner.get())
        val presented = AtomicInteger(0)
        val sendTapped = CompletableDeferred<Unit>()
        val uploadDone = CompletableDeferred<Unit>()
        val submitted = ReportResult.Submitted(UUID.randomUUID())
        val first = async {
            presenter(presented) {
                sendTapped.await()
                dismiss()
                uploadDone.await()
                submitted
            }.openReporter(owner.get())
        }
        awaitPresented(presented, 1)
        val joined = async { presenter(presented) { error("a joining open must not present") }.openReporter(owner.get()) }
        yield()
        sendTapped.complete(Unit)
        yield()

        // The dialog is gone and the report uploads, which outlives its
        // activity. A new open must neither inherit that report's result nor
        // present a second reporter while the first still holds the replay.
        owner.pause().stop().destroy()
        val next = Robolectric.buildActivity(Activity::class.java).setup().get()
        val late = async { presenter(presented) { error("an open during the upload must not present") }.openReporter(next) }
        yield()
        assertTrue("an open after Send must resolve without waiting for the upload", late.isCompleted)
        assertEquals(ReportResult.Cancelled("already_presenting"), late.await())
        assertFalse(first.isCompleted)

        uploadDone.complete(Unit)
        assertSame(submitted, first.await())
        assertSame("a caller that joined before Send receives the report's outcome", submitted, joined.await())
        assertEquals(1, presented.get())
    }

    /** What a fake dialog is opened with, and how it leaves the screen. */
    private class Shown(val extra: String?, val dismiss: () -> Unit)

    private fun presenter(presented: AtomicInteger, show: suspend Shown.() -> ReportResult) = TXReporterPresenter(
        captureScreenshot = { _, _ ->
            ScreenshotCapture.CaptureResult(Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888), 2, 2, byteArrayOf(1))
        },
        showDialog = { _, _, _, extra, onDismissed ->
            presented.incrementAndGet()
            Shown(extra, onDismissed).show()
        },
    )

    /** Bounded, so a first open that returns without presenting fails instead of hanging the run. */
    private suspend fun awaitPresented(presented: AtomicInteger, count: Int) =
        withTimeout(5_000) { while (presented.get() < count) yield() }

    private fun startSdk(activity: Activity) {
        Everframe.start(
            activity,
            EverframeConfig(appId = "a", sdkKey = "txx_live_test1234567890", capture = CaptureConfig(logs = false)),
        )
        awaitSession()
    }

    private fun awaitSession() {
        val field = Everframe::class.java.getDeclaredField("_replaySession").apply { isAccessible = true }
        val deadline = System.nanoTime() + 5_000_000_000L
        while (field.get(null) == null && System.nanoTime() < deadline) {
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
            Thread.sleep(5)
        }
        assertNotNull("public start must install its coordinator", field.get(null))
    }
}
