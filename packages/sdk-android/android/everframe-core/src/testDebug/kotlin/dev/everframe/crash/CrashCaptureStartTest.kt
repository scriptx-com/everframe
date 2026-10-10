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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
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
    /** While set, the OS-exit arm's journal write waits here, holding the recovery controller's lock. */
    @Volatile private var holdArm: CountDownLatch? = null
    private val armHeld = CountDownLatch(1)
    private val journalOps = object : OutboxFileOps by JvmOutboxFileOps() {
        override fun syncFile(file: java.io.File) {
            val gate = holdArm
            if (gate != null && Thread.currentThread().stackTrace.any { it.className.endsWith("AndroidNativeRecovery") && it.methodName == "arm" }) {
                armHeld.countDown(); gate.await(10, TimeUnit.SECONDS)
            }
            JvmOutboxFileOps().syncFile(file)
        }
    }

    private class Platform(override val pid: Int) : AndroidNativeExitPlatform {
        override val apiLevel = android.os.Build.VERSION.SDK_INT
        override val processName = "dev.everframe.crashdefault"
        val registrations = ArrayList<ByteArray?>()
        var exits = emptyList<AndroidNativeExit>()
        @Volatile var beforeHistory: () -> Unit = {}
        override fun history(): List<AndroidNativeExit> { beforeHistory(); return exits }
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
            fun store(name: String) = OutboxStore(File(root, name), keys.getValue(name), journalOps, 8, 2L * 1024 * 1024)
            AndroidNativeRecoveryController({ AndroidNativeRecovery(store("contexts"), store("prepared")) }, platform)
        }
        freshOutbox()
    }

    @After fun tearDown() {
        holdArm?.countDown()
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

    @Test fun `a kill in a secondary process keeps the default process's OS exit evidence`() {
        start(); awaitReady()
        val crashed = crashAndRelaunch()
        ShadowApplication.setProcessName("${context.packageName}:player")
        try {
            start() // a secondary process selects no mechanism and launches no arming work
            assertFalse("a secondary process must not arm OS exit capture", Everframe.isNativeCrashCaptureReady())
            assertTrue("a secondary process registered an OS token", platform.registrations.isEmpty())
            Everframe.kill()
        } finally {
            // The secondary process's in-memory commands die with it.
            AndroidNativeCrashRuntime.__resetForTesting()
            ShadowApplication.setProcessName(context.packageName)
        }
        freshOutbox()
        start(); awaitReady()
        assertEquals("the secondary kill erased the default process's evidence", listOf(crashed), nativeReports().map { it.reportId })
    }

    @Test fun `a repeated start while the previous crash is being recovered still reports it once`() {
        start(); awaitReady()
        val crashed = crashAndRelaunch()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        platform.beforeHistory = { entered.countDown(); release.await(5, TimeUnit.SECONDS) }
        Everframe.start(context, config) // the relaunched process's first start: recovery waits in history()
        try {
            assertTrue("recovery never read exit history", entered.await(5, TimeUnit.SECONDS))
            platform.beforeHistory = {}
            start() // a second start, e.g. a release-health user switch, lands mid-recovery
        } finally { release.countDown() }
        awaitReady()
        waitUntil("the previous process's crash was never reported") { nativeReports().isNotEmpty() }
        Thread.sleep(200)
        assertEquals(listOf(crashed), nativeReports().map { it.reportId })
    }

    @Test fun `a replacement start and the readiness query never wait for an in-flight arm`() {
        holdArm = CountDownLatch(1)
        Everframe.start(context, config)
        try {
            assertTrue("the arm never reached its journal write", armHeld.await(5, TimeUnit.SECONDS))
            val readiness = CountDownLatch(1)
            thread { Everframe.isNativeCrashCaptureReady(); readiness.countDown() }
            assertTrue("isNativeCrashCaptureReady waited for the arm's journal IO", readiness.await(2, TimeUnit.SECONDS))
            val restarted = CountDownLatch(1)
            thread { Everframe.start(context, crashOff); restarted.countDown() }
            assertTrue("a replacement start waited for the earlier arm's journal IO", restarted.await(2, TimeUnit.SECONDS))
            assertFalse(Everframe.isNativeCrashCaptureReady())
        } finally { holdArm?.countDown(); holdArm = null }
    }

    @Test fun `a JVM crash tags the OS token so a low-memory kill of that process is not a second issue`() {
        val crashDir = createTempDirectory(storage.toPath(), "crash").toFile()
        CrashReporter.sidecarFactory = { CrashSidecar(File(crashDir, "crash-outbox.jsonl"), JceTestOutboxKeyProvider(), JvmOutboxFileOps()) }
        try {
            start(); awaitReady()
            val token = platform.registrations.last()!!
            // A Java OOM: the uncaught-exception handler admits the crash...
            CrashReporter.captureThrowable(Thread.currentThread(), OutOfMemoryError("Java heap space"))
            assertArrayEquals(token + AndroidNativeRecovery.JVM_FATAL_SUFFIX, platform.registrations.last())
            // ...then lmkd ends the process while it is still in the foreground.
            val crashed = platform
            AndroidNativeCrashRuntime.__resetForTesting()
            platform = Platform(crashed.pid + 1).apply {
                exits = listOf(AndroidNativeExit(crashed.pid, crashed.processName, System.currentTimeMillis(), 3,
                    crashed.registrations.last(), { null }, 0, importance = 100))
            }
            start(); awaitReady()
            assertTrue("the JVM crash already reported this death", nativeReports().isEmpty())
        } finally { CrashReporter.sidecarFactory = { CrashSidecar(it) } }
    }

    @Test fun `start never reads the process name on the caller's thread`() {
        val readers = java.util.concurrent.ConcurrentLinkedQueue<Thread>()
        AppProcess.__readForTesting = { readers += Thread.currentThread() }
        try {
            start(); awaitReady()
            assertTrue("the default-process check never ran", readers.isNotEmpty())
            assertFalse("start() read the process name on the caller's thread", Thread.currentThread() in readers)
        } finally { AppProcess.__readForTesting = null }
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
