// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.state
import androidx.test.core.app.ApplicationProvider
import dev.everframe.Everframe
import dev.everframe.config.CaptureConfig
import dev.everframe.config.EverframeConfig
import dev.everframe.protocol.generated.StateValue
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class StateLifecycleTest {
    @Test fun automaticVersionUsesHostPackageInsteadOfSdkRelease() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        info.versionName = "2.7.1"
        info.versionCode = 271
        org.robolectric.Shadows.shadowOf(context.packageManager).installPackage(info)
        Everframe.start(context, EverframeConfig(appId = "test", sdkKey = "txx_live_test1234567890", release = "sdk-version", capture = CaptureConfig(logs = false)))
        val facts = Everframe.captureSessionSnapshot().state!!.initial.automatic
        assertEquals(StateValue.StringValue("2.7.1"), facts["app.version"])
        assertEquals(StateValue.StringValue("271"), facts["app.build"])
    }
    @Test fun automaticVersionMatchesReportMetadataForMissingBlankAndPaddedVersions() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        for ((version, expected) in listOf(null to "271", "  " to "271", " 2.7.1 " to "2.7.1")) {
            val info = context.packageManager.getPackageInfo(context.packageName, 0)
            info.versionName = version
            info.versionCode = 271
            org.robolectric.Shadows.shadowOf(context.packageManager).installPackage(info)
            val facts = AutomaticStateFacts.initial(context).automatic
            assertEquals(StateValue.StringValue(expected), facts["app.version"])
            assertEquals(expected, dev.everframe.capture.DeviceMetadata.collect(context)["appVersion"])
        }
    }
    private fun start() = Everframe.start(ApplicationProvider.getApplicationContext(), EverframeConfig(appId = "test", sdkKey = "txx_live_test1234567890", capture = CaptureConfig(logs = false)))
    @After fun cleanup() { Everframe.kill() }
    @Test fun captureIsImmutableAndSessionResetClearsState() {
        start()
        assertTrue(Everframe.setState("plan", StateValue.StringValue("premium")))
        val captured = Everframe.captureSessionSnapshot().state!!
        assertTrue(Everframe.clearState("plan"))
        assertNotNull(captured.current.custom["plan"])
        assertNull(Everframe.captureSessionSnapshot().state!!.current.custom["plan"])
        start(); assertTrue(Everframe.captureSessionSnapshot().state!!.current.custom.isEmpty())
        Everframe.kill(); assertFalse(Everframe.setState("afterKill", StateValue.BoolValue(true)))
        assertNull(Everframe.captureSessionSnapshot().state)
    }
    @Test fun manualCaptureKeepsOpenTimeStateAndSignOutRevokesIt() {
        start()
        Everframe.setState("plan", StateValue.StringValue("free"))
        val capture = Everframe.__replayFreeze()
        Everframe.setState("plan", StateValue.StringValue("premium"))
        assertEquals(StateValue.StringValue("free"), capture.takeState()!!.current.custom["plan"])
        capture.cancel()
        val next = Everframe.__replayFreeze()
        Everframe.setIdentityToken(null)
        assertNull(next.takeState()); next.cancel()
    }
    @Test fun capturedStateSurvivesEnvelopeEncoding() {
        start(); Everframe.setState("plan", StateValue.StringValue("premium"))
        val captured = Everframe.captureSessionSnapshot()
        val encoded = dev.everframe.envelope.EnvelopeBuilder().buildEncoded(sdkVersion = "test", formFactor = "phone", state = captured.state)
        val report = kotlinx.serialization.json.Json.decodeFromString<dev.everframe.protocol.generated.ReportEnvelope>(encoded.bytes.decodeToString())
        assertEquals(StateValue.StringValue("premium"), report.payload.state!!.current.custom["plan"])
        Everframe.setIdentityToken(null); assertNull(captured.state)
    }
    @Test fun staleAutomaticCallbackIsIgnored() {
        start(); val oldEpoch = Everframe.currentStartEpoch()
        start(); Everframe.applyAutomaticState(oldEpoch, mapOf("network.type" to StateValue.StringValue("from-old-session")))
        assertNotEquals(StateValue.StringValue("from-old-session"), Everframe.captureSessionSnapshot().state!!.current.automatic["network.type"])
    }
    @Test fun automaticFactsAndSignOutClearing() {
        start()
        assertEquals(StateValue.StringValue("anonymous"), Everframe.captureSessionSnapshot().state!!.current.automatic["user.status"])
        Everframe.setState("plan", StateValue.StringValue("premium"))
        Everframe.setIdentityToken(null)
        assertTrue(Everframe.captureSessionSnapshot().state!!.current.custom.isEmpty())
        assertTrue(Everframe.setState("plan", StateValue.StringValue("free")))
    }
}
