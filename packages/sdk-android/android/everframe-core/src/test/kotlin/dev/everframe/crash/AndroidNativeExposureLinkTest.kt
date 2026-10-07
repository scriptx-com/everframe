// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import dev.everframe.config.ReleaseHealthConfig
import dev.everframe.health.*
import dev.everframe.outbox.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

class AndroidNativeExposureLinkTest {
    @get:Rule val folder = TemporaryFolder()
    private val keys = JceTestOutboxKeyProvider()
    private val ops = JvmOutboxFileOps()
    private val launch = UUID.fromString("22222222-2222-4222-8222-222222222222")
    private val allowed = object : OutboxAuthorization { override fun isAllowed() = true }
    private fun store(name: String) = OutboxStore(File(folder.root, name), keys, ops, 8, 2 * 1024 * 1024)
    private fun engine() = AndroidNativeRecovery(store("contexts"), store("prepared"))
    private fun producer(build: String = "native-A") = ReleaseHealthProducer(store("health"), ReleaseHealthConfig(build),
        "test", "key-A", "https://a.example", allowed, allowed, launch, { 1000 }, { 0 })
    private fun template() = UUID.randomUUID().toString().let { id -> OutboxEntry(id, 1000,
        """{"reportId":"$id","submittedAt":"1970-01-01T00:00:01Z","context":{"app":{"name":"A","version":"1","build":"17"}},"reporter":{"title":"","description":""},"payload":{}}""".toByteArray(),
        "template", emptyList(), "key-A", "https://a.example") }
    private fun recover(token: ByteArray, reason: Int = 6, diagnostics: Boolean = true): JsonObject {
        val records = ArrayList<OutboxEntry>()
        assertEquals(1, engine().recover(listOf(AndroidNativeExit(99, "app", 2000, reason, token) { null }), 3000, allowed,
            allowDiagnostics = diagnostics) { records.add(it); true })
        assertEquals("key-A", records.single().sdkKey)
        assertEquals("https://a.example", records.single().endpoint)
        return Json.parseToJsonElement(records.single().envelopeBytes.toString(Charsets.UTF_8)).jsonObject
    }
    @Test fun `ANR recovery uses the prior durable exposure despite a new segment becoming ready`() {
        val old = producer(); assertTrue(old.start()); val pointer = old.readyPointer()!!
        var token = byteArrayOf()
        engine().arm(template(), 99, "app", allowed, diagnostics = true, processLaunchId = launch.toString(), apiLevel = 35,
            nativeExposure = pointer) { token = it }
        val next = producer("native-B"); assertTrue(next.start())
        assertNotEquals(pointer.exposureId, next.readyPointer()!!.exposureId)
        val body = recover(token)
        val diagnostic = body["payload"]!!.jsonObject["diagnostic"]!!.jsonObject
        assertEquals(pointer.toJson(), diagnostic["nativeExposure"])
        assertEquals("anr", diagnostic["cause"]!!.jsonPrimitive.content)
        assertEquals("diagnostic", body["source"]!!.jsonPrimitive.content)
    }
    @Test fun `native only mode carries one exact pointer without admitting other exit causes`() {
        val owner = producer(); assertTrue(owner.start()); val pointer = owner.readyPointer()!!
        var token = byteArrayOf()
        engine().arm(template(), 99, "app", allowed, processLaunchId = launch.toString(), apiLevel = 35,
            nativeExposure = pointer) { token = it }
        val body = recover(token, reason = 5, diagnostics = false)
        val payload = body["payload"]!!.jsonObject
        assertEquals("crash", body["source"]!!.jsonPrimitive.content)
        assertEquals(pointer.toJson(), payload["diagnostic"]!!.jsonObject["nativeExposure"])
        assertNotNull(payload["crash"])
        assertEquals(0, engine().recover(emptyList(), 4000, allowed) { error("duplicate") })
    }
    @Test fun `arm before health readiness stays unavailable after a later successful append`() {
        val owner = producer(); assertNull(owner.readyPointer())
        var token = byteArrayOf()
        engine().arm(template(), 99, "app", allowed, diagnostics = true, processLaunchId = launch.toString(), apiLevel = 35,
            nativeExposure = owner.readyPointer()) { token = it }
        assertTrue(owner.start())
        assertFalse(recover(token)["payload"]!!.jsonObject["diagnostic"]!!.jsonObject.containsKey("nativeExposure"))
    }
    @Test fun `enriched native only context still excludes ANR exits`() {
        val owner = producer(); assertTrue(owner.start())
        var token = byteArrayOf()
        engine().arm(template(), 99, "app", allowed, processLaunchId = launch.toString(), apiLevel = 35,
            nativeExposure = owner.readyPointer()) { token = it }
        assertEquals(0, engine().recover(listOf(AndroidNativeExit(99, "app", 2000, 6, token) { null }), 3000,
            allowed, allowDiagnostics = false) { error("native-only mode admitted ANR") })
    }
    @Test fun `foreign process pointer is refused before the OS token is registered`() {
        val owner = producer(); assertTrue(owner.start())
        var registered = false
        try {
            engine().arm(template(), 99, "app", allowed, diagnostics = true, processLaunchId = UUID.randomUUID().toString(), apiLevel = 35,
                nativeExposure = owner.readyPointer()) { registered = true }
            fail("foreign process pointer accepted")
        } catch (_: IllegalArgumentException) { }
        assertFalse(registered); assertTrue(store("contexts").snapshotTokens().isEmpty())
    }
    @Test fun `health opt out after pointer read prevents a new E8 admission using the cached pointer`() {
        val epoch = AtomicInteger(1)
        val health = ReleaseHealthController({ store("health") }, launch)
        assertTrue(health.activate(health.request(1, true), ReleaseHealthConfig("native-A"), "test", "key-A",
            "https://a.example", allowed, allowed))
        val selected = CountDownLatch(1); val resume = CountDownLatch(1)
        val registered = AtomicBoolean(false); val result = AtomicBoolean(true)
        val platform = object : AndroidNativeExitPlatform {
            override val apiLevel = 35; override val pid = 99; override val processName = "app"
            override fun history() = emptyList<AndroidNativeExit>()
            override fun setStateSummary(value: ByteArray?) { if (value != null) registered.set(true) }
        }
        val native = AndroidNativeRecoveryController(::engine, platform, launch.toString(), exposure = { requested ->
            val cached = health.readyPointer(requested)
            selected.countDown(); check(resume.await(5, TimeUnit.SECONDS))
            cached
        })
        val gate = object : OutboxAuthorization { override fun isAllowed() = epoch.get() == 1 }
        val worker = thread { result.set(native.enableDiagnostics(1, gate, 1000, ::template) { true }) }
        try {
            assertTrue(selected.await(5, TimeUnit.SECONDS))
            // Everframe reserves the new SDK epoch and health revocation under one authority lock.
            epoch.set(2); health.request(2, false)
            assertNull(health.readyPointer(1)); assertNull(health.readyPointer(2))
        } finally { resume.countDown(); worker.join(5000) }
        assertFalse(worker.isAlive); assertFalse(result.get()); assertFalse(registered.get())
        assertTrue(store("contexts").snapshotTokens().isEmpty())
    }
}
