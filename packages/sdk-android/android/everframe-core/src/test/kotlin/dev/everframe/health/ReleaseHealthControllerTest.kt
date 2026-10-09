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
    private var afterRename: () -> Unit = {}
    private val allowed = object : OutboxAuthorization { override fun isAllowed() = true }
    private val ops = object : OutboxFileOps by JvmOutboxFileOps() {
        override fun syncFile(file: File) {
            if (failPurge && file.name == "kill.pending") throw IOException("purge sync blocked")
            JvmOutboxFileOps().syncFile(file)
        }
        override fun renameAtomic(from: File, to: File) {
            JvmOutboxFileOps().renameAtomic(from, to)
            afterRename()
        }
    }
    private fun store(): OutboxStore {
        if (failFactory) throw IOException("key/storage factory blocked")
        return OutboxStore(File(folder.root, "health"), keys, ops, 256, 1024 * 1024, maintenanceReserveBytes = 16384)
    }
    private fun controller() = ReleaseHealthController(::store, UUID.fromString("22222222-2222-4222-8222-222222222222"), initiallyForeground = true)
    private fun activate(owner: ReleaseHealthController, request: ReleaseHealthRequest, build: String = "build-A", key: String = "key-A"): Boolean =
        owner.activate(request, ReleaseHealthConfig(build), "test", key, "https://example.test/api/ingest/release-health", allowed, allowed)
    private fun builds() = store().snapshotTokens().mapNotNull { store().readIfPresent(it)?.entry }.map {
        Json.parseToJsonElement(it.envelopeBytes.toString(Charsets.UTF_8)).jsonObject["exposure"]!!.jsonObject["nativeRelease"]!!.jsonObject["buildId"]!!.jsonPrimitive.content
    }.sorted()
    @Test fun `initial background never persists a start and reentry rotates the pointer`() {
        val owner = ReleaseHealthController(::store)
        val request = owner.request(1, true)
        assertFalse(activate(owner, request)); assertNull(owner.readyPointer(1))
        assertFalse(File(folder.root, "health").exists())
        owner.foreground(request, true)
        assertTrue(activate(owner, request))
        val first = owner.readyPointer(1)!!
        val closed = owner.foreground(request, false)!!
        assertNull(owner.readyPointer(1)) // Memory fence precedes any IO.
        assertNull(owner.foreground(request, false))
        assertTrue(closed.end("background"))
        assertFalse(activate(owner, request))
        owner.foreground(request, true)
        assertTrue(activate(owner, request))
        assertNotEquals(first.exposureId, owner.readyPointer(1)!!.exposureId)
        assertEquals(3, builds().size)
    }
    @Test fun `stale lifecycle callbacks cannot revive revoked generations`() {
        val owner = controller(); val prior = owner.request(1, true)
        assertTrue(activate(owner, prior))
        val revoked = owner.request(2, false)
        owner.foreground(prior, true)
        owner.foreground(prior, false)
        assertFalse(activate(owner, prior))
        assertTrue(owner.finishBoundary(revoked))
        assertNull(owner.readyPointer(1)); assertTrue(builds().isEmpty())
    }
    @Test fun `background snapshot survives reconfiguration before its IO end runs`() {
        val owner = controller(); val a = owner.request(1, true)
        assertTrue(activate(owner, a))
        val closed = owner.foreground(a, false)!!
        owner.rememberForegroundBoundary(closed)
        val b = owner.request(2, true)
        assertTrue(owner.finishBoundary(b)); assertTrue(activate(owner, b, "build-B"))
        owner.finishForegroundBoundary(closed)
        val records = store().let { queue -> queue.snapshotTokens().map { queue.readIfPresent(it)!!.entry } }
            .map { Json.parseToJsonElement(it.envelopeBytes.toString(Charsets.UTF_8)).jsonObject }
        assertEquals(3, records.size)
        assertEquals("background", records.single { it["phase"]!!.jsonPrimitive.content == "end" }["endReason"]!!.jsonPrimitive.content)
    }
    @Test fun `rapid foreground background callbacks fence a blocked durable start`() {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val owner = ReleaseHealthController({ entered.countDown(); check(release.await(5, TimeUnit.SECONDS)); store() })
        val request = owner.request(1, true); owner.foreground(request, true)
        val result = AtomicBoolean(true)
        val worker = thread { result.set(activate(owner, request)) }
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        owner.foreground(request, false)
        release.countDown(); worker.join(5000)
        assertFalse(worker.isAlive); assertFalse(result.get()); assertNull(owner.readyPointer(1))
        assertTrue(builds().isEmpty())
        owner.foreground(request, true); assertTrue(activate(owner, request))
    }
    /** Runs [boundary] at the first authorization check after the start record's rename commits it. */
    private fun committedThen(boundary: () -> Unit): OutboxAuthorization {
        var committed = false; var fired = false
        afterRename = { committed = true }
        return object : OutboxAuthorization {
            override fun isAllowed(): Boolean {
                if (committed && !fired) { fired = true; boundary() }
                return true
            }
        }
    }
    private fun records() = store().let { queue -> queue.snapshotTokens().map { queue.readIfPresent(it)!!.entry } }
        .map { Json.parseToJsonElement(it.envelopeBytes.toString(Charsets.UTF_8)).jsonObject }
    private fun JsonObject.text(key: String) = getValue(key).jsonPrimitive.content
    @Test fun `background landing after the durable start commit still ends that start`() {
        val owner = ReleaseHealthController(::store, UUID.fromString("22222222-2222-4222-8222-222222222222"))
        val request = owner.request(1, true); owner.foreground(request, true)
        val gate = committedThen { owner.foreground(request, false) }
        assertFalse(owner.activate(request, ReleaseHealthConfig("build-A"), "test", "key-A",
            "https://example.test/api/ingest/release-health", gate, gate))
        assertNull(owner.readyPointer(1))
        owner.finishBoundary(request)
        val records = records()
        assertEquals(listOf("end", "start"), records.map { it.text("phase") }.sorted())
        assertEquals(1, records.map { it["exposure"]!!.jsonObject.text("exposureId") }.toSet().size)
        assertEquals("background", records.single { it.text("phase") == "end" }.text("endReason"))
    }
    @Test fun `reconfiguration landing after the durable start commit ends that start as sdk_stop`() {
        val owner = controller(); val a = owner.request(1, true)
        lateinit var b: ReleaseHealthRequest
        val gate = committedThen { b = owner.request(2, true) }
        assertFalse(owner.activate(a, ReleaseHealthConfig("build-A"), "test", "key-A",
            "https://example.test/api/ingest/release-health", gate, gate))
        assertTrue(owner.finishBoundary(b))
        val records = records()
        assertEquals(listOf("end", "start"), records.map { it.text("phase") }.sorted())
        assertEquals("sdk_stop", records.single { it.text("phase") == "end" }.text("endReason"))
    }
    @Test fun `an independent flush cannot complete background before native attribution is cleared`() {
        val owner = controller(); val request = owner.request(1, true)
        assertTrue(activate(owner, request))
        val closed = owner.foreground(request, false)!!
        owner.finishBoundary(request)
        assertEquals(1, builds().size)
        owner.rememberForegroundBoundary(closed) // Runtime calls this after clearing actual native contexts.
        owner.finishBoundary(request)
        assertEquals(2, builds().size)
    }
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
        owner.foreground(a, true)
        val oldResult = AtomicBoolean(true)
        val old = thread { oldResult.set(activate(owner, a)) }
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        val b = owner.request(2, true)
        owner.foreground(b, true)
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
