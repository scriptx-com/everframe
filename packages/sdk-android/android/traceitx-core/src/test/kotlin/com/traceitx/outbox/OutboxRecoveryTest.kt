// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.outbox

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException
import java.io.ByteArrayOutputStream

class OutboxRecoveryTest {
    @get:Rule val tmp = TemporaryFolder()
    private val keys = JceTestOutboxKeyProvider()
    private val allowed = object : OutboxAuthorization { override fun isAllowed() = true }
    private fun store(root: File, ops: OutboxFileOps = JvmOutboxFileOps(), bytes: Long = 64L * 1024 * 1024) =
        OutboxStore(root, keys, ops, 50, bytes)

    @Test fun `fresh revoking facade deletes readable exact key when initial directory sync fails`() {
        val root = tmp.newFolder().canonicalFile
        val token = store(root).enqueueSync(entry("accepted"), allowed)
        val deleted = mutableListOf<String>()
        val trackingKeys = object : OutboxKeyProvider by keys {
            override fun deleteGeneration(generation: String) {
                deleted.add(generation)
                keys.deleteGeneration(generation)
            }
        }
        val ops = object : OutboxFileOps by JvmOutboxFileOps() {
            override fun syncDirectory(dir: File) { throw IOException("directory sync unavailable") }
        }
        assertThrows(OutboxWriteException::class.java) { OutboxStore(root, trackingKeys, ops).revokeSync() }
        assertEquals(listOf(token.generation), deleted)
        assertTrue(store(root).isRevocationPending())
        val registry = OutboxStore::class.java.getDeclaredField("coordinators").apply { isAccessible = true }
        @Suppress("UNCHECKED_CAST")
        (registry.get(null) as MutableMap<String, *>).remove(root.path)
        assertEquals(OutboxFailure.KEY_UNAVAILABLE, assertThrows(OutboxWriteException::class.java) {
            store(root).snapshotTokens()
        }.failure)
    }

    @Test fun `kill invalidation does not wait for staged enqueue and prevents commit`() {
        val root = tmp.newFolder()
        val entered = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        val ops = object : OutboxFileOps by JvmOutboxFileOps() {
            override fun syncFile(file: File) {
                JvmOutboxFileOps().syncFile(file)
                if (file.extension == "tmp") {
                    entered.countDown()
                    check(release.await(5, java.util.concurrent.TimeUnit.SECONDS))
                }
            }
        }
        val box = store(root, ops)
        val executor = java.util.concurrent.Executors.newSingleThreadExecutor()
        try {
            val enqueue = executor.submit<OutboxFailure> {
                assertThrows(OutboxWriteException::class.java) { box.enqueueSync(entry("staged"), allowed) }.failure
            }
            assertTrue(entered.await(5, java.util.concurrent.TimeUnit.SECONDS))
            box.invalidateSync()
            // A new facade can be constructed without waiting, but cannot accept this epoch yet.
            val replacement = store(root)
            assertTrue(replacement.isRevocationPending())
            assertFalse(replacement.hasCurrentLease())
            release.countDown()
            assertEquals(OutboxFailure.REVOKED, enqueue.get(5, java.util.concurrent.TimeUnit.SECONDS))
            box.revokeSync()
            assertFalse(replacement.hasCurrentLease())
            assertTrue(store(root).hasCurrentLease())
            assertTrue(store(root).snapshotTokens().isEmpty())
            store(root).enqueueSync(entry("fresh"), allowed)
        } finally { release.countDown(); executor.shutdownNow() }
    }

    @Test fun `durable intent survives simulated process registry loss before key deletion`() {
        val root = tmp.newFolder().canonicalFile
        val real = JceTestOutboxKeyProvider()
        val failingKeys = object : OutboxKeyProvider by real {
            override fun deleteGeneration(generation: String) { throw IOException("key deletion unavailable") }
        }
        val box = OutboxStore(root, failingKeys, JvmOutboxFileOps())
        box.enqueueSync(entry("old"), allowed)
        assertThrows(OutboxWriteException::class.java) { box.revokeSync() }
        assertTrue(File(root, "kill.pending").exists())
        // Simulate only loss of coordinator memory; retained JCE keys/files are not a power-loss test.
        val registry = OutboxStore::class.java.getDeclaredField("coordinators").apply { isAccessible = true }
        @Suppress("UNCHECKED_CAST")
        (registry.get(null) as MutableMap<String, *>).remove(root.path)
        val reopened = OutboxStore(root, real, JvmOutboxFileOps())
        assertTrue(reopened.snapshotTokens().isEmpty())
        assertTrue(reopened.hasRevocationHistory())
        assertFalse(File(root, "kill.pending").exists())
        reopened.enqueueSync(entry("new"), allowed)
    }

    @Test fun `all durable revocation operations failing reports failure and keeps process poisoned`() {
        val root = tmp.newFolder()
        var deny = false
        var keyAttempts = 0
        val failingKeys = object : OutboxKeyProvider by keys {
            override fun deleteGeneration(generation: String) { keyAttempts++; throw IOException("key unavailable") }
        }
        val ops = object : OutboxFileOps by JvmOutboxFileOps() {
            override fun syncDirectory(dir: File) {
                if (deny) throw IOException("disk unavailable")
                JvmOutboxFileOps().syncDirectory(dir)
            }
        }
        val box = OutboxStore(root, failingKeys, ops)
        val token = box.enqueueSync(entry("old"), allowed)
        deny = true
        assertThrows(OutboxWriteException::class.java) { box.revokeSync() }
        assertTrue(keyAttempts > 0)
        assertTrue(box.isRevocationPending())
        assertThrows(OutboxWriteException::class.java) { store(root).enqueueSync(entry("new"), allowed) }
        assertFalse(store(root).isPresent(token))
        // The old key still exists: memory poisoning alone is explicitly NOT durable revocation.
        keys.loadGeneration(token.generation)
    }

    @Test fun `crash try lock rejects OS contention and reentrant storage callbacks`() {
        val root = tmp.newFolder()
        val box = store(root)
        val token = box.enqueueSync(entry("old"), allowed)
        java.io.RandomAccessFile(File(root, "store.lock"), "rw").use { handle ->
            handle.channel.lock().use {
                assertThrows(OutboxWriteException::class.java) { box.tryEnqueueSync(entry("crash"), allowed) }
            }
        }
        box.withPresent(token) { assertNull(box.tryEnqueueSync(entry("reentrant"), allowed)) }
        assertEquals(1, box.snapshotTokens().size)
    }

    @Test fun `encrypted size prediction spans chunks and leaves stream open`() {
        val generation = java.util.UUID.randomUUID().toString()
        keys.createGeneration(generation)
        val token = OutboxToken(generation, java.util.UUID.randomUUID().toString())
        val codec = OutboxCipher(keys)
        val value = entry("large", ByteArray(170_000) { it.toByte() })
        val output = object : ByteArrayOutputStream() {
            var closed = false
            override fun close() { closed = true; super.close() }
        }
        codec.write(value, token, output)
        assertEquals(output.size().toLong(), codec.encryptedSize(value))
        assertFalse(output.closed)
        assertEquals(value, codec.read(token, output.toByteArray().inputStream()))
    }

    @Test fun `failure at each durability boundary recovers only authenticated whole entries`() {
        for (boundary in 0..3) {
            val root = tmp.newFolder()
            val original = store(root)
            original.enqueueSync(entry("accepted"), allowed)
            val ops = object : OutboxFileOps by JvmOutboxFileOps() {
                override fun syncFile(file: File) {
                    if (boundary == 0) throw IOException("after ciphertext write")
                    JvmOutboxFileOps().syncFile(file)
                    if (boundary == 1) throw IOException("after file sync")
                }
                override fun renameAtomic(from: File, to: File) {
                    JvmOutboxFileOps().renameAtomic(from, to)
                    if (boundary == 2) throw IOException("after rename")
                }
                override fun syncDirectory(dir: File) {
                    JvmOutboxFileOps().syncDirectory(dir)
                    if (boundary == 3 && dir == File(root.canonicalFile, "active")) throw IOException("after directory sync")
                }
            }
            assertEquals(OutboxFailure.IO, assertThrows(OutboxWriteException::class.java) {
                store(root, ops).enqueueSync(entry("candidate"), allowed)
            }.failure)
            val reopened = store(root)
            val recovered = reopened.snapshotTokens().mapNotNull { reopened.readIfPresent(it)?.entry }
            assertTrue(recovered.any { it == entry("accepted") })
            assertEquals(if (boundary < 2) 1 else 2, recovered.size)
            assertTrue(recovered.all { it == entry("accepted") || it == entry("candidate") })
            if (boundary >= 2) {
                reopened.enqueueSync(entry("candidate"), allowed)
                assertEquals(2, reopened.snapshotTokens().size)
            }
        }
    }

    @Test fun `attachments and undeletable cleanup consume physical reservation`() {
        val root = tmp.newFolder()
        val box = store(root, bytes = 1024L * 1024 + 4000)
        box.enqueueSync(entry("old"), allowed)
        val cleanup = File(root, "active/orphan.tmp").apply { mkdir() }
        File(cleanup, "occupied").writeBytes(ByteArray(3500))
        assertEquals(OutboxFailure.CAPACITY, assertThrows(OutboxWriteException::class.java) {
            box.enqueueSync(entry("new", ByteArray(1000)), allowed)
        }.failure)
        assertEquals(listOf("old"), box.snapshotTokens().map { box.readIfPresent(it)!!.entry.reportId })
    }

    @Test fun `duplicate admission returns same token and conflict rejects`() {
        val box = store(tmp.newFolder())
        val token = box.enqueueSync(entry("same"), allowed)
        assertEquals(token, box.enqueueSync(entry("same"), allowed))
        assertEquals(OutboxFailure.INVALID_ENTRY, assertThrows(OutboxWriteException::class.java) {
            box.enqueueSync(entry("same", byteArrayOf(9)), allowed)
        }.failure)
    }

    @Test fun `revocation invalidates leases and old token cannot touch replacement`() {
        val root = tmp.newFolder()
        val old = store(root)
        val token = old.enqueueSync(entry("same"), allowed)
        old.revokeSync()
        assertFalse(old.isPresent(token))
        assertEquals(OutboxFailure.REVOKED, assertThrows(OutboxWriteException::class.java) {
            old.enqueueSync(entry("late"), allowed)
        }.failure)
        val fresh = store(root)
        val replacement = fresh.enqueueSync(entry("same"), allowed)
        old.removeIfPresent(token)
        assertTrue(fresh.isPresent(replacement))
    }

    @Test fun `permission revoked during directory sync cannot return accepted`() {
        val root = tmp.newFolder()
        store(root).enqueueSync(entry("old"), allowed)
        var permitted = true
        val ops = object : OutboxFileOps by JvmOutboxFileOps() {
            override fun syncDirectory(dir: File) {
                JvmOutboxFileOps().syncDirectory(dir)
                if (dir == File(root.canonicalFile, "active")) permitted = false
            }
        }
        val box = store(root, ops)
        assertEquals(OutboxFailure.REVOKED, assertThrows(OutboxWriteException::class.java) {
            box.enqueueSync(entry("new"), object : OutboxAuthorization { override fun isAllowed() = permitted })
        }.failure)
        val fresh = store(root)
        assertEquals(listOf("old"), fresh.snapshotTokens().map { fresh.readIfPresent(it)!!.entry.reportId })
    }
    @Test fun `duplicate permission revoked during reconciliation removes owned token`() {
        val root = tmp.newFolder()
        store(root).enqueueSync(entry("same"), allowed)
        var permitted = true
        val ops = object : OutboxFileOps by JvmOutboxFileOps() {
            override fun syncDirectory(dir: File) {
                JvmOutboxFileOps().syncDirectory(dir)
                if (dir == File(root.canonicalFile, "active")) permitted = false
            }
        }
        assertEquals(OutboxFailure.REVOKED, assertThrows(OutboxWriteException::class.java) {
            store(root, ops).enqueueSync(entry("same"), object : OutboxAuthorization {
                override fun isAllowed() = permitted
            })
        }.failure)
        assertEquals(0, store(root).snapshotTokens().size)
    }

    @Test fun `failed removal sync never hydrates tombstone on reopen`() {
        val root = tmp.newFolder()
        val token = store(root).enqueueSync(entry("old"), allowed)
        val ops = object : OutboxFileOps by JvmOutboxFileOps() {
            override fun syncDirectory(dir: File) {
                if (dir == File(root.canonicalFile, "active")) throw IOException("uncertain removal")
                JvmOutboxFileOps().syncDirectory(dir)
            }
        }
        assertEquals(OutboxFailure.IO, assertThrows(OutboxWriteException::class.java) {
            store(root, ops).removeIfPresent(token)
        }.failure)
        assertTrue(File(root, "active/${token.fileId}.removed").exists())
        assertEquals(0, store(root).snapshotTokens().size)
        assertFalse(File(root, "active/${token.fileId}.removed").exists())
    }

    @Test fun `FIFO uses authenticated timestamp then random file id`() {
        val box = store(tmp.newFolder())
        val late = box.enqueueSync(entry("late").copy(createdAt = 9), allowed)
        val first = box.enqueueSync(entry("first").copy(createdAt = 1), allowed)
        val tie = box.enqueueSync(entry("tie").copy(createdAt = 1), allowed)
        assertEquals(listOf(first, tie).sortedBy { it.fileId } + late, box.snapshotTokens())
    }

    @Test fun `unavailable generation key never creates replacement or plaintext`() {
        val root = tmp.newFolder()
        store(root).enqueueSync(entry("old"), allowed)
        val withoutKey = OutboxStore(root, JceTestOutboxKeyProvider(), JvmOutboxFileOps())
        assertEquals(OutboxFailure.KEY_UNAVAILABLE, assertThrows(OutboxWriteException::class.java) {
            withoutKey.enqueueSync(entry("new"), allowed)
        }.failure)
        assertEquals(listOf("old"), store(root).snapshotTokens().map { store(root).readIfPresent(it)!!.entry.reportId })
    }

    @Test fun `exact reservation rejects one byte over including encrypted attachment`() {
        val root = tmp.newFolder()
        val value = entry("large", ByteArray(140_000))
        val bytes = OutboxCipher(keys).encryptedSize(value)
        assertEquals(OutboxFailure.CAPACITY, assertThrows(OutboxWriteException::class.java) {
            store(root, bytes = bytes + 1024L * 1024 - 1).enqueueSync(value, allowed)
        }.failure)
        assertEquals(0, store(root).snapshotTokens().size)
        val token = store(root, bytes = bytes + 1024L * 1024).enqueueSync(value, allowed)
        assertEquals(bytes, File(root, "active/${token.fileId}.txq").length())
    }

    @Test fun `failed revocation cannot admit a fresh lease into revoked generation`() {
        val root = tmp.newFolder()
        store(root).enqueueSync(entry("old"), allowed)
        val ops = object : OutboxFileOps by JvmOutboxFileOps() {
            override fun renameAtomic(from: File, to: File) { throw IOException("rename unavailable") }
        }
        assertThrows(OutboxWriteException::class.java) { store(root, ops).revokeSync() }
        assertThrows(OutboxWriteException::class.java) { store(root).enqueueSync(entry("new"), allowed) }
        val retry = store(root)
        retry.revokeSync()
        assertEquals(0, store(root).snapshotTokens().size)
        store(root).enqueueSync(entry("fresh"), allowed)
    }

    @Test fun `admission retry syncs directory link left by failed initialization`() {
        for (freshFacade in listOf(false, true)) {
            val parent = tmp.newFolder().canonicalFile
            val root = File(parent, "new-store")
            var failParentSync = true
            var parentSynced = false
            val ops = object : OutboxFileOps by JvmOutboxFileOps() {
                override fun syncDirectory(dir: File) {
                    if (dir == parent && failParentSync) throw IOException("initial parent sync")
                    JvmOutboxFileOps().syncDirectory(dir)
                    if (dir == parent) parentSynced = true
                }
            }
            val original = store(root, ops)
            assertThrows(OutboxWriteException::class.java) { original.enqueueSync(entry("first"), allowed) }
            assertTrue(root.isDirectory)
            assertFalse(parentSynced)
            failParentSync = false
            val retry = if (freshFacade) store(root, ops) else original
            retry.enqueueSync(entry("retry"), allowed)
            assertTrue("acceptance must reconcile the root's parent link", parentSynced)
        }
    }

    @Test fun `absent removal retry syncs after uncertain rename and cleanup deletion`() {
        for (freshFacade in listOf(false, true)) {
            val root = tmp.newFolder().canonicalFile
            val active = File(root, "active")
            val token = store(root).enqueueSync(entry("old"), allowed)
            var failuresRemaining = 2
            var synced = false
            val ops = object : OutboxFileOps by JvmOutboxFileOps() {
                override fun syncDirectory(dir: File) {
                    if (dir == active && failuresRemaining > 0) {
                        failuresRemaining--
                        throw IOException("uncertain removal or cleanup deletion")
                    }
                    JvmOutboxFileOps().syncDirectory(dir)
                    if (dir == active) synced = true
                }
            }
            val original = store(root, ops)
            assertThrows(OutboxWriteException::class.java) { original.removeIfPresent(token) }
            assertTrue(File(active, "${token.fileId}.removed").exists())
            assertThrows(OutboxWriteException::class.java) { store(root, ops).removeIfPresent(token) }
            assertFalse(File(active, "${token.fileId}.removed").exists())
            assertFalse(File(active, "${token.fileId}.txq").exists())
            assertFalse(synced)
            val retry = if (freshFacade) store(root, ops) else original
            retry.removeIfPresent(token)
            assertTrue("successful absence must reconcile the deletion", synced)
        }
    }

}
