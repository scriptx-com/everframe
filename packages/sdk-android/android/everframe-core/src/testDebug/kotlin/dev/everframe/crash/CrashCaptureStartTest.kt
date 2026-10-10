// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// DEBUG-ONLY unit test source set: EndpointOverride keeps every start on a local server.
package dev.everframe.crash

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.everframe.Everframe
import dev.everframe.config.CaptureConfig
import dev.everframe.config.EndpointOverride
import dev.everframe.config.EverframeConfig
import dev.everframe.outbox.*
import dev.everframe.shared.SharedData
import kotlinx.coroutines.Job
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowApplication
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import kotlin.io.path.createTempDirectory

/** A start with the default configuration arms crash capture with no further call. */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [34])
class CrashCaptureStartTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private val config = EverframeConfig(appId = "crash-default", sdkKey = "txx_live_crash_default_test",
        capture = CaptureConfig(logs = false))
    private val crashOff = config.copy(capture = config.capture.copy(crash = false))
    private val keys = mapOf("contexts" to JceTestOutboxKeyProvider(), "prepared" to JceTestOutboxKeyProvider())
    private val outboxField = Everframe::class.java.getDeclaredField("sharedOutbox").apply { isAccessible = true }
    private val storage = createTempDirectory("everframe-crash-default").toFile()
    private lateinit var outbox: JSONLOutbox
    private lateinit var server: MockWebServer
    private var platform = Platform(4242)

    private class Platform(override val pid: Int) : AndroidNativeExitPlatform {
        override val apiLevel = android.os.Build.VERSION.SDK_INT
        override val processName = "dev.everframe.crashdefault"
        val registrations = ArrayList<ByteArray?>()
        var exits = emptyList<AndroidNativeExit>()
        override fun history() = exits
        override fun setStateSummary(value: ByteArray?) { registrations.add(value) }
    }

    private inner class Producer(private val armResult: Boolean) : AndroidNativeSignalProducer {
        val arms = AtomicInteger()
        override fun generation() = 0L
        override fun arm(epoch: String, key: ByteArray, generation: Long): Boolean {
            arms.incrementAndGet()
            AndroidNativeSignalFiles(context.noBackupFilesDir, JvmOutboxFileOps()).prepare(epoch)
            return armResult
        }
        override fun pause() {}
        override fun revoke() = true
    }

    @Before fun setUp() {
        server = MockWebServer().apply {
            dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest) = if (request.path!!.startsWith("/api/config"))
                    MockResponse().setResponseCode(200).setBody("""{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0}""")
                else MockResponse().setResponseCode(503).setBody("{}")
            }
            start()
        }
        EndpointOverride.current = server.url("/").toString().trimEnd('/')
        SharedData.init(context)
        ShadowApplication.setProcessName(context.packageName)
        File(context.noBackupFilesDir, "dev.everframe").deleteRecursively()
        AndroidNativeCrashRuntime.__resetForTesting()
        AndroidNativeSignalRuntime.__resetForTesting()
        AndroidNativeCrashRuntime.__controllerFactoryForTesting = { app ->
            val root = File(app.noBackupFilesDir, "dev.everframe/native-exit-v1")
            fun store(name: String) = OutboxStore(File(root, name), keys.getValue(name), JvmOutboxFileOps(), 8, 2L * 1024 * 1024)
            AndroidNativeRecoveryController({ AndroidNativeRecovery(store("contexts"), store("prepared")) }, platform)
        }
        freshOutbox()
    }

    @After fun tearDown() {
        Everframe.kill()
        settle()
        AndroidNativeCrashRuntime.__controllerFactoryForTesting = null
        AndroidNativeCrashRuntime.__resetForTesting()
        AndroidNativeSignalRuntime.__resetForTesting()
        AndroidNativeSignalRuntime.__keysForTesting = null
        AndroidNativeSignalRuntime.__fileOpsForTesting = null
        AndroidNativeSignalRuntime.__producerForTesting = null
        outboxField.set(null, null)
        EndpointOverride.current = null
        server.shutdown()
        storage.deleteRecursively()
    }

    private fun freshOutbox() {
        outbox = JSONLOutbox(File(createTempDirectory(storage.toPath(), "outbox").toFile(), "outbox.jsonl"),
            keys = JceTestOutboxKeyProvider(), ops = JvmOutboxFileOps())
        outboxField.set(null, outbox)
    }

    /** Only after kill(): a running SDK keeps long-lived children in sdkScope. */
    private fun settle() = runBlocking {
        withTimeout(5_000) { Everframe.sdkScope.coroutineContext[Job]!!.children.toList().joinAll() }
    }

    private fun waitUntil(label: String, condition: () -> Boolean) {
        val deadline = System.nanoTime() + 5_000_000_000L
        while (!condition() && System.nanoTime() < deadline) Thread.sleep(5)
        assertTrue(label, condition())
    }

    private fun start(cfg: EverframeConfig = config) {
        val previous = Everframe._replaySession
        Everframe.start(context, cfg)
        val deadline = System.nanoTime() + 5_000_000_000L
        while ((Everframe._replaySession == null || Everframe._replaySession === previous) && System.nanoTime() < deadline) Thread.sleep(5)
    }

    private fun awaitReady() = waitUntil("crash capture never armed") { Everframe.isNativeCrashCaptureReady() }

    private fun installSignalSeams(armResult: Boolean = true): Producer {
        AndroidNativeSignalRuntime.__keysForTesting = JceTestOutboxKeyProvider()
        AndroidNativeSignalRuntime.__fileOpsForTesting = JvmOutboxFileOps()
        return Producer(armResult).also { AndroidNativeSignalRuntime.__producerForTesting = it }
    }

    /** Process death after registration: memory is lost; journals and the OS exit record remain. */
    private fun crashAndRelaunch(): String {
        val crashed = platform
        val token = crashed.registrations.last()!!
        val exit = AndroidNativeExit(crashed.pid, crashed.processName, System.currentTimeMillis(), 5, token) { null }
        AndroidNativeCrashRuntime.__resetForTesting()
        platform = Platform(crashed.pid + 1).apply { exits = listOf(exit) }
        return token.toString(Charsets.US_ASCII).removePrefix("everframe-native-v1:")
    }

    private fun nativeReports() = outbox.store.snapshotTokens().mapNotNull { outbox.store.readIfPresent(it)?.entry }.filter {
        Json.parseToJsonElement(it.envelopeBytes.toString(Charsets.UTF_8)).jsonObject["payload"]?.jsonObject
            ?.get("crash")?.jsonObject?.get("mechanism")?.jsonPrimitive?.content == "android-exit-info"
    }

    @Test fun `the default configuration arms OS exit capture with ANR diagnostics and no opt-in call`() {
        start(); awaitReady()
        assertTrue(platform.registrations.last()!!.toString(Charsets.US_ASCII).startsWith("everframe-native-v1:"))
        assertTrue("default capture must include ANR and exit diagnostics",
            AndroidNativeCrashRuntime.diagnosticsReady(Everframe.currentStartEpochVolatile()))
    }

    @Test fun `every start re-arms and recovers the previous process crash once`() {
        start(); awaitReady()
        val crashed = crashAndRelaunch()
        start(); awaitReady()
        assertEquals(listOf(crashed), nativeReports().map { it.reportId })
        start(); awaitReady()
        assertEquals("a repeated start must not admit the same crash again", listOf(crashed), nativeReports().map { it.reportId })
    }

    @Test fun `capture crash false arms nothing and keeps previous process evidence`() {
        start(); awaitReady()
        val crashed = crashAndRelaunch()
        start(crashOff) // a disabled start launches no arming work, so nothing below can still change
        assertFalse(Everframe.isNativeCrashCaptureReady())
        assertTrue("a disabled start registered an OS token", platform.registrations.isEmpty())
        assertTrue("a disabled start admitted previous-process evidence", nativeReports().isEmpty())
        start(); awaitReady()
        assertEquals("the next enabled start must still recover it", listOf(crashed), nativeReports().map { it.reportId })
    }

    @Test fun `a disabled restart drops readiness at once`() {
        start(); awaitReady()
        Everframe.start(context, crashOff)
        assertFalse(Everframe.isNativeCrashCaptureReady())
    }

    @Test fun `kill erases previous process evidence before the next start`() {
        start(); awaitReady()
        crashAndRelaunch()
        Everframe.kill()
        assertFalse(Everframe.isNativeCrashCaptureReady())
        freshOutbox()
        start(); awaitReady()
        assertTrue("killed evidence was admitted", nativeReports().isEmpty())
    }

    @Test @Config(sdk = [29])
    fun `API 29 without the native-crash module has no native mechanism`() {
        start() // no mechanism is selected, so no arming work is launched
        assertFalse(Everframe.isNativeCrashCaptureReady())
        assertTrue(platform.registrations.isEmpty())
    }

    @Test @Config(sdk = [29])
    fun `API 29 with the native-crash module arms the signal collector`() {
        val producer = installSignalSeams()
        start(); awaitReady()
        assertEquals(1, producer.arms.get())
        assertTrue("API 29 has no OS exit records", platform.registrations.isEmpty())
    }

    @Test @Config(sdk = [26])
    fun `API 26 start never fails on the process name probe`() {
        // Before API 28 the default-process check reads /proc/self/cmdline. A read that fails
        // (the JVM host has no /proc on macOS) must fail closed, never escape start().
        installSignalSeams()
        start()
        assertTrue("start must publish its configuration", Everframe.captureGate)
        assertFalse("a process that is not provably the default one arms nothing", Everframe.isNativeCrashCaptureReady())
    }

    @Test @Config(sdk = [30])
    fun `API 30 readiness waits for both the OS exit token and the signal collector`() {
        installSignalSeams(armResult = false)
        start()
        // The signal arm runs first, so once OS exit capture is ready the refusal has already happened.
        waitUntil("the OS exit token never registered") { AndroidNativeCrashRuntime.diagnosticsReady(Everframe.currentStartEpochVolatile()) }
        assertNotNull(platform.registrations.lastOrNull())
        assertFalse("a refused signal collector must keep readiness false", Everframe.isNativeCrashCaptureReady())
    }
}
