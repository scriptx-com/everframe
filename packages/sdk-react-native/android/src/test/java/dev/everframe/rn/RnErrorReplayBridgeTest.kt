// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
@file:Suppress("INVISIBLE_REFERENCE", "INVISIBLE_MEMBER")
package dev.everframe.rn

import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.bridge.JavaOnlyMap
import dev.everframe.Everframe
import dev.everframe.crash.CrashReporter
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

/**
 * Replays on errors (spec 2026-10-11). The bridge hands an error the app survives to the core entry points that may
 * attach a replay, and a fatal error to the one that never does. The core asks `CrashReporter.errorReplaySource` for
 * a snapshot only from the two `WithReplay` entry points, and only for a non-fatal error, so counting its calls shows
 * which entry point the bridge took. The source returns null, so every error is stored exactly as it was before.
 */
@RunWith(RobolectricTestRunner::class)
class RnErrorReplayBridgeTest {
    private val context = BridgeReactContext(RuntimeEnvironment.getApplication())
    private val module = EverframeModule(context)
    private lateinit var storage: BridgeCrashStorage
    private val productionDrain = module.__drainRequester
    private val snapshotsAsked = AtomicInteger()
    private var drains = 0

    private fun payload(mechanism: String, fatal: Boolean): String =
        """{"exceptionType":"RNReplay","message":"js error","framesRaw":["at fixture (address at index.android.bundle:1:42)"],"occurredAt":"2026-10-11T00:00:00Z","mechanism":"$mechanism","fatal":$fatal}"""
    private fun entries() = runBlocking { storage.outbox().hydrate() }
    private fun envelope() = JSONObject(String(entries().single().envelopeBytes))
    private fun crash() = envelope().getJSONObject("payload").getJSONObject("crash")

    @Before fun setup() {
        assertEquals("http://127.0.0.1:9", dev.everframe.BuildConfig.INGEST_URL)
        Everframe.kill()
        CrashReporter.__resetForTesting()
        storage = BridgeCrashStorage()
        module.configure(JavaOnlyMap().apply { putString("sdkKey", "synthetic-rn-replay") })
        val ready = Everframe::class.java.getDeclaredField("_replaySession").apply { isAccessible = true }
        val deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(5)
        while (ready.get(Everframe) == null && System.nanoTime() < deadline) Thread.sleep(5)
        assertNotNull("native startup must finish before owning capture storage", ready.get(Everframe))
        CrashReporter.configure(context)
        storage.install()
        CrashReporter.errorReplaySource = { snapshotsAsked.incrementAndGet(); null }
        module.__drainRequester = { drains++ }
    }

    @After fun teardown() {
        module.__drainRequester = productionDrain
        Everframe.kill()
        CrashReporter.__resetForTesting()
        storage.close()
    }

    @Test fun an_explicit_capture_asks_for_a_replay() {
        assertTrue(module.captureHandledException(payload("captureException", fatal = false)))
        assertEquals(1, snapshotsAsked.get())
        assertEquals("error", envelope().getString("source"))
        assertEquals(1, drains)
    }

    @Test fun a_nonfatal_errorutils_error_asks_for_a_replay() {
        assertTrue(module.reportCrash(payload("errorutils", fatal = false)))
        assertEquals(1, snapshotsAsked.get())
        assertEquals("error", envelope().getString("source"))
        val crash = crash()
        assertFalse(crash.getBoolean("fatal")); assertFalse(crash.getBoolean("handled"))
        assertEquals("errorutils", crash.getString("mechanism"))
        assertEquals(1, drains)
    }

    @Test fun an_unhandled_rejection_asks_for_a_replay() {
        assertTrue(module.reportCrash(payload("unhandledrejection", fatal = false)))
        assertEquals(1, snapshotsAsked.get())
        assertEquals("unhandledrejection", crash().getString("mechanism"))
        assertEquals(1, drains)
    }

    @Test fun a_fatal_error_never_asks_for_a_replay_and_stays_a_crash() {
        assertTrue(module.reportCrash(payload("errorutils", fatal = true)))
        assertEquals(0, snapshotsAsked.get())
        assertEquals("crash", envelope().getString("source"))
        assertTrue(crash().getBoolean("fatal"))
        assertEquals(0, drains)
    }

    @Test fun a_handled_capture_that_claims_fatal_is_still_an_error_the_app_survives() {
        assertTrue(module.captureHandledException(payload("captureException", fatal = true)))
        assertEquals(1, snapshotsAsked.get())
        assertEquals("error", envelope().getString("source"))
        assertFalse(crash().getBoolean("fatal"))
    }

    @Test fun a_killed_sdk_refuses_both_paths_without_asking_for_a_snapshot() {
        Everframe.kill()
        assertFalse(module.reportCrash(payload("errorutils", fatal = false)))
        assertFalse(module.captureHandledException(payload("captureException", fatal = false)))
        assertEquals(0, snapshotsAsked.get())
        assertEquals(0, drains)
        assertTrue(entries().isEmpty())
    }

    @Test fun disabled_crash_capture_refuses_both_paths_without_asking_for_a_snapshot() {
        val config = requireNotNull(Everframe.captureSessionSnapshot().config)
        Everframe.__setConfigForTesting(config.copy(capture = config.capture.copy(crash = false)))
        assertFalse(module.reportCrash(payload("errorutils", fatal = false)))
        assertFalse(module.captureHandledException(payload("captureException", fatal = false)))
        assertEquals(0, snapshotsAsked.get())
        assertEquals(0, drains)
        assertTrue(entries().isEmpty())
    }
}
