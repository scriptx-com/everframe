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
    private fun v(value: Long): ByteArray {
        var n = value
        val result = ArrayList<Byte>()
        do { val part = (n and 127).toInt(); n = n ushr 7; result.add((part or if (n != 0L) 128 else 0).toByte()) } while (n != 0L)
        return result.toByteArray()
    }
    private fun n(field: Int, value: Long) = v(field * 8L) + v(value)
    private fun b(field: Int, value: ByteArray) = v(field * 8L + 2) + v(value.size.toLong()) + value
    private class Frame(val path: String, val relativePc: Long, val buildId: String? = null)
    /** debuggerd tombstone for pid 99 whose crashed thread 42 holds [frames], innermost first. */
    private fun tombstone(signal: Int, vararg frames: Frame) = n(1, 1) + n(5, 99) + n(6, 42) + b(10, n(1, signal.toLong())) +
        b(16, n(1, 42) + b(2, frames.fold(n(1, 42)) { all, f -> all + b(4, n(1, f.relativePc) + n(2, f.relativePc + 0x7000000000) +
            b(6, f.path.toByteArray()) + (f.buildId?.let { b(8, it.toByteArray()) } ?: byteArrayOf())) }))
    private fun recoveredCrash(exit: (ByteArray) -> AndroidNativeExit): JsonObject {
        val (_, token) = arm(recovery())
        var crash: JsonObject? = null
        assertEquals(1, recovery().recover(listOf(exit(token)), 3000, allowed) {
            crash = Json.parseToJsonElement(it.envelopeBytes.toString(Charsets.UTF_8)).jsonObject["payload"]!!.jsonObject["crash"]!!.jsonObject
            true
        })
        return crash!!
    }
    private fun recoveredCrash(trace: ByteArray) = recoveredCrash { record(it, trace = { ByteArrayInputStream(trace) }) }
    private fun fingerprint(trace: ByteArray) = recoveredCrash(trace)["fingerprint"]!!.jsonPrimitive.content
    private val apk = "/data/app/~~seed==/dev.example-key==/base.apk!libfault.so"
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
    private val day = 24L * 60 * 60 * 1000
    @Test fun `an unmatched context expires 14 days away from its creation in either clock direction`() {
        val (_, kept) = arm(recovery())
        assertEquals(0, recovery().recover(emptyList(), 1000 + 13 * day, allowed) { error("unmatched") })
        assertEquals(0, recovery().recover(emptyList(), 1000 - 13 * day, allowed) { error("unmatched") })
        assertEquals("within 14 days either way it stays", 1, store("contexts").snapshotTokens().size)
        assertEquals(0, recovery().recover(listOf(record(byteArrayOf(1))), 1000 + 15 * day, allowed) { error("unmatched") })
        assertTrue(store("contexts").snapshotTokens().isEmpty())
        arm(recovery(), template().copy(createdAt = 20 * day)) // armed while the clock ran ahead
        assertEquals(0, recovery().recover(emptyList(), 2 * day, allowed) { error("unmatched") })
        assertTrue("a clock behind by more than 14 days must not keep it forever", store("contexts").snapshotTokens().isEmpty())
        assertTrue(kept.isNotEmpty())
    }
    @Test fun `a forward clock jump never drops a crash before it is reported`() {
        // Armed at the box's build-date clock, crashed after network time set it 56 years later.
        val (entry, token) = arm(recovery())
        val now = 56L * 365 * day
        var admitted: OutboxEntry? = null
        assertEquals(1, recovery().recover(listOf(record(token, time = now - 1000)), now, allowed) { admitted = it; true })
        assertEquals(entry.reportId, admitted!!.reportId)
    }
    @Test fun `a backward clock jump still matches the crash by its exact token`() {
        // Armed while the clock ran 20 days ahead; the crash happened after it was corrected.
        val (entry, token) = arm(recovery(), template().copy(createdAt = 20 * day))
        var admitted: OutboxEntry? = null
        assertEquals(1, recovery().recover(listOf(record(token, time = 2000)), 3000, allowed) { admitted = it; true })
        assertEquals(entry.reportId, admitted!!.reportId)
    }
    @Test fun `different token pid or process never adopt current context`() {
        val (_, token) = arm(recovery())
        for (exit in listOf(record(byteArrayOf(1)), record(token, pid = 100), record(token, process = "other"))) {
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
    @Test fun `bounded context storage frees the oldest slot instead of refusing registration`() {
        val engine = AndroidNativeRecovery(store("contexts", 1), store("prepared"))
        val (first, _) = arm(engine)
        var registered = false
        var reclaimed: Pair<Int, Int>? = null
        val second = template()
        engine.arm(second, 99, "app", allowed, onReclaimed = { u, o -> reclaimed = u to o }) { registered = true }
        assertTrue(registered)
        assertEquals(0 to 1, reclaimed)
        val left = store("contexts", 1).let { s -> s.snapshotTokens().map { s.readIfPresent(it)!!.entry.reportId } }
        assertEquals(listOf(second.reportId), left)
        assertNotEquals(first.reportId, second.reportId)
    }
    @Test fun `one app crash site keeps one fingerprint across OS ART and dexopt builds`() {
        fun segv(art: String, artPc: Long, dex: String) = tombstone(11,
            Frame(apk, 0x704, "2f753e29"), Frame(apk, 0x6f4, "2f753e29"),
            Frame("/system/framework/arm64/boot.oat", artPc, art), Frame("/apex/com.android.art/lib64/libart.so", artPc + 0x6e0000, art),
            Frame("/data/app/~~seed==/dev.example-key==/oat/arm64/$dex", 0xd309c))
        val reference = recoveredCrash(segv("73f9b9fa", 0x9c3a0, "base.vdex"))
        assertEquals(reference["fingerprint"], recoveredCrash(segv("1b9fecf8", 0x9d000, "base.odex"))["fingerprint"])
        val evidence = reference["androidNative"]!!.jsonObject["frames"]!!.jsonArray.map { it.jsonObject }
        assertEquals(5, evidence.size)
        assertEquals("73f9b9fa", evidence[2]["buildId"]!!.jsonPrimitive.content) // Raw evidence keeps OS identity.
        fun abort(libc: String, pc: Long) = tombstone(6,
            Frame("/apex/com.android.runtime/lib64/bionic/libc.so", pc, libc), Frame(apk, 0x718, "2f753e29"))
        assertEquals(fingerprint(abort("1b9fecf8", 0xbd448)), fingerprint(abort("dcb9fe2b", 0xbe000)))
        val extracted = "/data/app/~~seed==/dev.example-key==/lib/arm64/libfault.so"
        fun system(build: String, pc: Long) = tombstone(11, Frame("/system/lib64/libandroid_runtime.so", pc, build), Frame(extracted, 0x30, "aa"))
        assertEquals(fingerprint(system("01", 0x10)), fingerprint(system("02", 0x90)))
    }
    @Test fun `distinct app crash sites and signals keep distinct fingerprints`() {
        val site = fingerprint(tombstone(11, Frame(apk, 0x704, "2f753e29"), Frame("/apex/com.android.art/lib64/libart.so", 0x10, "dc")))
        assertNotEquals(site, fingerprint(tombstone(11, Frame(apk, 0x6f4, "2f753e29"), Frame("/apex/com.android.art/lib64/libart.so", 0x10, "dc"))))
        assertNotEquals(site, fingerprint(tombstone(6, Frame(apk, 0x704, "2f753e29"), Frame("/apex/com.android.art/lib64/libart.so", 0x10, "dc"))))
        // Without app frames, the crashing module identifies the group across OS builds.
        fun hwui(build: String, pc: Long) = tombstone(11, Frame("/system/lib64/libhwui.so", pc, build), Frame("/apex/com.android.runtime/lib64/bionic/libc.so", pc, build))
        assertEquals(fingerprint(hwui("0a", 0x100)), fingerprint(hwui("0b", 0x200)))
        assertNotEquals(fingerprint(hwui("0a", 0x100)), fingerprint(tombstone(11, Frame("/vendor/lib64/egl/libGLESv2_adreno.so", 0x100, "0a"))))
    }
    @Test fun `tombstone-less native exits group by the OS-reported signal`() {
        fun missing(status: Int) = recoveredCrash { AndroidNativeExit(99, "app", 2000, 5, it, { null }, status) }
        val segv = missing(11)
        assertEquals("Native signal 11", segv["exceptionType"]!!.jsonPrimitive.content)
        assertEquals(segv["fingerprint"], missing(11)["fingerprint"])
        assertNotEquals(segv["fingerprint"], missing(6)["fingerprint"])
        assertEquals("Native process crash", missing(0)["exceptionType"]!!.jsonPrimitive.content)
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
