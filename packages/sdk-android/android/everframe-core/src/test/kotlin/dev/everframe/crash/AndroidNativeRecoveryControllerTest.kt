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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class AndroidNativeRecoveryControllerTest {
    @get:Rule val folder = TemporaryFolder()
    private val keys = JceTestOutboxKeyProvider()
    private var failContextRevoke = false
    private val ops = object : OutboxFileOps by JvmOutboxFileOps() {
        override fun syncFile(file: File) {
            if (failContextRevoke && file.name == "kill.pending" && file.parentFile?.name == "contexts")
                throw java.io.IOException("injected context revoke fsync failure")
            JvmOutboxFileOps().syncFile(file)
        }
    }
    private val epoch = AtomicInteger(1)
    private var consent = true
    private val allowed = object : OutboxAuthorization { override fun isAllowed() = consent && epoch.get() == 1 }
    private fun engine() = AndroidNativeRecovery(
        OutboxStore(File(folder.root, "contexts"), keys, ops, 8, 2 * 1024 * 1024),
        OutboxStore(File(folder.root, "prepared"), keys, ops, 8, 2 * 1024 * 1024))
    private class Platform(override val apiLevel: Int = 31) : AndroidNativeExitPlatform {
        override val pid = 99
        override val processName = "app"
        var historyCalls = 0
        var registrations = ArrayList<ByteArray?>()
        var beforeHistory: () -> Unit = {}
        override fun history(): List<AndroidNativeExit> { historyCalls++; beforeHistory(); return emptyList() }
        override fun setStateSummary(value: ByteArray?) { registrations.add(value) }
    }
    private fun template(): OutboxEntry {
        val id = UUID.randomUUID().toString()
        return OutboxEntry(id, 1000, """{"reportId":"$id","reporter":{},"payload":{}}""".toByteArray(), "template", emptyList(), "key", "https://example.test")
    }
    @Test fun `diagnostic mode supports API30 but never queries unsupported APIs`() {
        val unsupported = Platform(29)
        assertFalse(AndroidNativeRecoveryController(::engine, unsupported).enableDiagnostics(1, allowed, 1000, ::template) { true })
        assertEquals(0, unsupported.historyCalls)
        val platform = Platform(30)
        val controller = AndroidNativeRecoveryController(::engine, platform)
        assertTrue(controller.enableDiagnostics(1, allowed, 1000, ::template) { true })
        assertEquals(1, platform.historyCalls)
        assertEquals(1, platform.registrations.filterNotNull().size)
        controller.retire(1, true) { true }
        assertNull(platform.registrations.last())
        assertFalse(controller.ready(1))
    }
    @Test fun `mode change fences queued work and keeps exactly one active OS summary owner`() {
        val requests = AndroidNativeRecoveryRequests()
        val native = requests.request(1, true)
        val diagnostics = requests.request(1, true, diagnostics = true)
        assertFalse(requests.allows(native, 1, true))
        assertTrue(requests.allows(diagnostics, 1, true))
        assertTrue(requests.diagnosticsEnabled(1))
        assertEquals(diagnostics, requests.request(1, true, diagnostics = true))
        val platform = Platform()
        val controller = AndroidNativeRecoveryController(::engine, platform)
        assertTrue(controller.enable(1, allowed, 1000, ::template) { true })
        assertTrue(controller.enableDiagnostics(1, allowed, 1000, ::template) { true })
        assertEquals(2, platform.registrations.filterNotNull().size)
        assertEquals(1, platform.registrations.count { it == null })
        assertTrue(controller.enableDiagnostics(1, allowed, 1000, ::template) { true })
        assertEquals(2, platform.historyCalls)
        requests.request(1, false)
        assertFalse(requests.diagnosticsEnabled(1))
        assertFalse(requests.allows(diagnostics, 1, true))
    }
    @Test fun `fresh owner disable failure fences both journals before a later enable`() {
        var oldToken = byteArrayOf()
        engine().arm(template(), 99, "app", allowed) { oldToken = it }
        engine().recover(listOf(AndroidNativeExit(99, "app", 2000, 5, oldToken) { null }), 3000, allowed) { false }
        val controller = AndroidNativeRecoveryController(::engine, Platform())
        failContextRevoke = true
        try { controller.retire(1, true) { true }; fail("injected failure") }
        catch (_: OutboxWriteException) { }
        failContextRevoke = false
        var admitted = 0
        controller.enable(1, allowed, 4000, ::template) { admitted++; true }
        assertEquals("explicitly revoked prepared evidence must never be admitted", 0, admitted)
        controller.retire(1, true) { true }
        assertTrue(controller.enable(1, allowed, 5000, ::template) { admitted++; true })
        assertEquals(0, admitted)
    }
    @Test fun `explicit disable intent survives a barrier controlled false to true displacement`() {
        var oldToken = byteArrayOf()
        engine().arm(template(), 99, "app", allowed) { oldToken = it }
        engine().recover(listOf(AndroidNativeExit(99, "app", 2000, 5, oldToken) { null }), 3000, allowed) { false }
        val requests = AndroidNativeRecoveryRequests()
        val controller = AndroidNativeRecoveryController(::engine, Platform())
        val falseRequested = CountDownLatch(1)
        val trueRequested = CountDownLatch(1)
        val oldTail = Thread {
            val disabled = requests.request(1, false)
            falseRequested.countDown()
            check(trueRequested.await(5, TimeUnit.SECONDS))
            controller.retire(1, true) { requests.allows(disabled, 1, false) }
        }
        oldTail.start()
        assertTrue(falseRequested.await(5, TimeUnit.SECONDS))
        val enabled = requests.request(1, true)
        trueRequested.countDown()
        oldTail.join(5000)
        assertFalse(oldTail.isAlive)
        var erased = false
        val gate = object : OutboxAuthorization { override fun isAllowed() = requests.allows(enabled, 1, true) }
        assertTrue(requests.finishRevocation {
            erased = true
            controller.retire(1, true) { gate.isAllowed() }
            gate.isAllowed()
        })
        assertTrue("disable must survive its displaced physical cleanup", erased)
        assertTrue(controller.enable(1, gate, 4000, ::template) { error("disabled prepared evidence resurrected") })
    }
    @Test fun `explicit erasure failure remains pending while ordinary start retains prior process evidence`() {
        val requests = AndroidNativeRecoveryRequests()
        requests.boundary(1)
        assertTrue(requests.finishRevocation { error("ordinary start must not purge previous process") })
        requests.request(1, false)
        try { requests.finishRevocation { throw java.io.IOException("erase failed") }; fail() }
        catch (_: java.io.IOException) { }
        requests.request(2, true)
        var retried = false
        assertTrue(requests.finishRevocation { retried = true; true })
        assertTrue(retried)
        assertTrue(requests.finishRevocation { error("completed obligation should not erase fresh evidence") })
    }
    @Test fun `queued enable cannot survive explicit disable or a newer SDK start`() {
        val requests = AndroidNativeRecoveryRequests()
        val first = requests.request(1, true)
        assertTrue(requests.allows(first, 1, true))
        assertEquals(first, requests.request(1, true))
        val disabled = requests.request(1, false)
        assertFalse(requests.allows(first, 1, true))
        val next = requests.request(2, true)
        assertFalse(requests.allows(disabled, 1, false))
        assertEquals(-1L, requests.request(1, false))
        assertTrue(requests.allows(next, 2, true))
    }
    @Test fun `kill erasure survives a displaced cleanup and completes before the next registration`() {
        val platform = Platform()
        val controller = AndroidNativeRecoveryController(::engine, platform)
        val revocation = AndroidNativeRecoveryRevocation()
        assertTrue(controller.enable(1, allowed, 3000, ::template) { true })
        val old = platform.registrations.single()!!
        revocation.invalidate()
        epoch.set(2)
        assertFalse(revocation.finish { false }) // Old kill tail lost its SDK epoch.
        assertTrue(revocation.finish {
            controller.retire(2, true) { true }
            true
        })
        val newGate = object : OutboxAuthorization { override fun isAllowed() = epoch.get() == 2 }
        assertTrue(controller.enable(2, newGate, 4000, ::template) { true })
        assertFalse(old.contentEquals(platform.registrations.last()))
        assertEquals(0, engine().recover(listOf(AndroidNativeExit(99, "app", 2000, 5, old) { null }), 5000, newGate) { error("erased crash resurrected") })
        var repeated = false
        assertTrue(revocation.finish { repeated = true; true })
        assertFalse(repeated)
    }
    @Test fun `older APIs and disabled consent never open OS history or register state`() {
        for (api in listOf(24, 25, 30)) {
            val platform = Platform(api)
            val controller = AndroidNativeRecoveryController(::engine, platform)
            assertFalse(controller.enable(1, allowed, 3000, ::template) { true })
            assertEquals(0, platform.historyCalls)
            assertTrue(platform.registrations.isEmpty())
        }
        consent = false
        val platform = Platform()
        assertFalse(AndroidNativeRecoveryController(::engine, platform).enable(1, allowed, 3000, ::template) { true })
        assertEquals(0, platform.historyCalls)
    }
    @Test fun `repeated enable is idempotent and explicit disable clears state and encrypted context`() {
        val platform = Platform()
        val controller = AndroidNativeRecoveryController(::engine, platform)
        assertTrue(controller.enable(1, allowed, 3000, ::template) { true })
        assertTrue(controller.enable(1, allowed, 3001, ::template) { true })
        assertEquals(1, platform.registrations.size)
        controller.retire(1, erasePersisted = true) { true }
        assertNull(platform.registrations.last())
        assertTrue(OutboxStore(File(folder.root, "contexts"), keys, ops).snapshotTokens().isEmpty())
    }
    @Test fun `start boundary during OS history does not wait for OS and cannot rearm old state`() {
        val platform = Platform()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        platform.beforeHistory = { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) }
        val controller = AndroidNativeRecoveryController(::engine, platform)
        var result = true
        val worker = Thread { result = controller.enable(1, allowed, 3000, ::template) { true } }
        worker.start()
        try {
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            epoch.set(2)
            controller.retire(2, erasePersisted = false) { epoch.get() == 2 }
            assertTrue(platform.registrations.none { it != null })
        } finally { release.countDown(); worker.join(5000) }
        assertFalse(worker.isAlive)
        assertFalse(result)
        assertTrue(platform.registrations.none { it != null })
    }
    @Test fun `delayed older boundary does not erase newer registration`() {
        val platform = Platform()
        val controller = AndroidNativeRecoveryController(::engine, platform)
        assertTrue(controller.enable(3, allowed, 3000, ::template) { true })
        controller.retire(2, erasePersisted = true) { false }
        assertEquals(1, platform.registrations.size)
        assertNotNull(platform.registrations.single())
    }
}
