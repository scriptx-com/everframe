// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Quick capture on real devices: allowed on linked devices and debug builds,
// attributed by the device token with a fresh link nonce, and the
// `device_unlinked` refusal. Tokens and nonces are compared, never printed.

package dev.everframe.quickcapture

import android.app.Activity
import android.app.Application
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.widget.Toast
import androidx.test.core.app.ApplicationProvider
import dev.everframe.Everframe
import dev.everframe.capture.ScreenshotCapture
import dev.everframe.companion.CompanionSubmissionComposer
import dev.everframe.config.CaptureHotkeyConfigWire
import dev.everframe.config.ReportResult
import dev.everframe.devicelink.DeviceLink
import dev.everframe.config.EverframeConfig
import dev.everframe.config.IngestEndpoint
import dev.everframe.devicelink.DeviceLinkOwner
import dev.everframe.devicelink.DeviceLinkScope
import dev.everframe.devicelink.IngestLinkResponse
import dev.everframe.devicelink.LinkPending
import dev.everframe.devicelink.StoredDeviceLink
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowToast

@RunWith(RobolectricTestRunner::class)
class QuickCaptureRealDeviceTest {
    private val app: Application = ApplicationProvider.getApplicationContext()
    private lateinit var activity: Activity
    private val submits = CopyOnWriteArrayList<CompanionSubmissionComposer.Inputs>()
    private var submitResult: suspend (CompanionSubmissionComposer.Inputs) -> ReportResult =
        { ReportResult.Submitted(UUID.randomUUID()) }
    private val attempts = CopyOnWriteArrayList<Triple<String, Int, String>>()
    private var priorSupplier: (() -> Activity?)? = null
    private var priorCaptureGate = false
    private val token = "evf_dev_" + "Rd3v".repeat(8)
    private val nonceShape = Regex("^[0-9A-Za-z]{40}$")

    @Before
    fun setUp() {
        dev.everframe.shared.SharedData.init(app)
        activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        priorSupplier = Everframe.__activitySupplier
        Everframe.__activitySupplier = { activity }
        priorCaptureGate = Everframe.captureGate
        Everframe.captureGate = true
        Everframe.report.__setPresenting(false)
        QuickCapture.isEmulator = { false }
        QuickCapture.screenshotter = { _, _ ->
            ScreenshotCapture.CaptureResult(Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888), 2, 2, byteArrayOf(1, 2, 3))
        }
        QuickCapture.freezer = { Everframe.__replayFreeze(it) }
        QuickCapture.submitter = { inputs ->
            submits += inputs
            submitResult(inputs)
        }
        QuickCapture.beginLinkAttempt = { id, number, nonce -> attempts += Triple(id, number, nonce) }
        DeviceLink.toaster = { text -> Handler(Looper.getMainLooper()).post { Toast.makeText(app, text, Toast.LENGTH_SHORT).show() } }
        DeviceLink.refreshConfig = {}
        Settings.Global.putString(app.contentResolver, CaptureTokenReader.SETTINGS_KEY, null)
        Everframe.__setConfigForTesting(EverframeConfig(appId = "app-id", sdkKey = sdkKey))
    }

    @After
    fun tearDown() {
        QuickCapture.teardown()
        QuickCapture.__resetForTesting()
        DeviceLink.__resetForTesting()
        Everframe.__activitySupplier = priorSupplier
        Everframe.captureGate = priorCaptureGate
        Everframe.__setConfigForTesting(null)
        Everframe.report.__setPresenting(false)
        Settings.Global.putString(app.contentResolver, CaptureTokenReader.SETTINGS_KEY, null)
        Settings.Global.putString(app.contentResolver, CaptureTokenReader.ORIGIN_SETTINGS_KEY, null)
    }

    private val sdkKey = "txx_live_quickcapture00001"
    private val scope: String get() = DeviceLinkScope.of(IngestEndpoint.url, sdkKey)!!

    /** A link for the started project's scope (its ingest origin and SDK key). */
    private fun link(owner: DeviceLinkOwner = DeviceLinkOwner.User("Aurimas")) =
        DeviceLink.__setCurrentForTesting(StoredDeviceLink(token, owner, scope))

    private fun arm(debug: Boolean, localEnabled: Boolean = true, remote: CaptureHotkeyConfigWire? = CaptureHotkeyConfigWire(enabled = true)) {
        QuickCapture.install(app, localEnabled = localEnabled, debug = debug)
        QuickCapture.publishRemote(remote)
    }

    private fun capture(): QuickCaptureOutcome {
        QuickCapture.trigger()
        return awaitMain(QuickCapture.__lastTrigger!!)
    }

    /** Robolectric keeps no per-toast text: the count, each text shown, and the last one pin the sequence. */
    private fun assertToasts(vararg expected: String) {
        assertEquals(expected.toList().toString(), expected.size, ShadowToast.shownToastCount())
        expected.forEach { assertTrue(it, ShadowToast.showedToast(it)) }
        if (expected.isNotEmpty()) assertEquals(expected.last(), ShadowToast.getTextOfLatestToast())
    }

    @Test
    fun aLinkForAnotherProjectIsNeverSentWithThisProjectsKey() {
        // The link state still holds project A's link while the session (and its key) is project B's: a
        // restart whose link load has not landed yet.
        DeviceLink.__setCurrentForTesting(
            StoredDeviceLink(token, DeviceLinkOwner.User("Aurimas"), DeviceLinkScope.of(IngestEndpoint.url, "txx_live_projecta000000")!!),
        )
        arm(debug = false)
        val outcome = capture()
        assertTrue("A's token rode a capture filed under B's key", submits.none { it.captureToken == token })
        assertTrue(submits.none { it.deviceLink != null })
        assertEquals(QuickCaptureOutcome.Failed, outcome)
    }

    @Test
    fun releaseUnlinkedRealDeviceIsIgnored() {
        arm(debug = false)
        assertEquals(QuickCaptureOutcome.Ignored("not_allowed"), capture())
        assertTrue(submits.isEmpty())
        assertEquals(0, ShadowToast.shownToastCount())
        assertFalse(QuickCapture.isAllowedOnThisDevice)
    }

    @Test
    fun debugUnlinkedRealDeviceCapturesShared() {
        arm(debug = true)
        assertEquals(QuickCaptureOutcome.Sent, capture())
        val inputs = submits.single()
        assertNull(inputs.captureToken)
        assertNull(inputs.deviceLink)
        assertTrue(inputs.quickCapture)
        assertToasts("Captured · ${QuickCapture.deviceName(app)}")
    }

    @Test
    fun linkedReleaseDeviceCapturesWithTokenAndNonce() {
        link()
        arm(debug = false)
        assertTrue(QuickCapture.isAllowedOnThisDevice)
        assertEquals(QuickCaptureOutcome.Sent, capture())
        val inputs = submits.single()
        assertTrue(inputs.captureToken == token)
        assertTrue(nonceShape.matches(inputs.deviceLink!!.nonce))
        assertToasts("Captured · Aurimas")
    }

    @Test
    fun teamLinkToast() {
        link(DeviceLinkOwner.Team)
        arm(debug = false)
        assertEquals(QuickCaptureOutcome.Sent, capture())
        assertToasts("Captured · team device")
    }

    @Test
    fun freshNoncePerCapture() {
        link()
        arm(debug = false)
        capture()
        capture()
        assertEquals(2, submits.size)
        assertNotEquals(submits[0].deviceLink!!.nonce, submits[1].deviceLink!!.nonce)
    }

    @Test
    fun deviceTokenWinsOverEmulatorAdbToken() {
        QuickCapture.isEmulator = { true }
        Settings.Global.putString(app.contentResolver, CaptureTokenReader.SETTINGS_KEY, "adb-cap-token")
        link()
        arm(debug = false)
        assertEquals(QuickCaptureOutcome.Sent, capture())
        assertTrue(submits.single().captureToken == token)

        // Unlinked debug emulator: the adb token, and no device link.
        DeviceLink.__setCurrentForTesting(null)
        arm(debug = true)
        capture()
        assertEquals("adb-cap-token", submits.last().captureToken)
        assertNull(submits.last().deviceLink)
    }

    @Test
    fun unlinkedResultForgetsAndToasts() {
        link()
        arm(debug = false)
        submitResult = { ReportResult.Cancelled(IngestLinkResponse.DEVICE_UNLINKED) }
        assertEquals(QuickCaptureOutcome.Unlinked, capture())
        idleMain()
        assertToasts("Captured · Aurimas", "This device was unlinked")
        assertNull(DeviceLink.current)
        assertNull(QuickCapture.toastText(QuickCaptureOutcome.Unlinked))
    }

    @Test
    fun unlinkedResultForAReplacedTokenKeepsTheNewLink() {
        link()
        arm(debug = false)
        val newer = StoredDeviceLink("evf_dev_" + "N3wr".repeat(8), DeviceLinkOwner.User("Jonas"), scope)
        submitResult = {
            DeviceLink.__setCurrentForTesting(newer) // a takeover finished while this upload was out
            ReportResult.Cancelled(IngestLinkResponse.DEVICE_UNLINKED)
        }
        assertEquals(QuickCaptureOutcome.Rejected, capture())
        idleMain()
        assertTrue(DeviceLink.current === newer)
        assertToasts("Captured · Aurimas", "Capture didn't upload")
    }

    @Test
    fun notQueuedShowsDidntUpload() {
        link()
        arm(debug = false)
        submitResult = { ReportResult.Cancelled(IngestLinkResponse.NOT_QUEUED) }
        assertEquals(QuickCaptureOutcome.Rejected, capture())
        assertToasts("Captured · Aurimas", "Capture didn't upload")
    }

    @Test
    fun linkPendingStartsTheAttempt() {
        link()
        arm(debug = false)
        val id = "6c1e2f6a-1b7e-4b43-9a55-0e0c2b8f3e10"
        submitResult = { inputs ->
            inputs.deviceLink!!.onLinkPending(LinkPending(id, 47))
            ReportResult.Submitted(UUID.randomUUID())
        }
        assertEquals(QuickCaptureOutcome.Sent, capture())
        val (attemptId, number, nonce) = attempts.single()
        assertEquals(id, attemptId)
        assertEquals(47, number)
        assertTrue(nonce == submits.single().deviceLink!!.nonce)
    }

    @Test
    fun remoteDisabledStillIgnoredWhenLinked() {
        link()
        arm(debug = false, remote = CaptureHotkeyConfigWire(enabled = false))
        assertEquals(QuickCaptureOutcome.Ignored("remote_disabled"), capture())
        assertTrue(submits.isEmpty())
    }

    @Test
    fun localOptOutIgnoredWhenLinked() {
        link()
        arm(debug = false, localEnabled = false)
        assertEquals(QuickCaptureOutcome.Ignored("disabled"), capture())
        assertTrue(submits.isEmpty())
    }

    @Test
    fun forcesReplayRule() {
        val flag = CaptureHotkeyConfigWire(enabled = true, replay = true)
        arm(debug = true, remote = flag)
        assertTrue("debug real device", QuickCapture.forcesReplay)

        arm(debug = false, remote = flag)
        assertFalse("unlinked release", QuickCapture.forcesReplay)
        link()
        assertTrue("linked release", QuickCapture.forcesReplay)

        arm(debug = false, remote = CaptureHotkeyConfigWire(enabled = true, replay = false))
        assertFalse("linked, replay off", QuickCapture.forcesReplay)
        arm(debug = true, remote = CaptureHotkeyConfigWire(enabled = true, replay = false))
        assertFalse("debug, replay off", QuickCapture.forcesReplay)

        arm(debug = false, remote = flag)
        Everframe.captureGate = false
        assertFalse("kill switch", QuickCapture.forcesReplay)
    }

    @Test
    fun noReceiverOnRealDevicesEvenWhenLinked() {
        link()
        arm(debug = true)
        assertTrue(
            shadowOf(app).registeredReceivers.none { it.intentFilter.hasAction(QuickCapture.ACTION) },
        )
        assertNull("the Shift+B chord stays emulator-only", QuickCapture.armedChord)
    }

    private fun idleMain() = shadowOf(Looper.getMainLooper()).idle()

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
