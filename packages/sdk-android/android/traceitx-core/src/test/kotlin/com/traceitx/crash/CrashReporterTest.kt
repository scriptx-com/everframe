// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Task 10 — CrashReporter (Robolectric). Mirrors BreadcrumbAdaptersTest's
// setup: ApplicationProvider.getApplicationContext(), SharedData.init(context),
// TraceItX.captureGate = true, save/restore Thread.getDefaultUncaughtExceptionHandler
// is not needed here (this suite drives CrashReporter directly, never
// Thread.setDefaultUncaughtExceptionHandler).
//
// Adaptations vs. the brief's sketch:
//   • `com.traceitx.protocol.generated.Source` -> `ReportEnvelopeSource`
//     (real generated enum name).
//   • Fixture path: gradle's testDebugUnitTest working directory is the
//     `traceitx-core` module directory itself (no custom `workingDir` is set
//     in build.gradle.kts), so the correct relative path is
//     `../../../protocol/__tests__/fixtures/crash-fingerprint.json` (three
//     levels up to `packages/`). Confirmed via a one-off
//     `File(".").canonicalFile` println during implementation; the defensive
//     fallback is kept anyway since CI/local invocation directories can
//     differ (documented as belt-and-suspenders, not load-bearing).
package com.traceitx.crash

import com.traceitx.outbox.JceTestOutboxKeyProvider
import com.traceitx.outbox.JvmOutboxFileOps

import androidx.test.core.app.ApplicationProvider
import android.content.Context
import com.traceitx.capture.ResourceRingBuffer
import com.traceitx.capture.sharedResourceBuffer
import com.traceitx.shared.SharedData
import com.traceitx.TraceItX
import com.traceitx.config.TraceItXConfig
import com.traceitx.config.VitalsConfig
import com.traceitx.outbox.CrashSidecar
import com.traceitx.outbox.JSONLOutbox
import com.traceitx.protocol.generated.ReportEnvelopeSource
import com.traceitx.vitals.PlayerIntegration
import com.traceitx.vitals.PlayerIntegrationContext
import com.traceitx.vitals.PlayerSnapshot
import com.traceitx.vitals.ResourceSampler
import com.traceitx.vitals.StartupTimings
import com.traceitx.vitals.VitalsController
import com.traceitx.vitals.VitalsRuntime
import com.traceitx.vitals.VitalsScheduler
import com.traceitx.vitals.VitalsServerConfig
import com.traceitx.vitals.VitalsServerConfigSignal
import com.traceitx.vitals.wire.SessionSummaryDims
import com.traceitx.vitals.wire.VitalsSample
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.double
import kotlinx.serialization.json.long
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class CrashReporterTest {

    @get:org.junit.Rule val tmp = org.junit.rules.TemporaryFolder()
    private val keys = JceTestOutboxKeyProvider()
    private lateinit var storageDir: File
    private fun encryptedOutbox() = JSONLOutbox(File(storageDir, "outbox.jsonl"), keys, JvmOutboxFileOps())

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val config = TraceItXConfig(appId = "app", sdkKey = "sk")

    @Before
    fun setUp() {
        SharedData.init(context)
        TraceItX.captureGate = true
        TraceItX.setUser(null)
        CrashReporter.__resetForTesting()
        storageDir = tmp.newFolder()
        CrashReporter.sidecarFactory = { CrashSidecar(sidecarFile(), keys, JvmOutboxFileOps()) }
        CrashReporter.configure(context)
        // CrashReporter reads the config out of the crash-entry snapshot now,
        // not from a field of its own, so it has to be installed on TraceItX.
        // `__setConfigForTesting` sets `_config` under `stateLock` without
        // paying for start()'s heavy-init tail — this suite deliberately flips
        // captureGate directly rather than calling start().
        TraceItX.__setConfigForTesting(config)
        // Process-global, like sharedLogBuffer/sharedBreadcrumbBuffer
        // elsewhere — leaking entries across this JVM-shared test suite
        // would make an unrelated test's crash envelope carry resources.
        sharedResourceBuffer.clear()
    }

    @After
    fun tearDown() {
        TraceItX.setUser(null)
        CrashReporter.__resetForTesting()
        // Process-global, like captureGate below.
        TraceItX.__setConfigForTesting(null)
        // TraceItX.captureGate is process-global; leaking `true` bleeds into
        // other suites sharing this JVM worker (mirrors BreadcrumbAdaptersTest's
        // tearDown).
        TraceItX.captureGate = false
        sharedResourceBuffer.clear()
        // VitalsRuntime is process-global too — a controller installed by the
        // vitals-stamping test below must not leak a live collector into
        // other suites sharing this JVM worker.
        VitalsRuntime.resetForTesting()
        VitalsServerConfigSignal.resetForTesting()
    }

    private fun sidecarFile() = File(storageDir, "crash-outbox.jsonl")

    private fun persistedEnvelope(name: String) = encryptedOutbox().let { outbox ->
        val entry = runBlocking { outbox.hydrate() }.single()
        runBlocking { outbox.drain { true } }
        Json.parseToJsonElement(String(entry.envelopeBytes)).jsonObject
    }

    private fun failStorage() {
        CrashReporter.sidecarFactory = { CrashSidecar(sidecarFile(), keys, object : com.traceitx.outbox.OutboxFileOps by JvmOutboxFileOps() {
            override fun syncFile(file: File) { throw java.io.IOException("unavailable") }
        }) }
    }

    private fun restoreStorage() {
        CrashReporter.sidecarFactory = { CrashSidecar(sidecarFile(), keys, JvmOutboxFileOps()) }
    }

    private fun handled(type: String = "Handled", bundle: com.traceitx.protocol.generated.JSBundle? = null) =
        CrashReporter.captureHandledFacts(type, "caught Bearer abc.def-123", listOf("at app:1:2"),
            "2026-09-14T12:00:00Z", bundle)

    private fun hermesFatal(): Boolean = CrashReporter.captureFactsAccepted(
        "Error", "test fatal", listOf("at throwUnhandled (address at index.android.bundle:1:819834)"),
        "errorutils", true, "2026-09-14T12:00:00Z",
        com.traceitx.protocol.generated.JSBundle(buildID = "test-android", bundleName = "index.android.bundle",
            engine = com.traceitx.protocol.generated.Engine.Hermes,
            platform = com.traceitx.protocol.generated.JSBundlePlatform.Android),
    )

    private fun rnWrapper(message: String = "Error: test fatal, stack:\nthrowUnhandled@1:819834\n") =
        com.facebook.react.common.JavascriptException(message).apply {
            stackTrace = arrayOf(StackTraceElement("com.facebook.react.modules.core.ExceptionsManagerModule",
                "reportException", "ExceptionsManagerModule.kt", 52))
        }

    @Test
    fun `persisted Hermes fatal prevents only its matching native wrapper duplicate`() {
        assertTrue(hermesFatal())
        CrashReporter.captureThrowable(Thread.currentThread(), rnWrapper())
        val outbox = encryptedOutbox()
        assertEquals(1, runBlocking { outbox.count() })
        val crash = Json.parseToJsonElement(String(runBlocking { outbox.hydrate() }.single().envelopeBytes))
            .jsonObject["payload"]!!.jsonObject["crash"]!!.jsonObject
        assertEquals("errorutils", crash["mechanism"]!!.jsonPrimitive.content)
        assertEquals("test-android", crash["jsBundle"]!!.jsonObject["buildId"]!!.jsonPrimitive.content)
    }

    @Test
    fun `suppressed fatal survives reopen while legacy processing hydration is blocked`() {
        val processing = File(storageDir, "crash-outbox.jsonl.processing")
        val blocked = "{unreadable legacy batch\n"
        processing.writeText(blocked)
        sidecarFile().writeText(blocked)
        val box = encryptedOutbox()
        assertEquals(0, runBlocking { CrashSidecar(sidecarFile(), keys, JvmOutboxFileOps()).hydrateInto(box) })
        assertTrue(hermesFatal())
        CrashReporter.captureThrowable(Thread.currentThread(), rnWrapper())
        assertEquals(1, runBlocking { box.count() })
        CrashReporter.__resetForTesting()
        val reopened = encryptedOutbox()
        assertEquals(0, runBlocking { CrashSidecar(sidecarFile(), keys, JvmOutboxFileOps()).hydrateInto(reopened) })
        val entry = runBlocking { reopened.hydrate() }.single()
        val crash = Json.parseToJsonElement(String(entry.envelopeBytes)).jsonObject["payload"]!!.jsonObject["crash"]!!.jsonObject
        assertEquals("errorutils", crash["mechanism"]!!.jsonPrimitive.content)
        assertEquals(blocked, processing.readText())
        assertEquals(blocked, sidecarFile().readText())
        assertFalse(File(storageDir, "outbox.jsonl.encrypted").walkTopDown().filter { it.isFile }
            .any { String(it.readBytes()).contains("test fatal") })
    }

    @Test
    fun `failed JS persistence preserves native wrapper fallback`() {
        failStorage()
        assertFalse(hermesFatal())
        restoreStorage()
        CrashReporter.captureThrowable(Thread.currentThread(), rnWrapper())
        val crash = persistedEnvelope("fallback")["payload"]!!.jsonObject["crash"]!!.jsonObject
        assertEquals("uncaught-exception-handler", crash["mechanism"]!!.jsonPrimitive.content)
    }

    @Test
    fun `later failed identical fatal cannot reuse an older acceptance`() {
        assertTrue(hermesFatal())
        val outbox = encryptedOutbox()
        assertEquals(1, runBlocking { outbox.count() })
        runBlocking { outbox.drain { true } }
        failStorage()
        assertFalse(hermesFatal())
        restoreStorage()
        CrashReporter.captureThrowable(Thread.currentThread(), rnWrapper())
        val crash = persistedEnvelope("later-fallback")["payload"]!!.jsonObject["crash"]!!.jsonObject
        assertEquals("uncaught-exception-handler", crash["mechanism"]!!.jsonPrimitive.content)
    }

    @Test
    fun `in-flight success does not suppress newer reentrant failure fallback`() {
        CrashReporter.__afterUserSnapshotHookForTesting = {
            CrashReporter.__afterUserSnapshotHookForTesting = null
            assertFalse(hermesFatal()) // Reentrancy latch rejects the newer attempt.
        }
        assertTrue(hermesFatal())
        CrashReporter.captureThrowable(Thread.currentThread(), rnWrapper())
        val outbox = encryptedOutbox()
        assertEquals(2, runBlocking { outbox.count() })
    }

    @Test
    fun `different native crash remains after a persisted Hermes fatal`() {
        assertTrue(hermesFatal())
        CrashReporter.captureThrowable(Thread.currentThread(), IllegalStateException("native bug"))
        CrashReporter.captureThrowable(Thread.currentThread(), rnWrapper("Error: another JS failure, stack:\nf@1:9\n"))
        val outbox = encryptedOutbox()
        assertEquals(3, runBlocking { outbox.count() })
    }

    @Test
    fun `handled capture persists fixed classification redaction context and entry user`() {
        TraceItX.setUser(com.traceitx.config.TXUser(id = "entry-user"))
        var hookRan = false
        CrashReporter.__afterUserSnapshotHookForTesting = {
            hookRan = true
            TraceItX.setUser(com.traceitx.config.TXUser(id = "later-user"))
            TraceItX.__setConfigForTesting(config.copy(sdkKey = "later-key"))
        }
        assertTrue(handled())
        assertTrue(hookRan)
        val outbox = encryptedOutbox()
        assertEquals(1, runBlocking { outbox.count() })
        val entry = runBlocking { outbox.hydrate() }.single()
        assertEquals("sk", entry.sdkKey)
        assertEquals(com.traceitx.config.IngestEndpoint.url, entry.endpoint)
        assertTrue(entry.attachmentRefs.isEmpty())
        val env = Json.parseToJsonElement(String(entry.envelopeBytes)).jsonObject
        assertEquals("error", env["source"]!!.jsonPrimitive.content)
        val crash = env["payload"]!!.jsonObject["crash"]!!.jsonObject
        assertEquals("true", crash["handled"]!!.jsonPrimitive.content)
        assertEquals("false", crash["fatal"]!!.jsonPrimitive.content)
        assertEquals("captureException", crash["mechanism"]!!.jsonPrimitive.content)
        assertNull(crash["details"])
        assertEquals("2026-09-14T12:00:00Z", crash["occurredAt"]!!.jsonPrimitive.content)
        assertEquals("caught [REDACTED]", crash["message"]!!.jsonPrimitive.content)
        assertEquals(CrashReporter.fingerprintOf("Handled", listOf("at app::")), crash["fingerprint"]!!.jsonPrimitive.content)
        assertEquals("entry-user", env["reporter"]!!.jsonObject["user"]!!.jsonObject["id"]!!.jsonPrimitive.content)
        assertEquals("later-user", TraceItX.currentUser?.id)
        assertTrue(env["attachments"]!!.jsonArray.isEmpty())
        val excluded = env["captureControl"]!!.jsonObject["excluded"]!!.jsonArray.map { it.jsonPrimitive.content }
        assertTrue(excluded.containsAll(listOf("screenshot", "uiTree", "focus", "logs", "network")))
        assertTrue(env["context"]!!.jsonObject["app"] != null)
    }

    @Test
    fun `handled optional identity is exact and invalid metadata retains raw frames`() {
        val identity = com.traceitx.protocol.generated.JSBundle(buildID = " js-7 ", bundleName = "index.bundle",
            engine = com.traceitx.protocol.generated.Engine.Hermes,
            platform = com.traceitx.protocol.generated.JSBundlePlatform.Android)
        for (bundle in listOf(identity, identity.copy(buildID = " "), identity.copy(bundleName = "../bad"))) {
            assertTrue(handled(bundle = bundle))
            val crash = persistedEnvelope("handled-identity")["payload"]!!.jsonObject["crash"]!!.jsonObject
            assertEquals(bundle == identity, crash["jsBundle"] != null)
            if (bundle == identity) assertEquals(" js-7 ", crash["jsBundle"]!!.jsonObject["buildId"]!!.jsonPrimitive.content)
            assertEquals("at app:1:2", crash["frames"]!!.jsonArray[0].jsonObject["raw"]!!.jsonPrimitive.content)
        }
    }

    @Test
    fun `accepted automatic captures persist explicit fatality without handled classification`() {
        for (fatal in listOf(false, true)) {
            assertTrue(CrashReporter.captureFactsAccepted("Automatic", "error", emptyList(), "errorutils", fatal,
                "2026-09-14T12:00:00Z"))
            val env = persistedEnvelope("automatic")
            val crash = env["payload"]!!.jsonObject["crash"]!!.jsonObject
            assertEquals(if (fatal) "crash" else "error", env["source"]!!.jsonPrimitive.content)
            assertEquals(fatal.toString(), crash["fatal"]!!.jsonPrimitive.content)
            assertEquals("false", crash["handled"]!!.jsonPrimitive.content)
            assertEquals("errorutils", crash["mechanism"]!!.jsonPrimitive.content)
        }
    }

    @Test
    fun `handled refuses missing configuration disabled reentrant revoked and failed storage`() {
        CrashReporter.__resetForTesting()
        assertFalse(handled())
        CrashReporter.configure(context)
        TraceItX.__setConfigForTesting(null)
        assertFalse(handled())
        TraceItX.__setConfigForTesting(config.copy(capture = config.capture.copy(crash = false)))
        assertFalse(handled())
        TraceItX.__setConfigForTesting(config)
        CrashReporter.__enterForTesting()
        assertFalse(handled())
        CrashReporter.__resetForTesting()
        CrashReporter.configure(context)
        CrashReporter.__afterUserSnapshotHookForTesting = { TraceItX.kill() }
        assertFalse(handled())
        assertFalse(sidecarFile().exists())
        CrashReporter.__afterUserSnapshotHookForTesting = null
        TraceItX.__setConfigForTesting(config)
        TraceItX.captureGate = true
        failStorage()
        assertFalse(handled())
        restoreStorage()
        assertTrue(handled("Recovered"))
    }

    @Test
    fun `handled burst interleaved with automatic and fatal retains every encrypted acceptance`() {
        assertTrue(handled("Handled1"))
        assertTrue(handled("Handled2"))
        assertTrue(CrashReporter.captureFactsAccepted("Automatic", "", emptyList(), "errorutils", false, "2026-09-14T12:00:00Z"))
        assertTrue(handled("Handled3"))
        assertTrue(CrashReporter.captureFactsAccepted("Fatal", "", emptyList(), "errorutils", true, "2026-09-14T12:00:00Z"))
        val outbox = encryptedOutbox()
        assertEquals(5, runBlocking { outbox.count() })
        val entries = runBlocking { outbox.hydrate() }
        assertEquals(setOf("Handled1", "Handled2", "Automatic", "Handled3", "Fatal"), entries.map {
            Json.parseToJsonElement(String(it.envelopeBytes)).jsonObject["payload"]!!.jsonObject["crash"]!!.jsonObject["exceptionType"]!!.jsonPrimitive.content
        }.toSet())
    }

    /** No-op fake integration — enough to attach and emit `player_attach` via [VitalsController.trackPlayer]. */
    private class FakePlayerIntegration : PlayerIntegration {
        override val library = "fake"
        override val version = "1"
        override fun attach(ctx: PlayerIntegrationContext): Boolean = true
        override fun snapshot(onResult: (PlayerSnapshot?) -> Boolean) { onResult(null) }
        override fun startupTimings(): StartupTimings? = null
        override fun describe(ctx: PlayerIntegrationContext) {}
        override fun detach() {}
    }

    private class FakeScheduler : VitalsScheduler {
        override fun repeat(intervalMs: Long, tick: () -> Unit) = AutoCloseable { }
    }

    @Test
    fun `kill and reopen during actual sidecar construction rejects captured crash`() {
        var crossedBoundary = false
        CrashReporter.sidecarFactory = {
            crossedBoundary = true
            TraceItX.kill()
            TraceItX.__setConfigForTesting(config)
            TraceItX.captureGate = true
            CrashSidecar(sidecarFile(), keys, JvmOutboxFileOps())
        }
        CrashReporter.captureThrowable(Thread.currentThread(), IllegalStateException("pre-kill"))
        assertTrue(crossedBoundary)
        assertEquals(0, runBlocking { encryptedOutbox().count() })
        CrashReporter.sidecarFactory = { CrashSidecar(sidecarFile(), keys, JvmOutboxFileOps()) }
        CrashReporter.captureThrowable(Thread.currentThread(), IllegalStateException("new-session"))
        assertEquals(1, runBlocking { encryptedOutbox().count() })
    }

    @Test
    fun `captureFacts persists exact optional Hermes metadata and drops invalid identity`() {
        val identity = com.traceitx.protocol.generated.JSBundle(
            buildID = " js-7 ", bundleName = "index.bundle",
            engine = com.traceitx.protocol.generated.Engine.Hermes,
            platform = com.traceitx.protocol.generated.JSBundlePlatform.Android,
        )
        for ((bundle, expected) in listOf(identity to true, identity.copy(buildID = " ") to false,
                identity.copy(buildID = "x\u0000y") to false, identity.copy(buildID = "\uD800") to false,
                identity.copy(bundleName = "../index.bundle") to false, null to false)) {
            runBlocking { encryptedOutbox().drain { true } }
            CrashReporter.captureFacts("Error", "hermes", listOf("at f (address at index.bundle:1:0)"),
                "errorutils", false, "2026-09-08T12:00:00Z", jsBundle = bundle)
            val outbox = encryptedOutbox()

            val entry = runBlocking { outbox.hydrate() }.single()
            val env = Json.parseToJsonElement(String(entry.envelopeBytes)).jsonObject
            val crash = env["payload"]!!.jsonObject["crash"]!!.jsonObject
            assertEquals(expected, crash["jsBundle"] != null)
            if (expected) assertEquals(" js-7 ", crash["jsBundle"]!!.jsonObject["buildId"]!!.jsonPrimitive.content)
            assertEquals("at f (address at index.bundle:1:0)", crash["frames"]!!.jsonArray[0].jsonObject["raw"]!!.jsonPrimitive.content)
            assertEquals(com.traceitx.capture.DeviceMetadata.collect(context)["appBuild"].toString(), env["context"]!!.jsonObject["app"]!!.jsonObject["build"]!!.jsonPrimitive.content)
        }
    }

    @Test
    fun `captureThrowable synchronously persists a redacted crash envelope encrypted across reopen`() {
        val boom = IllegalStateException("boom Bearer abc.def-123")
        CrashReporter.captureThrowable(Thread.currentThread(), boom)

        assertTrue(!sidecarFile().exists())
        val outbox = encryptedOutbox()
        assertEquals(1, runBlocking { outbox.count() })
        val entry = runBlocking { outbox.hydrate() }.single()
        val env = Json.parseToJsonElement(String(entry.envelopeBytes)).jsonObject
        assertEquals("crash", env["source"]!!.jsonPrimitive.content)
        val crash = env["payload"]!!.jsonObject["crash"]!!.jsonObject
        assertEquals("java.lang.IllegalStateException", crash["exceptionType"]!!.jsonPrimitive.content)
        assertEquals("true", crash["fatal"]?.jsonPrimitive?.content)
        assertTrue(crash["jsBundle"] == null)
        assertTrue(crash["message"]!!.jsonPrimitive.content.contains("[REDACTED]"))
        assertEquals(16, crash["fingerprint"]!!.jsonPrimitive.content.length)
        // Native uncaught exceptions remain unhandled; assert the raw bytes
        // for wire fidelity independently of the explicit handled entry point.
        assertEquals(false, crash["handled"]!!.jsonPrimitive.content.toBoolean())
        assertEquals("error", crash["details"]!!.jsonObject["severity"]!!.jsonPrimitive.content)
        assertTrue(String(entry.envelopeBytes).contains("\"handled\":false"))
        val title = env["reporter"]!!.jsonObject["title"]!!.jsonPrimitive.content
        assertTrue(title.length <= 50)
        assertEquals("", env["reporter"]!!.jsonObject["description"]!!.jsonPrimitive.content)
    }

    // --- Report Resource Window (spec 2026-09-05) — gap class 3: crash-path stamp site ---

    @Test
    fun `captureThrowable stamps payload_resources from the shared ring buffer`() {
        // Timestamped at "now" — the ring's default snapshot() evicts against
        // the REAL clock (windowSec defaults to 60s), so a fixed historical
        // timestamp would be evicted before the crash path ever reads it.
        sharedResourceBuffer.push(ResourceRingBuffer.Entry(t = System.currentTimeMillis(), cpu = 0.4, mem = 2048L))

        CrashReporter.captureThrowable(Thread.currentThread(), IllegalStateException("boom"))

        // Read back through the encrypted outbox the sidecar writes straight
        // into, the same way every sibling test in this class does —
        // `CrashSidecar.hydrateInto` is now only the legacy-migration path.
        val outbox = encryptedOutbox()
        assertEquals(1, runBlocking { outbox.count() })
        val entry = runBlocking { outbox.hydrate() }.single()
        val env = Json.parseToJsonElement(String(entry.envelopeBytes)).jsonObject
        val resources = env["payload"]!!.jsonObject["resources"]!!.jsonArray
        assertEquals(1, resources.size)
        assertEquals(2048.0, resources[0].jsonObject["mem"]!!.jsonPrimitive.double, 0.0)
    }

    @Test
    fun `captureThrowable sidecar JVM subtree matches the canonical fixture without changing outer crash facts`() {
        TraceItX.__setConfigForTesting(config.copy(r8MappingId = "android-release-ci-123"))
        val inner = IllegalStateException("inner failure").apply {
            stackTrace = arrayOf(StackTraceElement("sample.Inner", "fail", "Inner.kt", 7))
        }
        val middle = IllegalArgumentException("middle failure", inner).apply {
            stackTrace = arrayOf(StackTraceElement("sample.Middle", "run", "Middle.kt", 11))
        }
        val outer = RuntimeException("outer failure", middle).apply {
            stackTrace = arrayOf(StackTraceElement("sample.Outer", "start", "Outer.kt", 19))
        }

        CrashReporter.captureThrowable(Thread.currentThread(), outer)

        val env = persistedEnvelope("jvm-fixture")
        val crash = env["payload"]!!.jsonObject["crash"]!!.jsonObject
        val fixture = File("../../../protocol/__tests__/fixtures/jvm-crash-envelope.json")
        val fixtureJvm = Json.parseToJsonElement(fixture.readText()).jsonObject["payload"]!!
            .jsonObject["crash"]!!.jsonObject["jvm"]
        assertEquals(fixtureJvm, crash["jvm"])
        assertEquals("java.lang.RuntimeException", crash["exceptionType"]!!.jsonPrimitive.content)
        assertEquals("outer failure", crash["message"]!!.jsonPrimitive.content)
        assertEquals("crash", env["source"]!!.jsonPrimitive.content)
        assertFalse(crash["handled"]!!.jsonPrimitive.content.toBoolean())
        assertEquals(
            CrashReporter.fingerprintOf("java.lang.RuntimeException", listOf("start|Outer.kt")),
            crash["fingerprint"]!!.jsonPrimitive.content,
        )
        assertEquals(
            com.traceitx.capture.DeviceMetadata.collect(context)["appBuild"].toString(),
            env["context"]!!.jsonObject["app"]!!.jsonObject["build"]!!.jsonPrimitive.content,
        )
    }

    @Test
    fun `captureThrowable retains the mapping ID from its entry snapshot when live config changes`() {
        TraceItX.__setConfigForTesting(config.copy(r8MappingId = "mapping-A"))
        val cause = IllegalStateException("cause").apply { stackTrace = emptyArray() }
        val outer = ConfigSwappingThrowable {
            TraceItX.__setConfigForTesting(config.copy(r8MappingId = "mapping-B"))
        }.apply { initCause(cause) }

        CrashReporter.captureThrowable(Thread.currentThread(), outer)

        val crash = persistedEnvelope("jvm-snapshot")["payload"]!!.jsonObject["crash"]!!.jsonObject
        assertEquals("mapping-A", crash["jvm"]!!.jsonObject["mappingId"]!!.jsonPrimitive.content)
    }

    @Test
    fun `captureFacts excludes JVM metadata even when native config has a mapping ID`() {
        TraceItX.__setConfigForTesting(config.copy(r8MappingId = "native-map"))

        CrashReporter.captureFacts(
            exceptionType = "TypeError",
            message = "boom",
            framesRaw = listOf("at render (index.bundle:1:2)"),
            mechanism = "errorutils",
            fatal = true,
            occurredAt = "2026-09-09T12:00:00Z",
        )

        val crash = persistedEnvelope("rn-no-jvm")["payload"]!!.jsonObject["crash"]!!.jsonObject
        assertTrue(crash["jvm"] == null)
    }

    @Test
    fun `captureFacts non-fatal ships source=error with handled still false (v1 spec)`() {
        CrashReporter.captureFacts(
            exceptionType = "TypeError",
            message = "undefined is not a function",
            framesRaw = listOf("at render (app.tsx:10:5)"),
            mechanism = "rn-global-handler",
            fatal = false,
            occurredAt = "2026-07-18T00:00:00Z",
        )

        assertTrue(!sidecarFile().exists())
        val outbox = encryptedOutbox()
        assertEquals(1, runBlocking { outbox.count() })
        val entry = runBlocking { outbox.hydrate() }.single()
        val env = Json.parseToJsonElement(String(entry.envelopeBytes)).jsonObject
        assertEquals("false", env["payload"]!!.jsonObject["crash"]!!.jsonObject["fatal"]?.jsonPrimitive?.content)
        assertEquals("error", env["source"]!!.jsonPrimitive.content)
        val crash = env["payload"]!!.jsonObject["crash"]!!.jsonObject
        // Automatic ErrorUtils capture remains unhandled even when nonfatal;
        // the distinct explicit capture entry point sets handled=true.
        assertEquals(false, crash["handled"]!!.jsonPrimitive.content.toBoolean())
        assertNull(crash["details"])
        assertTrue(String(entry.envelopeBytes).contains("\"handled\":false"))
    }

    @Test
    fun `frame raw is re-capped to 1024 after an expanding SSN redaction`() {
        // SSN `123-45-6789` (11 chars) -> `[REDACTED:SSN]` (14 chars) is an
        // EXPANDING replacement (redaction-patterns.json `ssn-us`, mirrored
        // from sdk-core's engine.ts). Build a raw frame that is exactly at
        // the 1024-char protocol cap pre-redaction so post-redaction it would
        // overflow to 1027 chars unless CrashReporter re-caps after redact().
        val ssn = "123-45-6789"
        val prefix = "a".repeat(1024 - ssn.length)
        val rawAtCap = "$prefix$ssn"
        assertEquals(1024, rawAtCap.length)

        CrashReporter.captureFacts(
            exceptionType = "TypeError",
            message = "boom",
            framesRaw = listOf(rawAtCap),
            mechanism = "rn-global-handler",
            fatal = false,
            occurredAt = "2026-07-18T00:00:00Z",
        )

        assertTrue(!sidecarFile().exists())
        val outbox = encryptedOutbox()
        assertEquals(1, runBlocking { outbox.count() })
        val entry = runBlocking { outbox.hydrate() }.single()
        val bytes = entry.envelopeBytes
        // Envelope JSON must still parse (would be a Zod-rejecting shape at
        // ingest otherwise, but here we assert the raw wire-cap invariant
        // directly against the encoded bytes).
        val env = Json.parseToJsonElement(String(bytes)).jsonObject
        val frames = env["payload"]!!.jsonObject["crash"]!!.jsonObject["frames"]!!.jsonArray
        val raw = frames[0].jsonObject["raw"]!!.jsonPrimitive.content
        assertTrue(
            "redacted frame raw must be re-capped to <= 1024 chars, was ${raw.length}",
            raw.length <= 1024,
        )
    }

    @Test
    fun `re-entrant capture is a no-op (crash inside crash handling)`() {
        var causeReads = 0
        val outer = object : RuntimeException("outer") {
            override val cause: Throwable?
                get() { causeReads += 1; return null }
        }
        CrashReporter.__enterForTesting()
        CrashReporter.captureThrowable(Thread.currentThread(), outer)
        assertEquals(0, causeReads)
        assertTrue(!sidecarFile().exists())
        assertEquals(0, runBlocking { encryptedOutbox().count() })
        CrashReporter.__resetForTesting()
    }

    @Test
    fun `reentrant cause accessor is read once and persists only the outer report`() {
        var causeReads = 0
        val outer = object : RuntimeException("outer reentrant failure") {
            override val cause: Throwable?
                get() {
                    causeReads += 1
                    // Finite even without the guard: reproduce multiple reports,
                    // without relying on stack exhaustion to terminate the test.
                    if (causeReads <= 2) CrashReporter.captureThrowable(Thread.currentThread(), this)
                    return null
                }
        }

        CrashReporter.captureThrowable(Thread.currentThread(), outer)

        assertEquals(1, causeReads)
        // Hydrates the actual sidecar and requires exactly one persisted report.
        val crash = persistedEnvelope("jvm-reentrant")["payload"]!!.jsonObject["crash"]!!.jsonObject
        assertEquals("outer reentrant failure", crash["message"]!!.jsonPrimitive.content)
        assertEquals(outer.javaClass.name, crash["exceptionType"]!!.jsonPrimitive.content)
        assertTrue(crash["jvm"]!!.jsonObject["causes"]!!.jsonArray.isEmpty())
    }

    @Test
    fun `a crash envelope stamps sessionId and the recent vitals ring when a collector is running`() {
        var onSample: ((VitalsSample) -> Unit)? = null
        val controller = VitalsController(
            VitalsController.Deps(
                localConfig = VitalsConfig(),
                dims = SessionSummaryDims("android", "1", "0.8.0"),
                transport = { object : com.traceitx.vitals.VitalsSink { override fun send(body: String) = Unit; override fun close() = Unit } },
                scheduler = FakeScheduler(),
                samplerFactory = { sample, tick ->
                    onSample = sample
                    object : ResourceSampler(handler = android.os.Handler(android.os.Looper.getMainLooper()), onSample = sample, onTick = tick) {}
                },
                lifecycle = { _, _ -> null },
                newSessionId = { "crash-sid" },
            ),
        )
        // VitalsRuntime.install() subscribes the controller to
        // VitalsServerConfigSignal.flow on a background dispatcher, which
        // replays the flow's CURRENT value asynchronously. Pre-set it to the
        // same enabled config we apply manually below so that async replay —
        // whenever it actually runs — reaches the same "wants=true, already
        // running" no-op instead of racing our explicit applyServerConfig
        // call with a stale `null` that would stop the collector out from
        // under this test.
        VitalsServerConfigSignal.flow.value = VitalsServerConfig(true, 1.0)
        VitalsRuntime.install(controller)
        controller.applyServerConfig(VitalsServerConfig(true, 1.0))
        // One sample (via the sampler's onSample callback) and one player
        // event (trackPlayer's attach emits player_attach) — both must land
        // in the ring `EnvelopeBuilder` reads through `VitalsRuntime.currentStamp()`.
        onSample!!(VitalsSample(t = System.currentTimeMillis(), mem = 5))
        controller.trackPlayer(FakePlayerIntegration(), "main")

        CrashReporter.captureThrowable(Thread.currentThread(), RuntimeException("boom"))

        assertTrue(!sidecarFile().exists())
        val outbox = encryptedOutbox()
        assertEquals(1, runBlocking { outbox.count() })
        val entry = runBlocking { outbox.hydrate() }.single()
        val env = Json.parseToJsonElement(String(entry.envelopeBytes)).jsonObject
        assertEquals("crash-sid", env["sessionId"]!!.jsonPrimitive.content)
        val vitals = env["payload"]!!.jsonObject["vitals"]!!.jsonArray
        assertTrue("expected a non-empty vitals ring, got $vitals", vitals.isNotEmpty())
    }

    @Test
    fun `fingerprint matches cross-SDK parity fixture`() {
        // Confirmed via a one-off `File(".").canonicalFile` println: gradle's
        // testDebugUnitTest working directory is this module's own directory
        // (`traceitx-core`), three levels below `packages/` — no custom
        // `workingDir` is configured in build.gradle.kts.
        val fixture = File("../../../protocol/__tests__/fixtures/crash-fingerprint.json")
        val text = fixture.readText()
        val cases = Json.parseToJsonElement(text).jsonArray
        for (case in cases) {
            val obj = case.jsonObject
            val frames = obj["frames"]!!.jsonArray.map { f ->
                val fo = f.jsonObject
                val fn = fo["function"]?.jsonPrimitive?.content
                val file = fo["file"]?.jsonPrimitive?.content
                if (fn != null && file != null) "$fn|$file"
                else fo["raw"]!!.jsonPrimitive.content.replace(Regex("[0-9]+"), "")
            }
            assertEquals(
                obj["expected"]!!.jsonPrimitive.content,
                CrashReporter.fingerprintOf(obj["exceptionType"]!!.jsonPrimitive.content, frames),
            )
        }
    }

    private class ConfigSwappingThrowable(private val onStackRead: () -> Unit) : RuntimeException("outer") {
        override fun getStackTrace(): Array<StackTraceElement> {
            onStackRead()
            return arrayOf(StackTraceElement("sample.Outer", "start", "Outer.kt", 19))
        }
    }
}
