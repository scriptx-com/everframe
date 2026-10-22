// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.quickcapture

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.os.Looper
import android.provider.Settings
import androidx.test.core.app.ApplicationProvider
import dev.everframe.Everframe
import dev.everframe.capture.ScreenshotCapture
import dev.everframe.capture.replay.ReplaySession
import dev.everframe.capture.video.FrozenReportCapture
import dev.everframe.companion.CompanionSubmissionComposer
import dev.everframe.config.CaptureHotkeyConfigWire
import dev.everframe.config.ReportResult
import dev.everframe.config.ReporterTrigger
import dev.everframe.trigger.ShakeToReportGate
import dev.everframe.trigger.ShakeToReportTrigger
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowToast

@RunWith(RobolectricTestRunner::class)
class QuickCaptureTest {
    private val app: Application = ApplicationProvider.getApplicationContext()
    private lateinit var activity: Activity
    private val submits = CopyOnWriteArrayList<CompanionSubmissionComposer.Inputs>()
    private val freezes = AtomicInteger()
    private var submitResult: suspend (CompanionSubmissionComposer.Inputs) -> ReportResult =
        { ReportResult.Submitted(UUID.randomUUID()) }
    private var priorSupplier: (() -> Activity?)? = null
    private var priorCaptureGate = false
    private var installedSession: ReplaySession? = null

    @Before
    fun setUp() {
        dev.everframe.shared.SharedData.init(app)
        activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        priorSupplier = Everframe.__activitySupplier
        Everframe.__activitySupplier = { activity }
        priorCaptureGate = Everframe.captureGate
        Everframe.captureGate = true
        Everframe.report.__setPresenting(false)
        QuickCapture.isEmulator = { true }
        QuickCapture.screenshotter = { _, _ ->
            val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
            ScreenshotCapture.CaptureResult(bitmap, 2, 2, byteArrayOf(1, 2, 3))
        }
        QuickCapture.freezer = { trigger ->
            freezes.incrementAndGet()
            Everframe.__replayFreeze(trigger)
        }
        QuickCapture.submitter = { inputs ->
            submits += inputs
            submitResult(inputs)
        }
        Settings.Global.putString(app.contentResolver, CaptureTokenReader.SETTINGS_KEY, null)
        // The test sends the broadcast from the app itself; let it hold DUMP the way the adb shell does.
        shadowOf(app).grantPermissions(QuickCapture.BROADCAST_PERMISSION)
    }

    @After
    fun tearDown() {
        QuickCapture.teardown()
        QuickCapture.__resetForTesting()
        installedSession?.teardown()
        if (installedSession != null) Everframe._replaySession = null
        Everframe.__activitySupplier = priorSupplier
        Everframe.captureGate = priorCaptureGate
        Everframe.report.__setPresenting(false)
        Everframe.clearExtra()
        Settings.Global.putString(app.contentResolver, CaptureTokenReader.SETTINGS_KEY, null)
    }

    // ---- registration ----

    @Test
    fun registersReceiverOnlyOnDebugEmulator() {
        QuickCapture.install(app, localEnabled = true, debug = false)
        assertTrue("release build: no receiver", receivers().isEmpty())

        QuickCapture.isEmulator = { false }
        QuickCapture.install(app, localEnabled = true, debug = true)
        assertTrue("real device: no receiver", receivers().isEmpty())

        QuickCapture.isEmulator = { true }
        QuickCapture.install(app, localEnabled = false, debug = true)
        assertTrue("local opt-out: no receiver", receivers().isEmpty())

        QuickCapture.install(app, localEnabled = true, debug = true)
        val registered = receivers()
        assertEquals(1, registered.size)
        assertEquals(Context.RECEIVER_EXPORTED, registered.single().flags and Context.RECEIVER_EXPORTED)
        // Only senders holding DUMP (the adb shell, not third-party apps) can trigger a capture.
        assertEquals("android.permission.DUMP", registered.single().broadcastPermission)
    }

    @Test
    fun senderWithoutDumpCannotTrigger() {
        shadowOf(app).denyPermissions(QuickCapture.BROADCAST_PERMISSION)
        arm()
        app.sendBroadcast(Intent(QuickCapture.ACTION))
        idleMain()
        assertNull("a sender without DUMP (any third-party app) never reaches the receiver", QuickCapture.__lastTrigger)
        assertTrue(submits.isEmpty())
    }

    @Test
    fun reinstallReplacesTheReceiver() {
        arm()
        arm()
        assertEquals(1, receivers().size)
    }

    @Test
    fun staleInstallIsIgnored() {
        QuickCapture.install(app, localEnabled = true, debug = true, isCurrent = { false })
        assertTrue(receivers().isEmpty())
    }

    @Test
    fun teardownUnregisters() {
        arm()
        assertEquals(1, receivers().size)
        QuickCapture.teardown()
        assertTrue(receivers().isEmpty())
        app.sendBroadcast(Intent(QuickCapture.ACTION))
        idleMain()
        assertNull("no receiver, no capture", QuickCapture.__lastTrigger)
    }

    // ---- gate ----

    @Test
    fun ignoredWithoutRemoteBlock() {
        QuickCapture.install(app, localEnabled = true, debug = true)
        assertEquals(QuickCaptureOutcome.Ignored("remote_disabled"), broadcast())
        QuickCapture.publishRemote(CaptureHotkeyConfigWire(enabled = false))
        assertEquals(QuickCaptureOutcome.Ignored("remote_disabled"), broadcast())
        assertEquals(0, freezes.get())
        assertTrue(submits.isEmpty())
        assertNull("an ignored trigger shows no toast", ShadowToast.getTextOfLatestToast())
    }

    @Test
    fun forcesReplayOnlyWhileArmedWithTheFlag() {
        val forcing = CaptureHotkeyConfigWire(enabled = true, replay = true)
        assertFalse("nothing installed", QuickCapture.forcesReplay)

        QuickCapture.install(app, localEnabled = true, debug = true)
        assertFalse("no block yet", QuickCapture.forcesReplay)
        QuickCapture.publishRemote(forcing)
        assertTrue(QuickCapture.forcesReplay)

        QuickCapture.publishRemote(CaptureHotkeyConfigWire(enabled = true))
        assertFalse("flag absent", QuickCapture.forcesReplay)
        QuickCapture.publishRemote(CaptureHotkeyConfigWire(enabled = true, replay = false))
        assertFalse("flag false", QuickCapture.forcesReplay)
        QuickCapture.publishRemote(CaptureHotkeyConfigWire(enabled = false, replay = true))
        assertFalse("block disabled", QuickCapture.forcesReplay)
        QuickCapture.publishRemote(null)
        assertFalse("no block", QuickCapture.forcesReplay)

        QuickCapture.publishRemote(forcing)
        QuickCapture.publishRemote(CaptureHotkeyConfigWire(enabled = false), isCurrent = { false })
        assertTrue("a stale publish changes nothing", QuickCapture.forcesReplay)

        Everframe.captureGate = false
        assertFalse("kill switch closed", QuickCapture.forcesReplay)
        Everframe.captureGate = true
        assertTrue(QuickCapture.forcesReplay)

        QuickCapture.isEmulator = { false }
        assertFalse("not an emulator", QuickCapture.forcesReplay)
        QuickCapture.isEmulator = { true }

        QuickCapture.teardown()
        assertFalse("torn down", QuickCapture.forcesReplay)

        QuickCapture.install(app, localEnabled = true, debug = true)
        assertFalse("a new session starts unforced", QuickCapture.forcesReplay)

        QuickCapture.install(app, localEnabled = false, debug = true)
        QuickCapture.publishRemote(forcing)
        assertFalse("local opt-out", QuickCapture.forcesReplay)

        QuickCapture.install(app, localEnabled = true, debug = false)
        QuickCapture.publishRemote(forcing)
        assertFalse("release build", QuickCapture.forcesReplay)

        QuickCapture.isEmulator = { false }
        QuickCapture.install(app, localEnabled = true, debug = true)
        QuickCapture.isEmulator = { true }
        QuickCapture.publishRemote(forcing)
        assertFalse("no receiver installed (real device)", QuickCapture.forcesReplay)
    }

    @Test
    fun staleRemotePublishIsIgnored() {
        QuickCapture.install(app, localEnabled = true, debug = true)
        QuickCapture.publishRemote(CaptureHotkeyConfigWire(enabled = true), isCurrent = { false })
        assertEquals(QuickCaptureOutcome.Ignored("remote_disabled"), broadcast())
    }

    @Test
    fun reinstallDisarmsUntilTheNewSessionsConfigArrives() {
        arm()
        QuickCapture.install(app, localEnabled = true, debug = true)
        assertEquals(QuickCaptureOutcome.Ignored("remote_disabled"), broadcast())
    }

    @Test
    fun ignoredWithoutActivity() {
        arm()
        Everframe.__activitySupplier = null
        assertEquals(QuickCaptureOutcome.Ignored("inactive"), broadcast())
        assertEquals(0, freezes.get())
    }

    @Test
    fun ignoredWhileReporterPresenting() {
        arm()
        Everframe.report.__setPresenting(true)
        assertEquals(QuickCaptureOutcome.Ignored("reporter_presenting"), broadcast())
        assertEquals(0, freezes.get())
        assertTrue(submits.isEmpty())
    }

    @Test
    fun ignoredWhileAnotherCaptureHoldsTheFreeze() {
        installReplaySession()
        arm()
        // The companion freezes without marking the reporter presenting, and the
        // in-app reporter freezes before its dialog shows.
        val held = Everframe.__replayFreeze(ReporterTrigger.Companion)
        try {
            assertTrue(Everframe.__replayHasReporterOwner)
            assertEquals(QuickCaptureOutcome.Ignored("capture_frozen"), broadcast())
            assertEquals(0, freezes.get())
            assertTrue(submits.isEmpty())
        } finally {
            held.cancel()
        }
        assertFalse(Everframe.__replayHasReporterOwner)
        assertEquals(QuickCaptureOutcome.Sent, broadcast())
    }

    @Test
    fun secondBroadcastWhileInFlightIgnored() {
        arm()
        val release = CompletableDeferred<Unit>()
        val entered = CompletableDeferred<Unit>()
        submitResult = {
            entered.complete(Unit)
            release.await()
            ReportResult.Submitted(UUID.randomUUID())
        }
        val first = trigger()
        awaitMain(entered)
        assertTrue(QuickCapture.isCapturing)

        assertEquals(QuickCaptureOutcome.Ignored("in_flight"), broadcast())

        release.complete(Unit)
        assertEquals(QuickCaptureOutcome.Sent, awaitMain(first))
        assertFalse(QuickCapture.isCapturing)
        assertEquals(1, freezes.get())
        assertEquals(1, submits.size)
    }

    // ---- pipeline ----

    @Test
    fun broadcastTriggersQuickCaptureSubmit() {
        Settings.Global.putString(app.contentResolver, CaptureTokenReader.SETTINGS_KEY, " t1 ")
        Everframe.setExtra("""{"host":"payload"}""")
        arm()

        assertEquals(QuickCaptureOutcome.Sent, broadcast())

        assertEquals(1, freezes.get())
        val inputs = submits.single()
        assertTrue(inputs.quickCapture)
        assertFalse("a raw screenshot, not an annotated one", inputs.annotated)
        assertEquals("t1", inputs.captureToken)
        assertEquals("", inputs.title)
        assertEquals("", inputs.description)
        assertTrue(inputs.includeLogs && inputs.includeNetwork && inputs.includeMetadata)
        assertNull(inputs.companionAttribution)
        assertSame(activity, inputs.activity)
        assertEquals("""{"host":"payload"}""", inputs.hostExtra)
        assertNull("the pending extra is consumed once", runBlocking { Everframe.consumePendingAttachments() })
        assertEquals("Captured · ${QuickCapture.deviceName(app)}", ShadowToast.getTextOfLatestToast())
    }

    @Test
    fun invalidStoredTokenIsSentWithoutToken() {
        Settings.Global.putString(app.contentResolver, CaptureTokenReader.SETTINGS_KEY, "has space")
        arm()
        assertEquals(QuickCaptureOutcome.Sent, broadcast())
        assertNull(submits.single().captureToken)
    }

    @Test
    fun receiverReadsNoExtras() {
        arm()
        val intent = Intent(QuickCapture.ACTION).putExtra("captureToken", "spoofed").putExtra("title", "spoofed")
        app.sendBroadcast(intent)
        idleMain()
        assertEquals(QuickCaptureOutcome.Sent, awaitMain(checkNotNull(QuickCapture.__lastTrigger)))
        assertNull(submits.single().captureToken)
        assertEquals("", submits.single().title)
    }

    @Test
    fun queuedUploadReleasesTheFreezeAndSaysSo() {
        installReplaySession()
        arm()
        submitResult = { ReportResult.Queued(UUID.randomUUID()) }
        assertEquals(QuickCaptureOutcome.Queued, broadcast())
        assertFalse(Everframe.__replayHasReporterOwner)
        assertEquals("Captured · uploads when online", ShadowToast.getTextOfLatestToast())
    }

    @Test
    fun successfulUploadReleasesTheFreeze() {
        installReplaySession()
        arm()
        var heldDuringSubmit = false
        submitResult = {
            heldDuringSubmit = Everframe.__replayHasReporterOwner
            ReportResult.Submitted(UUID.randomUUID())
        }
        assertEquals(QuickCaptureOutcome.Sent, broadcast())
        assertTrue("the capture owns the freeze while it uploads", heldDuringSubmit)
        assertFalse(Everframe.__replayHasReporterOwner)
    }

    @Test
    fun failedSubmitCancelsTheFreeze() {
        installReplaySession()
        arm()
        submitResult = { ReportResult.Cancelled("revoked") }
        assertEquals(QuickCaptureOutcome.Failed, broadcast())
        assertFalse("a failed capture releases the frozen replay", Everframe.__replayHasReporterOwner)
        assertFreezeReusable()
        assertEquals("Capture failed", ShadowToast.getTextOfLatestToast())
        assertFalse(QuickCapture.isCapturing)
    }

    @Test
    fun throwingSubmitCancelsTheFreeze() {
        installReplaySession()
        arm()
        submitResult = { error("boom") }
        assertEquals(QuickCaptureOutcome.Failed, broadcast())
        assertFalse(Everframe.__replayHasReporterOwner)
        assertFreezeReusable()
        assertEquals("Capture failed", ShadowToast.getTextOfLatestToast())
    }

    @Test
    fun failedScreenshotNeverFreezes() {
        arm()
        QuickCapture.screenshotter = { _, _ -> null }
        assertEquals(QuickCaptureOutcome.Failed, broadcast())
        assertEquals(0, freezes.get())
        assertTrue(submits.isEmpty())
        assertEquals("Capture failed", ShadowToast.getTextOfLatestToast())
    }

    // ---- shake interplay and trigger value ----

    @Test
    fun shakeIgnoredWhileQuickCaptureInFlight() {
        val gate = ShakeToReportGate(localEnabled = true).apply {
            remoteEnabled = true
            foreground = true
        }
        arm()
        val release = CompletableDeferred<Unit>()
        val entered = CompletableDeferred<Unit>()
        submitResult = {
            entered.complete(Unit)
            release.await()
            ReportResult.Submitted(UUID.randomUUID())
        }
        val first = trigger()
        awaitMain(entered)
        assertFalse(ShakeToReportTrigger.tryBeginShake(gate))

        release.complete(Unit)
        awaitMain(first)
        assertTrue(ShakeToReportTrigger.tryBeginShake(gate))
        gate.complete()
    }

    @Test
    fun quickCaptureTriggerSerializesAsQuickCapture() {
        assertEquals("quick_capture", ReporterTrigger.QuickCapture.value)
        assertEquals(ReporterTrigger.QuickCapture, ReporterTrigger.fromValue("quick_capture"))
    }

    @Test
    fun toastCopy() {
        assertEquals("Captured · Pixel", QuickCapture.toastText(QuickCaptureOutcome.Sent, "Pixel"))
        assertEquals("Captured · uploads when online", QuickCapture.toastText(QuickCaptureOutcome.Queued, "Pixel"))
        assertEquals("Capture failed", QuickCapture.toastText(QuickCaptureOutcome.Failed, "Pixel"))
        assertNull(QuickCapture.toastText(QuickCaptureOutcome.Ignored("in_flight"), "Pixel"))
    }

    // ---- helpers ----

    private fun receivers() = shadowOf(app).registeredReceivers.filter { it.intentFilter.hasAction(QuickCapture.ACTION) }

    private fun arm() {
        QuickCapture.install(app, localEnabled = true, debug = true)
        QuickCapture.publishRemote(CaptureHotkeyConfigWire(enabled = true))
    }

    /** A bare session: never fetches config, but owns freezes exactly like a live one. */
    private fun installReplaySession() {
        val session = ReplaySession(sdkKey = "quick-capture-test")
        installedSession = session
        Everframe._replaySession = session
    }

    private fun assertFreezeReusable() {
        val next: FrozenReportCapture = Everframe.__replayFreeze()
        try {
            assertTrue("the next capture gets the replay", Everframe.__replayHasReporterOwner)
        } finally {
            next.cancel()
        }
    }

    private fun trigger(): Deferred<QuickCaptureOutcome> {
        val before = QuickCapture.__lastTrigger
        app.sendBroadcast(Intent(QuickCapture.ACTION))
        idleMain()
        val job = QuickCapture.__lastTrigger
        assertNotNull("the broadcast reached the receiver", job)
        check(job !== before) { "the broadcast did not start a capture" }
        return job!!
    }

    private fun broadcast(): QuickCaptureOutcome = awaitMain(trigger())

    private fun idleMain() = shadowOf(Looper.getMainLooper()).idle()

    /** The pipeline hops to Main for UI work, so the test thread (Main) must keep idling while it waits. */
    private fun <T> awaitMain(deferred: Deferred<T>): T {
        val deadline = System.currentTimeMillis() + 10_000
        while (!deferred.isCompleted) {
            idleMain()
            check(System.currentTimeMillis() < deadline) { "timed out waiting for the capture" }
            Thread.sleep(2)
        }
        idleMain()
        return runBlocking { deferred.await() }
    }
}
