// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.everframe.Everframe
import dev.everframe.config.CaptureConfig
import dev.everframe.config.EverframeConfig
import dev.everframe.outbox.*
import dev.everframe.shared.SharedData
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.io.path.createTempDirectory

/** The SDK's own start/kill/enable boundaries around a registration that survives process death. */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [34])
class AndroidNativeCrashRuntimeTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private val config = EverframeConfig(appId = "native-runtime", sdkKey = "txx_live_native_runtime_test",
        capture = CaptureConfig(logs = false))
    private val keys = mapOf("contexts" to JceTestOutboxKeyProvider(), "prepared" to JceTestOutboxKeyProvider())
    private val outboxField = Everframe::class.java.getDeclaredField("sharedOutbox").apply { isAccessible = true }
    private val storage = createTempDirectory("everframe-native-runtime").toFile()
    private lateinit var outbox: JSONLOutbox
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
        AndroidNativeCrashRuntime.__controllerFactoryForTesting = null
        AndroidNativeCrashRuntime.__resetForTesting()
        outboxField.set(null, null)
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

    private fun start() {
        val previous = Everframe._replaySession
        Everframe.start(context, config)
        awaitStarted(previous)
    }

    private fun enable() {
        Everframe.setNativeCrashRecoveryEnabled(true)
        val deadline = System.nanoTime() + 5_000_000_000L
        while (!Everframe.isNativeCrashRecoveryReady() && System.nanoTime() < deadline) Thread.sleep(5)
        assertTrue(Everframe.isNativeCrashRecoveryReady())
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

    /** Public opt-in. Reads the outbox where admission's follow-up drain would launch, then keeps delivery out. */
    private fun enableAndReadAdmitted(): List<String> {
        val admitted = CountDownLatch(1)
        var reports = emptyList<String>()
        Everframe.__beforeDrainLaunchForTesting = {
            Everframe.__beforeDrainLaunchForTesting = null
            reports = nativeReports().map { it.reportId }
            admitted.countDown()
            Everframe.kill()
        }
        Everframe.setNativeCrashRecoveryEnabled(true)
        assertTrue("recovery never completed registration", admitted.await(5, TimeUnit.SECONDS))
        return reports
    }

    @Test fun `ordinary start keeps the previous process registration for relaunch recovery`() {
        start(); enable()
        val crashed = crashAndRelaunch()
        start()
        assertEquals(listOf(crashed), enableAndReadAdmitted())
    }

    @Test fun `explicit disable displaced by a newer enable still erases previous process evidence`() {
        start(); enable()
        val crashed = crashAndRelaunch()
        start()
        val captured = Everframe.captureSessionSnapshot()
        val epoch = captured.user.startEpoch
        val disabled = AndroidNativeCrashRuntime.request(epoch, false)
        val enabled = AndroidNativeCrashRuntime.request(epoch, true)
        // The disable tail lost its command before its own erasure could run.
        AndroidNativeCrashRuntime.boundary(context, epoch, true, { Everframe.currentStartEpochVolatile() == epoch }, disabled)
        assertTrue(AndroidNativeCrashRuntime.enable(context, captured, outbox, enabled))
        assertTrue(AndroidNativeCrashRuntime.ready(epoch))
        assertTrue("disabled evidence was admitted", nativeReports().none { it.reportId == crashed })
    }

    @Test fun `kill displaced by a racing start still erases previous process evidence`() {
        start(); enable()
        val crashed = crashAndRelaunch()
        start() // The relaunched process has journals but no live recovery owner yet.
        var killing = false
        var racedInsideKill = false
        // kill() cancels this lazy child after its state-lock section and before its native
        // boundary; the completion handler is a start() landing in exactly that window.
        Everframe.sdkScope.launch(start = CoroutineStart.LAZY) { }.invokeOnCompletion {
            racedInsideKill = killing
            Everframe.start(context, config)
        }
        killing = true
        Everframe.kill()
        killing = false
        assertTrue(racedInsideKill)
        awaitStarted(null)
        freshOutbox()
        assertTrue("killed evidence was admitted", enableAndReadAdmitted().none { it == crashed })
    }
}
