// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.outbox

import java.security.MessageDigest
import java.util.UUID
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

internal fun entry(id: String, data: ByteArray = byteArrayOf(1, 2, 3)) = OutboxEntry(
    reportId = id,
    createdAt = 123L,
    envelopeBytes = "{\"secret\":\"captured\"}".toByteArray(),
    idempotencyKey = "idem-$id",
    sdkKey = "project-A-key",
    endpoint = "https://a.example",
    identitySubject = "original-person",
    attachmentRefs = listOf(
        OutboxEntry.AttachmentRef(
            "shot",
            "shot.png",
            "image/png",
            data,
            MessageDigest.getInstance("SHA-256").digest(data)
                .joinToString("") { "%02x".format(it) },
        ),
    ),
)

internal class JceTestOutboxKeyProvider(
    private val keysByAlias: MutableMap<String, SecretKey> = mutableMapOf(),
    private val aliasPrefix: String = "dev.everframe.outbox.v1",
) : OutboxKeyProvider {
    override fun createGeneration(generation: String): SecretKey {
        val alias = alias(generation)
        check(alias !in keysByAlias) { "Key already exists: $alias" }
        return KeyGenerator.getInstance("AES").apply { init(256) }.generateKey().also {
            keysByAlias[alias] = it
        }
    }

    override fun loadGeneration(generation: String): SecretKey =
        keysByAlias[alias(generation)] ?: error("Missing key: ${alias(generation)}")

    override fun deleteGeneration(generation: String) {
        keysByAlias.remove(alias(generation))
    }

    private fun alias(generation: String): String {
        require(UUID.fromString(generation).toString() == generation) { "Non-canonical generation UUID" }
        return "$aliasPrefix.$generation"
    }
}

internal class JvmOutboxFileOps : OutboxFileOps {
    override fun syncFile(file: java.io.File) {
        java.io.RandomAccessFile(file, "rw").use { it.fd.sync() }
    }
    override fun renameAtomic(from: java.io.File, to: java.io.File) {
        java.nio.file.Files.move(from.toPath(), to.toPath(), java.nio.file.StandardCopyOption.ATOMIC_MOVE)
    }
    override fun syncDirectory(dir: java.io.File) {
        java.nio.channels.FileChannel.open(dir.toPath(), java.nio.file.StandardOpenOption.READ).use { it.force(true) }
    }
}
