// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.health

import dev.everframe.config.ReleaseHealthConfig
import dev.everframe.outbox.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

class ReleaseHealthControllerTest {
    @get:Rule val folder = TemporaryFolder()
    private val keys = JceTestOutboxKeyProvider()
    private var failPurge = false
    private var failFactory = false
    private val allowed = object : OutboxAuthorization { override fun isAllowed() = true }
    private val ops = object : OutboxFileOps by JvmOutboxFileOps() {
        override fun syncFile(file: File) {
            if (failPurge && file.name == "kill.pending") throw IOException("purge sync blocked")
            JvmOutboxFileOps().syncFile(file)
        }
    }
    private fun store(): OutboxStore {
        if (failFactory) throw IOException("key/storage factory blocked")
        return OutboxStore(File(folder.root, "health"), keys, ops, 256, 1024 * 1024, maintenanceReserveBytes = 16384)
    }
    private fun controller() = ReleaseHealthController(::store, UUID.fromString("22222222-2222-4222-8222-222222222222"))
    private fun activate(owner: ReleaseHealthController, request: ReleaseHealthRequest, build: String = "build-A", key: String = "key-A"): Boolean =
        owner.activate(request, ReleaseHealthConfig(build), "test", key, "https://example.test/api/ingest/release-health", allowed, allowed)
    private fun builds() = store().snapshotTokens().mapNotNull { store().readIfPresent(it)?.entry }.map {
        Json.parseToJsonElement(it.envelopeBytes.toString(Charsets.UTF_8)).jsonObject["exposure"]!!.jsonObject["nativeRelease"]!!.jsonObject["buildId"]!!.jsonPrimitive.content
    }.sorted()
    @Test fun `request reserves a new segment before any ready pointer can be read`() {
        val owner = controller(); val a = owner.request(1, true)
        assertNull(owner.readyPointer(1)); assertTrue(activate(owner, a))
        val old = owner.readyPointer(1)!!
        val b = owner.request(2, true)
        assertNull(owner.readyPointer(1)); assertNull(owner.readyPointer(2))
        owner.finishBoundary(b)
        assertTrue(activate(owner, b, "build-B", "key-B"))
        val current = owner.readyPointer(2)!!
        assertEquals(old.processLaunchId, current.processLaunchId)
        assertNotEquals(old.exposureId, current.exposureId)
        assertEquals(listOf("build-A", "build-A", "build-B"), builds())
    }
    @Test fun `failed purge obligation survives disabled then enabled requests`() {
        val owner = controller(); assertTrue(activate(owner, owner.request(1, true)))
        failPurge = true
        val disabled = owner.request(2, false)
        assertNull(owner.readyPointer(1))
        assertFalse(owner.finishBoundary(disabled))
        val resumed = owner.request(3, true)
        assertFalse(activate(owner, resumed, "build-B")); assertNull(owner.readyPointer(3))
        failPurge = false
        assertTrue(activate(owner, resumed, "build-B"))
        assertEquals(listOf("build-B"), builds())
    }
    @Test fun `factory failure cannot forget a revocation before a later healthy start`() {
        val owner = controller(); assertTrue(activate(owner, owner.request(1, true)))
        failPurge = true; owner.finishBoundary(owner.request(2, false))
        failFactory = true; failPurge = false
        val resumed = owner.request(3, true)
        assertFalse(activate(owner, resumed, "build-B")); assertNull(owner.readyPointer(3))
        failFactory = false
        assertTrue(activate(owner, resumed, "build-B"))
        assertEquals(listOf("build-B"), builds())
    }
    @Test fun `disabled boundary without a journal creates no storage`() {
        val owner = controller()
        assertTrue(owner.finishBoundary(owner.request(1, false)))
        assertFalse(File(folder.root, "health").exists())
        assertTrue(activate(owner, owner.request(2, true)))
        assertEquals(listOf("build-A"), builds())
    }
    @Test fun `disabled boundary still erases a journal left by an earlier process`() {
        val earlier = controller(); assertTrue(activate(earlier, earlier.request(1, true)))
        val next = controller()
        assertTrue(next.finishBoundary(next.request(1, false)))
        assertEquals(emptyList<String>(), builds())
    }
    @Test fun `an old boundary cannot erase the newly admitted segment`() {
        val owner = controller(); assertTrue(activate(owner, owner.request(1, true)))
        val disabled = owner.request(2, false)
        val resumed = owner.request(3, true)
        assertTrue(activate(owner, resumed, "build-B"))
        owner.finishBoundary(disabled)
        assertEquals(listOf("build-B"), builds())
        assertNotNull(owner.readyPointer(3))
    }
    @Test fun `a stale append completion cannot replace a newer ready pointer`() {
        val entered = CountDownLatch(1); val release = CountDownLatch(1); val first = AtomicBoolean(true)
        val owner = ReleaseHealthController({
            if (first.compareAndSet(true, false)) { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) }
            store()
        })
        val a = owner.request(1, true)
        val oldResult = AtomicBoolean(true)
        val old = thread { oldResult.set(activate(owner, a)) }
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        val b = owner.request(2, true)
        release.countDown(); old.join(5000); assertFalse(old.isAlive); assertFalse(oldResult.get())
        assertTrue(activate(owner, b, "build-B"))
        assertEquals("build-B", owner.readyPointer(2)!!.nativeBuildId)
        assertEquals(listOf("build-B"), builds())
    }
    @Test fun `disabled request revokes every captured route before prepared transport starts`() = runBlocking {
        val owner = controller(); val a = owner.request(1, true); assertTrue(activate(owner, a))
        val b = owner.request(2, true); owner.finishBoundary(b); assertTrue(activate(owner, b, "build-B", "key-B"))
        var started = 0
        val transport = HealthTransport { _ ->
            val prepared = { started++; CompletableDeferred(201) }
            owner.request(3, false)
            prepared
        }
        val admission = HealthAdmission { allowed, request -> if (allowed()) request() else null }
        assertEquals(0, owner.flush(b, transport, admission)); assertEquals(0, started)
        assertNull(owner.readyPointer(2))
    }
}
