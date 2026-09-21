// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

// Native RN configuration, breadcrumb, crash and empty owned capture contracts.
package com.traceitx.rn

import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.bridge.JavaOnlyMap
import com.facebook.react.bridge.ReactApplicationContext
import com.traceitx.TraceItX
import com.traceitx.capture.replay.ReplaySession
import com.traceitx.capture.sharedBreadcrumbBuffer
import com.traceitx.protocol.generated.Attachment
import com.traceitx.protocol.generated.BreadcrumbKind
import com.traceitx.protocol.generated.Format
import com.traceitx.protocol.generated.AttachmentKind
import com.traceitx.protocol.generated.VFrame
import com.traceitx.protocol.generated.VNode
import com.traceitx.protocol.generated.VOp
import com.traceitx.protocol.generated.VOpAdd
import com.traceitx.protocol.generated.VOpSet
import com.traceitx.protocol.generated.VRect
import com.traceitx.protocol.generated.VTreeTimeline
import com.traceitx.protocol.generated.VTreeTimelineViewport
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.security.MessageDigest

@RunWith(RobolectricTestRunner::class)
class RnReplayBridgeTest {

    private lateinit var reactContext: ReactApplicationContext
    private lateinit var module: TraceItXModule

    // Forwarded SDK key fixture — the value JS passes as opts["apiKey"]. Criterion
    // #1 asserts replay is armed keyed on THIS value.
    private val sdkKey = "txx_live_rnreplaytest"

    @Before
    fun setUp() {
        // Every configure/start in this suite may fetch config or drain.
        // Refuse an artifact with a production endpoint before any test runs.
        assertEquals("http://127.0.0.1:9", com.traceitx.BuildConfig.INGEST_URL)
        // Mirror TraceItXModuleTest.kt's @Before: a real Robolectric application
        // Context wrapped in a ReactApplicationContext + the bridge module.
        //
        // Task 11 (Plan 5) fix: `ReactApplicationContext` is `abstract` in the
        // react-native-tvos 0.85.3-0 fork this workspace pins (see
        // examples/react-native/package.json's `"react-native":
        // "npm:react-native-tvos@0.85.3-0"` alias) — confirmed by decompiling
        // the resolved AAR's classes.jar directly (`javap` shows `public
        // abstract class ReactApplicationContext`). This is a real upstream
        // API change (RN's bridgeless-architecture refactor split the old
        // concrete class into an abstract base + `BridgeReactContext`
        // (legacy-bridge) / `BridgelessReactContext` (new-arch) concrete
        // subclasses), not a build-classpath gap — the same abstract class is
        // resolved identically on the main and test compile classpaths.
        // `BridgeReactContext` is RN's own concrete legacy-bridge subclass,
        // exactly what a host app's old-architecture bridge instantiates —
        // this is the intended replacement, not a hand-rolled stub.
        reactContext = BridgeReactContext(RuntimeEnvironment.getApplication())
        module = TraceItXModule(reactContext)
    }

    // ------------------------------------------------------------------------
    // Test A — criterion #2: NO new JS config / TurboModule / ingest surface.
    // ------------------------------------------------------------------------

    /**
     * The bridge must expose NO replay-config method. Reflectively assert
     * TraceItXModule has no method whose name suggests a replay-config knob —
     * pinning "no new TurboModule method."
     */
    @Test
    fun bridge_exposes_no_replay_config_method() {
        val forbidden = setOf(
            "configureReplay",
            "setReplayConfig",
            "enableReplay",
            "setReplayEnabled",
            "setSamplingRate",
            "setReplayDuration",
        )
        val methodNames = TraceItXModule::class.java.methods.map { it.name }.toSet()
        for (name in forbidden) {
            assertFalse(
                "bridge must NOT expose a replay-config method '$name' (criterion #2)",
                methodNames.contains(name),
            )
        }
    }

    /**
     * configure(opts) must consume ONLY apiKey / sdkVersion. A map carrying
     * replay-config keys (replayEnabled / samplingRate / replayDurationSec) and
     * an apiBase override must NOT throw and must NOT change behavior — those
     * keys are simply ignored. This pins "no new JS config field is read on the
     * Android side." We assert the observable contract: configure with only the
     * replay-ish keys present (NO apiKey) still rejects on the missing apiKey,
     * proving configure keys off apiKey alone and never off a replay knob.
     */
    @Test
    fun configure_reads_only_apiKey_not_replay_config_keys() {
        // No apiKey, but every replay-config-looking key present. If configure
        // consumed any of these as a start signal, captureGate would flip. It
        // must NOT — the only required field is apiKey.
        TraceItX.kill() // reset gate to a known-closed baseline
        // Task 11 (Plan 5): `JavaOnlyMap` — RN's own pure-JVM `WritableMap`
        // implementation — instead of `Arguments.createMap()`. The latter
        // constructs a JNI-backed `WritableNativeMap`, whose `HybridData`
        // static initializer requires `SoLoader`/`NativeLoader` to have
        // loaded the native library — unavailable under a plain Robolectric
        // JVM unit test (no real Android/JNI runtime), so it throws
        // `IllegalStateException: NativeLoader has not been initialized`.
        // `JavaOnlyMap` is RN's own host-test double for exactly this case.
        val opts = JavaOnlyMap().apply {
            putBoolean("replayEnabled", true)
            putDouble("samplingRate", 1.0)
            putInt("replayDurationSec", 60)
            putString("apiBase", "https://attacker.example")
        }
        // configure throws JSApplicationIllegalArgumentException for the missing
        // apiKey — but that throw is caught by the bridge's txGuardSurface and
        // surfaces only for the IllegalArgument case. We assert the EFFECT:
        // captureGate stays false because start() was never reached.
        runCatching { module.configure(opts) }
        assertFalse(
            "configure with replay-config keys but NO apiKey must NOT arm the SDK (criterion #2)",
            TraceItX.captureGate,
        )
    }

    // ------------------------------------------------------------------------
    // Test B — criterion #1: armed-at-start, keyed on the forwarded SDK key.
    // ------------------------------------------------------------------------

    /**
     * configure(apiKey) → TraceItX.start() flips captureGate true. The replay
     * ReplaySession is armed on TraceItX.sdkScope (Dispatchers.IO) inside start()
     * keyed on config.sdkKey == the forwarded apiKey (TraceItX.kt:162-167). The
     * arming itself (_replaySession) is `internal` to :traceitx-core and not
     * observable from this module; the observable bridge effect is the gate flip,
     * which is the precondition openReporter checks before driving the replay
     * lifecycle. Test C proves the armed session's lifecycle shape directly.
     */
    @Test
    fun configure_arms_capture_keyed_on_forwarded_sdk_key() {
        TraceItX.kill()
        assertFalse("precondition: gate closed before configure", TraceItX.captureGate)

        // JavaOnlyMap — see the setUp-adjacent comment in
        // configure_reads_only_apiKey_not_replay_config_keys() above for why
        // (Arguments.createMap()'s WritableNativeMap needs native SoLoader
        // init, unavailable under Robolectric).
        val opts = JavaOnlyMap().apply { putString("apiKey", sdkKey) }
        module.configure(opts)

        assertTrue(
            "configure(apiKey) must arm the SDK (captureGate=true) — the openReporter " +
                "precondition that gates the native replay freeze/attach path (criterion #1)",
            TraceItX.captureGate,
        )
    }

    // ------------------------------------------------------------------------
    // Test B.1 — Plan 4 / Task 14: addBreadcrumb forwards to the native
    // singleton (TraceItX.addBreadcrumb, Task 9) with NO bridge-side
    // coercion. A crumb lands in sharedBreadcrumbBuffer and an unrecognized
    // kind coerces to Custom — proving the coercion happens in the singleton
    // the bridge reaches, not in TraceItXModule itself.
    // ------------------------------------------------------------------------

    @Test
    fun addBreadcrumb_forwards_to_native_singleton_with_kind_coercion() {
        TraceItX.kill()
        // JavaOnlyMap — see configure_reads_only_apiKey_not_replay_config_keys().
        val opts = JavaOnlyMap().apply { putString("apiKey", sdkKey) }
        module.configure(opts)
        sharedBreadcrumbBuffer.clear()

        // Numeric timestamps can match credit-card redaction; keep this forwarding fixture non-sensitive.
        val marker = "rn-bridge-breadcrumb-probe"
        module.addBreadcrumb(marker, "totally-unknown-kind", null, null)

        sharedBreadcrumbBuffer.freeze()
        val crumb = sharedBreadcrumbBuffer.takeFrozen()?.firstOrNull { it.message == marker }
        assertNotNull(
            "addBreadcrumb must reach sharedBreadcrumbBuffer; snapshot=${sharedBreadcrumbBuffer.snapshotForReport()}",
            crumb,
        )
        assertEquals(
            "unknown kind must coerce to Custom — proving TraceItX.addBreadcrumb (Task 9), not the bridge, owns coercion",
            BreadcrumbKind.Custom,
            crumb!!.kind,
        )
    }

    // ------------------------------------------------------------------------
    // Test B.2 — final-review fix (2026-07-14): recordScreen forwards to the
    // native singleton (TraceItX.recordScreen, navigation screen markers) and
    // chains from→to through the SAME sharedBreadcrumbBuffer Test B.1 targets.
    // Moved here from TraceItXModuleTest.kt — that file is excluded from every
    // unit-test compile by build.gradle.kts:105-108 (pre-existing, unrelated
    // debt predating this test), which made the original copy dead code that
    // never ran. RnReplayBridgeTest.kt compiles and runs, so this is the test's
    // one live copy.
    // ------------------------------------------------------------------------

    @Test
    fun recordScreenForwardsToCoreAndChainsFromTo() {
        // No reset seam for the core adapter's previous-state from this
        // module (internal to :traceitx-core) — use unique names instead.
        //
        // `TraceItX.captureGate` has an `internal set` (module-boundary
        // enforced by Kotlin across the compiled :traceitx-core AAR) — it
        // is NOT assignable from this separate Gradle module. Open/close the
        // gate the same way addBreadcrumb_forwards_to_native_singleton_with
        // _kind_coercion (Test B.1, above) does: `TraceItX.kill()` to force a
        // known-closed baseline, then the real `module.configure()` bridge
        // path (which calls `TraceItX.start()`) to flip it open.
        TraceItX.kill()
        val opts = JavaOnlyMap().apply { putString("apiKey", sdkKey) }
        module.configure(opts)
        sharedBreadcrumbBuffer.applyConfig(null)
        sharedBreadcrumbBuffer.clear()
        try {
            module.recordScreen("RnScreenA", null)
            module.recordScreen("RnScreenB", null)
            sharedBreadcrumbBuffer.freeze()
            val nav = (sharedBreadcrumbBuffer.takeFrozen() ?: emptyList())
                .filter { it.kind == BreadcrumbKind.Navigation }
            assertTrue(
                "expected a RnScreenA → RnScreenB crumb, got: ${nav.map { it.message }}",
                nav.any { it.message == "RnScreenA → RnScreenB" },
            )
        } finally {
            sharedBreadcrumbBuffer.clear()
            TraceItX.kill()
        }
    }

    // ------------------------------------------------------------------------
    // Test C — criterion #1/#3: the replay lifecycle the bridge path reaches.
    // ------------------------------------------------------------------------

    /** The public facade returns an explicit empty owner when no video is available. */
    @Test
    fun replay_lifecycle_seams_are_reachable_and_fail_soft_on_empty_buffer() {
        val session = ReplaySession(
            baseUrl = "https://traceitx.test",
            apiKey = sdkKey,
            locallyDisabled = false,
            // Inject a null Activity supplier so no walk/allocation occurs on the JVM.
            activitySupplier = { null },
        )

        val capture = TraceItX.__replayFreeze()
        assertNull(kotlinx.coroutines.runBlocking { capture.exportVideo() })
        capture.cancel()
        session.teardown()
    }

    // ------------------------------------------------------------------------
    // Test F — synchronous persistence acknowledgement and drain decisions.
    // Tests start from neutral collector state; successful paths configure the
    // actual core and decode its sidecar. The native AAR must be Debug with a
    // loopback ingest endpoint when this suite runs.
    // ------------------------------------------------------------------------

    /**
     * Known-neutral crash-reporting state for the duration of [body]:
     * TraceItX killed (gate closed, config dropped) and CrashReporter
     * explicitly unconfigured — regardless of what any previously-run test
     * in this class (or this JVM) left behind. Teardown re-neutralizes both
     * and restores the module's production `__drainRequester`.
     */
    private lateinit var crashStorage: BridgeCrashStorage

    private fun withIsolatedCrashState(body: () -> Unit) {
        TraceItX.kill()
        com.traceitx.crash.CrashReporter.__resetForTesting()
        crashStorage = BridgeCrashStorage()
        val productionDrainRequester = module.__drainRequester
        try {
            body()
        } finally {
            module.__drainRequester = productionDrainRequester
            com.traceitx.crash.CrashReporter.__resetForTesting()
            TraceItX.kill()
            crashSidecar().delete()
            crashStorage.close()
        }
    }

    @Test
    fun reportCrash_persistsExactHermesIdentity() = withIsolatedCrashState {
        val context = androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()
        configureCrashCore()
        val sidecar = java.io.File(java.io.File(context.cacheDir, "com.traceitx"), "crash-outbox.jsonl")
        sidecar.delete()
        module.__drainRequester = {}
        val identity = """{"engine":"hermes","platform":"android","buildId":" js-7 ","bundleName":"index.bundle"}"""
        try {
            assertTrue(module.reportCrash("""{"exceptionType":"Error","framesRaw":["at f (address at index.bundle:1:0)"],"jsBundle":$identity}"""))
            val outbox = crashStorage.outbox()

            val entry = kotlinx.coroutines.runBlocking { outbox.hydrate() }.single()
            kotlinx.coroutines.runBlocking { outbox.drain { true } }
            val env = org.json.JSONObject(String(entry.envelopeBytes))
            val crash = env.getJSONObject("payload").getJSONObject("crash")
            val actual = crash.getJSONObject("jsBundle")
            for (key in listOf("engine", "platform", "buildId", "bundleName")) {
                assertEquals(org.json.JSONObject(identity).getString(key), actual.getString(key))
            }
            assertEquals("at f (address at index.bundle:1:0)", crash.getJSONArray("frames").getJSONObject(0).getString("raw"))
            assertEquals(com.traceitx.capture.DeviceMetadata.collect(context)["appBuild"].toString(), env.getJSONObject("context").getJSONObject("app").getString("build"))
            for (invalid in listOf("null", "42", "{}", """{"engine":"jsc"}""",
                """{"engine":"hermes","platform":"android","buildId":" ","bundleName":"index.bundle"}""")) {
                assertTrue(module.reportCrash("""{"exceptionType":"Error","jsBundle":$invalid}"""))
                val invalidOutbox = crashStorage.outbox()

                val invalidEntry = kotlinx.coroutines.runBlocking { invalidOutbox.hydrate() }.single()
                kotlinx.coroutines.runBlocking { invalidOutbox.drain { true } }
                val persisted = org.json.JSONObject(String(invalidEntry.envelopeBytes))
                assertFalse(persisted.getJSONObject("payload").getJSONObject("crash").has("jsBundle"))
            }
        } finally { sidecar.delete() }
    }

    @Test
    fun reportCrash_beforeNativeStart_returnsFalse_andDoesNotDrain() = withIsolatedCrashState {
        val json = """
            {
              "exceptionType": "TypeError",
              "message": "undefined is not a function",
              "framesRaw": ["at foo (index.js:10:5)", "at bar (index.js:20:1)"],
              "mechanism": "errorutils",
              "fatal": false,
              "occurredAt": "2026-07-18T00:00:00.000Z"
            }
        """.trimIndent()

        var drains = 0
        module.__drainRequester = { drains++ }
        assertFalse(module.reportCrash(json))
        assertEquals(0, drains)
    }

    @Test
    fun reportCrash_missingOptionalFields_beforeStart_returnsFalse() = withIsolatedCrashState {
        assertFalse(module.reportCrash("{}"))
    }

    @Test
    fun reportCrash_malformedJson_returnsFalse_neverThrows() = withIsolatedCrashState {
        assertFalse(
            "malformed JSON must return false, not throw",
            module.reportCrash("not-json-at-all{"),
        )
    }

    @Test
    fun reportCrash_nonFatal_requestsImmediateDrain() = withIsolatedCrashState {
        configureCrashCore()
        var drainRequested = false
        module.__drainRequester = { drainRequested = true }

        assertTrue(module.reportCrash("""{"fatal": false}"""))
        assertTrue(
            "fatal=false must request an immediate outbox drain — the JS " +
                "runtime survives an ErrorUtils-caught error, so the report " +
                "ships now instead of waiting for the next launch",
            drainRequested,
        )
    }

    @Test
    fun reportCrash_fatal_doesNotRequestDrain() = withIsolatedCrashState {
        configureCrashCore()
        var drainRequested = false
        module.__drainRequester = { drainRequested = true }

        assertTrue(module.reportCrash("""{"fatal": true}"""))
        val envelope = persistedCrashEnvelope()
        assertEquals("crash", envelope.getString("source"))
        val crash = envelope.getJSONObject("payload").getJSONObject("crash")
        assertTrue(crash.getBoolean("fatal"))
        assertFalse(crash.getBoolean("handled"))
        assertFalse(
            "fatal=true must NOT request a drain — the process dies via RN's " +
                "own fatal handling right after reportCrash returns; the " +
                "sidecar entry ships on next launch via start()'s hydrate+drain",
            drainRequested,
        )
    }

    @Test
    fun reportCrash_malformedJson_doesNotRequestDrain() = withIsolatedCrashState {
        // The drain call sits AFTER captureFacts inside the same try —
        // a parse failure must short-circuit both.
        var drainRequested = false
        module.__drainRequester = { drainRequested = true }

        assertFalse(module.reportCrash("not-json-at-all{"))
        assertFalse("malformed JSON must not reach the drain branch", drainRequested)
    }

    @Test
    fun handledCapture_enforcesClassification_boundsFrames_andPersistsBeforeDrain() = withIsolatedCrashState {
        configureCrashCore()
        var drains = 0
        module.__drainRequester = {
            drains++
            assertEquals("storage must finish before scheduling", 1, kotlinx.coroutines.runBlocking { crashStorage.outbox().count() })
        }
        val frames = org.json.JSONArray()
        repeat(256) { frames.put("at app:1:2 " + "x".repeat(1100)) }
        // Invalid elements beyond the cap must never be converted.
        frames.put(org.json.JSONObject.NULL)
        val json = org.json.JSONObject()
            .put("exceptionType", "H".repeat(300))
            .put("message", "m".repeat(5000))
            .put("framesRaw", frames)
            .put("fatal", true).put("handled", false).put("source", "crash")
            .put("mechanism", "conflicting")
            .put("jsBundle", org.json.JSONObject("""{"engine":"hermes","platform":"android","buildId":" js-7 ","bundleName":"index.bundle"}"""))
        assertTrue(module.captureHandledException(json.toString()))
        assertEquals(1, drains)
        val env = persistedCrashEnvelope()
        assertEquals("error", env.getString("source"))
        val crash = env.getJSONObject("payload").getJSONObject("crash")
        assertTrue(crash.getBoolean("handled"))
        assertFalse(crash.getBoolean("fatal"))
        assertEquals("captureException", crash.getString("mechanism"))
        assertEquals(256, crash.getString("exceptionType").length)
        assertEquals(4096, crash.getString("message").length)
        assertEquals(256, crash.getJSONArray("frames").length())
        assertEquals(1024, crash.getJSONArray("frames").getJSONObject(0).getString("raw").length)
        assertEquals(" js-7 ", crash.getJSONObject("jsBundle").getString("buildId"))
    }

    @Test
    fun handledCapture_refusesBeforeStart_invalidInput_andFailedStorage_withoutDrain() = withIsolatedCrashState {
        var drains = 0
        module.__drainRequester = { drains++ }
        assertFalse(module.captureHandledException("{}"))
        assertEquals(0, drains)
        configureCrashCore()
        module.__drainRequester = { drains++ }
        for (invalid in listOf("not-json", "[]", "null", """{"framesRaw":[null]}""")) {
            assertFalse(module.captureHandledException(invalid))
        }
        crashStorage.install(fail = true)
        assertTrue(crashSidecar().mkdirs())
        val blocker = java.io.File(crashSidecar(), "blocker").apply { writeText("preserve") }
        try {
            assertFalse(module.captureHandledException("{}"))
            assertEquals(0, drains)
            assertEquals("preserve", blocker.readText())
        } finally {
            blocker.delete()
            crashSidecar().delete()
        }
    }

    @Test
    fun handledCapture_invalidOptionalIdentity_keepsRawCapture_andSchedulingFailureKeepsTrue() = withIsolatedCrashState {
        configureCrashCore()
        module.__drainRequester = { throw IllegalStateException("scheduler unavailable") }
        for (invalid in listOf("null", "42", "{}", """{"engine":"jsc"}""")) {
            assertTrue(module.captureHandledException("""{"message":"caught Bearer abc.def-123","framesRaw":["at app:1:2"],"jsBundle":$invalid}"""))
            val crash = persistedCrashEnvelope().getJSONObject("payload").getJSONObject("crash")
            assertFalse(crash.has("jsBundle"))
            assertEquals("at app:1:2", crash.getJSONArray("frames").getJSONObject(0).getString("raw"))
            assertEquals("caught [REDACTED]", crash.getString("message"))
        }
    }

    private fun crashSidecar() = java.io.File(java.io.File(reactContext.cacheDir, "com.traceitx"), "crash-outbox.jsonl")

    private fun configureCrashCore() {
        assertEquals("http://127.0.0.1:9", com.traceitx.BuildConfig.INGEST_URL)
        val opts = com.facebook.react.bridge.JavaOnlyMap()
        opts.putString("apiKey", "txx_live_handled_test")
        crashSidecar().delete()
        module.configure(opts)
        // start's last replay-session assignment follows sidecar hydration.
        // Await it so startup cannot steal the report this test will inspect.
        val field = TraceItX::class.java.getDeclaredField("_replaySession").apply { isAccessible = true }
        val deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(5)
        while (field.get(TraceItX) == null && System.nanoTime() < deadline) Thread.sleep(5)
        assertNotNull("native start must finish before capture", field.get(TraceItX))
        com.traceitx.crash.CrashReporter.configure(reactContext)
        crashStorage.install()
        crashSidecar().delete()
        module.__drainRequester = {}
    }

    private fun persistedCrashEnvelope(): org.json.JSONObject {
        val outbox = crashStorage.outbox()
        assertEquals(1, kotlinx.coroutines.runBlocking { outbox.count() })
        val entry = kotlinx.coroutines.runBlocking { outbox.hydrate() }.single()
        kotlinx.coroutines.runBlocking { outbox.drain { true } }
        assertTrue(entry.attachmentRefs.isEmpty())
        return org.json.JSONObject(String(entry.envelopeBytes))
    }

    @Test
    fun reportCrash_failedStorage_returnsFalse_withoutDrain() = withIsolatedCrashState {
        configureCrashCore()
        var drains = 0
        module.__drainRequester = { drains++ }
        crashStorage.install(fail = true)
        assertTrue(crashSidecar().mkdirs())
        val blocker = java.io.File(crashSidecar(), "blocker").apply { writeText("preserve") }
        try {
            assertFalse(module.reportCrash("{}"))
            assertEquals(0, drains)
            assertEquals("preserve", blocker.readText())
        } finally {
            blocker.delete()
            crashSidecar().delete()
        }
    }

    @Test
    fun reportCrash_drainSchedulingFailure_doesNotUndoAcceptance() = withIsolatedCrashState {
        configureCrashCore()
        module.__drainRequester = { throw IllegalStateException("scheduler unavailable") }
        assertTrue(module.reportCrash("{}"))
        assertEquals("error", persistedCrashEnvelope().getString("source"))
    }

    // ------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------

    private fun rect(x: Double = 0.0, y: Double = 0.0, w: Double = 0.0, h: Double = 0.0) =
        VRect(h = h, w = w, x = x, y = y)

}
