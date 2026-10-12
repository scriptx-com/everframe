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
import org.robolectric.shadows.ShadowLog
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
        capture = CaptureConfig(logs = false), releaseHealth = ReleaseHealthConfig())
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
        // Robolectric runs against the merged debug unit-test manifest (android:debuggable="true";
        // Config.NONE is ignored with includeAndroidResources). These tests model a release host.
        ReleaseHealthBuildGate.__debuggableForTesting = false
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
        ReleaseHealthBuildGate.__debuggableForTesting = null
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
    private fun start(host: Context = context, owner: TestLifecycleOwner = lifecycle, using: EverframeConfig = config) {
        Everframe.start(host, using)
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
    private fun exitReady() = dev.everframe.crash.AndroidNativeCrashRuntime.ready(Everframe.currentStartEpochVolatile())
    private fun signalReady() = dev.everframe.crash.AndroidNativeSignalRuntime.ready(Everframe.currentStartEpochVolatile())
    /** The OS context that the current state summary names. */
    private fun registeredContext(): JsonObject {
        val id = platform.registrations.last()!!.toString(Charsets.US_ASCII).removePrefix("everframe-native-v1:")
        return decoded(OutboxStore(File(context.noBackupFilesDir, "dev.everframe/native-exit-v1/contexts"),
            nativeKeys.getValue("contexts"), JvmOutboxFileOps(), 8, 2L * 1024 * 1024)).single { it.first == id }.second
    }
    private fun capsule() = decoded(OutboxStore(File(context.noBackupFilesDir, "dev.everframe/native-signal-v1/capsules"),
        signalKeys, JvmOutboxFileOps(), 8, 2L * 1024 * 1024)).single().second
    private val skipLine = "[everframe] Release health is off in debug builds."
    private fun skipLines() = ShadowLog.getLogsForTag("Everframe").map { it.msg }.filter { it == skipLine }
    /** The journal as a process that died the moment start() returned would find it on its next launch. */
    private fun recordsAfterProcessDeath(): List<JsonObject> {
        val source = File(context.noBackupFilesDir, "dev.everframe/release-health-v1")
        val image = File(createTempDirectory(storage.toPath(), "image").toFile(), "release-health-v1")
        if (source.exists()) source.copyRecursively(image)
        val survivingKeys = JceTestOutboxKeyProvider(synchronized(keystore) { HashMap(keystore) })
        return decoded(OutboxStore(image, survivingKeys, JvmOutboxFileOps(), 256, 1024 * 1024,
            maintenanceReserveBytes = 16 * 1024)).map { it.second }
    }
    /** Polls an image copied while the IO tail may still be deleting the journal: a copy that races the deletion is not done yet. */
    private fun imageIsEmptyOnceErasureFinishes() = runCatching { recordsAfterProcessDeath().isEmpty() }.getOrDefault(false)
    /** A foreground session whose start is journaled; afterwards journal IO off this thread waits on [hold]. */
    private fun recordThenHold() {
        start()
        idleUntil("native recovery never registered its context") { exitReady() }
        lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_START); settle()
        assertNotNull("the foreground session never became ready", pointer())
        assertTrue("the session start never reached the journal", records().isNotEmpty())
        hold = CountDownLatch(1)
    }
    /** With IO-thread erasure held, an empty image proves that start() erased on its own thread. */
    private fun assertOffStartErases(off: EverframeConfig) {
        recordThenHold()
        Everframe.start(context, off)
        assertTrue("start() returned before erasing undelivered health records", recordsAfterProcessDeath().isEmpty())
        hold!!.countDown()
        assertFalse(Everframe.isReleaseHealthReady())
        assertNull(pointer())
    }
    /** Null and a skipped debug build leave erasure to the IO tail: start() returns first, then the journal empties. */
    private fun assertOffStartErasesInBackground(off: EverframeConfig) {
        recordThenHold()
        Everframe.start(context, off)
        hold!!.countDown()
        idleUntil("the off start never erased undelivered health records") { imageIsEmptyOnceErasureFinishes() }
        assertFalse(Everframe.isReleaseHealthReady())
        assertNull(pointer())
    }

    @Test fun `the session carries the app version and build the package declares`() {
        shadowOf(context.packageManager).getInternalMutablePackageInfo(context.packageName).apply {
            versionName = "2.4.0"; longVersionCode = 412
        }
        start(using = config.copy(debugBuild = false))
        lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_START); settle()
        val session = pointer()!!
        assertEquals(dev.everframe.capture.AppRelease("2.4.0", "412", debug = false), session.app)
        val record = records().single()
        assertEquals(5, record.getValue("schemaVersion").jsonPrimitive.int)
        assertEquals(buildJsonObject { put("version", "2.4.0"); put("build", "412"); put("debug", false) },
            record.getValue("exposure").jsonObject.getValue("app"))
        assertEquals(session.toJson(), JsonObject(record.getValue("exposure").jsonObject.filterKeys { it in session.toJson().keys }))
    }
    @Test fun `the session of a debuggable host is marked debug unless debugBuild says otherwise`() {
        shadowOf(context.packageManager).getInternalMutablePackageInfo(context.packageName).apply {
            versionName = "2.4.0"; longVersionCode = 412
        }
        // Robolectric runs the merged debug manifest, so the host is debuggable here.
        start(using = config.copy(debugBuild = null, releaseHealth = ReleaseHealthConfig(includeDebugBuilds = true)))
        lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_START); settle()
        assertEquals(true, pointer()!!.app.debug)
        assertEquals(true, records().single().getValue("exposure").jsonObject.getValue("app").jsonObject.getValue("debug").jsonPrimitive.boolean)
    }
    @Test fun `foreground entry keeps the OS context registered until the session context replaces it`() {
        start()
        assertFalse(Everframe.isReleaseHealthReady())
        idleUntil("native recovery never registered its context") { exitReady() }
        assertFalse(registeredContext().containsKey("nativeExposure"))
        lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_START)
        assertNotNull("foreground entry cleared the OS exit token", platform.registrations.last())
        settle()
        val session = pointer()
        assertNotNull("the foreground session never became ready", session)
        assertTrue(Everframe.isReleaseHealthReady())
        assertEquals(session!!.toJson(), registeredContext()["nativeExposure"])
        assertTrue("the OS exit token was cleared during foreground entry", platform.registrations.none { it == null })
        assertTrue(exitReady())
    }

    @Test fun `background clears the OS pointer before the session ends and keeps capturing without it`() {
        start()
        lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_START); settle()
        val session = pointer()!!
        idleUntil("native recovery never registered its context") { exitReady() }
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
        assertTrue(exitReady())
    }

    @Test @Config(sdk = [30])
    fun `the API 30 signal handler stays armed at foreground entry and its capsule gains the session pointer`() {
        start()
        idleUntil("signal capture never armed") { signalReady() }
        assertFalse(capsule().containsKey("nativeExposure"))
        val pauses = producer.pauses.get()
        lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_START)
        assertEquals("foreground entry paused the signal handler", pauses, producer.pauses.get())
        assertTrue(signalReady())
        settle()
        val session = pointer()
        assertNotNull("the foreground session never became ready", session)
        assertEquals(session!!.toJson(), capsule()["nativeExposure"])
        assertTrue(producer.armed); assertTrue(signalReady())
        lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        assertFalse(producer.armed); assertFalse(Everframe.isReleaseHealthReady())
        settle()
        assertFalse(capsule().containsKey("nativeExposure"))
        assertTrue(producer.armed); assertTrue(signalReady())
    }

    @Test fun `kill during the lifecycle work leaves no session, journal record or OS context behind`() {
        start()
        idleUntil("native recovery never registered its context") { exitReady() }
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

    @Test fun `a configuration that leaves release health out records on a release host`() {
        start(using = EverframeConfig(appId = "health-runtime", sdkKey = "txx_live_health_runtime_test",
            capture = CaptureConfig(logs = false)))
        lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_START); settle()
        assertNotNull("the default configuration opened no session", pointer())
        assertTrue(Everframe.isReleaseHealthReady())
        assertEquals("start", records().single().text("phase"))
    }

    @Test fun `a null release health configuration is off and erases in the background`() =
        assertOffStartErasesInBackground(config.copy(releaseHealth = null))

    @Test fun `a disabled release health configuration is off and erases before start returns`() =
        assertOffStartErases(config.copy(releaseHealth = ReleaseHealthConfig(enabled = false)))

    @Test fun `a debuggable host is skipped, says so once per start and erases in the background`() {
        recordThenHold()
        ShadowLog.clear()
        ReleaseHealthBuildGate.__debuggableForTesting = true
        Everframe.start(context, config)
        hold!!.countDown()
        idleUntil("the skipped start never erased undelivered health records") { imageIsEmptyOnceErasureFinishes() }
        assertEquals(listOf(skipLine), skipLines())
        idleUntil("the skipped start left the previous lifecycle observer installed") { lifecycle.observerCount == 0 }
        lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_START); settle()
        assertFalse(Everframe.isReleaseHealthReady())
        assertNull(pointer())
        assertTrue("a skipped start journaled a session", records().isEmpty())
        Everframe.start(context, config)
        assertEquals("each skipped start says so exactly once", listOf(skipLine, skipLine), skipLines())
    }

    @Test fun `includeDebugBuilds records on a debuggable host`() {
        ShadowLog.clear()
        ReleaseHealthBuildGate.__debuggableForTesting = true
        start(using = config.copy(releaseHealth = ReleaseHealthConfig(includeDebugBuilds = true)))
        lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_START); settle()
        assertNotNull("includeDebugBuilds opened no session on a debuggable host", pointer())
        assertTrue(Everframe.isReleaseHealthReady())
        assertEquals("start", records().single().text("phase"))
        assertEquals(emptyList<String>(), skipLines())
    }

    @Test fun `debugBuild false records on a debuggable host and debugBuild true skips a release host`() {
        ShadowLog.clear()
        ReleaseHealthBuildGate.__debuggableForTesting = true
        start(using = config.copy(debugBuild = false))
        lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_START); settle()
        assertTrue("debugBuild = false did not keep release health on", Everframe.isReleaseHealthReady())
        assertEquals(false, pointer()!!.app.debug)
        assertEquals(emptyList<String>(), skipLines())
        lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_STOP); settle()

        ReleaseHealthBuildGate.__debuggableForTesting = false
        Everframe.start(context, config.copy(debugBuild = true))
        idleUntil("the debugBuild = true start never skipped release health") { skipLines().isNotEmpty() }
        assertEquals(listOf(skipLine), skipLines())
        lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_START); settle()
        assertFalse(Everframe.isReleaseHealthReady())
    }
}
