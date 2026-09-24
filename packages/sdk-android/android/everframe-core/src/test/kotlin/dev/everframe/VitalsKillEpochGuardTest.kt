// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Codex round-4, #2 — `kill()`'s vitals teardown must belong to the kill that
// started it.
//
// `kill()` bumps the start epoch inside its `stateLock` critical section and
// then runs a long, lock-free tail: the reporter teardown hook, evidence
// zeroization, the log-tee uninstall, the replay-session teardown. Only after
// all of that does it reach `VitalsRuntime.shutdown()` and the server-config
// clear, and both used to be unconditional. A `start()` completing anywhere in
// that window published its configuration, installed its controller and had
// its dashboard gate delivered — and the older `kill()` then shut that
// controller down and cleared that gate. The `start()` had already returned
// successfully; vitals were simply dead for the whole session, with nothing
// left running to notice.
//
// `__reporterTriggersTeardown` is the seam that makes the interleaving
// deterministic: it is a public hook `kill()` invokes at the very top of that
// tail, so a competing `start()` driven from inside it is ordered exactly
// where the race puts it — after the epoch bump, before the vitals steps.
package dev.everframe

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.everframe.config.CaptureConfig
import dev.everframe.config.EverframeConfig
import dev.everframe.config.VitalsConfig
import dev.everframe.shared.SharedData
import dev.everframe.vitals.ResourceSampler
import dev.everframe.vitals.VitalsController
import dev.everframe.vitals.VitalsRuntime
import dev.everframe.vitals.VitalsScheduler
import dev.everframe.vitals.VitalsServerConfig
import dev.everframe.vitals.VitalsServerConfigSignal
import dev.everframe.vitals.VitalsSink
import dev.everframe.vitals.wire.SessionSummaryDims
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class VitalsKillEpochGuardTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()

    private fun validConfig() = EverframeConfig(
        appId = "test-app-id",
        sdkKey = "txx_live_test1234567890",
        capture = CaptureConfig(logs = false),
    )

    private fun controller() = VitalsController(
        VitalsController.Deps(
            localConfig = VitalsConfig(),
            dims = SessionSummaryDims("android", "1", "0.8.0"),
            transport = { object : VitalsSink { override fun send(body: String) = Unit; override fun close() = Unit } },
            scheduler = object : VitalsScheduler { override fun repeat(intervalMs: Long, tick: () -> Unit) = AutoCloseable { } },
            samplerFactory = { onSample, onTick ->
                object : ResourceSampler(handler = android.os.Handler(android.os.Looper.getMainLooper()), onSample = onSample, onTick = onTick) {}
            },
            lifecycle = { _, _ -> null },
            now = { 1_000_000L },
            random = { 0.0 },
            newSessionId = { "sid" },
        ),
    )

    @Before
    fun setUp() {
        SharedData.init(context)
        VitalsRuntime.resetForTesting()
        VitalsServerConfigSignal.resetForTesting()
    }

    @After
    fun tearDown() {
        Everframe.__reporterTriggersTeardown = null
        VitalsRuntime.resetForTesting()
        VitalsServerConfigSignal.resetForTesting()
    }

    @Test
    fun `a kill superseded mid-tail leaves the newer session's controller and gate alone`() {
        Everframe.start(context, validConfig())
        val fresh = controller()

        Everframe.__reporterTriggersTeardown = {
            // The competing start(): it bumps the epoch past this kill's, so
            // everything the kill does from here belongs to a session that is
            // no longer current.
            Everframe.start(context, validConfig())
            VitalsRuntime.install(fresh)
            VitalsServerConfigSignal.flow.value = VitalsServerConfig(true, 1.0)
        }

        Everframe.kill()

        assertEquals(
            "a superseded kill must not shut down the controller a newer start installed",
            fresh,
            VitalsRuntime.current(),
        )
        assertNotNull(
            "...nor clear the dashboard gate that session already received",
            VitalsServerConfigSignal.flow.value,
        )
    }

    @Test
    fun `an unsuperseded kill still tears the vitals runtime down`() {
        // The other half: the guard must not make kill() a no-op. Nothing
        // moves the epoch here, so the tail is this kill's to run.
        Everframe.start(context, validConfig())
        val live = controller()
        VitalsRuntime.install(live)
        VitalsServerConfigSignal.flow.value = VitalsServerConfig(true, 1.0)

        Everframe.kill()

        assertTrue("kill() must still unpublish the live controller", VitalsRuntime.current() == null)
        assertTrue("...and clear the gate", VitalsServerConfigSignal.flow.value == null)
    }
}
