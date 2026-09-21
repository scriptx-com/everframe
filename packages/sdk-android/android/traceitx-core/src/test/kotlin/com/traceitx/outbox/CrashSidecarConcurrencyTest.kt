// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package com.traceitx.outbox

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit

class CrashSidecarConcurrencyTest {
    @get:Rule val tmp = TemporaryFolder()
    private val keys = JceTestOutboxKeyProvider()
    private fun entry(id: String) = OutboxEntry(id, 1L, "{}".toByteArray(), "k-$id", emptyList(), "key", "https://test.example.com")

    @Test fun `alias crash writer rejects contention before first encrypted write completes`() {
        val file = File(tmp.root, "crash-outbox.jsonl")
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val ops = object : OutboxFileOps by JvmOutboxFileOps() {
            override fun syncFile(file: File) {
                if (file.extension == "tmp") { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) }
                JvmOutboxFileOps().syncFile(file)
            }
        }
        val first = FutureTask { CrashSidecar(file, keys, ops).appendSyncAccepted(entry("first")) }
        val second = FutureTask { CrashSidecar(File(tmp.root, "./crash-outbox.jsonl"), keys, JvmOutboxFileOps()).appendSyncAccepted(entry("second")) }
        val t1 = Thread(first); val t2 = Thread(second)
        try {
            t1.start()
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            t2.start()
            assertFalse(second.get(1, TimeUnit.SECONDS))
            assertFalse(first.isDone)
            release.countDown()
            assertTrue(first.get(5, TimeUnit.SECONDS))
            assertEquals(listOf("first"), runBlocking { JSONLOutbox(File(tmp.root, "outbox.jsonl"), keys, JvmOutboxFileOps()).hydrate() }.map { it.reportId })
        } finally { release.countDown(); t1.join(5000); t2.join(5000) }
    }

    @Test fun `blocked legacy processing survives repeated hydration alongside accepted encrypted capture`() = runBlocking {
        val file = File(tmp.root, "crash-outbox.jsonl")
        val processing = File(tmp.root, "crash-outbox.jsonl.processing")
        processing.writeText("{blocked legacy batch\n")
        val original = processing.readBytes()
        val sidecar = CrashSidecar(file, keys, JvmOutboxFileOps())
        assertTrue(sidecar.appendSyncAccepted(entry("accepted")))
        repeat(2) {
            val reopened = JSONLOutbox(File(tmp.root, "outbox.jsonl"), keys, JvmOutboxFileOps())
            assertEquals(0, sidecar.hydrateInto(reopened))
            assertEquals(listOf("accepted"), reopened.hydrate().map { it.reportId })
            assertArrayEquals(original, processing.readBytes())
        }
    }
}
