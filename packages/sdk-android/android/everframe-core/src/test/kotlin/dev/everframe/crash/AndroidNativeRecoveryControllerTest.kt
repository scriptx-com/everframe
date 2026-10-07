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
    private val ops = JvmOutboxFileOps()
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
