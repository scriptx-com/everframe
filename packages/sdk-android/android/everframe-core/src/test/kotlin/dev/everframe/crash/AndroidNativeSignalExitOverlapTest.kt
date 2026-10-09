// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import dev.everframe.outbox.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.security.SecureRandom
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** The authenticated record a native handler publishes for [epoch], with the production identity. */
internal fun nativeSignalRecord(epoch: String, key: ByteArray, capturedAt: Long = 2000): ByteArray {
    val header = byteArrayOf(69,86,81,67,1,0,0,0); val nonce = ByteArray(12).also { SecureRandom().nextBytes(it) }
    val text = """{"version":1,"reportId":"$epoch","epoch":"$epoch","owner":"anonymous","release":"frozen","signal":11,"architecture":4,"threadId":99,"snapshotTimeMs":$capturedAt,"pc":4112,"moduleBase":4096,"moduleOffset":16,"module":"libfault.so","buildId":"aabb","partial":true}"""
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce)); cipher.updateAAD(header)
    return header + nonce + cipher.doFinal(text.toByteArray())
}

/** API30 with signal capture and process-exit diagnostics both enabled: one native fault, one crash report. */
class AndroidNativeSignalExitOverlapTest {
    @get:Rule val folder = TemporaryFolder()
    private val keys = JceTestOutboxKeyProvider()
    private val allowed = object : OutboxAuthorization { override fun isAllowed() = true }
    private val crashed = "33333333-3333-4333-8333-333333333333" // the ended process's shared launch identity
    private val files by lazy { AndroidNativeSignalFiles(folder.root, JvmOutboxFileOps()) }
    private fun store(name: String) = OutboxStore(File(folder.root, name), keys, JvmOutboxFileOps(), 8, 2 * 1024 * 1024)
    private fun signal() = AndroidNativeRecordImport(store("capsules"), store("prepared"), store("delivered"))
    private fun exits() = AndroidNativeRecovery(store("contexts"), store("exit-prepared"))
    private fun template(): OutboxEntry {
        val id = UUID.randomUUID().toString()
        return OutboxEntry(id, 1000, """{"reportId":"$id","reporter":{},"payload":{}}""".toByteArray(), "template", emptyList(), "key", "https://example.test")
    }
    private val outbox = ArrayList<OutboxEntry>()
    private fun crashes() = outbox.map { Json.parseToJsonElement(it.envelopeBytes.toString(Charsets.UTF_8)).jsonObject }
        .filter { it["source"]!!.jsonPrimitive.content == "crash" }
        .map { it["payload"]!!.jsonObject["crash"]!!.jsonObject["mechanism"]!!.jsonPrimitive.content }

    /** The ended launch armed signal capture; its handler wrote a record only when [recorded]. */
    private fun signalArmed(launch: String, recorded: Boolean) = assertTrue(signal().arm(template(), launch, allowed) { epoch, key ->
        files.prepare(epoch)
        if (recorded) File(files.records, "$epoch/$epoch").writeBytes(nativeSignalRecord(epoch, key))
        true
    })
    /** The ended launch armed both paths; returns the native exit the OS recorded for it. */
    private fun crashedLaunch(launch: String = crashed, recorded: Boolean = true, pid: Int = 99): AndroidNativeExit {
        signalArmed(launch, recorded)
        var token = byteArrayOf()
        exits().arm(template(), pid, "app", allowed, diagnostics = true, processLaunchId = launch, apiLevel = 30) { token = it }
        return AndroidNativeExit(pid, "app", 2500, 5, token, { error("API30 has no tombstone") }, 11)
    }
    private fun signalRecovery(now: Long = 3000) = signal().recover("next-launch", now, allowed, files::read) { e, _ -> outbox += e; true }
    private fun exitRecovery(vararg exit: AndroidNativeExit, now: Long = 3000) = exits().recover(exit.toList(), now, allowed,
        allowDiagnostics = true, signalCapture = { signal().captured(it, now, files::read) }) { outbox += it; true }
    private fun exitContexts() = store("contexts").snapshotTokens().size

    @Test fun `signal report admitted first leaves the OS exit without a second crash`() {
        val exit = crashedLaunch()
        assertEquals(1, signalRecovery())
        assertEquals(0, exitRecovery(exit))
        assertEquals(listOf("android-native-handler"), crashes())
        assertEquals(0, exitContexts())
    }
    @Test fun `exit-info recovery first waits for the held record, then settles without a second crash`() {
        val exit = crashedLaunch()
        assertEquals(0, exitRecovery(exit))
        assertEquals("the OS exit stays undecided while the record awaits import", 1, exitContexts())
        assertEquals(1, signalRecovery())
        assertEquals(0, exitRecovery(exit, now = 4000))
        assertEquals(listOf("android-native-handler"), crashes())
        assertEquals(0, exitContexts())
    }
    @Test fun `a fault the handler did not record is still reported from the OS exit`() {
        val exit = crashedLaunch(recorded = false)
        assertEquals(1, exitRecovery(exit))
        assertEquals(0, signalRecovery())
        assertEquals(listOf("android-exit-info"), crashes())
    }
    @Test fun `an unauthenticated record cannot withhold the OS exit's crash`() {
        val exit = crashedLaunch()
        val record = files.records.listFiles()!!.single().let { File(it, it.name) }
        record.writeBytes(record.readBytes().also { it[it.lastIndex] = (it[it.lastIndex].toInt() xor 1).toByte() })
        assertEquals(1, exitRecovery(exit))
        assertEquals(0, signalRecovery())
        assertEquals(listOf("android-exit-info"), crashes())
    }
    @Test fun `erasing a held record returns the decision to the OS exit`() {
        val exit = crashedLaunch()
        assertEquals(0, exitRecovery(exit))
        signal().revoke() // explicit signal disable before the record was delivered
        assertEquals(1, exitRecovery(exit, now = 4000))
        assertEquals(listOf("android-exit-info"), crashes())
    }
    @Test fun `another launch's captured fault never withholds this exit`() {
        crashedLaunch(launch = "44444444-4444-4444-8444-444444444444", pid = 98)
        val exit = crashedLaunch(recorded = false)
        assertEquals(1, signalRecovery())
        assertEquals(1, exitRecovery(exit))
        assertEquals(listOf("android-native-handler", "android-exit-info"), crashes())
    }
    @Test fun `exit-info controller defers to the signal path it is given`() {
        val exit = crashedLaunch()
        assertEquals(1, signalRecovery())
        val platform = object : AndroidNativeExitPlatform {
            override val apiLevel = 30
            override val pid = 100
            override val processName = "app"
            override fun history() = listOf(exit)
            override fun setStateSummary(value: ByteArray?) {}
        }
        val controller = AndroidNativeRecoveryController(::exits, platform, processLaunchId = "55555555-5555-4555-8555-555555555555",
            signalCapture = { signal().captured(it, 3000, files::read) })
        assertTrue(controller.enableDiagnostics(1, allowed, 3000, ::template) { outbox += it; true })
        assertEquals(listOf("android-native-handler"), crashes())
    }
    @Test fun `an unreadable receipt store still finds a held record`() {
        crashedLaunch(launch = "44444444-4444-4444-8444-444444444444", pid = 98); assertEquals(1, signalRecovery()) // a receipt exists
        val exit = crashedLaunch()
        val lostKey = object : OutboxKeyProvider by keys {
            override fun loadGeneration(generation: String): javax.crypto.SecretKey = throw java.security.KeyStoreException("receipt key lost")
        }
        val query = AndroidNativeRecordImport(store("capsules"), store("prepared"), OutboxStore(File(folder.root, "delivered"), lostKey, JvmOutboxFileOps(), 8, 2 * 1024 * 1024))
        assertEquals(NativeSignalCapture.PENDING, query.captured(crashed, 3000, files::read))
        assertEquals(0, exits().recover(listOf(exit), 3000, allowed, allowDiagnostics = true, signalCapture = { query.captured(it, 3000, files::read) }) { outbox += it; true })
    }
    @Test fun `delivery receipts expire with the exit-info contexts they settle`() {
        crashedLaunch(); assertEquals(1, signalRecovery())
        assertEquals(NativeSignalCapture.DELIVERED, signal().captured(crashed, 3000, files::read))
        assertEquals(0, signalRecovery(now = 3000 + AndroidNativeRecordImport.MAX_AGE_MS + 1))
        assertTrue(store("delivered").snapshotTokens().isEmpty())
    }
    @Test fun `delivery receipts stay bounded and keep the newest launches`() {
        val launches = (0 until 10).map { UUID(0, it.toLong()).toString() }
        launches.forEachIndexed { i, launch -> signalArmed(launch, recorded = true); assertEquals(1, signalRecovery(now = 3000L + i)) }
        assertEquals(8, store("delivered").snapshotTokens().size)
        assertEquals(NativeSignalCapture.DELIVERED, signal().captured(launches.last(), 3000, files::read))
        assertEquals(NativeSignalCapture.NONE, signal().captured(launches.first(), 3000, files::read))
    }
}
