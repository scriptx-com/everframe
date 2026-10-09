// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import dev.everframe.outbox.JvmOutboxFileOps
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CyclicBarrier

class AndroidNativeSignalFilesTest {
    @get:Rule val folder = TemporaryFolder()
    private val a = "a".repeat(32)
    private val b = "b".repeat(32)
    @Test fun `cleanup preserves retained encrypted records and removes retired owned directories`() {
        val files = AndroidNativeSignalFiles(folder.root, JvmOutboxFileOps())
        for (id in listOf(a,b)) {
            files.prepare(id)
            File(files.records,"$id/authority").writeBytes(ByteArray(96))
            File(files.records,"$id/$id").writeBytes(ByteArray(40))
        }
        files.cleanup(setOf(a))
        assertTrue(File(files.records,a).isDirectory); assertFalse(File(files.records,b).exists())
        assertEquals(40,files.read(a)!!.size)
    }
    @Test fun `first use races another store creating the shared parent without failing`() {
        // On a fresh install the SDK outbox creates dev.everframe on its own thread while the
        // first opt-in builds this store; whichever creates a directory first, both proceed.
        repeat(200) { round ->
            val base = folder.newFolder("round$round")
            val barrier = CyclicBarrier(4)
            val failures = ConcurrentLinkedQueue<Throwable>()
            val threads = List(4) { Thread { try { barrier.await(); AndroidNativeSignalFiles(base, JvmOutboxFileOps()) } catch (error: Throwable) { failures.add(error) } } }
            threads.forEach { it.start() }; threads.forEach { it.join() }
            assertTrue(failures.joinToString(), failures.isEmpty())
            assertTrue(File(base, "dev.everframe/native-signal-v1/records").isDirectory)
        }
    }
    @Test fun `parent link is refused without touching its target`() {
        val outside = folder.newFolder("outside")
        Files.createSymbolicLink(File(folder.root,"dev.everframe").toPath(),outside.toPath())
        try { AndroidNativeSignalFiles(folder.root,JvmOutboxFileOps()); fail("symlink") } catch (_: IllegalStateException) {}
        assertTrue(outside.listFiles()!!.isEmpty())
    }
    @Test fun `record directory link cannot read or erase outside evidence`() {
        val files=AndroidNativeSignalFiles(folder.root,JvmOutboxFileOps());val outside=folder.newFolder("outside")
        File(outside,a).writeBytes(ByteArray(40))
        Files.createSymbolicLink(File(files.records,a).toPath(),outside.toPath())
        try { files.read(a);fail("symlink") } catch (_: IllegalStateException) {}
        try { files.cleanup(emptySet());fail("symlink") } catch (_: IllegalStateException) {}
        assertTrue(File(outside,a).isFile)
    }
    @Test fun `directory overflow refuses more native capture rather than growing storage`() {
        val files=AndroidNativeSignalFiles(folder.root,JvmOutboxFileOps())
        repeat(16) { files.prepare(it.toString(16).padStart(32,'0')) }
        try { files.prepare(a);fail("capacity") } catch (_: IllegalStateException) {}
        assertEquals(16,files.records.listFiles()!!.size)
        files.cleanup(emptySet());files.prepare(a);assertEquals(1,files.records.listFiles()!!.size)
    }
}
