// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Plan 05-05 Task 1 — JSONLOutbox unit tests. Pure JVM (no Robolectric needed —
// JSONLOutbox accepts a File constructor for test injection).
package com.traceitx.outbox

import kotlinx.coroutines.launch
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class JSONLOutboxTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private val keys = JceTestOutboxKeyProvider()
    private var timestamp = 0L
    private lateinit var outboxFile: File
    private lateinit var outbox: JSONLOutbox

    @Before
    fun setUp() {
        outboxFile = File(tmp.newFolder("com.traceitx"), "outbox.jsonl")
        outbox = JSONLOutbox(outboxFile, keys = keys, ops = JvmOutboxFileOps())
    }

    @After
    fun tearDown() {
        outboxFile.parentFile?.listFiles()?.forEach { it.delete() }
    }

    private fun makeEntry(reportId: String, payloadSize: Int = 32): OutboxEntry =
        OutboxEntry(
            reportId = reportId,
            createdAt = ++timestamp,
            envelopeBytes = ByteArray(payloadSize) { (it and 0xff).toByte() },
            idempotencyKey = "idem-$reportId",
            attachmentRefs = emptyList(),
            sdkKey = "test-key",
            endpoint = "https://test.example.com",
        )

    @Test
    fun `full queue rejects without evicting accepted entry`() = runBlocking {
        val box = JSONLOutbox(outboxFile, keys = keys, ops = JvmOutboxFileOps(), maxEntries = 1)
        box.enqueue(makeEntry("old"))
        org.junit.Assert.assertThrows(OutboxWriteException::class.java) {
            runBlocking { box.enqueue(makeEntry("new")) }
        }
        assertEquals(listOf("old"), box.hydrate().map { it.reportId })
    }

    @Test fun removalDuringFailedDrainDoesNotResurrect() = runBlocking {
        outbox.enqueue(makeEntry("old"))
        val entered = kotlinx.coroutines.CompletableDeferred<Unit>()
        val resume = kotlinx.coroutines.CompletableDeferred<Unit>()
        val job = launch { outbox.drain { entered.complete(Unit); resume.await(); false } }
        entered.await()
        outbox.removeWhere { it.reportId == "old" }
        outbox.enqueue(makeEntry("new"))
        resume.complete(Unit)
        job.join()
        assertEquals(listOf("new"), outbox.hydrate().map { it.reportId })
    }

    @Test
    fun `enqueue leaves no tmp files after write`() = runBlocking {
        outbox.enqueue(makeEntry("r-1"))
        outbox.enqueue(makeEntry("r-2"))
        val tmpFiles = File(outboxFile.parentFile, "${outboxFile.name}.encrypted/active").listFiles { f ->
            f.name.endsWith(".tmp")
        } ?: emptyArray()
        assertEquals("expected no tmp files left, got ${tmpFiles.toList()}", 0, tmpFiles.size)
    }

    @Test
    fun `malformed legacy locator cannot corrupt encrypted entries`() = runBlocking {
        outbox.enqueue(makeEntry("good-1"))
        // Append a bad line directly to the file.
        outboxFile.appendText("THIS IS NOT JSON\n")
        outbox.enqueue(makeEntry("good-2"))
        val all = outbox.hydrate()
        // The legacy locator is isolated from the encrypted store.
        val ids = all.map { it.reportId }
        assertTrue("expected good-1 in $ids", ids.contains("good-1"))
        assertTrue("expected good-2 in $ids", ids.contains("good-2"))
    }

    @Test
    fun `hydrate of malformed-only file returns empty without throwing`() = runBlocking {
        outboxFile.parentFile?.mkdirs()
        outboxFile.writeText("garbage line 1\nstill not json\n{partial:")
        val all = outbox.hydrate()
        assertEquals(0, all.size)
    }

    @Test
    fun `concurrent enqueue from 4 coroutines preserves all entries`() = runBlocking {
        val outbox = JSONLOutbox(outboxFile, keys = keys, ops = JvmOutboxFileOps(), maxEntries = 10_000, maxTotalBytes = 100_000_000L)
        val deferred = (0 until 4).map { worker ->
            async {
                for (i in 0 until 100) outbox.enqueue(makeEntry("w$worker-i$i"))
            }
        }
        deferred.awaitAll()
        val all = outbox.hydrate()
        assertEquals(400, all.size)
        // No torn writes — every entry is parseable, no duplicates.
        val ids = all.map { it.reportId }.toSet()
        assertEquals(400, ids.size)
    }

    @Test
    fun `drain keeps entries whose predicate returns false`() = runBlocking {
        outbox.enqueue(makeEntry("keep-1"))
        outbox.enqueue(makeEntry("drop-1"))
        outbox.enqueue(makeEntry("keep-2"))
        outbox.drain { it.reportId.startsWith("drop-") }
        val all = outbox.hydrate()
        assertEquals(2, all.size)
        assertEquals(listOf("keep-1", "keep-2"), all.map { it.reportId })
    }

    @Test
    fun `drain keeps entry when predicate throws`() = runBlocking {
        outbox.enqueue(makeEntry("a"))
        outbox.enqueue(makeEntry("b"))
        outbox.drain { entry ->
            if (entry.reportId == "b") throw RuntimeException("kaboom")
            true
        }
        val all = outbox.hydrate()
        // "a" was consumed (predicate true), "b" stays (predicate threw).
        assertEquals(1, all.size)
        assertEquals("b", all.first().reportId)
    }

    @Test
    fun `count reflects on-disk state`() = runBlocking {
        assertEquals(0, outbox.count())
        outbox.enqueue(makeEntry("a"))
        outbox.enqueue(makeEntry("b"))
        assertEquals(2, outbox.count())
    }

    @Test
    fun `hydrate returns empty for missing file`() = runBlocking {
        val freshFile = File(tmp.newFolder("fresh"), "outbox.jsonl")
        val freshOutbox = JSONLOutbox(freshFile, keys = keys, ops = JvmOutboxFileOps())
        assertFalse(freshFile.exists())
        assertEquals(0, freshOutbox.hydrate().size)
    }

    @Test
    fun `DEFAULT_MAX_ENTRIES is 50 and DEFAULT_MAX_TOTAL_BYTES is 64MiB`() {
        assertEquals(50, JSONLOutbox.DEFAULT_MAX_ENTRIES)
        assertEquals(64L * 1024 * 1024, JSONLOutbox.DEFAULT_MAX_TOTAL_BYTES)
    }
    @Test fun successfulOldDrainDoesNotRemoveSameIdReplacement() = runBlocking {
        outbox.enqueue(entry("same"))
        val entered = kotlinx.coroutines.CompletableDeferred<Unit>()
        val resume = kotlinx.coroutines.CompletableDeferred<Unit>()
        val job = launch { outbox.drain { entered.complete(Unit); resume.await(); true } }
        entered.await()
        outbox.removeWhere { true }
        val replacement = entry("same", byteArrayOf(9))
        outbox.enqueue(replacement)
        resume.complete(Unit)
        job.join()
        assertEquals(listOf(replacement), outbox.hydrate())
    }

    @Test fun independentFacadesPreserveConcurrentAdmissions() = runBlocking {
        val other = JSONLOutbox(outboxFile, keys = keys, ops = JvmOutboxFileOps())
        listOf(outbox, other).mapIndexed { index, box -> async {
            repeat(10) { box.enqueue(entry("$index-$it")) }
        } }.awaitAll()
        assertEquals(20, outbox.count())
        assertEquals(20, other.count())
    }

    @Test fun drainPropagatesCancellation() = runBlocking {
        outbox.enqueue(entry("old"))
        org.junit.Assert.assertThrows(kotlinx.coroutines.CancellationException::class.java) {
            runBlocking { outbox.drain { throw kotlinx.coroutines.CancellationException("cancel") } }
        }
        assertEquals(1, outbox.count())
    }

}
