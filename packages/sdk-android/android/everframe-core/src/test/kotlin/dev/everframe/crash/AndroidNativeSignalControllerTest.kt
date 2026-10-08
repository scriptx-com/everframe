// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import dev.everframe.outbox.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.UUID

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
        var available = true
        var revokeFails = false
        override fun generation() = 0L
        override fun arm(epoch: String, key: ByteArray, generation: Long): Boolean {
            arms++; borrowedKey = key; armed = available; onArm(); return available
        }
        override fun pause() { armed = false }
        override fun revoke(): Boolean { armed = false; return !revokeFails }
    }
    private fun owner(p: Producer, launch: String = "this-process") = AndroidNativeSignalController(
        ::engine, p, { null }, processLaunchId = launch, now = { 3000 })
    private fun enable(c: AndroidNativeSignalController, command: Long = c.request(), epoch: Int = 1): Boolean =
        c.enable(command, epoch, allowed, ::template) { _, _ -> error("no prior record") }

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

}
