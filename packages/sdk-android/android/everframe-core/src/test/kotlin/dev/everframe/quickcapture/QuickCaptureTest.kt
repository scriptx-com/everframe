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
import android.view.KeyEvent
import android.view.Window
import android.widget.EditText
import androidx.test.core.app.ApplicationProvider
import dev.everframe.Everframe
import dev.everframe.capture.ScreenshotCapture
import dev.everframe.capture.TXWindowCallbackWrapper
import dev.everframe.capture.replay.ReplaySession
import dev.everframe.capture.video.FrozenReportCapture
import dev.everframe.config.CaptureConfig
import dev.everframe.config.Environment
import dev.everframe.config.EverframeConfig
import dev.everframe.config.CaptureHotkeyConfigWire
import dev.everframe.config.ReportResult
import dev.everframe.config.ReporterTrigger
import dev.everframe.trigger.ShakeToReportGate
import dev.everframe.trigger.ShakeToReportTrigger
import java.lang.reflect.Proxy
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.withContext
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
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowToast

@RunWith(RobolectricTestRunner::class)
class QuickCaptureTest {
    private val app: Application = ApplicationProvider.getApplicationContext()
    private lateinit var activity: Activity
    private val submits = CopyOnWriteArrayList<SubmissionComposer.Inputs>()
    private val freezes = AtomicInteger()
    private var submitResult: suspend (SubmissionComposer.Inputs) -> ReportResult =
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
        Settings.Global.putString(app.contentResolver, CaptureTokenReader.ORIGIN_SETTINGS_KEY, null)
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
        assertTrue("a debug build forces on a real device too", QuickCapture.forcesReplay)
        QuickCapture.install(app, localEnabled = true, debug = false)
        QuickCapture.publishRemote(forcing)
        assertFalse("an unlinked release build never forces", QuickCapture.forcesReplay)
        QuickCapture.isEmulator = { true }
        QuickCapture.install(app, localEnabled = true, debug = true)
        QuickCapture.publishRemote(forcing)
        assertTrue(QuickCapture.forcesReplay)

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
        assertTrue("no receiver needed: a debug build on a real device forces", QuickCapture.forcesReplay)
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
        // The in-app reporter freezes before its dialog shows.
        val held = Everframe.__replayFreeze(ReporterTrigger.Button)
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
    fun queuedUploadReleasesTheFreezeAndAddsNoSecondToast() {
        installReplaySession()
        arm()
        submitResult = { ReportResult.Queued(UUID.randomUUID()) }
        assertEquals(QuickCaptureOutcome.Queued, broadcast())
        assertFalse(Everframe.__replayHasReporterOwner)
        assertEquals("only the confirmation: a queued capture is not lost", 1, ShadowToast.shownToastCount())
        assertEquals(confirmed(), ShadowToast.getTextOfLatestToast())
    }

    @Test
    fun confirmationToastIsShownBeforeTheUploadFinishes() {
        arm()
        val release = CompletableDeferred<Unit>()
        val entered = CompletableDeferred<Unit>()
        submitResult = {
            entered.complete(Unit)
            release.await()
            ReportResult.Submitted(UUID.randomUUID())
        }
        val pending = trigger()
        awaitMain(entered)
        idleMain()
        assertEquals("confirmed while the upload is still running", confirmed(), ShadowToast.getTextOfLatestToast())
        assertEquals(1, ShadowToast.shownToastCount())
        assertTrue("a second capture stays blocked until the upload finishes", QuickCapture.isCapturing)

        release.complete(Unit)
        assertEquals(QuickCaptureOutcome.Sent, awaitMain(pending))
        assertEquals("a sent capture says nothing more", 1, ShadowToast.shownToastCount())
        assertFalse(QuickCapture.isCapturing)
    }

    @Test
    fun rejectedUploadFollowsTheConfirmationWithAFailureToast() {
        installReplaySession()
        arm()
        submitResult = { ReportResult.Cancelled("submit_guard_failed") }
        assertEquals(QuickCaptureOutcome.Rejected, broadcast())
        assertEquals(2, ShadowToast.shownToastCount())
        assertTrue(ShadowToast.showedToast(confirmed()))
        assertEquals("Capture didn't upload", ShadowToast.getTextOfLatestToast())
        assertFalse(Everframe.__replayHasReporterOwner)
    }

    @Test
    fun gateIgnoredTriggersShowNoConfirmation() {
        arm()
        Everframe.report.__setPresenting(true)
        assertEquals(QuickCaptureOutcome.Ignored("reporter_presenting"), broadcast())
        Everframe.report.__setPresenting(false)
        Everframe.captureGate = false
        assertEquals(QuickCaptureOutcome.Ignored("kill_switch"), broadcast())
        Everframe.captureGate = true
        armWithScreenshotDisabled()
        assertEquals(QuickCaptureOutcome.Ignored("screenshot_disabled"), broadcast())
        assertEquals(0, ShadowToast.shownToastCount())
        assertTrue(submits.isEmpty())
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
        assertEquals(QuickCaptureOutcome.Rejected, broadcast())
        assertFalse("a failed capture releases the frozen replay", Everframe.__replayHasReporterOwner)
        assertFreezeReusable()
        assertEquals("Capture didn't upload", ShadowToast.getTextOfLatestToast())
        assertFalse(QuickCapture.isCapturing)
    }

    @Test
    fun throwingSubmitCancelsTheFreeze() {
        installReplaySession()
        arm()
        submitResult = { error("boom") }
        assertEquals(QuickCaptureOutcome.Rejected, broadcast())
        assertFalse(Everframe.__replayHasReporterOwner)
        assertFreezeReusable()
        assertEquals(2, ShadowToast.shownToastCount())
        assertEquals("Capture didn't upload", ShadowToast.getTextOfLatestToast())
    }

    @Test
    fun failedScreenshotNeverFreezes() {
        arm()
        QuickCapture.screenshotter = { _, _ -> null }
        assertEquals(QuickCaptureOutcome.Failed, broadcast())
        assertEquals(0, freezes.get())
        assertTrue(submits.isEmpty())
        assertEquals("an evidence failure is never confirmed", 1, ShadowToast.shownToastCount())
        assertEquals("Capture failed", ShadowToast.getTextOfLatestToast())
    }

    // ---- host evidence and capture.screenshot ----

    private fun hostShot(): ScreenshotCapture.CaptureResult {
        val bitmap = Bitmap.createBitmap(6, 4, Bitmap.Config.ARGB_8888)
        return ScreenshotCapture.CaptureResult(bitmap, 6, 4, byteArrayOf(9, 9))
    }

    /** A Flutter-style session: `capture.screenshot = false`. */
    private fun armWithScreenshotDisabled() {
        QuickCapture.install(app, localEnabled = true, debug = true, screenshot = false)
        QuickCapture.publishRemote(CaptureHotkeyConfigWire(enabled = true))
    }

    @Test
    fun providerEvidenceIsSubmittedWithoutNativeScreenshot() {
        Settings.Global.putString(app.contentResolver, CaptureTokenReader.SETTINGS_KEY, "t1")
        armWithScreenshotDisabled()
        QuickCapture.screenshotter = { _, _ -> throw AssertionError("the native screenshot must not be taken") }
        val shot = hostShot()
        val vtree = """{"version":"everframe-vtree-v1"}""".toByteArray()
        Everframe.__setQuickCaptureEvidenceProvider { QuickCaptureHostEvidence(shot, vtree) }

        assertEquals(QuickCaptureOutcome.Sent, broadcast())

        val inputs = submits.single()
        assertSame(shot.bitmap, inputs.captureBitmap)
        assertSame(vtree, inputs.hostReplayVTree)
        assertFalse(inputs.annotated)
        assertTrue(inputs.quickCapture)
        assertEquals("t1", inputs.captureToken)
        assertEquals(1, freezes.get())
    }

    /** The token goes only to the origin that issued it; the capture still ships without it. */
    @Test
    fun tokenFromAnotherOriginIsNotAttached() {
        Settings.Global.putString(app.contentResolver, CaptureTokenReader.SETTINGS_KEY, "t1")
        Settings.Global.putString(app.contentResolver, CaptureTokenReader.ORIGIN_SETTINGS_KEY, "https://evil.example")
        arm()
        assertEquals(QuickCaptureOutcome.Sent, broadcast())
        assertNull(submits.single().captureToken)

        submits.clear()
        Settings.Global.putString(
            app.contentResolver, CaptureTokenReader.ORIGIN_SETTINGS_KEY, dev.everframe.config.IngestEndpoint.url,
        )
        assertEquals(QuickCaptureOutcome.Sent, broadcast())
        assertEquals("t1", submits.single().captureToken)
    }

    /** As `EFReporterFromImage(sdkName = ...)`: the host's SDK identity labels the report. */
    @Test
    fun providerEvidenceCarriesTheHostSdkName() {
        armWithScreenshotDisabled()
        Everframe.__setQuickCaptureEvidenceProvider {
            QuickCaptureHostEvidence(hostShot(), null, sdkName = "everframe-flutter")
        }

        assertEquals(QuickCaptureOutcome.Sent, broadcast())

        assertEquals("everframe-flutter", submits.single().sdkName)
    }

    @Test
    fun providerEvidenceWithoutSdkNameAndNativeCaptureKeepTheNativeName() {
        armWithScreenshotDisabled()
        Everframe.__setQuickCaptureEvidenceProvider { QuickCaptureHostEvidence(hostShot(), null) }
        assertEquals(QuickCaptureOutcome.Sent, broadcast())
        assertEquals("everframe-android", submits.single().sdkName)

        submits.clear()
        Everframe.__setQuickCaptureEvidenceProvider(null)
        arm()
        assertEquals(QuickCaptureOutcome.Sent, broadcast())
        assertEquals("everframe-android", submits.single().sdkName)
    }

    @Test
    fun providerEvidenceWithAnUnknownSdkNameFails() {
        armWithScreenshotDisabled()
        Everframe.__setQuickCaptureEvidenceProvider {
            QuickCaptureHostEvidence(hostShot(), null, sdkName = "everframe-unknown")
        }
        assertEquals(QuickCaptureOutcome.Failed, broadcast())
        assertEquals(0, freezes.get())
        assertTrue(submits.isEmpty())
    }

    /** Like `EFReporterFromImage`: host evidence without frames still owns replay. */
    @Test
    fun providerEvidenceWithoutReplaySendsEmptyHostReplay() {
        armWithScreenshotDisabled()
        QuickCapture.screenshotter = { _, _ -> throw AssertionError("the native screenshot must not be taken") }
        Everframe.__setQuickCaptureEvidenceProvider { QuickCaptureHostEvidence(hostShot(), null) }

        assertEquals(QuickCaptureOutcome.Sent, broadcast())

        val replay = submits.single().hostReplayVTree
        assertNotNull("an empty value keeps the unmasked native video off", replay)
        assertEquals(0, replay!!.size)
    }

    @Test
    fun nilProviderResultFailsWithoutNativeScreenshot() {
        armWithScreenshotDisabled()
        val nativeShots = AtomicInteger()
        QuickCapture.screenshotter = { _, _ -> nativeShots.incrementAndGet(); null }
        Everframe.__setQuickCaptureEvidenceProvider { null }

        assertEquals(QuickCaptureOutcome.Failed, broadcast())

        assertEquals(0, nativeShots.get())
        assertEquals(0, freezes.get())
        assertTrue(submits.isEmpty())
        assertEquals("Capture failed", ShadowToast.getTextOfLatestToast())
    }

    @Test
    fun throwingProviderFailsWithoutNativeScreenshot() {
        armWithScreenshotDisabled()
        val nativeShots = AtomicInteger()
        QuickCapture.screenshotter = { _, _ -> nativeShots.incrementAndGet(); null }
        Everframe.__setQuickCaptureEvidenceProvider { error("render failed") }

        assertEquals(QuickCaptureOutcome.Failed, broadcast())

        assertEquals(0, nativeShots.get())
        assertEquals(0, freezes.get())
        assertTrue(submits.isEmpty())
    }

    /** The provider suspends: a kill() or a reporter opening meanwhile must stop the capture before it freezes. */
    @Test
    fun providerRaceWithKillOrReporterFailsWithoutFreezing() {
        armWithScreenshotDisabled()
        Everframe.__setQuickCaptureEvidenceProvider {
            Everframe.captureGate = false
            QuickCaptureHostEvidence(hostShot(), null)
        }
        assertEquals(QuickCaptureOutcome.Failed, broadcast())
        Everframe.captureGate = true

        Everframe.__setQuickCaptureEvidenceProvider {
            Everframe.report.__setPresenting(true)
            QuickCaptureHostEvidence(hostShot(), null)
        }
        assertEquals(QuickCaptureOutcome.Failed, broadcast())
        Everframe.report.__setPresenting(false)

        assertEquals(0, freezes.get())
        assertTrue(submits.isEmpty())
    }

    /** A provider that never answers fails the capture at the timeout, with no native fallback. */
    @Test
    fun providerTimeoutFailsWithoutNativeScreenshot() {
        armWithScreenshotDisabled()
        val nativeShots = AtomicInteger()
        QuickCapture.screenshotter = { _, _ -> nativeShots.incrementAndGet(); null }
        QuickCapture.evidenceTimeoutMs = 100
        Everframe.__setQuickCaptureEvidenceProvider { awaitCancellation() }
        val started = System.currentTimeMillis()

        assertEquals(QuickCaptureOutcome.Failed, broadcast())

        assertTrue(System.currentTimeMillis() - started < 5_000)
        assertEquals(0, nativeShots.get())
        assertEquals(0, freezes.get())
        assertTrue(submits.isEmpty())
        assertFalse(QuickCapture.isCapturing)
    }

    /** The wait ends at the timeout even when the provider ignores cancellation. */
    @Test
    fun providerIgnoringCancellationStillTimesOut() {
        armWithScreenshotDisabled()
        QuickCapture.evidenceTimeoutMs = 100
        val release = java.util.concurrent.CountDownLatch(1)
        Everframe.__setQuickCaptureEvidenceProvider {
            release.await(10, java.util.concurrent.TimeUnit.SECONDS)
            QuickCaptureHostEvidence(hostShot(), null)
        }
        try {
            assertEquals(QuickCaptureOutcome.Failed, broadcast())
            assertTrue(submits.isEmpty())
        } finally {
            release.countDown()
        }
    }

    @Test
    fun evidenceTimeoutDefaultsToFiveSeconds() {
        assertEquals(5_000L, QuickCapture.evidenceTimeoutMs)
    }

    /**
     * A new session while the host renders (a superseding start(), or the start() after a kill()): the image
     * belongs to the previous session, so the epoch check fails the capture.
     */
    @Test
    fun providerAcrossANewSessionFailsWithoutFreezing() {
        armWithScreenshotDisabled()
        Everframe.__setQuickCaptureEvidenceProvider {
            Everframe.start(app, EverframeConfig(
                appId = "qc-app", sdkKey = "txx_live_quickcapture0002", environment = Environment.production,
            ))
            QuickCaptureHostEvidence(hostShot(), null)
        }
        try {
            assertEquals(QuickCaptureOutcome.Failed, broadcast())
            assertEquals(0, freezes.get())
            assertTrue(submits.isEmpty())
        } finally {
            Everframe.kill()
        }
    }

    /**
     * The native screenshot suspends too (PixelCopy, PNG encoding): a new session meanwhile means the image
     * belongs to the previous one, so the same epoch check fails the capture.
     */
    @Test
    fun nativeScreenshotAcrossANewSessionFailsWithoutFreezing() {
        arm()
        val native = QuickCapture.screenshotter
        QuickCapture.screenshotter = { activity, rects ->
            val shot = native(activity, rects)
            Everframe.start(app, EverframeConfig(
                appId = "qc-app", sdkKey = "txx_live_quickcapture0003", environment = Environment.production,
            ))
            shot
        }
        try {
            assertEquals(QuickCaptureOutcome.Failed, broadcast())
            assertEquals(0, freezes.get())
            assertTrue(submits.isEmpty())
        } finally {
            Everframe.kill()
        }
    }

    /** As the host branch: a kill() or a reporter opening during the native screenshot stops the capture. */
    @Test
    fun nativeScreenshotRaceWithKillOrReporterFailsWithoutFreezing() {
        arm()
        val native = QuickCapture.screenshotter
        QuickCapture.screenshotter = { activity, rects ->
            Everframe.captureGate = false
            native(activity, rects)
        }
        assertEquals(QuickCaptureOutcome.Failed, broadcast())
        Everframe.captureGate = true

        QuickCapture.screenshotter = { activity, rects ->
            Everframe.report.__setPresenting(true)
            native(activity, rects)
        }
        assertEquals(QuickCaptureOutcome.Failed, broadcast())
        Everframe.report.__setPresenting(false)

        assertEquals(0, freezes.get())
        assertTrue(submits.isEmpty())
    }

    /**
     * The submission carries the snapshot taken before the screenshot, and a start() after the
     * post-screenshot check (here, from the freeze) never hands the capture the new session: the check
     * after the host extras fails it instead.
     */
    @Test
    fun submissionCarriesTheSessionFromBeforeTheScreenshot() {
        installReplaySession()
        val projectA = EverframeConfig(
            appId = "qc-app", sdkKey = "txx_live_quickcaptureA001", environment = Environment.production,
        )
        val projectB = EverframeConfig(
            appId = "qc-app", sdkKey = "txx_live_quickcaptureB001", environment = Environment.production,
        )
        try {
            Everframe.start(app, projectA)
            arm()
            val before = Everframe.captureSessionSnapshot()
            assertEquals(QuickCaptureOutcome.Sent, broadcast())
            val session = submits.single().capturedSession
            assertEquals("txx_live_quickcaptureA001", session.config?.sdkKey)
            assertEquals(before.user.startEpoch, session.user.startEpoch)

            submits.clear()
            QuickCapture.freezer = { trigger ->
                freezes.incrementAndGet()
                Everframe.start(app, projectB)
                Everframe.__replayFreeze(trigger)
            }
            assertEquals(QuickCaptureOutcome.Failed, broadcast())
            assertTrue(submits.isEmpty())
            assertFalse("the freeze is released", Everframe.__replayHasReporterOwner)
        } finally {
            Everframe.kill()
        }
    }

    /**
     * The host-extra resolver (React Native's) can suspend after the freeze: a start() meanwhile could hand
     * the new session's metadata to this capture, so the capture fails and releases its freeze.
     */
    @Test
    fun startDuringHostExtraResolutionFailsWithoutSubmitting() {
        installReplaySession()
        val projectA = EverframeConfig(
            appId = "qc-app", sdkKey = "txx_live_quickcaptureA002", environment = Environment.production,
        )
        val projectB = EverframeConfig(
            appId = "qc-app", sdkKey = "txx_live_quickcaptureB002", environment = Environment.production,
        )
        try {
            Everframe.start(app, projectA)
            arm()
            Everframe.__pendingExtraResolveHook = {
                Everframe.start(app, projectB)
                Everframe.setExtra("""{"project":"B"}""")
            }

            assertEquals(QuickCaptureOutcome.Failed, broadcast())

            assertEquals(1, freezes.get())
            assertTrue(submits.isEmpty())
            assertFalse("the freeze is released", Everframe.__replayHasReporterOwner)
        } finally {
            Everframe.__pendingExtraResolveHook = null
            Everframe.kill()
        }
    }

    /** kill() cancels every SDK-scope child, so a capture waiting on its provider ends with nothing frozen. */
    @Test
    fun killDuringProviderCancelsTheCapture() {
        armWithScreenshotDisabled()
        Everframe.__setQuickCaptureEvidenceProvider {
            Everframe.kill()
            // As a following start(): the gate is open again.
            Everframe.captureGate = true
            QuickCaptureHostEvidence(hostShot(), null)
        }
        val job = trigger()
        val outcome = runCatching { awaitMain(job) }
        assertTrue("the capture is cancelled, got $outcome",
            outcome.exceptionOrNull() is kotlinx.coroutines.CancellationException)
        assertEquals(0, freezes.get())
        assertTrue(submits.isEmpty())
        assertFalse(QuickCapture.isCapturing)
    }

    @Test
    fun providerWhileActivityFinishesFails() {
        armWithScreenshotDisabled()
        Everframe.__setQuickCaptureEvidenceProvider {
            withContext(Dispatchers.Main) { activity.finish() }
            QuickCaptureHostEvidence(hostShot(), null)
        }
        assertEquals(QuickCaptureOutcome.Failed, broadcast())
        assertEquals(0, freezes.get())
        assertTrue(submits.isEmpty())
    }

    @Test
    fun screenshotDisabledWithoutProviderIsIgnored() {
        armWithScreenshotDisabled()
        val nativeShots = AtomicInteger()
        QuickCapture.screenshotter = { _, _ -> nativeShots.incrementAndGet(); null }

        assertEquals(QuickCaptureOutcome.Ignored("screenshot_disabled"), broadcast())

        assertEquals(0, nativeShots.get())
        assertEquals(0, freezes.get())
        assertTrue(submits.isEmpty())
        assertNull("an ignored trigger shows no toast", ShadowToast.getTextOfLatestToast())
    }

    @Test
    fun defaultConfigStillUsesNativeScreenshot() {
        arm()
        val nativeShots = AtomicInteger()
        val native = QuickCapture.screenshotter
        QuickCapture.screenshotter = { activity, rects -> nativeShots.incrementAndGet(); native(activity, rects) }

        assertEquals(QuickCaptureOutcome.Sent, broadcast())

        assertEquals(1, nativeShots.get())
        assertNull(submits.single().hostReplayVTree)
        assertFalse(submits.single().annotated)
    }

    @Test
    fun teardownClearsTheEvidenceProvider() {
        Everframe.__setQuickCaptureEvidenceProvider { QuickCaptureHostEvidence(hostShot(), null) }
        assertTrue(QuickCapture.hasEvidenceProvider)
        QuickCapture.teardown()
        assertFalse(QuickCapture.hasEvidenceProvider)

        Everframe.__setQuickCaptureEvidenceProvider { null }
        Everframe.__setQuickCaptureEvidenceProvider(null)
        assertFalse(QuickCapture.hasEvidenceProvider)

        Everframe.__setQuickCaptureEvidenceProvider { null }
        QuickCapture.teardown(isCurrent = { false })
        assertTrue("a stale teardown keeps it", QuickCapture.hasEvidenceProvider)
    }

    /** `start` carries the session's `capture.screenshot` into the gate; `kill` clears the provider. */
    @Test
    fun startCarriesCaptureScreenshotAndKillClearsTheProvider() {
        try {
            Everframe.start(app, EverframeConfig(
                appId = "qc-app", sdkKey = "txx_live_quickcapture0001", environment = Environment.production,
                capture = CaptureConfig(screenshot = false), debugBuild = true,
            ), activity)
            assertFalse(QuickCapture.sessionScreenshotEnabled)
            Everframe.start(app, EverframeConfig(
                appId = "qc-app", sdkKey = "txx_live_quickcapture0001", environment = Environment.production,
                debugBuild = true,
            ), activity)
            assertTrue(QuickCapture.sessionScreenshotEnabled)

            Everframe.__setQuickCaptureEvidenceProvider { null }
            assertTrue(QuickCapture.hasEvidenceProvider)
            Everframe.kill()
            assertFalse(QuickCapture.hasEvidenceProvider)
        } finally {
            Everframe.kill()
        }
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
        assertEquals("Captured · Pixel", QuickCapture.confirmedText(CaptureAttribution.Shared(null), "Pixel"))
        assertEquals("Captured · Pixel", QuickCapture.confirmedText(CaptureAttribution.Shared("adb-token"), "Pixel"))
        val linked = dev.everframe.devicelink.StoredDeviceLink(
            "evf_dev_" + "Tc0p".repeat(8), dev.everframe.devicelink.DeviceLinkOwner.User("Aurimas"), "scope",
        )
        assertEquals("Captured · Aurimas", QuickCapture.confirmedText(CaptureAttribution.Linked(linked, "n"), "Pixel"))
        assertEquals(
            "Captured · team device",
            QuickCapture.confirmedText(
                CaptureAttribution.Linked(
                    dev.everframe.devicelink.StoredDeviceLink(linked.token, dev.everframe.devicelink.DeviceLinkOwner.Team, "scope"),
                    "n",
                ),
                "Pixel",
            ),
        )
        assertNull("the unlink toast comes from DeviceLink.forget", QuickCapture.toastText(QuickCaptureOutcome.Unlinked))
        assertNull(QuickCapture.toastText(QuickCaptureOutcome.Sent))
        assertNull(QuickCapture.toastText(QuickCaptureOutcome.Queued))
        assertEquals("Capture failed", QuickCapture.toastText(QuickCaptureOutcome.Failed))
        assertEquals("Capture didn't upload", QuickCapture.toastText(QuickCaptureOutcome.Rejected))
        assertNull(QuickCapture.toastText(QuickCaptureOutcome.Ignored("in_flight")))
    }

    // ---- in-app chord (Shift+B) ----

    @Test
    fun shiftBTriggersACaptureAndIsConsumed() {
        arm()
        val (wrapper, delivered) = wrap()

        assertFalse("Shift itself passes through", wrapper.dispatchKeyEvent(shiftKey(KeyEvent.ACTION_DOWN)))
        assertTrue("the chord's key-down is consumed", wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_DOWN, SHIFT)))
        val trigger = QuickCapture.__lastTrigger
        assertNotNull("the chord started a capture", trigger)
        assertTrue("so is its key-up", wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_UP, SHIFT)))
        assertFalse(wrapper.dispatchKeyEvent(shiftKey(KeyEvent.ACTION_UP)))

        assertEquals(QuickCaptureOutcome.Sent, awaitMain(trigger!!))
        assertEquals(1, freezes.get())
        assertTrue(submits.single().quickCapture)
        assertEquals(listOf(KeyEvent.KEYCODE_SHIFT_LEFT, KeyEvent.KEYCODE_SHIFT_LEFT), delivered.map { it.keyCode })
    }

    @Test
    fun heldChordKeyRepeatsAreConsumedUntilItsKeyUp() {
        arm()
        val (wrapper, delivered) = wrap()
        assertTrue(wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_DOWN, SHIFT)))
        val first = QuickCapture.__lastTrigger
        assertTrue(wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_DOWN, SHIFT, repeat = 1)))
        assertTrue(wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_DOWN, SHIFT, repeat = 2)))
        assertSame("a held key triggers once", first, QuickCapture.__lastTrigger)
        assertTrue(wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_UP, SHIFT)))
        assertFalse("the next B is the app's again", wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_UP, 0)))
        assertEquals(1, delivered.size)
        awaitMain(first!!)
    }

    @Test
    fun shiftBInAFocusedTextEditorIsTyping() {
        arm()
        val field = EditText(activity)
        activity.setContentView(field)
        assertTrue(field.requestFocus())
        assertSame(field, activity.window.currentFocus)
        val (wrapper, delivered) = wrap()

        assertFalse(wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_DOWN, SHIFT)))
        assertFalse(wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_UP, SHIFT)))

        assertNull("no capture while typing", QuickCapture.__lastTrigger)
        assertEquals(2, delivered.size)
    }

    /**
     * Flutter: a Dart TextField edits through `FlutterView`, which opens an input connection but never says it
     * is a text editor. The input method's active connection is what tells the SDK someone is typing.
     */
    @Test
    @Config(shadows = [AcceptingTextInputMethodManager::class])
    fun shiftBWhileTheInputMethodIsAcceptingTextIsTyping() {
        arm()
        val engineView = object : android.view.View(activity) {
            override fun onCheckIsTextEditor(): Boolean = false
            override fun onCreateInputConnection(outAttrs: android.view.inputmethod.EditorInfo): android.view.inputmethod.InputConnection =
                android.view.inputmethod.BaseInputConnection(this, true)
        }.apply { isFocusableInTouchMode = true }
        activity.setContentView(engineView)
        assertTrue(engineView.requestFocus())
        val (wrapper, delivered) = wrap()

        AcceptingTextInputMethodManager.accepting = true
        try {
            assertFalse(wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_DOWN, SHIFT)))
            assertFalse(wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_UP, SHIFT)))
            assertNull("no capture while the input method is taking text", QuickCapture.__lastTrigger)
            assertEquals(2, delivered.size)
        } finally {
            AcceptingTextInputMethodManager.accepting = false
        }

        // The same view with no active input connection: the chord captures.
        assertTrue(wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_DOWN, SHIFT)))
        assertEquals(QuickCaptureOutcome.Sent, awaitMain(QuickCapture.__lastTrigger!!))
    }

    @Test
    fun shiftBOnAFocusedNonEditorViewTriggers() {
        arm()
        val button = android.widget.Button(activity).apply { isFocusableInTouchMode = true }
        activity.setContentView(button)
        assertTrue(button.requestFocus())
        val (wrapper, _) = wrap()
        assertTrue(wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_DOWN, SHIFT)))
        assertEquals(QuickCaptureOutcome.Sent, awaitMain(QuickCapture.__lastTrigger!!))
    }

    @Test
    fun disarmedSessionPassesShiftBThrough() {
        val (wrapper, delivered) = wrap()
        assertFalse("nothing installed", wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_DOWN, SHIFT)))

        QuickCapture.install(app, localEnabled = true, debug = true)
        assertFalse("no dashboard block yet", wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_DOWN, SHIFT)))
        QuickCapture.publishRemote(CaptureHotkeyConfigWire(enabled = false))
        assertFalse("block disabled", wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_DOWN, SHIFT)))

        QuickCapture.install(app, localEnabled = true, debug = false)
        QuickCapture.publishRemote(CaptureHotkeyConfigWire(enabled = true))
        assertFalse("release build", wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_DOWN, SHIFT)))

        QuickCapture.install(app, localEnabled = false, debug = true)
        QuickCapture.publishRemote(CaptureHotkeyConfigWire(enabled = true))
        assertFalse("local opt-out", wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_DOWN, SHIFT)))

        QuickCapture.isEmulator = { false }
        QuickCapture.install(app, localEnabled = true, debug = true)
        QuickCapture.isEmulator = { true }
        QuickCapture.publishRemote(CaptureHotkeyConfigWire(enabled = true))
        assertFalse("real device", wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_DOWN, SHIFT)))

        arm()
        Everframe.captureGate = false
        assertFalse("kill switch closed", wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_DOWN, SHIFT)))
        Everframe.captureGate = true

        QuickCapture.teardown()
        assertFalse("torn down", wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_DOWN, SHIFT)))

        assertNull(QuickCapture.__lastTrigger)
        assertEquals(8, delivered.size)
    }

    @Test
    fun otherChordsDoNotTriggerWithTheDefaultBinding() {
        arm()
        val (wrapper, delivered) = wrap()
        val ctrlShift = SHIFT or KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON
        assertFalse("Ctrl+Shift+B", wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_DOWN, ctrlShift)))
        assertFalse(wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_UP, ctrlShift)))
        assertFalse("plain B", wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_DOWN, 0)))
        assertFalse(wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_UP, 0)))
        assertFalse("Shift+K", wrapper.dispatchKeyEvent(KeyEvent(0L, 0L, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_K, 0, SHIFT)))
        assertNull(QuickCapture.__lastTrigger)
        assertEquals(5, delivered.size)
    }

    @Test
    fun dashboardShiftKBindingTriggersOnShiftK() {
        QuickCapture.install(app, localEnabled = true, debug = true)
        QuickCapture.publishRemote(CaptureHotkeyConfigWire(enabled = true, binding = "Shift+K"))
        val (wrapper, _) = wrap()
        assertFalse("Shift+B is not the binding", wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_DOWN, SHIFT)))
        assertNull(QuickCapture.__lastTrigger)
        assertTrue(wrapper.dispatchKeyEvent(KeyEvent(0L, 0L, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_K, 0, SHIFT)))
        assertTrue(wrapper.dispatchKeyEvent(KeyEvent(0L, 0L, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_K, 0, SHIFT)))
        assertEquals(QuickCaptureOutcome.Sent, awaitMain(QuickCapture.__lastTrigger!!))
    }

    @Test
    fun bindingTheEmulatorCannotDeliverFallsBackToShiftB() {
        QuickCapture.install(app, localEnabled = true, debug = true)
        val (wrapper, _) = wrap()
        for (binding in listOf("Shift Shift", "Mod+Shift+K", "Ctrl+K")) {
            QuickCapture.publishRemote(CaptureHotkeyConfigWire(enabled = true, binding = binding))
            QuickCapture.__lastTrigger = null
            assertTrue(binding, wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_DOWN, SHIFT)))
            assertTrue(binding, wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_UP, SHIFT)))
            assertNotNull(binding, QuickCapture.__lastTrigger)
            awaitMain(QuickCapture.__lastTrigger!!)
        }
    }

    @Test
    fun aThrowingFocusCheckStillDispatchesTheKey() {
        arm()
        val broken = object : android.view.View(activity) {
            override fun onCheckIsTextEditor(): Boolean = throw IllegalStateException("boom")
        }.apply { isFocusableInTouchMode = true }
        activity.setContentView(broken)
        assertTrue(broken.requestFocus())
        val (wrapper, delivered) = wrap()
        assertFalse(wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_DOWN, SHIFT)))
        assertFalse(wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_UP, SHIFT)))
        assertEquals(2, delivered.size)
        assertNull(QuickCapture.__lastTrigger)
    }

    @Test
    @Config(qualifiers = "television")
    fun shiftBTriggersOnTvAndRemoteKeysStillDispatch() {
        arm()
        val (wrapper, delivered) = wrap()
        assertTrue(wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_DOWN, SHIFT)))
        assertTrue(wrapper.dispatchKeyEvent(bKey(KeyEvent.ACTION_UP, SHIFT)))
        assertEquals(QuickCaptureOutcome.Sent, awaitMain(QuickCapture.__lastTrigger!!))
        assertFalse(wrapper.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_CENTER)))
        assertFalse(wrapper.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_CENTER)))
        assertEquals(listOf(KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_DPAD_CENTER), delivered.map { it.keyCode })
    }

    @Test
    fun windowCallbackWrapperIsInstalledWithBreadcrumbsDisabled() {
        dev.everframe.capture.sharedBreadcrumbBuffer.applyConfig(
            dev.everframe.config.BreadcrumbsConfigWire(
                enabled = false, kinds = emptyList(), maxCount = 0, byteBudget = 0, consoleEntryCap = 0,
            ),
        )
        try {
            dev.everframe.capture.BreadcrumbTapNavAdapters.__resetForTesting()
            dev.everframe.capture.BreadcrumbTapNavAdapters.install(app, activity)
            idleMain()
            assertTrue(activity.window.callback is TXWindowCallbackWrapper)
        } finally {
            dev.everframe.capture.sharedBreadcrumbBuffer.applyConfig(null)
            dev.everframe.capture.BreadcrumbTapNavAdapters.__resetForTesting()
        }
    }

    // ---- helpers ----

    /** The wrapper over a delegate that records every key event it receives and handles none. */
    private fun wrap(): Pair<TXWindowCallbackWrapper, MutableList<KeyEvent>> {
        val delivered = mutableListOf<KeyEvent>()
        val delegate = Proxy.newProxyInstance(Window.Callback::class.java.classLoader, arrayOf(Window.Callback::class.java)) { _, method, args ->
            if (method.name == "dispatchKeyEvent") delivered += args[0] as KeyEvent
            when (method.returnType) {
                java.lang.Boolean.TYPE -> false
                else -> null
            }
        } as Window.Callback
        return TXWindowCallbackWrapper(delegate, activity) to delivered
    }

    private fun bKey(action: Int, meta: Int, repeat: Int = 0) = KeyEvent(0L, 0L, action, KeyEvent.KEYCODE_B, repeat, meta)

    private fun shiftKey(action: Int) =
        KeyEvent(0L, 0L, action, KeyEvent.KEYCODE_SHIFT_LEFT, 0, if (action == KeyEvent.ACTION_DOWN) SHIFT else 0)

    private fun confirmed() = QuickCapture.confirmedText(CaptureAttribution.Shared(null), QuickCapture.deviceName(app))

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

    private companion object {
        const val SHIFT = KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON
    }
}

/** `isAcceptingText` is not shadowed by Robolectric; this reports an active input connection on demand. */
@org.robolectric.annotation.Implements(android.view.inputmethod.InputMethodManager::class)
class AcceptingTextInputMethodManager : org.robolectric.shadows.ShadowInputMethodManager() {
    @org.robolectric.annotation.Implementation
    protected fun isAcceptingText(): Boolean = accepting

    companion object {
        @Volatile
        @JvmStatic
        var accepting = false
    }
}
