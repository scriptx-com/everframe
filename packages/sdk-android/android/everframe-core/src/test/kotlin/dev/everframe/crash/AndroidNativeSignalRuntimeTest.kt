// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.everframe.Everframe
import dev.everframe.TXCapturedSession
import dev.everframe.TXCapturedUser
import dev.everframe.config.EverframeConfig
import dev.everframe.outbox.*
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowApplication
import java.io.File
import java.util.UUID

/** Process-level signal lifecycle; JVM keys and file operations stand in for Keystore and Os. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class AndroidNativeSignalRuntimeTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private val keys = JceTestOutboxKeyProvider()
    private val allowed = object : OutboxAuthorization { override fun isAllowed() = true }
    private val root get() = File(context.noBackupFilesDir, "dev.everframe/native-signal-v1")
    /** Durable capsule files, counted on disk: a revoked lease hides entries without erasing them. */
    private fun capsuleFiles() = File(root, "capsules/active").listFiles { file -> file.extension == "txq" }?.size ?: 0
    private fun records() = File(root, "records").list().orEmpty().toSet()
    private fun template(): OutboxEntry {
        val id = UUID.randomUUID().toString()
        return OutboxEntry(id, 1000, """{"reportId":"$id","payload":{}}""".toByteArray(), "template", emptyList(), "original", "https://original.example")
    }
    private inner class Producer : AndroidNativeSignalProducer {
        var revokes = 0
        var arms = 0
        var pauses = 0
        var pauseFailure: Throwable? = null
        override fun generation() = 0L
        override fun arm(epoch: String, key: ByteArray, generation: Long): Boolean {
            arms++; AndroidNativeSignalFiles(context.noBackupFilesDir, JvmOutboxFileOps()).prepare(epoch); return true
        }
        override fun pause() { pauses++; pauseFailure?.let { throw it } }
        override fun revoke(): Boolean { revokes++; return true }
    }
    private val producer = Producer()

    @Before fun seams() {
        AndroidNativeSignalRuntime.__resetForTesting()
        AndroidNativeSignalRuntime.__keysForTesting = keys
        AndroidNativeSignalRuntime.__fileOpsForTesting = JvmOutboxFileOps()
        AndroidNativeSignalRuntime.__producerForTesting = producer
        ShadowApplication.setProcessName(context.packageName)
    }
    @After fun reset() {
        AndroidNativeSignalRuntime.__resetForTesting()
        AndroidNativeSignalRuntime.__keysForTesting = null
        AndroidNativeSignalRuntime.__fileOpsForTesting = null
        AndroidNativeSignalRuntime.__producerForTesting = null
    }

    @Test fun `the collector is available only with the optional module or a test producer`() {
        assertTrue(AndroidNativeSignalRuntime.available(context))
        AndroidNativeSignalRuntime.__producerForTesting = null
        assertFalse("core tests do not package dev.everframe.nativecrash.NativeCrashBridge", AndroidNativeSignalRuntime.available(context))
    }
    /** Arms this process's capsule as the opt-in's IO step does once its gates pass. */
    private fun armed(): AndroidNativeSignalController {
        val owner = AndroidNativeSignalRuntime.__ownerForTesting(context)
        assertTrue(owner.enable(owner.request(), 1, allowed, ::template) { _, _ -> false })
        assertEquals(1, capsuleFiles()); assertEquals(1, records().size)
        return owner
    }
    private fun session() = TXCapturedSession(TXCapturedUser(null, 1, null), null, 0)
    private fun outbox() = JSONLOutbox(File(context.cacheDir, "outbox"), keys, JvmOutboxFileOps())

    @Test fun `erase without a live controller removes an earlier process's evidence`() {
        armed()
        AndroidNativeSignalRuntime.__resetForTesting() // process death; durable evidence remains
        AndroidNativeSignalRuntime.request(erase = true)
        assertTrue(AndroidNativeSignalRuntime.finishErase(context))
        assertEquals(0, capsuleFiles()); assertTrue(records().isEmpty())
    }
    @Test fun `erase without a context keeps its obligation until a context is available`() {
        armed()
        AndroidNativeSignalRuntime.request(erase = true)
        assertFalse(AndroidNativeSignalRuntime.finishErase(null))
        assertFalse(AndroidNativeSignalRuntime.ready(1))
        assertEquals(1, capsuleFiles())
        assertTrue(AndroidNativeSignalRuntime.finishErase(context))
        assertEquals(0, capsuleFiles()); assertTrue(records().isEmpty())
    }
    @Test fun `a secondary process neither arms nor erases the default process's evidence`() {
        armed()
        AndroidNativeSignalRuntime.__resetForTesting()
        val revokes = producer.revokes
        ShadowApplication.setProcessName("${context.packageName}:worker")
        assertFalse(AndroidNativeSignalRuntime.enable(context, session(), outbox(), AndroidNativeSignalRuntime.request()))
        AndroidNativeSignalRuntime.request(erase = true)
        assertTrue(AndroidNativeSignalRuntime.finishErase(context))
        assertEquals(1, capsuleFiles()); assertEquals(1, records().size)
        assertEquals(revokes, producer.revokes)
    }
    @Test fun `replacement start retires the current capsule only while its command is newest`() {
        armed()
        val stale = AndroidNativeSignalRuntime.request()
        AndroidNativeSignalRuntime.request() // a newer opt-in or erase owns this owner now
        runBlocking { AndroidNativeSignalRuntime.retireAfterStart(stale)!!.join() }
        assertEquals(1, capsuleFiles()); assertEquals(1, records().size)
        val current = AndroidNativeSignalRuntime.request()
        runBlocking { AndroidNativeSignalRuntime.retireAfterStart(current)!!.join() }
        assertEquals(0, capsuleFiles()); assertTrue(records().isEmpty())
    }
    @Test fun `absent optional module leaves readiness false without a capsule or record`() {
        AndroidNativeSignalRuntime.__producerForTesting = null
        val owner = AndroidNativeSignalRuntime.__ownerForTesting(context)
        assertFalse(owner.enable(owner.request(), 1, allowed, ::template) { _, _ -> false })
        assertFalse(owner.ready(1)); assertEquals(0, capsuleFiles()); assertTrue(records().isEmpty())
        AndroidNativeSignalRuntime.request(erase = true)
        assertTrue(AndroidNativeSignalRuntime.finishErase(context))
    }
    @Test @Config(sdk = [31])
    fun `API31 never arms the signal path`() {
        assertFalse(AndroidNativeSignalRuntime.enable(context, session(), outbox(), AndroidNativeSignalRuntime.request()))
        assertFalse(root.exists())
    }
    @Test @Config(sdk = [25])
    fun `API25 erase completes without creating native storage`() {
        AndroidNativeSignalRuntime.request(erase = true)
        assertTrue(AndroidNativeSignalRuntime.finishErase(context))
        assertFalse(root.exists())
    }

    private fun storeAt(name: String) = OutboxStore(File(root, name), keys, JvmOutboxFileOps(), 8, 2 * 1024 * 1024)
    /** An ended launch's capsule, with the record its handler published when [recorded]. */
    private fun endedLaunch(launch: String, recorded: Boolean) {
        val files = AndroidNativeSignalFiles(context.noBackupFilesDir, JvmOutboxFileOps())
        assertTrue(AndroidNativeRecordImport(storeAt("capsules"), storeAt("prepared")).arm(template(), launch, allowed) { epoch, key ->
            files.prepare(epoch); if (recorded) File(files.records, "$epoch/$epoch").writeBytes(nativeSignalRecord(epoch, key, System.currentTimeMillis())); true })
    }
    @Test fun `exit-info coordination sees an ended launch's authenticated record, then its delivery`() {
        endedLaunch("ended-recorded", recorded = true); endedLaunch("ended-clean", recorded = false)
        assertEquals(NativeSignalCapture.PENDING, AndroidNativeSignalRuntime.capture(context, "ended-recorded"))
        assertEquals(NativeSignalCapture.NONE, AndroidNativeSignalRuntime.capture(context, "ended-clean"))
        val owner = AndroidNativeSignalRuntime.__ownerForTesting(context)
        assertTrue(owner.enable(owner.request(), 1, allowed, ::template) { _, _ -> true })
        assertEquals(NativeSignalCapture.DELIVERED, AndroidNativeSignalRuntime.capture(context, "ended-recorded"))
        assertEquals(NativeSignalCapture.NONE, AndroidNativeSignalRuntime.capture(context, "ended-clean"))
        AndroidNativeSignalRuntime.request(erase = true)
        assertEquals("a pending erase owns every record", NativeSignalCapture.NONE, AndroidNativeSignalRuntime.capture(context, "ended-recorded"))
    }
    @Test @Config(sdk = [31])
    fun `API31 exit-info recovery never defers to records this path cannot deliver`() {
        endedLaunch("ended-recorded", recorded = true)
        assertEquals(NativeSignalCapture.NONE, AndroidNativeSignalRuntime.capture(context, "ended-recorded"))
    }

    /** A Keystore whose key loads fail transiently; the outbox reports that as KEY_UNAVAILABLE. */
    private class FlakyKeys(private val keys: OutboxKeyProvider) : OutboxKeyProvider by keys {
        @Volatile var failing = false
        override fun loadGeneration(generation: String): javax.crypto.SecretKey {
            if (failing) throw java.security.KeyStoreException("transient keystore failure")
            return keys.loadGeneration(generation)
        }
    }
    @Test fun `replacement retirement storage failure never reaches the host's uncaught exception handler`() {
        val flaky = FlakyKeys(keys)
        AndroidNativeSignalRuntime.__keysForTesting = flaky
        armed()
        flaky.failing = true
        val uncaught = java.util.concurrent.atomic.AtomicReference<Throwable?>()
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { _, error -> uncaught.set(error) }
        try {
            runBlocking { AndroidNativeSignalRuntime.retireAfterStart(AndroidNativeSignalRuntime.request())!!.join() }
        } finally { Thread.setDefaultUncaughtExceptionHandler(previous) }
        assertNull("SDK storage failure escaped to the host", uncaught.get())
        assertTrue(dev.everframe.envelope.InternalLogger.drainFailures().any { it.label == "nativeSignal.retire" })
        assertFalse(AndroidNativeSignalRuntime.ready(1))
        // The retained owner is erased once storage recovers.
        flaky.failing = false
        AndroidNativeSignalRuntime.request(erase = true)
        assertTrue(AndroidNativeSignalRuntime.finishErase(context))
        assertEquals(0, capsuleFiles()); assertTrue(records().isEmpty())
    }
    @Test fun `a mismatched optional module's pause cannot escape start or kill fences`() {
        armed()
        producer.pauseFailure = NoSuchMethodException("pause") // reflective bridge from another module version
        val start = AndroidNativeSignalRuntime.request()
        assertTrue(AndroidNativeSignalRuntime.request(erase = true) > start)
        assertFalse(AndroidNativeSignalRuntime.ready(1))
        assertTrue(AndroidNativeSignalRuntime.finishErase(context))
        assertEquals(0, capsuleFiles()); assertTrue(records().isEmpty())
    }

    @Test fun `a repeated opt-in in one start keeps the armed owner without pausing or re-arming`() {
        val gate = Everframe.captureGate
        Everframe.captureGate = true
        try {
            val epoch = Everframe.currentStartEpochVolatile()
            val session = TXCapturedSession(TXCapturedUser(null, epoch, null), EverframeConfig(appId = "app", sdkKey = "key"), 0, captureConsent = true)
            val first = AndroidNativeSignalRuntime.requestEnable(epoch)
            assertTrue(AndroidNativeSignalRuntime.enable(context, session, outbox(), first))
            val arms = producer.arms; val pauses = producer.pauses
            val repeat = AndroidNativeSignalRuntime.requestEnable(epoch)
            assertEquals("a repeat must not fence the armed or in-flight setup", first, repeat)
            assertTrue(AndroidNativeSignalRuntime.ready(epoch))
            assertTrue(AndroidNativeSignalRuntime.enable(context, session, outbox(), repeat))
            assertEquals(arms, producer.arms); assertEquals(pauses, producer.pauses); assertEquals(1, capsuleFiles())
            // Any other command still fences, and the next opt-in arms a new capsule.
            assertTrue(AndroidNativeSignalRuntime.request() > repeat)
            assertFalse(AndroidNativeSignalRuntime.ready(epoch))
            assertTrue(AndroidNativeSignalRuntime.enable(context, session, outbox(), AndroidNativeSignalRuntime.requestEnable(epoch)))
            assertEquals(arms + 1, producer.arms); assertEquals(1, capsuleFiles())
        } finally { Everframe.captureGate = gate }
    }
}
