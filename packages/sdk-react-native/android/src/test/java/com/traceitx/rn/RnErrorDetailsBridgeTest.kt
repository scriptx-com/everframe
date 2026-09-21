// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
@file:Suppress("INVISIBLE_REFERENCE", "INVISIBLE_MEMBER")
package com.traceitx.rn

import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.bridge.JavaOnlyMap
import com.traceitx.TraceItX
import com.traceitx.crash.CrashReporter
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class RnErrorDetailsBridgeTest {
    private val context = BridgeReactContext(RuntimeEnvironment.getApplication())
    private val module = TraceItXModule(context)
    private lateinit var storage: BridgeCrashStorage
    private val productionDrain = module.__drainRequester
    private var drains = 0
    private val bundle = """{"engine":"hermes","platform":"android","buildId":"owned-rn-build","bundleName":"index.android.bundle"}"""
    private fun payload(details: String? = null, fatal: Boolean = false): String =
        """{"exceptionType":"RNDetails","message":"core facts","framesRaw":["at fixture (address at index.android.bundle:1:42)"],"occurredAt":"2026-09-15T00:00:00Z","fatal":$fatal,"jsBundle":$bundle${if (details == null) "" else ",\"details\":$details"}}"""
    private fun entries() = runBlocking { storage.outbox().hydrate() }
    private fun crash() = JSONObject(String(entries().single().envelopeBytes)).getJSONObject("payload").getJSONObject("crash")
    private fun clearStored() = runBlocking { storage.outbox().drain { true } }

    @Before fun setup() {
        assertEquals("http://127.0.0.1:9", com.traceitx.BuildConfig.INGEST_URL)
        TraceItX.kill()
        CrashReporter.__resetForTesting()
        storage = BridgeCrashStorage()
        val options = JavaOnlyMap().apply { putString("apiKey", "synthetic-rn-details") }
        module.configure(options)
        val ready = TraceItX::class.java.getDeclaredField("_replaySession").apply { isAccessible = true }
        val deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(5)
        while (ready.get(TraceItX) == null && System.nanoTime() < deadline) Thread.sleep(5)
        assertNotNull("native startup must finish before owning capture storage", ready.get(TraceItX))
        CrashReporter.configure(context)
        storage.install()
        module.__drainRequester = { drains++ }
    }

    @After fun teardown() {
        module.__drainRequester = productionDrain
        TraceItX.kill()
        CrashReporter.__resetForTesting()
        storage.close()
    }

    @Test fun handled_details_are_in_encrypted_bytes_before_acknowledgement() {
        var persistedBeforeDrain = false
        module.__drainRequester = {
            drains++
            persistedBeforeDrain = crash().getJSONObject("details").getString("severity") == "warning"
        }
        assertTrue(module.captureHandledException(payload("""{"severity":"warning","context":"checkout","metadata":{"accessToken":"synthetic","n":9007199254740994,"flag":true}}""", fatal = true)))
        val crash = crash()
        assertTrue(storage.persistedBytes().isNotEmpty())
        assertFalse(storage.persistedBytes().any { String(it).contains("core facts") })
        assertTrue(crash.getBoolean("handled")); assertFalse(crash.getBoolean("fatal"))
        assertEquals("captureException", crash.getString("mechanism"))
        val details = crash.getJSONObject("details")
        assertEquals("checkout", details.getString("context"))
        assertEquals("[REDACTED]", details.getJSONObject("metadata").getString("accessToken"))
        assertEquals(9007199254740994.0, details.getJSONObject("metadata").getDouble("n"), 0.0)
        assertTrue(details.getJSONObject("metadata").getBoolean("flag"))
        assertEquals(1, drains)
        assertTrue("encrypted storage must complete before scheduling", persistedBeforeDrain)
        assertEquals("owned-rn-build", crash.getJSONObject("jsBundle").getString("buildId"))
    }

    @Test fun automatic_details_do_not_change_fatal_classification_or_schedule_a_drain() {
        assertTrue(module.reportCrash(payload("""{"severity":"info","metadata":{"n":1.25}}""", fatal = true)))
        val crash = crash()
        assertTrue(crash.getBoolean("fatal")); assertFalse(crash.getBoolean("handled"))
        assertEquals("errorutils", crash.getString("mechanism"))
        assertEquals("info", crash.getJSONObject("details").getString("severity"))
        assertEquals(0, drains)
    }

    @Test fun absent_and_malformed_optional_details_preserve_raw_facts_and_bundle() {
        for (handled in listOf(false, true)) {
            for (details in listOf(null, "null", "42", "[]", """{"context":null,"metadata":{"valid":true}}""")) {
                val accepted = if (handled) module.captureHandledException(payload(details)) else module.reportCrash(payload(details))
                assertTrue(accepted)
                val crash = crash()
                assertEquals("core facts", crash.getString("message"))
                assertEquals("at fixture (address at index.android.bundle:1:42)", crash.getJSONArray("frames").getJSONObject(0).getString("raw"))
                assertEquals("owned-rn-build", crash.getJSONObject("jsBundle").getString("buildId"))
                if (details == null) assertFalse(crash.has("details")) else {
                    assertEquals("error", crash.getJSONObject("details").getString("severity"))
                    assertTrue(crash.getJSONObject("details").getBoolean("truncated"))
                }
                clearStored()
            }
        }
    }

    @Test fun refusal_storage_failure_and_kill_never_acknowledge_or_schedule() {
        storage.install(fail = true)
        assertFalse(module.captureHandledException(payload("{}")))
        assertEquals(0, drains); assertTrue(entries().isEmpty())
        storage.install()
        TraceItX.kill()
        assertFalse(module.reportCrash(payload("{}")))
        assertFalse(module.captureHandledException(payload("{}")))
        assertEquals(0, drains); assertTrue(entries().isEmpty())
    }

    @Test fun disabled_crash_config_refuses_both_paths_without_storage_or_drain() {
        val config = requireNotNull(TraceItX.captureSessionSnapshot().config)
        TraceItX.__setConfigForTesting(config.copy(capture = config.capture.copy(crash = false)))
        assertFalse(module.reportCrash(payload("{}")))
        assertFalse(module.captureHandledException(payload("{}")))
        assertEquals(0, drains); assertTrue(entries().isEmpty())
    }

    @Test fun failed_delivery_keeps_exact_details_report_and_idempotency_identity() {
        assertTrue(module.captureHandledException(payload("""{"metadata":{"n":-9007199254740994,"nested":{"ok":true}}}""")))
        val original = entries().single()
        assertEquals(-9007199254740994.0, crash().getJSONObject("details").getJSONObject("metadata").getDouble("n"), 0.0)
        runBlocking { storage.outbox().drain { entry ->
            assertArrayEquals(original.envelopeBytes, entry.envelopeBytes)
            false
        } }
        val retry = entries().single()
        assertArrayEquals(original.envelopeBytes, retry.envelopeBytes)
        assertEquals(original.reportId, retry.reportId)
        assertEquals(original.idempotencyKey, retry.idempotencyKey)
        println("RN_DETAILS_RETRY " + JSONObject().put("reportId", original.reportId).put("idempotencyKey", original.idempotencyKey)
            .put("envelopeSha256", java.security.MessageDigest.getInstance("SHA-256").digest(original.envelopeBytes).joinToString("") { "%02x".format(it) })
            .put("details", crash().getJSONObject("details")))
        runBlocking { storage.outbox().drain { true } }
        assertTrue(entries().isEmpty())
    }
}
