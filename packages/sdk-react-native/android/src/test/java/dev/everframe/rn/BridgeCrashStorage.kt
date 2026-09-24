// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
@file:Suppress("INVISIBLE_REFERENCE", "INVISIBLE_MEMBER")
package dev.everframe.rn

import dev.everframe.crash.CrashReporter
import dev.everframe.outbox.*
import java.io.File
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/** Host encryption fixture: exercise real admission with JCE, never Android Keystore or live storage. */
internal class BridgeCrashStorage {
    private val root = java.nio.file.Files.createTempDirectory("everframe-bridge-crash").toFile()
    private val keys = object : OutboxKeyProvider {
        private val values = mutableMapOf<String, SecretKey>()
        override fun createGeneration(generation: String): SecretKey =
            KeyGenerator.getInstance("AES").apply { init(256) }.generateKey().also { values[generation] = it }
        override fun loadGeneration(generation: String): SecretKey = checkNotNull(values[generation])
        override fun deleteGeneration(generation: String) { values.remove(generation) }
    }
    private val ops = object : OutboxFileOps {
        override fun syncFile(file: File) { java.io.RandomAccessFile(file, "rw").use { it.fd.sync() } }
        override fun renameAtomic(from: File, to: File) {
            java.nio.file.Files.move(from.toPath(), to.toPath(), java.nio.file.StandardCopyOption.ATOMIC_MOVE)
        }
        override fun syncDirectory(dir: File) {
            java.nio.channels.FileChannel.open(dir.toPath(), java.nio.file.StandardOpenOption.READ).use { it.force(true) }
        }
    }
    fun outbox() = JSONLOutbox(File(root, "outbox.jsonl"), keys, ops)
    fun install(fail: Boolean = false) {
        val writer = if (fail) object : OutboxFileOps by ops {
            override fun syncFile(file: File) { throw java.io.IOException("test storage unavailable") }
        } else ops
        CrashReporter.sidecarFactory = { CrashSidecar(File(root, "crash-outbox.jsonl"), keys, writer) }
    }
    fun persistedBytes(): List<ByteArray> = root.walkTopDown().filter { it.isFile }.map { it.readBytes() }.toList()
    fun close() { root.deleteRecursively() }
}
