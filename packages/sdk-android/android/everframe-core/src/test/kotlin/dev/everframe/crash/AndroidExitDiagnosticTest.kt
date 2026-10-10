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

class AndroidExitDiagnosticTest {
    @get:Rule val folder = TemporaryFolder()
    private val keys = JceTestOutboxKeyProvider()
    private val allowed = object : OutboxAuthorization { override fun isAllowed() = true }
    private val launch = "22222222-2222-4222-8222-222222222222"
    private fun store(name: String) = OutboxStore(File(folder.root, name), keys, JvmOutboxFileOps(), 8, 2 * 1024 * 1024)
    private fun engine() = AndroidNativeRecovery(store("contexts"), store("prepared"))
    private fun arm(api: Int = 31): Pair<OutboxEntry, ByteArray> {
        val id = UUID.randomUUID().toString()
        val entry = OutboxEntry(id, 1000,
            """{"reportId":"$id","context":{"app":{"version":"old","build":"17"}},"reporter":{"title":"","description":""},"payload":{}}""".toByteArray(),
            "template", emptyList(), "old-key", "https://old.example")
        var token = byteArrayOf()
        engine().arm(entry, 99, "app", allowed, diagnostics = true, processLaunchId = launch, apiLevel = api) { token = it }
        return entry to token
    }
    private fun record(token: ByteArray, reason: Int, trace: () -> java.io.InputStream? = { null }) =
        AndroidNativeExit(99, "app", 2000, reason, token, trace)
    private fun body(entry: OutboxEntry) = Json.parseToJsonElement(entry.envelopeBytes.toString(Charsets.UTF_8)).jsonObject
    private fun evidence(entry: OutboxEntry) = body(entry)["payload"]!!.jsonObject["diagnostic"]!!.jsonObject

    @Test fun `OS ANR remains diagnostic with exact previous process and release even without trace`() {
        val (entry, token) = arm(api = 30)
        val accepted = arrayListOf<OutboxEntry>()
        assertEquals(1, engine().recover(listOf(record(token, 6)), 3000, allowed, allowDiagnostics = true) { accepted.add(it); true })
        val report = accepted.single()
        assertEquals(entry.reportId, report.reportId)
        assertEquals("old-key", report.sdkKey)
        assertEquals("https://old.example", report.endpoint)
        assertEquals("diagnostic", body(report)["source"]!!.jsonPrimitive.content)
        assertNull(body(report)["payload"]!!.jsonObject["crash"])
        assertEquals("old", body(report)["context"]!!.jsonObject["app"]!!.jsonObject["version"]!!.jsonPrimitive.content)
        val diagnostic = evidence(report)
        assertEquals(launch, diagnostic["processLaunchId"]!!.jsonPrimitive.content)
        assertEquals(entry.reportId, diagnostic["evidenceId"]!!.jsonPrimitive.content)
        assertEquals("anr", diagnostic["cause"]!!.jsonPrimitive.content)
        assertEquals("terminated", diagnostic["outcome"]!!.jsonPrimitive.content)
        assertEquals("1970-01-01T00:00:02Z", diagnostic["occurredAt"]!!.jsonPrimitive.content)
        assertEquals("unavailable", diagnostic["trace"]!!.jsonObject["status"]!!.jsonPrimitive.content)
        assertEquals(0, engine().recover(listOf(record(token, 6)), 4000, allowed, allowDiagnostics = true) { error("duplicate") })
    }
    @Test fun `exits other than native crashes and ANRs are consumed without a report or a trace read`() {
        // Low-memory kills, user stops, JVM crashes (already reported by the uncaught-exception
        // handler) and every other reason are not crash reports; a routinely killed TV app must
        // not fill ingest limits with them.
        for (reason in listOf(3, 4, 10, 11, 1, 2, 13, 999)) {
            val (_, token) = arm()
            val reported = arrayListOf<OutboxEntry>()
            // admit() exceptions are swallowed as refusals, so collect instead of throwing.
            engine().recover(listOf(record(token, reason) { error("unrelated trace read") }), 3000, allowed, allowDiagnostics = true) {
                reported.add(it); true
            }
            assertTrue("exit reason $reason was reported", reported.isEmpty())
            assertTrue("the matched context must be consumed", store("contexts").snapshotTokens().isEmpty())
            assertTrue(store("prepared").snapshotTokens().isEmpty())
        }
    }
    @Test fun `native exit carries one crash envelope plus matching evidence including API30 metadata only`() {
        val (_, token) = arm(api = 30)
        var count = 0
        assertEquals(1, engine().recover(listOf(record(token, 5) { error("API30 tombstone read") }), 3000, allowed, allowDiagnostics = true) {
            count++
            assertEquals("crash", body(it)["source"]!!.jsonPrimitive.content)
            assertTrue(body(it)["payload"]!!.jsonObject["crash"]!!.jsonObject["fatal"]!!.jsonPrimitive.boolean)
            assertEquals("native_crash", evidence(it)["cause"]!!.jsonPrimitive.content)
            assertEquals("unsupported", evidence(it)["trace"]!!.jsonObject["status"]!!.jsonPrimitive.content)
            true
        })
        assertEquals(1, count)
    }
    @Test fun `ANR stack exposes only main thread structured frames and retries immutable bytes`() {
        val (_, token) = arm()
        val trace = """
            ----- pid 99 at 2026-10-07 10:00:00 -----
            Cmd line: app secret@example.test
            "main" prio=5 tid=1 Sleeping
              at java.lang.Thread.sleep(Native method)
              at com.example.Screen.block(Screen.kt:42)
            "worker" prio=5 tid=2 Runnable
              at private.Worker.secret(Secret.java:99)
        """.trimIndent().toByteArray()
        var first: OutboxEntry? = null
        assertEquals(0, engine().recover(listOf(record(token, 6) { ByteArrayInputStream(trace) }), 3000, allowed, allowDiagnostics = true) {
            first = it
            val frames = evidence(it)["trace"]!!.jsonObject["frames"]!!.jsonArray
            assertEquals(2, frames.size)
            assertEquals("com.example.Screen.block", frames[1].jsonObject["function"]!!.jsonPrimitive.content)
            assertEquals(42, frames[1].jsonObject["line"]!!.jsonPrimitive.int)
            assertFalse(it.envelopeBytes.toString(Charsets.UTF_8).contains("secret"))
            false
        })
        assertEquals(1, engine().recover(emptyList(), 5000, allowed, allowDiagnostics = true) { assertEquals(first, it); true })
    }
    @Test fun `missing main thread or invalid utf8 never invents an available stack`() {
        for (bytes in listOf("\"worker\" prio=5 tid=2\n  at a.b(B.java:2)".toByteArray(), byteArrayOf(0xff.toByte()))) {
            val (_, token) = arm()
            assertEquals(1, engine().recover(listOf(record(token, 6) { ByteArrayInputStream(bytes) }), 3000, allowed, allowDiagnostics = true) {
                assertEquals("malformed", evidence(it)["trace"]!!.jsonObject["status"]!!.jsonPrimitive.content)
                assertTrue(evidence(it)["trace"]!!.jsonObject["frames"]!!.jsonArray.isEmpty())
                true
            })
        }
    }
    @Test fun `ANR reader caps bytes and frames closes streams and excludes another process`() {
        val own = "----- pid 99 at today -----\n\"main\" prio=5 tid=1 Runnable\n"
        val foreign = "----- pid 100 at today -----\n\"main\" prio=5 tid=1 Runnable\n  at foreign.Process.run(Foreign.java:8)\n"
        var closed = false
        val input = object : ByteArrayInputStream((foreign + own + (1..70).joinToString("\n") { "  at own.Process.frame$it(Main.java:$it)" }).toByteArray()) {
            override fun close() { closed = true; super.close() }
        }
        val trace = AndroidExitDiagnostic.readAnr({ input }, 99)
        assertTrue(closed)
        assertEquals(64, trace["frames"]!!.jsonArray.size)
        assertTrue(trace["truncated"]!!.jsonPrimitive.boolean)
        assertFalse(trace.toString().contains("foreign"))
        val huge = object : ByteArrayInputStream((own + "  at own.Process.run(Main.java:7)\n" + "x".repeat(300000)).toByteArray()) {
            val bytesRead get() = pos
        }
        val bounded = AndroidExitDiagnostic.readAnr({ huge }, 99)
        assertTrue(bounded["truncated"]!!.jsonPrimitive.boolean)
        assertTrue(huge.bytesRead <= 256 * 1024 + 1)
        assertEquals(1, bounded["frames"]!!.jsonArray.size)
    }
    @Test fun `ANR stack keeps Kotlin mangled frames and marks unparsed main thread frames as truncated`() {
        fun read(vararg frames: String) = AndroidExitDiagnostic.readAnr({
            ByteArrayInputStream(("----- pid 99 at today -----\n\"main\" prio=5 tid=1 Runnable\n" +
                frames.joinToString("") { "  at $it\n" } + "\"worker\" prio=5 tid=2 Runnable\n").toByteArray())
        }, 99)
        val compose = read("com.example.ui.FeedKt.FeedRow-8Feqmps(Feed.kt:40)",
            "androidx.compose.ui.node.LayoutNode.remeasure-_Sx5XlM\$ui_release(LayoutNode.kt:1205)",
            "com.example.ui.ComposableSingletons\$FeedKt\$lambda-1\$1.invoke(Feed.kt:30)",
            "com.example.Main.run(Main.java:7)")
        assertEquals(listOf("com.example.ui.FeedKt.FeedRow-8Feqmps", "androidx.compose.ui.node.LayoutNode.remeasure-_Sx5XlM\$ui_release",
            "com.example.ui.ComposableSingletons\$FeedKt\$lambda-1\$1.invoke", "com.example.Main.run"),
            compose["frames"]!!.jsonArray.map { it.jsonObject["function"]!!.jsonPrimitive.content })
        assertFalse(compose["truncated"]!!.jsonPrimitive.boolean)
        val gap = read("com.example.Main.run(Main.java:7)", "com.example.Café.render(Café.kt:8)", "com.example.Main.start(Main.java:9)")
        assertEquals("available", gap["status"]!!.jsonPrimitive.content)
        assertEquals(2, gap["frames"]!!.jsonArray.size)
        assertTrue("an omitted frame must not look like a complete stack", gap["truncated"]!!.jsonPrimitive.boolean)
    }

    @Test fun `native only reenable drops unadmitted non native context and prepared diagnostics`() {
        val (_, pendingToken) = arm()
        assertEquals(0, engine().recover(listOf(record(pendingToken, 6)), 3000, allowed, allowDiagnostics = true) { false })
        assertEquals(1, store("prepared").snapshotTokens().size)
        var forbiddenAdmissions = 0
        assertEquals(0, engine().recover(emptyList(), 4000, allowed) { forbiddenAdmissions++; true })
        assertEquals(0, forbiddenAdmissions)
        assertTrue(store("prepared").snapshotTokens().isEmpty())
        assertTrue(store("contexts").snapshotTokens().isEmpty())
        val (_, contextToken) = arm()
        assertEquals(0, engine().recover(listOf(record(contextToken, 6) { error("native-only mode read ANR trace") }), 4000, allowed) { error("native-only ANR") })
        assertTrue(store("contexts").snapshotTokens().isEmpty())
        assertEquals(0, engine().recover(emptyList(), 5000, allowed, allowDiagnostics = true) { error("discarded ANR resurrected") })
    }

}
