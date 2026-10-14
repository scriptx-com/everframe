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
