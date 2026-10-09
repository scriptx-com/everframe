// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// DEBUG-ONLY unit test source set: assigns `EndpointOverride.current` (a `val` in release)
// so every start talks to a local server and leaves no blocked work in the SDK scope.
package dev.everframe.health

import android.content.Context
import android.content.ContextWrapper
import android.os.Looper
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.testing.TestLifecycleOwner
import androidx.test.core.app.ApplicationProvider
import dev.everframe.Everframe
import dev.everframe.config.CaptureConfig
import dev.everframe.config.EndpointOverride
import dev.everframe.config.EverframeConfig
import dev.everframe.config.ReleaseHealthConfig
import dev.everframe.crash.AndroidNativeCrashRuntime
import dev.everframe.crash.AndroidNativeExit
import dev.everframe.crash.AndroidNativeExitPlatform
import dev.everframe.crash.AndroidNativeRecovery
import dev.everframe.crash.AndroidNativeRecoveryController
import dev.everframe.crash.AndroidNativeSignalFiles
import dev.everframe.crash.AndroidNativeSignalProducer
import dev.everframe.crash.AndroidNativeSignalRuntime
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
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowApplication
import java.io.File
import java.util.Collections
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.SecretKey
import kotlin.concurrent.thread
import kotlin.io.path.createTempDirectory

/** Process lifecycle transitions through the SDK's own release-health and native collector runtimes. */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [34])
class ReleaseHealthRuntimeTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private val config = EverframeConfig(appId = "health-runtime", sdkKey = "txx_live_health_runtime_test",
        capture = CaptureConfig(logs = false), releaseHealth = ReleaseHealthConfig("native-build-A"))
    /** Stands in for the Keystore: it outlives a simulated process death. */
    private val keystore: MutableMap<String, SecretKey> = Collections.synchronizedMap(HashMap())
    private val nativeKeys = mapOf("contexts" to JceTestOutboxKeyProvider(), "prepared" to JceTestOutboxKeyProvider())
    private val signalKeys = JceTestOutboxKeyProvider()
    private val outboxField = Everframe::class.java.getDeclaredField("sharedOutbox").apply { isAccessible = true }
    private val storage = createTempDirectory("everframe-health-runtime").toFile()
    /** Every release-health record offered to the server; it answers 503, so records stay queued. */
    private val sent = ConcurrentLinkedQueue<JsonObject>()
    private val platform = Platform()
    private val producer = SignalProducer()
    private lateinit var server: MockWebServer
    private lateinit var lifecycle: TestLifecycleOwner
    private lateinit var testThread: Thread
    @Volatile private var hold: CountDownLatch? = null
    private val held = CountDownLatch(1)

    private class Platform : AndroidNativeExitPlatform {
        override val apiLevel = 34
        override val pid = 4242
        override val processName = "dev.everframe.healthruntime"
        /** Every OS state-summary write, in order; null clears the token. */
        val registrations: MutableList<ByteArray?> = Collections.synchronizedList(ArrayList())
        override fun history() = emptyList<AndroidNativeExit>()
        override fun setStateSummary(value: ByteArray?) { registrations.add(value) }
    }

    private inner class SignalProducer : AndroidNativeSignalProducer {
        @Volatile var armed = false
        val pauses = AtomicInteger()
        override fun generation() = 0L
        override fun arm(epoch: String, key: ByteArray, generation: Long): Boolean {
            AndroidNativeSignalFiles(context.noBackupFilesDir, JvmOutboxFileOps()).prepare(epoch); armed = true; return true
        }
        override fun pause() { pauses.incrementAndGet(); armed = false }
        override fun revoke(): Boolean { armed = false; return true }
    }

    /** Health journal IO. While [hold] is set, IO off the test thread waits until it opens. */
    private val healthOps = object : OutboxFileOps {
        private val ops = JvmOutboxFileOps()
        override fun syncFile(file: File) { pause(); ops.syncFile(file) }
        override fun renameAtomic(from: File, to: File) { pause(); ops.renameAtomic(from, to) }
        override fun syncDirectory(dir: File) { pause(); ops.syncDirectory(dir) }
        private fun pause() {
            val gate = hold ?: return
            if (Thread.currentThread() === testThread) return
            held.countDown()
            gate.await(10, TimeUnit.SECONDS)
        }
    }

    @Before fun setUp() {
        testThread = Thread.currentThread()
        server = MockWebServer().apply {
            dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse = when {
                    request.path == "/api/ingest/release-health" -> {
                        sent += Json.parseToJsonElement(request.body.readUtf8()).jsonObject
                        MockResponse().setResponseCode(503).setBody("{}")
                    }
                    request.path!!.startsWith("/api/config") ->
                        MockResponse().setResponseCode(200).setBody("""{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0}""")
                    else -> MockResponse().setResponseCode(503).setBody("{}")
                }
            }
            start()
        }
        EndpointOverride.current = server.url("/").toString().trimEnd('/')
        SharedData.init(context)
        lifecycle = TestLifecycleOwner(Lifecycle.State.CREATED)
        ReleaseHealthRuntime.__resetForTesting()
        ReleaseHealthRuntime.__keysForTesting = JceTestOutboxKeyProvider(keystore)
        ReleaseHealthRuntime.__fileOpsForTesting = healthOps
        ReleaseHealthRuntime.__lifecycleOwnerForTesting = lifecycle
        AndroidNativeCrashRuntime.__resetForTesting()
        // Production owner shape: the OS context freezes the release-health ready pointer.
        AndroidNativeCrashRuntime.__controllerFactoryForTesting = { app ->
            val root = File(app.noBackupFilesDir, "dev.everframe/native-exit-v1")
            fun store(name: String) = OutboxStore(File(root, name), nativeKeys.getValue(name), JvmOutboxFileOps(), 8, 2L * 1024 * 1024)
            AndroidNativeRecoveryController({ AndroidNativeRecovery(store("contexts"), store("prepared")) }, platform,
                exposure = ReleaseHealthRuntime::readyPointer)
        }
        AndroidNativeSignalRuntime.__resetForTesting()
        AndroidNativeSignalRuntime.__keysForTesting = signalKeys
        AndroidNativeSignalRuntime.__fileOpsForTesting = JvmOutboxFileOps()
        AndroidNativeSignalRuntime.__producerForTesting = producer
        ShadowApplication.setProcessName(context.packageName)
        outboxField.set(null, JSONLOutbox(File(createTempDirectory(storage.toPath(), "outbox").toFile(), "outbox.jsonl"),
            keys = JceTestOutboxKeyProvider(), ops = JvmOutboxFileOps()))
    }

    @After fun tearDown() {
        hold?.countDown()
        Everframe.kill()
        // Later suites join every SDK-scope child; none of these sessions may outlive the test.
        runBlocking {
            withTimeout(5_000) {
                (ReleaseHealthRuntime.__pendingWorkForTesting() + Everframe.sdkScope.coroutineContext[Job]!!.children.toList()).joinAll()
            }
        }
        ReleaseHealthRuntime.__resetForTesting()
        ReleaseHealthRuntime.__keysForTesting = null
        ReleaseHealthRuntime.__fileOpsForTesting = null
        ReleaseHealthRuntime.__lifecycleOwnerForTesting = null
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

    /** Runs main-looper work posted from IO until [done] holds. */
    private fun idleUntil(message: String, done: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (!done() && System.nanoTime() < deadline) { shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(5) }
        assertTrue(message, done())
    }
    /** Waits for the lifecycle and delivery work the runtime has launched so far. */
    private fun settle() = runBlocking { withTimeout(5_000) { ReleaseHealthRuntime.__pendingWorkForTesting().joinAll() } }
    private fun start(host: Context = context, owner: TestLifecycleOwner = lifecycle) {
        Everframe.start(host, config)
        idleUntil("release health never installed its lifecycle observer") { owner.observerCount == 1 }
        settle()
    }
    private fun pointer() = ReleaseHealthRuntime.readyPointer(Everframe.currentStartEpochVolatile())
    private fun JsonObject.text(key: String) = getValue(key).jsonPrimitive.content
    private fun JsonObject.exposureId() = getValue("exposure").jsonObject.text("exposureId")
    private fun decoded(queue: OutboxStore) = queue.snapshotTokens().mapNotNull { queue.readIfPresent(it)?.entry }
        .map { it.reportId to Json.parseToJsonElement(it.envelopeBytes.toString(Charsets.UTF_8)).jsonObject }
    private fun records() = decoded(OutboxStore(File(context.noBackupFilesDir, "dev.everframe/release-health-v1"),
        JceTestOutboxKeyProvider(keystore), JvmOutboxFileOps(), 256, 1024 * 1024, maintenanceReserveBytes = 16 * 1024)).map { it.second }
    /** The OS context that the current state summary names. */
    private fun registeredContext(): JsonObject {
        val id = platform.registrations.last()!!.toString(Charsets.US_ASCII).removePrefix("everframe-native-v1:")
        return decoded(OutboxStore(File(context.noBackupFilesDir, "dev.everframe/native-exit-v1/contexts"),
            nativeKeys.getValue("contexts"), JvmOutboxFileOps(), 8, 2L * 1024 * 1024)).single { it.first == id }.second
    }
    private fun capsule() = decoded(OutboxStore(File(context.noBackupFilesDir, "dev.everframe/native-signal-v1/capsules"),
        signalKeys, JvmOutboxFileOps(), 8, 2L * 1024 * 1024)).single().second

    @Test fun `foreground entry keeps the OS context registered until the session context replaces it`() {
        start()
        assertFalse(Everframe.isReleaseHealthReady())
        Everframe.setNativeCrashRecoveryEnabled(true)
        idleUntil("native recovery never registered its context") { Everframe.isNativeCrashRecoveryReady() }
        assertFalse(registeredContext().containsKey("nativeExposure"))
        lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_START)
        assertNotNull("foreground entry cleared the OS exit token", platform.registrations.last())
        settle()
        val session = pointer()
        assertNotNull("the foreground session never became ready", session)
        assertTrue(Everframe.isReleaseHealthReady())
        assertEquals(session!!.toJson(), registeredContext()["nativeExposure"])
        assertTrue("the OS exit token was cleared during foreground entry", platform.registrations.none { it == null })
        assertTrue(Everframe.isNativeCrashRecoveryReady())
    }

    @Test fun `background clears the OS pointer before the session ends and keeps capturing without it`() {
        start()
        lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_START); settle()
        val session = pointer()!!
        Everframe.setNativeCrashRecoveryEnabled(true)
        idleUntil("native recovery never registered its context") { Everframe.isNativeCrashRecoveryReady() }
        assertEquals(session.toJson(), registeredContext()["nativeExposure"])
        lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        // Readiness and the OS token fall on the lifecycle callback, before any journal IO.
        assertFalse(Everframe.isReleaseHealthReady())
        assertNull("background left the session pointer registered", platform.registrations.last())
        settle()
        val end = records().single { it.text("phase") == "end" }
        assertEquals(session.exposureId, end.exposureId())
        assertEquals("background", end.text("endReason"))
        assertNotNull("background capture was never registered again", platform.registrations.last())
        assertFalse(registeredContext().containsKey("nativeExposure"))
        assertTrue(Everframe.isNativeCrashRecoveryReady())
    }

    @Test @Config(sdk = [30])
    fun `the API 30 signal handler stays armed at foreground entry and its capsule gains the session pointer`() {
        start()
        Everframe.setNativeSignalCaptureEnabled(true)
        idleUntil("signal capture never armed") { Everframe.isNativeSignalCaptureReady() }
        assertFalse(capsule().containsKey("nativeExposure"))
        val pauses = producer.pauses.get()
        lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_START)
        assertEquals("foreground entry paused the signal handler", pauses, producer.pauses.get())
        assertTrue(Everframe.isNativeSignalCaptureReady())
        settle()
        val session = pointer()
        assertNotNull("the foreground session never became ready", session)
        assertEquals(session!!.toJson(), capsule()["nativeExposure"])
        assertTrue(producer.armed); assertTrue(Everframe.isNativeSignalCaptureReady())
        lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        assertFalse(producer.armed); assertFalse(Everframe.isReleaseHealthReady())
        settle()
        assertFalse(capsule().containsKey("nativeExposure"))
        assertTrue(producer.armed); assertTrue(Everframe.isNativeSignalCaptureReady())
    }

    @Test fun `kill during the lifecycle work leaves no session, journal record or OS context behind`() {
        start()
        Everframe.setNativeCrashRecoveryEnabled(true)
        idleUntil("native recovery never registered its context") { Everframe.isNativeCrashRecoveryReady() }
        settle()
        hold = CountDownLatch(1)
        lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_START)
        assertTrue("the lifecycle work never reached the journal", held.await(5, TimeUnit.SECONDS))
        val killing = thread { Everframe.kill() }
        idleUntil("kill() never closed the capture gate") { !Everframe.captureGate }
        hold!!.countDown()
        idleUntil("kill() never returned") { !killing.isAlive }
        settle()
        assertFalse(Everframe.isReleaseHealthReady())
        assertNull(pointer())
        assertTrue("a killed session reached the journal", records().isEmpty())
        assertTrue("a killed session was offered for delivery", sent.isEmpty())
        assertNull("kill() left an OS context registered", platform.registrations.last())
    }

    @Test fun `kill erases the journal before it returns so a relaunch sends nothing captured before it`() {
        start()
        lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_START); settle()
        val killed = pointer()!!.exposureId
        assertTrue("the session start was never offered for delivery", sent.any { it.exposureId() == killed })
        // Journal IO off this thread now waits: a process that dies as kill() returns keeps
        // exactly the journal and keys that exist at that moment.
        hold = CountDownLatch(1)
        Everframe.kill()
        val image = File(storage, "relaunch")
        File(context.noBackupFilesDir, "dev.everframe/release-health-v1").copyRecursively(File(image, "dev.everframe/release-health-v1"))
        val survivingKeys = JceTestOutboxKeyProvider(synchronized(keystore) { HashMap(keystore) })
        hold!!.countDown()
        ReleaseHealthRuntime.__resetForTesting()
        ReleaseHealthRuntime.__keysForTesting = survivingKeys
        val foreground = TestLifecycleOwner(Lifecycle.State.STARTED)
        ReleaseHealthRuntime.__lifecycleOwnerForTesting = foreground
        sent.clear()
        val relaunched = object : ContextWrapper(context) {
            override fun getApplicationContext(): Context = this
            override fun getNoBackupFilesDir(): File = image
        }
        start(relaunched, foreground)
        assertTrue("the relaunch opened no session", Everframe.isReleaseHealthReady())
        assertTrue("the relaunch offered no session for delivery", sent.isNotEmpty())
        assertTrue("a record captured before kill() was sent after it", sent.none { it.exposureId() == killed })
    }
}
