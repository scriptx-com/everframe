// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// DEBUG-ONLY unit test source set: assigns `EndpointOverride.current` (a `val` in release)
// so every start talks to a local server and leaves no blocked work in the SDK scope.
package dev.everframe.crash

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.everframe.Everframe
import dev.everframe.config.CaptureConfig
import dev.everframe.config.EndpointOverride
import dev.everframe.config.EverframeConfig
import dev.everframe.outbox.*
import dev.everframe.shared.SharedData
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
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
import kotlin.io.path.createTempDirectory

/** The SDK's own start/kill/enable boundaries around a registration that survives process death. */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [34])
class AndroidNativeCrashRuntimeTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private val config = EverframeConfig(appId = "native-runtime", sdkKey = "txx_live_native_runtime_test",
        capture = CaptureConfig(logs = false))
    private val crashOff = config.copy(capture = config.capture.copy(crash = false))
    private val keys = mapOf("contexts" to JceTestOutboxKeyProvider(), "prepared" to JceTestOutboxKeyProvider())
    private val outboxField = Everframe::class.java.getDeclaredField("sharedOutbox").apply { isAccessible = true }
    private val storage = createTempDirectory("everframe-native-runtime").toFile()
    private lateinit var outbox: JSONLOutbox
    private lateinit var server: MockWebServer
    private var platform = Platform(4242)

    private class Platform(override val pid: Int) : AndroidNativeExitPlatform {
        override val apiLevel = 34
        override val processName = "dev.everframe.nativeruntime"
        val registrations = ArrayList<ByteArray?>()
        var exits = emptyList<AndroidNativeExit>()
        override fun history() = exits
        override fun setStateSummary(value: ByteArray?) { registrations.add(value) }
    }

    @Before fun setUp() {
        ShadowApplication.setProcessName(context.packageName)
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
        File(context.noBackupFilesDir, "dev.everframe/native-exit-v1").deleteRecursively()
        AndroidNativeCrashRuntime.__resetForTesting()
        // Production owner shape and journal root; only Keystore and ActivityManager are replaced.
        AndroidNativeCrashRuntime.__controllerFactoryForTesting = { app ->
            val root = File(app.noBackupFilesDir, "dev.everframe/native-exit-v1")
            fun store(name: String) = OutboxStore(File(root, name), keys.getValue(name), JvmOutboxFileOps(), 8, 2L * 1024 * 1024)
            AndroidNativeRecoveryController({ AndroidNativeRecovery(store("contexts"), store("prepared")) }, platform)
        }
        freshOutbox()
    }

    @After fun tearDown() {
        Everframe.__resetStartTailDelayHookForTesting()
        Everframe.kill()
        // Later suites join every SDK-scope child; none of these sessions may outlive the test.
        runBlocking { withTimeout(5_000) { Everframe.sdkScope.coroutineContext[Job]!!.children.toList().joinAll() } }
        AndroidNativeCrashRuntime.__controllerFactoryForTesting = null
        AndroidNativeCrashRuntime.__resetForTesting()
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

    /** Start drains the shared outbox before it installs replay; recovery must admit after that drain. */
    private fun awaitStarted(previous: Any?) {
        val deadline = System.nanoTime() + 5_000_000_000L
        while ((Everframe._replaySession == null || Everframe._replaySession === previous) && System.nanoTime() < deadline) Thread.sleep(5)
        assertTrue("start never finished its initial drain", Everframe._replaySession.let { it != null && it !== previous })
    }

    private fun start(cfg: EverframeConfig = config) {
        val previous = Everframe._replaySession
        Everframe.start(context, cfg)
        awaitStarted(previous)
    }

    private fun awaitReady() {
        val deadline = System.nanoTime() + 5_000_000_000L
        while (!Everframe.isNativeCrashCaptureReady() && System.nanoTime() < deadline) Thread.sleep(5)
        assertTrue(Everframe.isNativeCrashCaptureReady())
    }

    /** Process death after registration: memory is lost; journals and the OS exit record remain. */
    private fun crashAndRelaunch(): String {
        val crashed = platform
        val token = crashed.registrations.last()!!
        val exit = AndroidNativeExit(crashed.pid, crashed.processName, System.currentTimeMillis(), 5, token) { null }
        AndroidNativeCrashRuntime.__resetForTesting()
        platform = Platform(4343).apply { exits = listOf(exit) }
        return token.toString(Charsets.US_ASCII).removePrefix("everframe-native-v1:")
    }

    private fun nativeReports() = outbox.store.snapshotTokens().mapNotNull { outbox.store.readIfPresent(it)?.entry }.filter {
        Json.parseToJsonElement(it.envelopeBytes.toString(Charsets.UTF_8)).jsonObject["payload"]?.jsonObject
            ?.get("crash")?.jsonObject?.get("mechanism")?.jsonPrimitive?.content == "android-exit-info"
    }

    /** Relaunch start. Reads the outbox at the drain crash capture requests after arming, then keeps delivery out. */
    private fun startAndReadAdmitted(): List<String> {
        val admitted = CountDownLatch(1)
        val calls = AtomicInteger()
        var reports = emptyList<String>()
        Everframe.__beforeDrainLaunchForTesting = {
            // The first call is start()'s own drain; the second follows crash capture arming.
            if (calls.incrementAndGet() == 2) {
                Everframe.__beforeDrainLaunchForTesting = null
                reports = nativeReports().map { it.reportId }
                admitted.countDown()
                Everframe.kill()
            }
        }
        Everframe.start(context, config)
        assertTrue("recovery never completed registration", admitted.await(5, TimeUnit.SECONDS))
        return reports
    }

    @Test fun `ordinary start keeps the previous process registration for relaunch recovery`() {
        start(); awaitReady()
        val crashed = crashAndRelaunch()
        assertEquals(listOf(crashed), startAndReadAdmitted())
    }

    @Test fun `kill displaced by a racing start still erases previous process evidence`() {
        start(); awaitReady()
        val crashed = crashAndRelaunch()
        // The relaunched process has journals but no live recovery owner yet; keep these starts
        // from arming so the kill below is the first owner of that evidence.
        start(crashOff)
        var killing = false
        var racedInsideKill = false
        // kill() cancels this lazy child after its state-lock section and before its native
        // boundary; the completion handler is a start() landing in exactly that window.
        Everframe.sdkScope.launch(start = CoroutineStart.LAZY) { }.invokeOnCompletion {
            racedInsideKill = killing
            Everframe.start(context, crashOff)
        }
        killing = true
        Everframe.kill()
        killing = false
        assertTrue(racedInsideKill)
        awaitStarted(null)
        freshOutbox()
        assertTrue("killed evidence was admitted", startAndReadAdmitted().none { it == crashed })
    }
}
