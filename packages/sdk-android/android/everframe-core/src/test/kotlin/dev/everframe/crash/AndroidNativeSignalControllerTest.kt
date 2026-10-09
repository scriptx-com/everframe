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

class AndroidNativeSignalControllerTest {
    @get:Rule val folder = TemporaryFolder()
    private val keys = JceTestOutboxKeyProvider()
    private val allowed = object : OutboxAuthorization { override fun isAllowed() = true }
    private fun store(name: String) = OutboxStore(File(folder.root, name), keys, JvmOutboxFileOps(), 8, 2*1024*1024)
    private fun engine() = AndroidNativeRecordImport(store("capsules"), store("prepared"))
    private fun template(): OutboxEntry {
        val id = UUID.randomUUID().toString()
        return OutboxEntry(id, 1000, """{"reportId":"$id","payload":{}}""".toByteArray(), "template", emptyList(), "original", "https://original.example")
    }
    private class Producer : AndroidNativeSignalProducer {
        var armed = false
        var arms = 0
        var borrowedKey: ByteArray? = null
        var onArm: () -> Unit = {}
        var prepare: (String) -> Unit = {}
        var available = true
        var revokeFails = false
        override fun generation() = 0L
        override fun arm(epoch: String, key: ByteArray, generation: Long): Boolean {
            arms++; borrowedKey = key; prepare(epoch); armed = available; onArm(); return available
        }
        override fun pause() { armed = false }
        override fun revoke(): Boolean { armed = false; return !revokeFails }
    }
    private fun owner(p: Producer, launch: String = "this-process") = AndroidNativeSignalController(
        ::engine, p, { null }, processLaunchId = launch, now = { 3000 })
    private fun enable(c: AndroidNativeSignalController, command: Long = c.request(), epoch: Int = 1): Boolean =
        c.enable(command, epoch, allowed, ::template) { _, _ -> error("no prior record") }

    @Test fun `refresh rotates frozen signal attribution and keeps background capture armed`() {
        val launch = UUID.randomUUID().toString()
        var pointer: dev.everframe.health.NativeExposurePointer? = dev.everframe.health.NativeExposurePointer(
            UUID.randomUUID().toString(), launch, "2026-10-09T10:00:00.000Z", "native", null,
            dev.everframe.config.ReleaseHealthBundleStatus.NOT_APPLICABLE)
        val p = Producer()
        val c = AndroidNativeSignalController(::engine, p, { null }, launch, { 3000 }, exposure = { pointer })
        assertTrue(enable(c))
        fun frozen() = store("capsules").let { queue ->
            Json.parseToJsonElement(queue.readIfPresent(queue.snapshotTokens().single())!!.entry.envelopeBytes.toString(Charsets.UTF_8)).jsonObject
        }
        assertEquals(pointer!!.exposureId, frozen()["nativeExposure"]!!.jsonObject["exposureId"]!!.jsonPrimitive.content)
        pointer = null; c.invalidateExposure()
        assertFalse(p.armed)
        assertTrue(c.refreshExposure(1))
        assertTrue(p.armed); assertTrue(c.ready(1)); assertFalse(frozen().containsKey("nativeExposure"))
        pointer = dev.everframe.health.NativeExposurePointer(UUID.randomUUID().toString(), launch,
            "2026-10-09T10:00:01.000Z", "native", null, dev.everframe.config.ReleaseHealthBundleStatus.NOT_APPLICABLE)
        c.invalidateExposure(); assertTrue(c.refreshExposure(1))
        assertEquals(pointer!!.exposureId, frozen()["nativeExposure"]!!.jsonObject["exposureId"]!!.jsonPrimitive.content)
        assertEquals(3, p.arms)
    }
    @Test fun `opt in armed before the session start is durable gains its pointer on refresh`() {
        val launch = UUID.randomUUID().toString()
        var pointer: dev.everframe.health.NativeExposurePointer? = null
        val p = Producer()
        val c = AndroidNativeSignalController(::engine, p, { null }, launch, { 3000 }, exposure = { pointer })
        fun frozen() = store("capsules").let { queue ->
            Json.parseToJsonElement(queue.readIfPresent(queue.snapshotTokens().single())!!.entry.envelopeBytes.toString(Charsets.UTF_8)).jsonObject
        }
        assertTrue(enable(c)); assertFalse(frozen().containsKey("nativeExposure"))
        // Foreground entry fences nothing; the refresh after the durable start replaces the capsule.
        pointer = dev.everframe.health.NativeExposurePointer(UUID.randomUUID().toString(), launch,
            "2026-10-09T10:00:00.000Z", "native", null, dev.everframe.config.ReleaseHealthBundleStatus.NOT_APPLICABLE)
        assertTrue(c.refreshExposure(1))
        assertEquals(pointer!!.toJson(), frozen()["nativeExposure"])
        assertTrue(p.armed); assertTrue(c.ready(1)); assertEquals(2, p.arms)
        assertTrue(c.refreshExposure(1)) // The same pointer keeps the armed capsule.
        assertEquals(2, p.arms)
    }
    @Test fun `background during native provisioning fences the stale arm and durable capsule`() {
        val p = Producer(); val c = owner(p)
        p.onArm = { c.invalidateExposure() }
        assertFalse(enable(c)); assertFalse(c.ready(1)); assertFalse(p.armed)
        assertTrue(store("capsules").snapshotTokens().isEmpty())
    }
    @Test fun `lifecycle cancellation of initial native arm preserves opt in for a fresh retry`() {
        val p = Producer(); val c = owner(p)
        p.onArm = { c.invalidateExposure(); p.available = false }
        assertFalse(enable(c)); assertFalse(c.ready(1)); assertFalse(p.armed)
        assertTrue(store("capsules").snapshotTokens().isEmpty())
        p.onArm = {}; p.available = true
        assertTrue(c.refreshExposure(1)); assertTrue(c.ready(1)); assertTrue(p.armed)
        assertEquals(1, store("capsules").snapshotTokens().size)
    }
    @Test fun `lifecycle cancellation before signal owner publication stays retryable but revoke wins`() {
        val p = Producer(); var first = true
        lateinit var c: AndroidNativeSignalController
        c = AndroidNativeSignalController({
            if (first) { first = false; c.invalidateExposure() }
            engine()
        }, p, { null }, now = { 3000 })
        assertFalse(enable(c)); assertFalse(c.ready(1))
        assertTrue(c.refreshExposure(1)); assertTrue(c.ready(1))
        c.request(erase = true); assertTrue(c.finishRevocation())
        assertFalse(c.refreshExposure(1)); assertFalse(c.ready(1)); assertFalse(p.armed)
        assertTrue(store("capsules").snapshotTokens().isEmpty())
    }
    @Test fun `superseded signal command cannot refresh a canceled initial setup`() {
        val p = Producer(); val c = owner(p)
        p.onArm = { c.invalidateExposure(); p.available = false }
        assertFalse(enable(c))
        c.request(); p.onArm = {}; p.available = true
        assertFalse(c.refreshExposure(1)); assertFalse(c.ready(1)); assertFalse(p.armed)
    }
    @Test fun `lifecycle cancellation in the initial authorization window retains signal setup`() {
        val p = Producer(); val c = owner(p); var first = true
        val gate = object : OutboxAuthorization {
            override fun isAllowed(): Boolean {
                if (first) { first = false; c.invalidateExposure() }
                return true
            }
        }
        assertFalse(c.enable(c.request(), 1, gate, ::template) { _, _ -> true })
        assertFalse(c.ready(1)); assertEquals(0, p.arms)
        assertTrue(c.refreshExposure(1)); assertTrue(c.ready(1)); assertTrue(p.armed)
    }
    @Test fun `capsules carry the process launch identity that exit-info contexts carry`() {
        val c = AndroidNativeSignalController(::engine, Producer(), { null }, now = { 3000 })
        assertTrue(enable(c))
        val capsule = store("capsules").let { s -> s.readIfPresent(s.snapshotTokens().single())!!.entry }
        val launch = Json.parseToJsonElement(capsule.envelopeBytes.toString(Charsets.UTF_8)).jsonObject["launch"]!!.jsonPrimitive.content
        assertEquals(dev.everframe.health.ProcessLaunchIdentity.id.toString(), launch)
    }
    @Test fun `ordinary opt in is ready only after durable arm`() {
        val p = Producer(); val c = owner(p)
        assertFalse(c.ready(1)); assertTrue(enable(c)); assertTrue(c.ready(1)); assertTrue(p.armed)
        assertEquals(1, store("capsules").snapshotTokens().size)
    }
    @Test fun `replacement start pauses immediately and retires only current capsule before rearm`() {
        val p = Producer(); val c = owner(p)
        assertTrue(enable(c)); val old = store("capsules").snapshotTokens().single()
        val command = c.request()
        assertFalse(c.ready(1)); assertFalse(p.armed)
        assertTrue(enable(c, command, 2)); assertFalse(c.ready(1)); assertTrue(c.ready(2))
        assertNull(store("capsules").readIfPresent(old)); assertEquals(1, store("capsules").snapshotTokens().size)
    }
    @Test fun `late enable command cannot replace newer capture owner`() {
        val p = Producer(); val c = owner(p); val stale = c.request(); val current = c.request()
        assertFalse(enable(c, stale)); assertEquals(0, p.arms)
        assertTrue(enable(c, current)); assertTrue(c.ready(1))
    }
    @Test fun `disable racing native provisioning fences readiness and durable capsule`() {
        val p = Producer(); val c = owner(p)
        p.onArm = { c.request(erase = true) }
        assertFalse(enable(c)); assertFalse(c.ready(1)); assertFalse(p.armed)
        assertTrue(c.finishRevocation()); assertTrue(store("capsules").snapshotTokens().isEmpty())
    }
    @Test fun `failed native arm never announces readiness or consumes a capsule`() {
        val p = Producer().apply { available = false }; val c = owner(p)
        assertFalse(enable(c)); assertFalse(c.ready(1)); assertTrue(store("capsules").snapshotTokens().isEmpty())
    }
    @Test fun `disable erases previous and current contexts and permits later explicit reenable`() {
        val p = Producer(); val c = owner(p)
        assertTrue(enable(c)); c.request(erase = true); assertTrue(c.finishRevocation())
        assertTrue(store("capsules").snapshotTokens().isEmpty()); assertFalse(c.ready(1))
        assertTrue(enable(c)); assertEquals(1, store("capsules").snapshotTokens().size)
    }
    @Test fun `failed shutdown retains revocation obligation and blocks later activation`() {
        val p = Producer(); val c = owner(p); assertTrue(enable(c))
        p.revokeFails = true; c.request(erase = true)
        assertFalse(c.finishRevocation()); assertTrue(store("capsules").snapshotTokens().isEmpty())
        assertFalse(enable(c)); assertFalse(c.ready(1))
        p.revokeFails = false; assertTrue(enable(c)); assertTrue(c.ready(1))
    }
    @Test fun `many configuration changes and clean process launches cannot exhaust capsules`() {
        val p = Producer(); var c = owner(p)
        repeat(12) { assertTrue(enable(c, epoch = it)); assertEquals(1, store("capsules").snapshotTokens().size) }
        repeat(12) { i -> c = owner(p, "launch-$i"); assertTrue(enable(c)); assertEquals(1, store("capsules").snapshotTokens().size) }
    }
    @Test fun `denied authorization does not invoke native arm`() {
        val p = Producer(); val c = owner(p)
        assertFalse(c.enable(c.request(), 1, object : OutboxAuthorization { override fun isAllowed() = false }, ::template) { _, _ -> true })
        assertEquals(0, p.arms); assertFalse(c.ready(1))
    }
    @Test fun `replacement after durable arm retires the now paused capsule`() {
        val p = Producer(); val c = owner(p)
        val gate = object : OutboxAuthorization {
            override fun isAllowed(): Boolean {
                // arm() clears its borrowed key in finally, before returning to the controller.
                if (p.borrowedKey?.all { it == 0.toByte() } == true) { c.request(); return false }
                return true
            }
        }
        assertFalse(c.enable(c.request(), 1, gate, ::template) { _, _ -> false })
        assertFalse(c.ready(1)); assertFalse(p.armed)
        assertTrue(store("capsules").snapshotTokens().isEmpty())
    }

    // Production layout: stores and records under the owned native directory, real cleanup.
    private val files by lazy { AndroidNativeSignalFiles(folder.root, JvmOutboxFileOps()) }
    private fun owned(name: String) = OutboxStore(File(files.root, name), keys, JvmOutboxFileOps(), 8, 2*1024*1024)
    private fun ownedEngine() = AndroidNativeRecordImport(owned("capsules"), owned("prepared"))
    private fun epochs(name: String) = owned(name).let { s -> s.snapshotTokens().map { s.readIfPresent(it)!!.entry.reportId.replace("-", "") }.toSet() }
    private fun nativeRecord(epoch: String, key: ByteArray): ByteArray {
        val header = byteArrayOf(69,86,81,67,1,0,0,0); val nonce = ByteArray(12).also { SecureRandom().nextBytes(it) }
        val text = """{"version":1,"reportId":"$epoch","epoch":"$epoch","owner":"anonymous","release":"frozen","signal":11,"architecture":4,"threadId":99,"snapshotTimeMs":2000,"pc":4112,"moduleBase":4096,"moduleOffset":16,"module":"libfault.so","buildId":"aabb","partial":true}"""
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce)); cipher.updateAAD(header)
        return header + nonce + cipher.doFinal(text.toByteArray())
    }
    /** An ended launch armed its capsule, and its handler published the authenticated record. */
    private fun crashedLaunch(launch: String): String {
        var epoch = ""
        assertTrue(ownedEngine().arm(template(), launch, allowed) { id, key ->
            files.prepare(id); File(files.records, "$id/$id").writeBytes(nativeRecord(id, key)); epoch = id; true })
        return epoch
    }
    private fun assertEvidence(vararg ended: String) {
        for (epoch in ended) assertNotNull("record of ended launch $epoch was deleted", files.read(epoch))
        assertTrue("capsule of an ended launch was retired", epochs("capsules").containsAll(ended.toList()))
    }

    @Test fun `replacement and retirement keep ended launches' capsules, prepared reports and records`() {
        val p = Producer().apply { prepare = files::prepare }
        val c = AndroidNativeSignalController(::ownedEngine, p, files::read, processLaunchId = "this-process", now = { 3000 }, cleanup = files::cleanup)
        // The main outbox is full, so recovered reports stay prepared beside their capsules.
        fun enable(epoch: Int) = c.enable(c.request(), epoch, allowed, ::template) { _, _ -> false }
        val held = crashedLaunch("ended-held")
        assertTrue(enable(1)); assertEquals(setOf(held), epochs("prepared"))
        val first = (epochs("capsules") - held).single()
        val pending = crashedLaunch("ended-not-yet-imported")

        assertTrue(c.retireCurrent())
        assertEvidence(held, pending); assertEquals(setOf(held), epochs("prepared"))
        assertEquals(setOf(held, pending), epochs("capsules")); assertEquals(setOf(held, pending), files.records.list()!!.toSet())

        assertTrue(enable(2)); val second = (epochs("capsules") - held - pending).single()
        assertTrue(enable(3)) // replacement start while this process's capsule is armed
        assertEvidence(held, pending); assertEquals(setOf(held, pending), epochs("prepared"))
        val third = (epochs("capsules") - held - pending).single()
        assertEquals(setOf(held, pending, third), files.records.list()!!.toSet())
        assertFalse(epochs("capsules").contains(first) || epochs("capsules").contains(second))

        // The next launch has outbox capacity and delivers both original reports.
        val admitted = ArrayList<String>()
        val next = AndroidNativeSignalController(::ownedEngine, Producer(), files::read, processLaunchId = "next-process", now = { 4000 }, cleanup = files::cleanup)
        assertTrue(next.enable(next.request(), 1, allowed, ::template) { e, _ -> admitted += e.reportId.replace("-", ""); true })
        assertEquals(setOf(held, pending), admitted.toSet())
    }

}
