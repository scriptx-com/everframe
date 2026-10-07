// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import dev.everframe.outbox.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.io.File
import java.util.UUID

class AndroidNativeRecoveryTest {
    @get:Rule val folder = TemporaryFolder()
    private val keys = JceTestOutboxKeyProvider()
    private var failContextRemoval = false
    private val ops = object : OutboxFileOps by JvmOutboxFileOps() {
        override fun syncDirectory(dir: File) {
            JvmOutboxFileOps().syncDirectory(dir)
            if (failContextRemoval && dir.name == "active" && dir.parentFile?.name == "contexts" && dir.listFiles().orEmpty().none { it.extension == "txq" }) {
                failContextRemoval = false
                throw java.io.IOException("interrupted source removal sync")
            }
        }
    }
    private val allowed = object : OutboxAuthorization { override fun isAllowed() = true }
    private fun store(name: String, maxEntries: Int = 8) = OutboxStore(File(folder.root, name), keys, ops, maxEntries, 2 * 1024 * 1024)
    private fun recovery() = AndroidNativeRecovery(store("contexts"), store("prepared"))
    private fun template(id: String = UUID.randomUUID().toString()) = OutboxEntry(id, 1000,
        """{"reportId":"$id","submittedAt":"2026-10-07T18:00:00Z","context":{"app":{"name":"old","version":"1.2","build":"17"}},"reporter":{"title":"","description":""},"payload":{}}""".toByteArray(),
        "template", emptyList(), "old-key", "https://old.example")
    private fun record(token: ByteArray, reason: Int = 5, pid: Int = 99, process: String = "app", time: Long = 2000, trace: (() -> java.io.InputStream?) = { null }) =
        AndroidNativeExit(pid, process, time, reason, token, trace)
    private fun arm(engine: AndroidNativeRecovery, value: OutboxEntry = template()): Pair<OutboxEntry, ByteArray> {
        var token = byteArrayOf()
        engine.arm(value, 99, "app", allowed) { token = it }
        return value to token
    }
    @Test fun `registers only opaque token after durable encrypted context admission`() {
        val engine = recovery()
        val value = template()
        engine.arm(value, 99, "app", allowed) { token ->
            assertTrue(token.size <= 128)
            assertFalse(token.toString(Charsets.UTF_8).contains("old"))
            assertEquals(1, store("contexts").snapshotTokens().size)
            val files = folder.root.walkTopDown().filter { it.isFile }.map { it.readBytes().toString(Charsets.ISO_8859_1) }.joinToString()
            assertFalse(files.contains("old-key"))
            assertFalse(files.contains("https://old.example"))
        }
    }
    @Test fun `relaunch preserves destination release report id and anonymous attribution`() {
        val (value, token) = arm(recovery())
        val accepted = ArrayList<OutboxEntry>()
        assertEquals(1, recovery().recover(listOf(record(token)), 3000, allowed) { accepted.add(it); true })
        val report = accepted.single()
        assertEquals(value.reportId, report.reportId)
        assertEquals("old-key", report.sdkKey)
        assertEquals("https://old.example", report.endpoint)
        assertNull(report.identitySubject)
        val json = Json.parseToJsonElement(report.envelopeBytes.toString(Charsets.UTF_8)).jsonObject
        assertEquals("1.2", json["context"]!!.jsonObject["app"]!!.jsonObject["version"]!!.jsonPrimitive.content)
        val crash = json["payload"]!!.jsonObject["crash"]!!.jsonObject
        assertEquals("1970-01-01T00:00:02Z", crash["occurredAt"]!!.jsonPrimitive.content)
        assertTrue(crash["fatal"]!!.jsonPrimitive.boolean)
        assertFalse(crash["handled"]!!.jsonPrimitive.boolean)
        assertEquals(0, recovery().recover(listOf(record(token)), 4000, allowed) { error("duplicate") })
    }
    @Test fun `failed admission retains frozen prepared bytes when trace later changes`() {
        val (_, token) = arm(recovery())
        var first: OutboxEntry? = null
        assertEquals(0, recovery().recover(listOf(record(token)), 3000, allowed) { first = it; false })
        assertEquals(1, store("contexts").snapshotTokens().size)
        assertEquals(1, store("prepared").snapshotTokens().size)
        assertEquals(1, recovery().recover(emptyList(), 4000, allowed) { assertEquals(first, it); true })
        assertEquals(0, store("contexts").snapshotTokens().size)
        assertEquals(0, store("prepared").snapshotTokens().size)
    }
    @Test fun `interrupted source removal retains final receipt and reconciles identical payload`() {
        val (_, token) = arm(recovery())
        var accepted: OutboxEntry? = null
        try {
            recovery().recover(listOf(record(token)), 3000, allowed) { accepted = it; failContextRemoval = true; true }
            fail("injected source sync interruption")
        } catch (_: OutboxWriteException) { }
        assertEquals(1, store("prepared").snapshotTokens().size)
        assertEquals(1, recovery().recover(emptyList(), 4000, allowed) { assertEquals(accepted, it); true })
        assertTrue(store("prepared").snapshotTokens().isEmpty())
    }
    @Test fun `expired and unmatched history never become a current-session crash`() {
        val (_, token) = arm(recovery())
        assertEquals(0, recovery().recover(listOf(record(token)), 15L * 24 * 60 * 60 * 1000, allowed) { error("expired") })
        assertTrue(store("contexts").snapshotTokens().isEmpty())
    }
    @Test fun `different token pid process and earlier death never adopt current context`() {
        val (_, token) = arm(recovery())
        for (exit in listOf(record(byteArrayOf(1)), record(token, pid = 100), record(token, process = "other"), record(token, time = 999))) {
            assertEquals(0, recovery().recover(listOf(exit), 3000, allowed) { error("mismatched") })
        }
        assertEquals(1, store("contexts").snapshotTokens().size)
    }
    @Test fun `non native exit with stale ANR trace produces no native report`() {
        val (_, token) = arm(recovery())
        var traceRead = false
        assertEquals(0, recovery().recover(listOf(record(token, reason = 6, trace = { traceRead = true; null })), 3000, allowed) { error("not native") })
        assertFalse(traceRead)
        assertTrue(store("contexts").snapshotTokens().isEmpty())
    }
    @Test fun `ambiguous matched history is not guessed`() {
        val (_, token) = arm(recovery())
        assertEquals(0, recovery().recover(listOf(record(token), record(token, time = 2001)), 3000, allowed) { error("ambiguous") })
    }
    @Test fun `revocation during trace read prevents admission and registration failure remains safe`() {
        var live = true
        val gate = object : OutboxAuthorization { override fun isAllowed() = live }
        val engine = recovery()
        val (_, token) = arm(engine)
        assertEquals(0, engine.recover(listOf(record(token, trace = { live = false; ByteArrayInputStream(byteArrayOf(1)) })), 3000, gate) { error("revoked") })
        engine.revoke()
        assertEquals(0, recovery().recover(listOf(record(token)), 4000, allowed) { error("revoked persisted") })
        try { recovery().arm(template(), 99, "app", allowed) { throw IllegalStateException("binder") }; fail() }
        catch (_: IllegalStateException) { }
        assertTrue(store("contexts").snapshotTokens().isEmpty())
    }
    @Test fun `bounded context storage refuses registration when full`() {
        val engine = AndroidNativeRecovery(store("contexts", 1), store("prepared"))
        arm(engine)
        var registered = false
        try { engine.arm(template(), 99, "app", allowed) { registered = true }; fail() }
        catch (_: OutboxWriteException) { }
        assertFalse(registered)
    }
    @Test fun `malformed and missing tombstones remain explicit raw native outcomes`() {
        for (trace in listOf<() -> java.io.InputStream?>({ null }, { ByteArrayInputStream(byteArrayOf(0)) }, { throw java.io.IOException("gone") })) {
            val (_, token) = arm(recovery())
            assertEquals(1, recovery().recover(listOf(record(token, trace = trace)), 3000, allowed) {
                val crash = Json.parseToJsonElement(it.envelopeBytes.toString(Charsets.UTF_8)).jsonObject["payload"]!!.jsonObject["crash"]!!.jsonObject
                assertTrue(crash["frames"]!!.jsonArray.isEmpty())
                assertTrue(crash["message"]!!.jsonPrimitive.content.contains("tombstone unavailable"))
                assertNull(crash["androidNative"])
                true
            })
        }
    }
}
