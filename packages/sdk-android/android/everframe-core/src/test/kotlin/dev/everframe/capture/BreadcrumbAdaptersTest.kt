// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Task 11 — BreadcrumbAdapters (console/network/lifecycle/error dual-writes +
// installers). Robolectric is used throughout (single RunWith for the whole
// class) because LifecycleBreadcrumbObserver.install() touches
// ProcessLifecycleOwner.get(), which needs a real Application instance —
// mirrors RelayWSClientTest's rationale. SharedData.init(context) is required
// for every path that reaches RedactionEngine (all `sharedBreadcrumbBuffer.add`
// calls) — mirrors BreadcrumbRingBufferTest / EverframeInterceptorTest setUp.
package dev.everframe.capture

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.test.core.app.ApplicationProvider
import android.content.Context
import dev.everframe.Everframe
import dev.everframe.config.BreadcrumbsConfigWire
import dev.everframe.config.CaptureConfig
import dev.everframe.config.EverframeConfig
import dev.everframe.crash.CrashReporter
import dev.everframe.okhttp.addEverframeInterceptor
import dev.everframe.protocol.generated.Breadcrumb
import dev.everframe.protocol.generated.BreadcrumbKind
import dev.everframe.protocol.generated.Level
import dev.everframe.shared.SharedData
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class BreadcrumbAdaptersTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()

    /** Captured before each test's mutation so tearDown can restore it — the
     *  default uncaught-exception handler is process-global and must not leak
     *  across test classes sharing this JVM worker. */
    private var originalUncaughtHandler: Thread.UncaughtExceptionHandler? = null

    private fun resetBreadcrumbState() {
        sharedBreadcrumbBuffer.applyConfig(null)
        sharedBreadcrumbBuffer.clear()
    }

    private lateinit var crashOutbox: dev.everframe.outbox.JSONLOutbox

    private fun sidecarFile() = File(File(context.cacheDir, "dev.everframe"), "crash-outbox.jsonl")

    /**
     * CrashReporter takes only a context now: it reads the config out of the
     * crash-entry snapshot rather than caching a second copy of its own, so the
     * config a crash test wants exercised has to be installed on Everframe.
     * `__setConfigForTesting` sets `_config` under `stateLock` without running
     * start()'s heavy-init tail — this suite flips `captureGate` directly for
     * the same reason. tearDown clears it (process-global).
     */
    private fun configureCrashReporter(config: EverframeConfig) {
        CrashReporter.configure(context)
        Everframe.__setConfigForTesting(config)
    }

    @Before
    fun setUp() {
        SharedData.init(context)
        originalUncaughtHandler = Thread.getDefaultUncaughtExceptionHandler()
        resetBreadcrumbState()
        sharedLogBuffer.clear()
        sharedNetworkBuffer.clear()
        Everframe.captureGate = true
        LogCapture.uninstall()
        LifecycleBreadcrumbObserver.__resetForTesting()
        ErrorBreadcrumbAdapter.__resetForTesting()
        CrashReporter.__resetForTesting()
        val dir = kotlin.io.path.createTempDirectory("adapter-crash").toFile()
        val keys = dev.everframe.outbox.JceTestOutboxKeyProvider()
        val ops = dev.everframe.outbox.JvmOutboxFileOps()
        crashOutbox = dev.everframe.outbox.JSONLOutbox(File(dir, "outbox.jsonl"), keys, ops)
        CrashReporter.sidecarFactory = { dev.everframe.outbox.CrashSidecar(File(dir, "crash-outbox.jsonl"), keys, ops) }
        sidecarFile().delete()
    }

    @After
    fun tearDown() {
        LogCapture.uninstall()
        resetBreadcrumbState()
        sharedLogBuffer.clear()
        sharedNetworkBuffer.clear()
        Everframe.captureGate = false
        // Process-global like captureGate — leaking a config bleeds into other
        // suites sharing this JVM worker.
        Everframe.__setConfigForTesting(null)
        LifecycleBreadcrumbObserver.__resetForTesting()
        ErrorBreadcrumbAdapter.__resetForTesting()
        CrashReporter.__resetForTesting()
        sidecarFile().delete()
        Thread.setDefaultUncaughtExceptionHandler(originalUncaughtHandler)
    }

    private fun matchingCrumb(message: String): Breadcrumb? {
        sharedBreadcrumbBuffer.freeze()
        return sharedBreadcrumbBuffer.takeFrozen()?.firstOrNull { it.message == message }
    }

    private fun firstCrumbOfKind(kind: BreadcrumbKind): Breadcrumb? {
        sharedBreadcrumbBuffer.freeze()
        return sharedBreadcrumbBuffer.takeFrozen()?.firstOrNull { it.kind == kind }
    }

    // ==================== Console ====================

    @Test
    fun `mapLevel maps INFO WARN ERROR ASSERT DEBUG VERBOSE and falls back to Info`() {
        assertEquals(Level.Info, ConsoleBreadcrumbAdapter.mapLevel("INFO"))
        assertEquals(Level.Warn, ConsoleBreadcrumbAdapter.mapLevel("WARN"))
        assertEquals(Level.Error, ConsoleBreadcrumbAdapter.mapLevel("ERROR"))
        // ASSERT (Log.wtf(), priority 7) is Android's highest severity, strictly
        // more severe than ERROR, so it promotes to Level.Error (cross-SDK parity
        // with iOS's "fault" -> .error promotion).
        assertEquals(Level.Error, ConsoleBreadcrumbAdapter.mapLevel("ASSERT"))
        assertEquals(Level.Debug, ConsoleBreadcrumbAdapter.mapLevel("DEBUG"))
        assertEquals(Level.Debug, ConsoleBreadcrumbAdapter.mapLevel("VERBOSE"))
        // Any genuinely-unrecognized string falls back to Info (never dropped).
        assertEquals(Level.Info, ConsoleBreadcrumbAdapter.mapLevel("totally-unknown"))
    }

    @Test
    fun `dualWrite lands one console crumb with the mapped level`() {
        val marker = "direct-${UUID.randomUUID()}"
        ConsoleBreadcrumbAdapter.dualWrite(rawLevel = "WARN", message = marker)
        val crumb = matchingCrumb(marker)
        assertEquals(BreadcrumbKind.Console, crumb?.kind)
        assertEquals(Level.Warn, crumb?.level)
    }

    @Test
    fun `system_out_println_push_site_lands_console_crumb_with_info_level`() {
        LogCapture.install()
        try {
            val marker = "console-out-${UUID.randomUUID()}"
            println(marker)
            val crumb = matchingCrumb(marker)
            assertNotNull("expected a console crumb for the System.out tee push site", crumb)
            assertEquals(BreadcrumbKind.Console, crumb?.kind)
            assertEquals(Level.Info, crumb?.level)
        } finally {
            LogCapture.uninstall()
        }
    }

    @Test
    fun `system_err_println_push_site_lands_console_crumb_with_error_level`() {
        LogCapture.install()
        try {
            val marker = "console-err-${UUID.randomUUID()}"
            System.err.println(marker)
            val crumb = matchingCrumb(marker)
            assertNotNull("expected a console crumb for the System.err tee push site", crumb)
            assertEquals(BreadcrumbKind.Console, crumb?.kind)
            assertEquals(Level.Error, crumb?.level)
        } finally {
            LogCapture.uninstall()
        }
    }

    @Test
    fun `timber_tree_push_site_lands_console_crumb_with_mapped_level`() {
        LogCapture.install()
        try {
            val marker = "console-timber-${UUID.randomUUID()}"
            timber.log.Timber.tag("UnitTest").w(marker)
            val crumb = matchingCrumb(marker)
            assertNotNull("expected a console crumb for the Timber tree push site", crumb)
            assertEquals(BreadcrumbKind.Console, crumb?.kind)
            assertEquals(Level.Warn, crumb?.level)
        } finally {
            LogCapture.uninstall()
        }
    }

    @Test
    fun `console dual-write is a no-op when console kind is disabled`() {
        sharedBreadcrumbBuffer.applyConfig(
            BreadcrumbsConfigWire(
                enabled = true, kinds = listOf("network"), maxCount = 10, byteBudget = 16384, consoleEntryCap = 1024,
            ),
        )
        val marker = "disabled-console-${UUID.randomUUID()}"
        ConsoleBreadcrumbAdapter.dualWrite(rawLevel = "INFO", message = marker)
        assertNull(matchingCrumb(marker))
    }

    // ==================== Network ====================

    @Test
    fun `map success level thresholds mirror web statusLevel`() {
        val ok = NetworkBreadcrumbAdapter.map("GET", "https://x.test/a", 200, 12L)
        assertEquals("GET https://x.test/a 200", ok.message)
        assertEquals(Level.Info, ok.level)

        val notFound = NetworkBreadcrumbAdapter.map("GET", "https://x.test/a", 404, 5L)
        assertEquals(Level.Warn, notFound.level)

        val serverError = NetworkBreadcrumbAdapter.map("GET", "https://x.test/a", 500, 5L)
        assertEquals(Level.Error, serverError.level)

        val failed = NetworkBreadcrumbAdapter.map("POST", "https://x.test/b", null, 3L)
        assertEquals("POST https://x.test/b failed", failed.message)
        assertEquals(Level.Error, failed.level)
        assertEquals(JsonNull, failed.data["status"])
        assertEquals("https://x.test/b", (failed.data["url"] as? JsonPrimitive)?.content)
    }

    @Test
    fun `dualWrite lands one network crumb from an Entry`() {
        val entry = NetworkRingBuffer.Entry(
            timestamp = 0L, method = "GET", url = "https://x.test/ping", status = 200, durationMs = 7L,
            requestHeaders = emptyMap(), responseHeaders = emptyMap(), errorMessage = null,
        )
        NetworkBreadcrumbAdapter.dualWrite(entry)
        val crumb = firstCrumbOfKind(BreadcrumbKind.Network)
        assertEquals("GET https://x.test/ping 200", crumb?.message)
        assertEquals(Level.Info, crumb?.level)
    }

    @Test
    fun `successful interceptor call lands a network crumb`() {
        val server = MockWebServer()
        server.start()
        try {
            server.enqueue(MockResponse().setResponseCode(200).setBody("ok"))
            val client = OkHttpClient.Builder().addEverframeInterceptor().build()
            client.newCall(Request.Builder().url(server.url("/ping")).build()).execute().close()

            val crumb = firstCrumbOfKind(BreadcrumbKind.Network)
            assertNotNull("expected a network crumb from the success push site", crumb)
            assertTrue(crumb!!.message.startsWith("GET"))
            assertTrue(crumb.message.endsWith(" 200"))
            assertEquals(Level.Info, crumb.level)
            assertEquals("200", (crumb.data?.get("status") as? JsonPrimitive)?.content)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `IOException interceptor call lands a failed network crumb and still rethrows`() {
        val server = MockWebServer()
        server.start()
        val url = server.url("/dead")
        server.shutdown() // guaranteed transport failure

        val client = OkHttpClient.Builder().addEverframeInterceptor().build()
        var caught: IOException? = null
        try {
            client.newCall(Request.Builder().url(url).build()).execute().close()
            fail("expected IOException to propagate")
        } catch (e: IOException) {
            caught = e
        }
        assertNotNull("interceptor must re-throw the IOException", caught)

        val crumb = firstCrumbOfKind(BreadcrumbKind.Network)
        assertNotNull("expected a network crumb from the IOException push site", crumb)
        assertTrue(crumb!!.message.endsWith("failed"))
        assertEquals(Level.Error, crumb.level)
        assertEquals(JsonNull, crumb.data?.get("status"))
    }

    @Test
    fun `network dual-write is a no-op when network kind is disabled`() {
        sharedBreadcrumbBuffer.applyConfig(
            BreadcrumbsConfigWire(
                enabled = true, kinds = listOf("console"), maxCount = 10, byteBudget = 16384, consoleEntryCap = 1024,
            ),
        )
        val entry = NetworkRingBuffer.Entry(
            timestamp = 0L, method = "GET", url = "https://x.test/ping", status = 200, durationMs = 7L,
            requestHeaders = emptyMap(), responseHeaders = emptyMap(), errorMessage = null,
        )
        NetworkBreadcrumbAdapter.dualWrite(entry)
        assertEquals(0, sharedBreadcrumbBuffer.size)
    }

    // ==================== Lifecycle ====================

    private class FakeLifecycleOwner : LifecycleOwner {
        private val registry = LifecycleRegistry(this).apply { currentState = Lifecycle.State.STARTED }
        override val lifecycle: Lifecycle = registry
    }

    @Test
    fun `onStart adds a foreground lifecycle crumb`() {
        LifecycleBreadcrumbObserver.onStart(FakeLifecycleOwner())
        val crumb = firstCrumbOfKind(BreadcrumbKind.Lifecycle)
        assertEquals("foreground", crumb?.message)
        assertEquals("foreground", (crumb?.data?.get("state") as? JsonPrimitive)?.content)
    }

    @Test
    fun `onStop adds a background lifecycle crumb`() {
        LifecycleBreadcrumbObserver.onStop(FakeLifecycleOwner())
        val crumb = firstCrumbOfKind(BreadcrumbKind.Lifecycle)
        assertEquals("background", crumb?.message)
        assertEquals("background", (crumb?.data?.get("state") as? JsonPrimitive)?.content)
    }

    @Test
    fun `install is idempotent and does not throw`() {
        assertFalse(LifecycleBreadcrumbObserver.installedForTesting())
        LifecycleBreadcrumbObserver.install()
        assertTrue(LifecycleBreadcrumbObserver.installedForTesting())
        // Second call must be a no-op — no crash, no duplicate registration attempt.
        LifecycleBreadcrumbObserver.install()
        assertTrue(LifecycleBreadcrumbObserver.installedForTesting())
    }

    // ==================== Error ====================

    @Test
    fun `install chains previous handler and handle fires both crumb and sentinel`() {
        val sentinelCalled = AtomicBoolean(false)
        val sentinelThread = AtomicReference<Thread?>(null)
        val sentinel = Thread.UncaughtExceptionHandler { t, _ ->
            sentinelCalled.set(true)
            sentinelThread.set(t)
        }
        Thread.setDefaultUncaughtExceptionHandler(sentinel)

        ErrorBreadcrumbAdapter.install()
        assertSame(sentinel, ErrorBreadcrumbAdapter.previousHandlerForTesting())

        val throwable = RuntimeException("boom-${UUID.randomUUID()}")
        val thread = Thread.currentThread()
        ErrorBreadcrumbAdapter.handle(thread, throwable)

        assertTrue("sentinel previous handler must still fire", sentinelCalled.get())
        assertSame(thread, sentinelThread.get())

        val crumb = firstCrumbOfKind(BreadcrumbKind.Error)
        assertNotNull("expected an error crumb", crumb)
        assertEquals(throwable.message, crumb?.message)
        assertEquals(Level.Error, crumb?.level)
        assertEquals(throwable.javaClass.name, (crumb?.data?.get("name") as? JsonPrimitive)?.content)
        assertNotNull(crumb?.data?.get("stackDigest"))
    }

    @Test
    fun `handle falls back to the exception class name when message is null`() {
        Thread.setDefaultUncaughtExceptionHandler(Thread.UncaughtExceptionHandler { _, _ -> })
        ErrorBreadcrumbAdapter.install()
        val throwable = RuntimeException()
        ErrorBreadcrumbAdapter.handle(Thread.currentThread(), throwable)
        val crumb = firstCrumbOfKind(BreadcrumbKind.Error)
        assertEquals(throwable.javaClass.name, crumb?.message)
    }

    @Test
    fun `install is idempotent, does not re-chain on second call`() {
        val sentinel = Thread.UncaughtExceptionHandler { _, _ -> }
        Thread.setDefaultUncaughtExceptionHandler(sentinel)
        ErrorBreadcrumbAdapter.install()
        val handlerAfterFirst = Thread.getDefaultUncaughtExceptionHandler()

        ErrorBreadcrumbAdapter.install()
        assertSame(handlerAfterFirst, Thread.getDefaultUncaughtExceptionHandler())
        assertSame(sentinel, ErrorBreadcrumbAdapter.previousHandlerForTesting())
    }

    @Test
    fun `error dual-write is a no-op when error kind is disabled but sentinel still fires`() {
        sharedBreadcrumbBuffer.applyConfig(
            BreadcrumbsConfigWire(
                enabled = true, kinds = listOf("console"), maxCount = 10, byteBudget = 16384, consoleEntryCap = 1024,
            ),
        )
        val sentinelCalled = AtomicBoolean(false)
        Thread.setDefaultUncaughtExceptionHandler(Thread.UncaughtExceptionHandler { _, _ -> sentinelCalled.set(true) })
        ErrorBreadcrumbAdapter.install()

        ErrorBreadcrumbAdapter.handle(Thread.currentThread(), RuntimeException("gated-out"))

        assertNull(firstCrumbOfKind(BreadcrumbKind.Error))
        assertTrue("chained handler must still fire even when the error kind is gated off", sentinelCalled.get())
    }

    // ==================== Install orchestrator ====================

    @Test
    fun `BreadcrumbAdapters install wires both lifecycle and error adapters`() {
        Thread.setDefaultUncaughtExceptionHandler(null)
        assertFalse(LifecycleBreadcrumbObserver.installedForTesting())

        BreadcrumbAdapters.install(context)

        assertTrue(LifecycleBreadcrumbObserver.installedForTesting())
        assertNotNull(
            "uncaught exception handler must be installed",
            Thread.getDefaultUncaughtExceptionHandler(),
        )
    }

    // ==================== Task 10: crash-report hook regression ====================
    //
    // ErrorBreadcrumbAdapter.handle gained a CrashReporter.captureThrowable
    // call (its own txGuardVoid, between the crumb block and the chained
    // previousHandler call). These regressions pin: (a) the error crumb's
    // message/data shape is unchanged, (b) the chained handler still fires
    // exactly once and LAST (after the crash persist), and (c) the sidecar
    // is gated by CaptureConfig.crash while the crumb still lands regardless.

    @Test
    fun `handle still lands the same error crumb shape when CrashReporter is wired`() {
        configureCrashReporter(EverframeConfig(appId = "app", sdkKey = "sk"))
        Thread.setDefaultUncaughtExceptionHandler(Thread.UncaughtExceptionHandler { _, _ -> })
        ErrorBreadcrumbAdapter.install()

        val throwable = RuntimeException("boom-${UUID.randomUUID()}")
        ErrorBreadcrumbAdapter.handle(Thread.currentThread(), throwable)

        val crumb = firstCrumbOfKind(BreadcrumbKind.Error)
        assertNotNull("expected an error crumb", crumb)
        assertEquals(throwable.message, crumb?.message)
        assertEquals(Level.Error, crumb?.level)
        assertEquals(throwable.javaClass.name, (crumb?.data?.get("name") as? JsonPrimitive)?.content)
        assertNotNull(crumb?.data?.get("stackDigest"))
    }

    @Test
    fun `handle chains previousHandler exactly once and LAST, after the crash persist`() {
        configureCrashReporter(EverframeConfig(appId = "app", sdkKey = "sk"))
        val callCount = AtomicBoolean(false)
        var sidecarExistedWhenChainRan = false
        val previous = Thread.UncaughtExceptionHandler { _, _ ->
            // If the crash hook runs before the chain call (as required), the
            // sidecar file must already exist by the time this fires.
            sidecarExistedWhenChainRan = kotlinx.coroutines.runBlocking { crashOutbox.hydrate().size == 1 }
            assertFalse("previousHandler must fire exactly once", callCount.getAndSet(true))
        }
        Thread.setDefaultUncaughtExceptionHandler(previous)
        ErrorBreadcrumbAdapter.install()

        ErrorBreadcrumbAdapter.handle(Thread.currentThread(), RuntimeException("chain-order-${UUID.randomUUID()}"))

        assertTrue("previousHandler must have fired", callCount.get())
        assertTrue("crash sidecar must be written before the chained handler runs", sidecarExistedWhenChainRan)
    }

    @Test
    fun `sidecar is not created when CaptureConfig crash is false, but the crumb still lands`() {
        configureCrashReporter(
            EverframeConfig(appId = "app", sdkKey = "sk", capture = CaptureConfig(crash = false)),
        )
        Thread.setDefaultUncaughtExceptionHandler(Thread.UncaughtExceptionHandler { _, _ -> })
        ErrorBreadcrumbAdapter.install()

        val throwable = RuntimeException("gated-crash-${UUID.randomUUID()}")
        ErrorBreadcrumbAdapter.handle(Thread.currentThread(), throwable)

        assertTrue("encrypted queue must stay empty when capture.crash is false", kotlinx.coroutines.runBlocking { crashOutbox.hydrate().isEmpty() })
        val crumb = firstCrumbOfKind(BreadcrumbKind.Error)
        assertNotNull("crumb must still land even when crash capture is off", crumb)
        assertEquals(throwable.message, crumb?.message)
    }
}
