// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.health

import dev.everframe.config.ReleaseHealthConfig
import dev.everframe.config.ReleaseHealthBundleStatus
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

class ReleaseHealthProducerTest {
    @get:Rule val folder = TemporaryFolder()
    private val keys = JceTestOutboxKeyProvider()
    private val ops = JvmOutboxFileOps()
    private val launch = UUID.fromString("22222222-2222-4222-8222-222222222222")
    private var current = true
    private var consent = true
    private var now = 1_791_370_800_000L
    private var elapsed = 1_000_000_000L
    private val currentGate = object : OutboxAuthorization { override fun isAllowed() = current && consent }
    private val consentGate = object : OutboxAuthorization { override fun isAllowed() = consent }
    private val admission = HealthAdmission { allowed, request -> if (allowed()) request() else null }
    private fun store(maxEntries: Int = 256, maxBytes: Long = 1024 * 1024) =
        OutboxStore(File(folder.root, "health"), keys, ops, maxEntries, maxBytes, maintenanceReserveBytes = 1024)
    private fun producer(queue: OutboxStore = store(), config: ReleaseHealthConfig = ReleaseHealthConfig("native-build-A"),
                         key: String = "route-key-A", endpoint: String = "https://a.example/api/ingest/release-health") =
        ReleaseHealthProducer(queue, config, "test-sdk", key, endpoint, currentGate, consentGate,
            launch, { now }, { elapsed })
    private fun entries() = store().snapshotTokens().mapNotNull { store().readIfPresent(it)?.entry }
    private fun record(entry: OutboxEntry) = Json.parseToJsonElement(entry.envelopeBytes.toString(Charsets.UTF_8)).jsonObject

    @Test fun `provided subjects stay frozen through offline identity and bundle rotation`() {
        val first = producer(config = ReleaseHealthConfig("native", "bundle-a", ReleaseHealthBundleStatus.KNOWN, userId = "opaque-a"))
        assertTrue(first.start()); val a = first.readyPointer()!!; assertTrue(first.end())
        val next = producer(config = ReleaseHealthConfig("native", "bundle-b", ReleaseHealthBundleStatus.KNOWN, userId = "opaque-b"))
        assertTrue(next.start()); assertEquals(a.processLaunchId, next.readyPointer()!!.processLaunchId)
        val records = entries().map(::record)
        assertEquals(3, records.size)
        for (body in records) {
            assertEquals(2, body["schemaVersion"]!!.jsonPrimitive.int)
            val exposure = body["exposure"]!!.jsonObject
            assertEquals("launch-v1", exposure["sessionPolicy"]!!.jsonPrimitive.content)
            val expected = if (exposure["loadedBuildId"]!!.jsonPrimitive.content == "bundle-a") "opaque-a" else "opaque-b"
            assertEquals(buildJsonObject { put("kind", "provided"); put("id", expected) }, exposure["subject"])
        }
    }
    @Test fun `invalid supplied subject never publishes readiness`() {
        for (id in listOf("", " ", "x".repeat(129), "a\u0000", "\ud800")) {
            val owner = producer(config = ReleaseHealthConfig("native", userId = id))
            assertFalse(owner.start()); assertNull(owner.readyPointer())
        }
        assertTrue(entries().isEmpty())
        assertTrue(producer(config = ReleaseHealthConfig("native", userId = "x".repeat(128))).start())
    }
    @Test fun `readiness requires a committed anonymous start and encrypted route`() {
        val owner = producer()
        assertNull(owner.readyPointer())
        assertTrue(owner.start())
        val pointer = owner.readyPointer()!!
        val entry = entries().single()
        val body = record(entry)
        assertEquals("start", body["phase"]!!.jsonPrimitive.content)
        assertEquals(2, body["schemaVersion"]!!.jsonPrimitive.int)
        assertEquals(buildJsonObject { put("kind", "anonymous") }, body["exposure"]!!.jsonObject["subject"])
        assertEquals(0, body["sequence"]!!.jsonPrimitive.int)
        val exposure = body["exposure"]!!.jsonObject
        assertEquals(pointer.exposureId, exposure["exposureId"]!!.jsonPrimitive.content)
        assertEquals(launch.toString(), exposure["processLaunchId"]!!.jsonPrimitive.content)
        assertEquals("native-build-A", exposure["nativeRelease"]!!.jsonObject["buildId"]!!.jsonPrimitive.content)
        assertEquals(JsonNull, exposure["loadedBuildId"])
        assertEquals(JsonNull, exposure["coverage"]!!.jsonObject["priorQueueLosses"])
        assertEquals("unavailable", exposure["coverage"]!!.jsonObject["queueLossAccounting"]!!.jsonPrimitive.content)
        assertFalse(exposure.containsKey("pageLaunchId"))
        assertNull(entry.identitySubject)
        assertTrue(entry.attachmentRefs.isEmpty())
        val disk = folder.root.walkTopDown().filter { it.isFile }.joinToString { it.readBytes().toString(Charsets.ISO_8859_1) }
        assertFalse(disk.contains("route-key-A")); assertFalse(disk.contains("native-build-A"))
        assertTrue(owner.start())
        assertEquals(entry, entries().single())
    }
    @Test fun `full queue publishes no ready token and does not replace older records`() {
        val first = producer(store(maxEntries = 1)); assertTrue(first.start())
        val original = entries().single()
        val refused = producer(store(maxEntries = 1))
        assertFalse(refused.start()); assertNull(refused.readyPointer())
        assertEquals(original, entries().single())
    }
    @Test fun `interrupted small budget staging stays encrypted and later healthy writes recover`() {
        val initial = producer(); assertTrue(initial.start())
        val before = entries().single()
        val failedOps = object : OutboxFileOps by ops {
            override fun renameAtomic(from: File, to: File) { throw IOException("interrupted rename") }
        }
        val failedStore = OutboxStore(File(folder.root, "health"), keys, failedOps, 256, 1024 * 1024,
            maintenanceReserveBytes = 16 * 1024)
        val failed = producer(queue = failedStore, config = ReleaseHealthConfig("never-plaintext-build"))
        assertFalse(failed.start()); assertNull(failed.readyPointer())
        val disk = folder.root.walkTopDown().filter { it.isFile }.joinToString { it.readBytes().toString(Charsets.ISO_8859_1) }
        assertFalse(disk.contains("never-plaintext-build")); assertFalse(disk.contains("route-key-A"))
        val healthy = producer(); assertTrue(healthy.start())
        assertEquals(2, entries().size); assertTrue(entries().contains(before))
        assertFalse(folder.root.walkTopDown().any { it.name.endsWith(".tmp") })
    }
    @Test fun `invalid build and contradictory bundle do not admit an exposure`() {
        for (config in listOf(ReleaseHealthConfig(""), ReleaseHealthConfig("native", "downloaded", ReleaseHealthBundleStatus.UNKNOWN),
            ReleaseHealthConfig("native", null, ReleaseHealthBundleStatus.KNOWN), ReleaseHealthConfig("bad\u0000build"))) {
            val owner = producer(config = config)
            assertFalse(owner.start()); assertNull(owner.readyPointer())
        }
        assertTrue(entries().isEmpty())
    }
    @Test fun `same process restart creates separate immutable segments`() {
        val first = producer(); assertTrue(first.start())
        val a = first.readyPointer()!!
        elapsed += 2_000_000_000L; now += 2_000
        assertTrue(first.end())
        val next = producer(config = ReleaseHealthConfig("native-build-B"), key = "route-key-B", endpoint = "https://b.example/api/ingest/release-health")
        assertTrue(next.start())
        val b = next.readyPointer()!!
        assertEquals(a.processLaunchId, b.processLaunchId)
        assertNotEquals(a.exposureId, b.exposureId)
        assertEquals("native-build-A", a.nativeBuildId)
        val records = entries().map(::record)
        val end = records.single { it["phase"]!!.jsonPrimitive.content == "end" }
        assertEquals(a.exposureId, end["exposure"]!!.jsonObject["exposureId"]!!.jsonPrimitive.content)
        assertEquals(2000, end["elapsedMs"]!!.jsonPrimitive.int)
        assertEquals("sdk_stop", end["endReason"]!!.jsonPrimitive.content)
        assertTrue(first.end()); assertEquals(3, entries().size)
    }
    @Test fun `readiness cannot survive a stale SDK epoch or withdrawn consent`() {
        val owner = producer(); assertTrue(owner.start())
        current = false; assertNull(owner.readyPointer())
        consent = false; assertFalse(owner.end())
        assertEquals(1, entries().size)
    }
    @Test fun `retry preserves bytes and original route across new producer configuration`() = runBlocking {
        val first = producer(); assertTrue(first.start())
        val original = entries().single()
        val later = producer(config = ReleaseHealthConfig("native-build-B"), key = "route-key-B")
        val sent = mutableListOf<OutboxEntry>()
        var status = 503
        val transport = HealthTransport { entry -> { sent.add(entry); CompletableDeferred(status) } }
        assertEquals(0, later.flush(transport, admission))
        assertEquals(original, sent.single())
        status = 201
        assertEquals(1, later.flush(transport, admission))
        assertEquals(sent[0], sent[1]); assertTrue(entries().isEmpty())
    }
    @Test fun `late consent withdrawal vetoes prepared HTTP admission`() = runBlocking {
        val owner = producer(); assertTrue(owner.start())
        var requests = 0
        val transport = HealthTransport { _ ->
            val prepared = { requests++; CompletableDeferred(201) }
            consent = false
            prepared
        }
        assertEquals(0, owner.flush(transport, admission))
        assertEquals(0, requests)
    }
    @Test fun `seven day local expiry is pruned before a healthy append`() {
        assertTrue(producer().start())
        now += 7L * 24 * 60 * 60 * 1000 + 1
        val fresh = producer(config = ReleaseHealthConfig("native-build-B")); assertTrue(fresh.start())
        assertEquals(fresh.readyPointer()!!.exposureId, record(entries().single())["exposure"]!!.jsonObject["exposureId"]!!.jsonPrimitive.content)
    }
    @Test fun `shared journal enforces the record count across producer instances`() {
        assertTrue(producer().start())
        val seed = entries().single()
        // Populate the encrypted boundary directly: repeatedly pruning every earlier entry
        // would turn this capacity check into tens of thousands of unrelated directory syncs.
        repeat(254) {
            val id = UUID.randomUUID().toString()
            val original = record(seed)
            val body = buildJsonObject {
                for ((key, value) in original) put(key, value)
                put("recordId", id)
                put("exposure", buildJsonObject {
                    for ((key, value) in original["exposure"]!!.jsonObject) put(key, value)
                    put("exposureId", UUID.randomUUID().toString())
                })
            }.toString().toByteArray(Charsets.UTF_8)
            store().enqueueSync(seed.copy(reportId = id, idempotencyKey = id, envelopeBytes = body), currentGate)
        }
        assertTrue(producer().start())
        val refused = producer(); assertFalse(refused.start()); assertNull(refused.readyPointer())
        assertEquals(256, entries().size)
    }
    @Test fun `shared journal byte budget fails closed without evicting owner`() {
        val first = producer(store(maxBytes = 16384)); assertTrue(first.start())
        val original = entries().single()
        var refused = false
        repeat(30) { if (!producer(store(maxBytes = 16384)).start()) refused = true }
        assertTrue(refused)
        assertTrue(entries().contains(original))
    }
}
