// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Task 5 — companion freeze/discard lifecycle. The phone-companion flow has
// no on-device reporter UI, so `report.request` IS reporter-open: it must
// freeze the breadcrumb/replay buffers the same way `TXReporterPresenter`
// does on-device, and a failed capture must discard the stale freeze so a
// later report doesn't inherit it.

package dev.everframe.companion

import androidx.test.core.app.ApplicationProvider
import dev.everframe.Everframe
import dev.everframe.capture.sharedBreadcrumbBuffer
import dev.everframe.protocol.generated.ReportAssembled
import dev.everframe.protocol.generated.ReportAssembledCounts
import dev.everframe.protocol.generated.ReportAssembledToggles
import dev.everframe.shared.SharedData
import okhttp3.Request
import okhttp3.WebSocket
import okio.ByteString
import org.junit.After
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class CompanionFreezeLifecycleTest {

    private class FakeWs : WebSocket {
        override fun send(text: String): Boolean = true
        override fun send(bytes: ByteString): Boolean = true
        override fun close(code: Int, reason: String?): Boolean = true
        override fun cancel() {}
        override fun queueSize(): Long = 0
        override fun request(): Request = Request.Builder().url("https://relay.test").build()
    }

    private fun minimalPayload(correlationId: String) =
        CompanionCaptureBridge.AssembledPayload(
            assembled = ReportAssembled(
                correlationId = correlationId,
                counts = ReportAssembledCounts(logs = 0L, network = 0L, uiTreeNodes = 0L),
                mime = "image/png",
                size = 1L,
                toggles = ReportAssembledToggles(
                    logs = true, metadata = true, network = true,
                    screenshot = true, uiTree = false,
                ),
                tree = null,
            ),
            pngBytes = byteArrayOf(1),
        )

    @Before
    fun setUp() {
        SharedData.init(ApplicationProvider.getApplicationContext())
        Everframe.start(ApplicationProvider.getApplicationContext(), dev.everframe.config.EverframeConfig(
            appId = "test", sdkKey = "txx_live_test1234567890", environment = dev.everframe.config.Environment.production))
        sharedBreadcrumbBuffer.applyConfig(null)
        sharedBreadcrumbBuffer.clear()
    }

    @After
    fun tearDown() {
        CompanionCaptureBridge.__teardownForTesting()
        sharedBreadcrumbBuffer.clear()
        Everframe.kill()
    }

    @Test
    fun reportRequestFreezesBreadcrumbChain() {
        Everframe.addBreadcrumb("before-report")
        var frozen: dev.everframe.capture.video.FrozenReportCapture? = null
        CompanionCaptureBridge.__captureProvider = { id, capture ->
            frozen = capture
            org.junit.Assert.assertEquals(listOf("before-report"), capture.takeBreadcrumbs()!!.map { it.message })
            minimalPayload(id)
        }
        // Explicit `null` — this is the QR path, which carries no attribution
        // token. `onReportRequest` has no default for that parameter on
        // purpose (see its KDoc), so every call site states what the token is.
        CompanionCaptureBridge.onReportRequest("corr-1", FakeWs(), null)
        // The cancel+freeze pair is now posted to the main looper (review
        // finding: ReplaySession is main-thread-confined, but this runs on
        // the OkHttp WS reader thread in production). Under Robolectric's
        // PAUSED looper mode the posted runnable doesn't run until drained.
        shadowOf(android.os.Looper.getMainLooper()).idle()
        assertNotNull(frozen)
    }

    @Test
    fun duplicateDisconnectCallbacksCannotCancelReplacementCapture() {
        val oldClient = RelayWSClient(client = okhttp3.OkHttpClient())
        val nextClient = RelayWSClient(client = okhttp3.OkHttpClient())
        CompanionCaptureBridge.__captureProvider = { id, _ -> minimalPayload(id) }
        CompanionCaptureBridge.onReportRequest("old", FakeWs(), null, oldClient)
        oldClient.listener.onClosing(FakeWs(), 1000, "closed")
        oldClient.listener.onClosing(FakeWs(), 1000, "duplicate")
        Everframe.start(ApplicationProvider.getApplicationContext(), dev.everframe.config.EverframeConfig(
            appId = "replacement", sdkKey = "txx_live_test1234567890"))
        val deadline = System.nanoTime() + 5_000_000_000L
        while (Everframe._replaySession == null && System.nanoTime() < deadline) Thread.sleep(5)
        org.junit.Assert.assertNotNull(Everframe._replaySession)
        sharedBreadcrumbBuffer.clear(); Everframe.addBreadcrumb("replacement")
        CompanionCaptureBridge.onReportRequest("new", FakeWs(), null, nextClient)
        val newer = CompanionCaptureBridge.captureFor("new")!!
        // Both old callbacks run only now, after the replacement acquired its owner.
        shadowOf(android.os.Looper.getMainLooper()).idle()
        org.junit.Assert.assertEquals(listOf("replacement"), newer.takeBreadcrumbs()!!.map { it.message })
        newer.cancel(); oldClient.stop(); nextClient.stop()
    }

    @Test
    fun detachedCaptureCannotPublishAfterNewOwnerArrives() {
        val oldClient = Any()
        CompanionCaptureBridge.__captureProvider = { id, _ -> minimalPayload(id) }
        CompanionCaptureBridge.onReportRequest("old", FakeWs(), null, oldClient)
        val old = CompanionCaptureBridge.takeCaptureFor(oldClient)!!
        CompanionCaptureBridge.onReportRequest("new", FakeWs(), null, Any())
        var oldPublished = false
        org.junit.Assert.assertFalse(CompanionCaptureBridge.__publishCapture("old", old) { oldPublished = true })
        org.junit.Assert.assertFalse(oldPublished)
        val newer = CompanionCaptureBridge.captureFor("new")!!
        var newPublished = false
        org.junit.Assert.assertTrue(CompanionCaptureBridge.__publishCapture("new", newer) { newPublished = true })
        org.junit.Assert.assertTrue(newPublished)
        old.cancel(); newer.cancel()
    }

    @Test
    fun captureFailureDiscardsSnapshot() {
        Everframe.addBreadcrumb("x")
        CompanionCaptureBridge.__captureProvider = { _, _ -> null }
        // `onReportRequest`'s documented precondition: `RelayWSClient` has
        // already flipped the pair into `ReportInProgress` for THIS
        // correlation_id before dispatching here. That is now a claim rather
        // than a bare state, and the failure exit's discard is gated on still
        // holding it (PR-fix 7) — a discard run for a report a re-bond already
        // superseded would throw away the LIVE report's frozen snapshot. Stand
        // the precondition up, or this test asserts the discard from outside
        // the contract the production caller satisfies.
        Companion.__beginReport("corr-2")
        CompanionCaptureBridge.onReportRequest("corr-2", FakeWs(), null)
        // Same reasoning as above — drain the posted cancel+freeze (and the
        // payload-null branch's posted cancel) before asserting.
        shadowOf(android.os.Looper.getMainLooper()).idle()
        assertNull(sharedBreadcrumbBuffer.takeFrozen())
    }
}
