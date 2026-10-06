// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.diagnostics

import dev.everframe.outbox.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException

class ReportDiagnosticsPipelineTest {
    @get:Rule val tmp = TemporaryFolder()
    private val allowed = object : OutboxAuthorization { override fun isAllowed() = true }

    @Test fun durableEnqueueAndDuplicateAreOperationsNotDistinctReports() {
        val ledger = ReportDiagnostics(); val owner = ledger.beginGeneration(1, true)
        val box = OutboxStore(tmp.newFolder(), JceTestOutboxKeyProvider(), JvmOutboxFileOps())
        val token = box.enqueueSync(entry("one"), allowed, owner)
        assertEquals(token, box.enqueueSync(entry("one"), allowed, owner))
        assertEquals(1, ledger.snapshot().queue.pendingCount)
        assertEquals(2, ledger.snapshot().queue.operations.getValue("enqueue-committed"))
        box.removeIfPresent(token, owner, QueueOperation.REMOVED_AFTER_ACCEPTANCE)
        box.removeIfPresent(token, owner, QueueOperation.REMOVED_AFTER_ACCEPTANCE)
        assertEquals(1, ledger.snapshot().queue.operations.getValue("removed-after-acceptance"))
        assertTrue(box.snapshotTokens(owner).isEmpty())
        assertEquals(0, ledger.snapshot().queue.pendingCount)
        assertFalse(ledger.snapshot().toJson().contains("project-A-key"))
        assertFalse(ledger.snapshot().toJson().contains("original-person"))
    }

    @Test fun capacityAndRevocationNeverPretendAnEmptyQueue() {
        val ledger = ReportDiagnostics(); val owner = ledger.beginGeneration(1, true)
        val box = OutboxStore(tmp.newFolder(), JceTestOutboxKeyProvider(), JvmOutboxFileOps(), maxEntries = 1)
        box.enqueueSync(entry("one"), allowed, owner)
        assertThrows(OutboxWriteException::class.java) { box.enqueueSync(entry("two"), allowed, owner) }
        assertEquals("capacity", ledger.snapshot().queue.lastFailure)
        assertNull(ledger.snapshot().queue.pendingCount)
        assertEquals(1, box.snapshotTokens().size)
        val revoked = object : OutboxAuthorization { override fun isAllowed() = false }
        assertThrows(OutboxWriteException::class.java) { box.enqueueSync(entry("three"), revoked, owner) }
        assertEquals("revoked", ledger.snapshot().queue.lastFailure)
        assertEquals(0, ledger.snapshot().queue.operations.getValue("capacity-evicted"))
    }

    @Test fun failedRemovalAndCorruptReadInvalidateCountWithoutRemovingOriginal() {
        val ledger = ReportDiagnostics(); val owner = ledger.beginGeneration(1, true)
        var fail = false
        val root = tmp.newFolder()
        val ops = object : OutboxFileOps by JvmOutboxFileOps() {
            override fun renameAtomic(from: File, to: File) {
                if (fail && to.extension == "removed") throw IOException("secret native path")
                JvmOutboxFileOps().renameAtomic(from, to)
            }
        }
        val box = OutboxStore(root, JceTestOutboxKeyProvider(), ops)
        val token = box.enqueueSync(entry("one"), allowed, owner)
        fail = true
        assertThrows(OutboxWriteException::class.java) { box.removeIfPresent(token, owner, QueueOperation.REMOVED_AFTER_ACCEPTANCE) }
        assertNull(ledger.snapshot().queue.pendingCount)
        assertEquals(0, ledger.snapshot().queue.operations.getValue("removed-after-acceptance"))
        assertEquals(1, ledger.snapshot().queue.operations.getValue("removal-failed"))
        assertTrue(box.isPresent(token))
        File(root, "active/${token.fileId}.txq").writeText("corrupt secret")
        assertThrows(OutboxWriteException::class.java) { box.snapshotTokens(owner) }
        assertEquals(1, ledger.snapshot().queue.operations.getValue("read-failed"))
        assertThrows(OutboxWriteException::class.java) { box.readIfPresent(token, owner) }
        assertEquals(2, ledger.snapshot().queue.operations.getValue("read-failed"))
        assertNull(ledger.snapshot().queue.pendingCount)
        assertFalse(ledger.snapshot().toJson().contains("secret"))
    }

    @Test fun diagnosticReadsPerformNoFileOrKeyWorkAndUnboundStoreDoesNotObserve() {
        var keyReads = 0; var diskCalls = 0
        val ledger = ReportDiagnostics(); val owner = ledger.beginGeneration(1, true)
        val baseKeys = JceTestOutboxKeyProvider()
        val keys = object : OutboxKeyProvider by baseKeys {
            override fun loadGeneration(generation: String) = baseKeys.loadGeneration(generation).also { keyReads++ }
        }
        val ops = object : OutboxFileOps by JvmOutboxFileOps() {
            override fun syncDirectory(dir: File) { diskCalls++; JvmOutboxFileOps().syncDirectory(dir) }
        }
        val box = OutboxStore(tmp.newFolder(), keys, ops)
        box.enqueueSync(entry("one"), allowed, owner)
        val beforeKeys = keyReads; val beforeDisk = diskCalls
        repeat(100) { ledger.snapshot().toJson() }
        assertEquals(beforeKeys, keyReads); assertEquals(beforeDisk, diskCalls)
        box.enqueueSync(entry("unbound"), allowed)
        assertEquals(1, ledger.snapshot().queue.operations.getValue("enqueue-committed"))
    }
    @Test fun fatalStorageContentionReportsBusyWithoutWaitingForWriter() {
        val ledger = ReportDiagnostics(); val owner = ledger.beginGeneration(1, true)
        val entered = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        val ops = object : OutboxFileOps by JvmOutboxFileOps() {
            override fun syncFile(file: File) {
                if (file.extension == "tmp") { entered.countDown(); check(release.await(5, java.util.concurrent.TimeUnit.SECONDS)) }
                JvmOutboxFileOps().syncFile(file)
            }
        }
        val box = OutboxStore(tmp.newFolder(), JceTestOutboxKeyProvider(), ops)
        val writer = Thread { box.enqueueSync(entry("writer"), allowed) }
        writer.start(); assertTrue(entered.await(2, java.util.concurrent.TimeUnit.SECONDS))
        try {
            val done = java.util.concurrent.CountDownLatch(1)
            val fatal = Thread { assertNull(box.tryEnqueueSync(entry("fatal"), allowed, owner)); done.countDown() }
            fatal.start()
            assertTrue("fatal storage waited", done.await(1, java.util.concurrent.TimeUnit.SECONDS))
            fatal.join(1000)
            assertEquals("busy", ledger.snapshot().queue.lastFailure)
            assertNull(ledger.snapshot().queue.pendingCount)
        } finally { release.countDown(); writer.join(2000) }
    }

    @Test fun keyFailureIsClassifiedWithoutExposingProviderMessage() {
        val ledger = ReportDiagnostics(); val owner = ledger.beginGeneration(1, true)
        val base = JceTestOutboxKeyProvider()
        val keys = object : OutboxKeyProvider by base {
            override fun createGeneration(generation: String): javax.crypto.SecretKey = error("secret key provider message")
        }
        val box = OutboxStore(tmp.newFolder(), keys, JvmOutboxFileOps())
        assertThrows(OutboxWriteException::class.java) { box.enqueueSync(entry("one"), allowed, owner) }
        assertEquals("key-unavailable", ledger.snapshot().queue.lastFailure)
        assertEquals(0, ledger.snapshot().queue.operations.getValue("enqueue-committed"))
        assertFalse(ledger.snapshot().toJson().contains("secret"))
    }

    @Test fun readingWithoutMigrationDoesNotClaimLegacyDebtIsClear() {
        val ledger = ReportDiagnostics(); val owner = ledger.beginGeneration(1, true)
        val legacy = tmp.newFile("legacy.jsonl").apply { writeText("unread legacy content") }
        val box = OutboxStore(tmp.newFolder(), JceTestOutboxKeyProvider(), JvmOutboxFileOps(), legacyFiles = listOf(legacy))
        box.snapshotTokens(owner)
        assertEquals("not-observed", ledger.snapshot().queue.migration)
        box.migrateLegacy()
        box.snapshotTokens(owner)
        assertEquals("blocked", ledger.snapshot().queue.migration)
        assertEquals("partial", ledger.snapshot().queue.quality)
        assertTrue(legacy.exists())
    }

}
