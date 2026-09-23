// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.outbox

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.EOFException
import java.io.InputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.security.KeyStoreException
import java.security.MessageDigest
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal class AndroidOutboxKeyProvider(
    private val aliasPrefix: String = "dev.everframe.outbox.v1",
) : OutboxKeyProvider {
    @Synchronized
    override fun createGeneration(generation: String): SecretKey {
        val alias = alias(generation)
        val keyStore = keyStore()
        if (keyStore.containsAlias(alias)) {
            throw KeyStoreException("Outbox key already exists: $alias")
        }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE).run {
            init(
                KeyGenParameterSpec.Builder(
                    alias,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setKeySize(AES_KEY_BITS)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .setUserAuthenticationRequired(false)
                    .build(),
            )
            generateKey()
        }
    }

    @Synchronized
    override fun loadGeneration(generation: String): SecretKey {
        val alias = alias(generation)
        return keyStore().getKey(alias, null) as? SecretKey
            ?: throw KeyStoreException("Outbox key does not exist: $alias")
    }

    @Synchronized
    override fun deleteGeneration(generation: String) {
        keyStore().deleteEntry(alias(generation))
    }

    private fun alias(generation: String): String {
        requireCanonicalUuid(generation, "generation")
        return "$aliasPrefix.$generation"
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }

    private companion object {
        const val ANDROID_KEY_STORE = "AndroidKeyStore"
        const val AES_KEY_BITS = 256
    }
}

internal class OutboxCipher(
    private val keys: OutboxKeyProvider,
    private val limits: OutboxLimits = OutboxLimits(),
) {
    init {
        require(limits.maxPayloadBytes >= 0)
        require(limits.maxEncodedEntryBytes >= 0)
        require(limits.maxEnvelopeBytes >= 0)
        require(limits.maxAttachments >= 0)
        require(limits.maxPartMetadataBytes >= 0)
        require(limits.maxRoutingFieldBytes >= 0)
        require(limits.maxReportIdBytes >= 0)
    }

    fun write(entry: OutboxEntry, token: OutboxToken, output: OutputStream) {
        validateToken(token)
        validateEntry(entry)
        val key = keys.loadGeneration(token.generation)
        val encryptor = Cipher.getInstance(TRANSFORMATION).apply {
            init(Cipher.ENCRYPT_MODE, key)
            updateAAD(aad(token))
        }
        val iv = encryptor.iv
        check(iv.size == IV_BYTES) { "AES-GCM provider returned ${iv.size}-byte IV" }

        output.write(MAGIC)
        output.write(VERSION)
        output.write(iv)

        val encrypted = CipherUpdatingOutputStream(output, encryptor)
        val data = DataOutputStream(encrypted)
        writeEntry(entry, data)
        encrypted.finish()
    }

    fun read(token: OutboxToken, input: InputStream): OutboxEntry {
        validateToken(token)
        val magic = input.readExactly(MAGIC.size)
        require(magic.contentEquals(MAGIC)) { "Invalid outbox magic" }
        val version = input.read()
        if (version < 0) throw EOFException("Missing outbox format version")
        require(version == VERSION) { "Unsupported outbox format version: $version" }
        val iv = input.readExactly(IV_BYTES)
        val ciphertext = input.readCapped(limits.maxEncodedEntryBytes + TAG_BYTES)
        require(ciphertext.size >= TAG_BYTES) { "Truncated AES-GCM ciphertext" }

        val key = keys.loadGeneration(token.generation)
        val plaintext = Cipher.getInstance(TRANSFORMATION).run {
            init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv))
            updateAAD(aad(token))
            doFinal(ciphertext)
        }
        require(plaintext.size.toLong() <= limits.maxEncodedEntryBytes) {
            "Encoded outbox entry exceeds limit"
        }
        return readEntry(plaintext)
    }

    private fun validateToken(token: OutboxToken) {
        requireCanonicalUuid(token.generation, "generation")
        requireCanonicalUuid(token.fileId, "fileId")
    }

    /** Exact validated disk bytes: binary plaintext plus magic/version, IV and GCM tag. */
    fun encryptedSize(entry: OutboxEntry): Long =
        validateEntry(entry) + MAGIC.size + 1L + IV_BYTES + TAG_BYTES

    private fun validateEntry(entry: OutboxEntry): Long {
        val reportIdBytes = checkedUtf8(entry.reportId, limits.maxReportIdBytes, "reportId")
        val idempotencyBytes = checkedUtf8(
            entry.idempotencyKey,
            limits.maxRoutingFieldBytes,
            "idempotencyKey",
        )
        val sdkKeyBytes = checkedUtf8(entry.sdkKey, limits.maxRoutingFieldBytes, "sdkKey")
        val endpointBytes = checkedUtf8(entry.endpoint, limits.maxRoutingFieldBytes, "endpoint")
        val subjectBytes = entry.identitySubject?.let {
            checkedUtf8(it, limits.maxRoutingFieldBytes, "identitySubject")
        }
        require(entry.envelopeBytes.size <= limits.maxEnvelopeBytes) { "Envelope exceeds limit" }
        require(entry.attachmentRefs.size <= limits.maxAttachments) { "Too many attachments" }

        var payloadBytes = entry.envelopeBytes.size.toLong()
        var encodedBytes = 4L + reportIdBytes.size + 8L + 4L + entry.envelopeBytes.size +
            4L + idempotencyBytes.size + 4L + sdkKeyBytes.size + 4L + endpointBytes.size + 1L +
            (subjectBytes?.let { 4L + it.size } ?: 0L) + 4L
        val names = HashSet<String>()
        entry.attachmentRefs.forEach { attachment ->
            require(attachment.name != ENVELOPE_PART_NAME) { "Attachment name is reserved" }
            require(names.add(attachment.name)) { "Duplicate attachment name: ${attachment.name}" }
            val name = checkedUtf8(attachment.name, limits.maxPartMetadataBytes, "attachment name")
            val filename = checkedUtf8(
                attachment.filename,
                limits.maxPartMetadataBytes,
                "attachment filename",
            )
            val contentType = checkedUtf8(
                attachment.contentType,
                limits.maxPartMetadataBytes,
                "attachment contentType",
            )
            val sha = checkedSha(attachment.data, attachment.sha256Hex)
            payloadBytes = checkedAdd(payloadBytes, attachment.data.size.toLong(), "Payload size overflow")
            encodedBytes = checkedAdd(
                encodedBytes,
                4L + name.size + 4L + filename.size + 4L + contentType.size +
                    4L + attachment.data.size + 4L + sha.size,
                "Encoded entry size overflow",
            )
        }
        require(payloadBytes <= limits.maxPayloadBytes) { "Payload exceeds limit" }
        require(encodedBytes <= limits.maxEncodedEntryBytes) { "Encoded outbox entry exceeds limit" }
        return encodedBytes
    }

    private fun writeEntry(entry: OutboxEntry, output: DataOutputStream) {
        output.writeUtf8(entry.reportId)
        output.writeLong(entry.createdAt)
        output.writeBlob(entry.envelopeBytes)
        output.writeUtf8(entry.idempotencyKey)
        output.writeUtf8(entry.sdkKey)
        output.writeUtf8(entry.endpoint)
        output.writeBoolean(entry.identitySubject != null)
        entry.identitySubject?.let { output.writeUtf8(it) }
        output.writeInt(entry.attachmentRefs.size)
        entry.attachmentRefs.forEach {
            output.writeUtf8(it.name)
            output.writeUtf8(it.filename)
            output.writeUtf8(it.contentType)
            output.writeBlob(it.data)
            output.writeUtf8(it.sha256Hex)
        }
    }

    private fun readEntry(plaintext: ByteArray): OutboxEntry {
        val input = DataInputStream(ByteArrayInputStream(plaintext))
        val reportId = input.readUtf8(limits.maxReportIdBytes, "reportId")
        val createdAt = input.readLong()
        val envelope = input.readBlob(limits.maxEnvelopeBytes, "envelope")
        var payloadBytes = envelope.size.toLong()
        val idempotencyKey = input.readUtf8(limits.maxRoutingFieldBytes, "idempotencyKey")
        val sdkKey = input.readUtf8(limits.maxRoutingFieldBytes, "sdkKey")
        val endpoint = input.readUtf8(limits.maxRoutingFieldBytes, "endpoint")
        val subjectPresent = input.readUnsignedByte()
        require(subjectPresent == 0 || subjectPresent == 1) { "Invalid identitySubject presence" }
        val identitySubject = if (subjectPresent == 1) {
            input.readUtf8(limits.maxRoutingFieldBytes, "identitySubject")
        } else {
            null
        }
        val attachmentCount = input.readBoundedLength(limits.maxAttachments, "attachment count")
        val names = HashSet<String>()
        val attachments = ArrayList<OutboxEntry.AttachmentRef>(attachmentCount)
        repeat(attachmentCount) {
            val name = input.readUtf8(limits.maxPartMetadataBytes, "attachment name")
            require(name != ENVELOPE_PART_NAME) { "Attachment name is reserved" }
            require(names.add(name)) { "Duplicate attachment name: $name" }
            val filename = input.readUtf8(limits.maxPartMetadataBytes, "attachment filename")
            val contentType = input.readUtf8(limits.maxPartMetadataBytes, "attachment contentType")
            val remainingPayload = limits.maxPayloadBytes - payloadBytes
            require(remainingPayload >= 0) { "Payload exceeds limit" }
            val dataLimit = minOf(remainingPayload, Int.MAX_VALUE.toLong()).toInt()
            val data = input.readBlob(dataLimit, "attachment data")
            payloadBytes = checkedAdd(payloadBytes, data.size.toLong(), "Payload size overflow")
            val sha256Hex = input.readUtf8(SHA_HEX_BYTES, "attachment sha256")
            checkedSha(data, sha256Hex)
            attachments += OutboxEntry.AttachmentRef(name, filename, contentType, data, sha256Hex)
        }
        require(payloadBytes <= limits.maxPayloadBytes) { "Payload exceeds limit" }
        require(input.read() == -1) { "Trailing plaintext data" }
        return OutboxEntry(
            reportId = reportId,
            createdAt = createdAt,
            envelopeBytes = envelope,
            idempotencyKey = idempotencyKey,
            attachmentRefs = attachments,
            sdkKey = sdkKey,
            endpoint = endpoint,
            identitySubject = identitySubject,
        )
    }

    private fun aad(token: OutboxToken): ByteArray = ByteArrayOutputStream().also { bytes ->
        DataOutputStream(bytes).use { data ->
            data.write(MAGIC)
            data.writeByte(VERSION)
            data.writeUtf8(token.generation)
            data.writeUtf8(token.fileId)
        }
    }.toByteArray()

    private fun checkedUtf8(value: String, maxBytes: Int, field: String): ByteArray {
        require(value.length <= maxBytes) { "$field exceeds UTF-8 limit" }
        val encoded = strictUtf8(value, field)
        require(encoded.size <= maxBytes) { "$field exceeds UTF-8 limit" }
        return encoded
    }

    private fun strictUtf8(value: String, field: String): ByteArray {
        val encoded = try {
            StandardCharsets.UTF_8.newEncoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .encode(CharBuffer.wrap(value))
        } catch (invalid: CharacterCodingException) {
            throw IllegalArgumentException("$field contains malformed UTF-16", invalid)
        }
        return ByteArray(encoded.remaining()).also { encoded.get(it) }
    }

    private fun checkedSha(data: ByteArray, sha256Hex: String): ByteArray {
        val encoded = checkedUtf8(sha256Hex, SHA_HEX_BYTES, "attachment sha256")
        require(encoded.size == SHA_HEX_BYTES && sha256Hex.all { it in '0'..'9' || it in 'a'..'f' }) {
            "Attachment SHA-256 is not canonical lowercase hex"
        }
        val actual = MessageDigest.getInstance("SHA-256").digest(data)
            .joinToString("") { "%02x".format(it) }
        require(MessageDigest.isEqual(actual.toByteArray(StandardCharsets.US_ASCII), encoded)) {
            "Attachment SHA-256 mismatch"
        }
        return encoded
    }

    private fun DataInputStream.readUtf8(maxBytes: Int, field: String): String {
        val encoded = readBlob(maxBytes, field)
        return StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(encoded))
            .toString()
    }

    private fun DataInputStream.readBlob(maxBytes: Int, field: String): ByteArray {
        val size = readBoundedLength(maxBytes, "$field length")
        return ByteArray(size).also { readFully(it) }
    }

    private fun DataInputStream.readBoundedLength(max: Int, field: String): Int {
        val value = readInt()
        require(value in 0..max) { "$field is out of bounds: $value" }
        return value
    }

    private fun DataOutputStream.writeUtf8(value: String) = writeBlob(strictUtf8(value, "UTF-8 field"))

    private fun DataOutputStream.writeBlob(value: ByteArray) {
        writeInt(value.size)
        write(value)
    }

    private class CipherUpdatingOutputStream(
        private val output: OutputStream,
        private val cipher: Cipher,
    ) : OutputStream() {
        private val buffer = ByteArray(CHUNK_BYTES)
        private var buffered = 0
        private var finished = false

        override fun write(value: Int) {
            check(!finished) { "Cipher stream is finished" }
            if (buffered == buffer.size) flushChunk()
            buffer[buffered++] = value.toByte()
        }

        override fun write(value: ByteArray, offset: Int, length: Int) {
            check(!finished) { "Cipher stream is finished" }
            require(offset >= 0 && length >= 0 && offset <= value.size - length)
            var sourceOffset = offset
            var remaining = length
            while (remaining > 0) {
                if (buffered == buffer.size) flushChunk()
                val copied = minOf(remaining, buffer.size - buffered)
                value.copyInto(buffer, buffered, sourceOffset, sourceOffset + copied)
                buffered += copied
                sourceOffset += copied
                remaining -= copied
            }
        }

        fun finish() {
            check(!finished) { "Cipher stream is finished" }
            flushChunk()
            output.write(cipher.doFinal())
            output.flush()
            finished = true
        }

        private fun flushChunk() {
            if (buffered == 0) return
            cipher.update(buffer, 0, buffered)?.takeIf { it.isNotEmpty() }?.let(output::write)
            buffered = 0
        }
    }

    private companion object {
        val MAGIC = byteArrayOf('T'.code.toByte(), 'X'.code.toByte(), 'O'.code.toByte(), 'B'.code.toByte())
        const val VERSION = 1
        const val IV_BYTES = 12
        const val TAG_BITS = 128
        const val TAG_BYTES = TAG_BITS / 8
        const val SHA_HEX_BYTES = 64
        const val CHUNK_BYTES = 64 * 1024
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val ENVELOPE_PART_NAME = "envelope"
    }
}

private fun requireCanonicalUuid(value: String, field: String) {
    val parsed = try {
        UUID.fromString(value)
    } catch (invalid: IllegalArgumentException) {
        throw IllegalArgumentException("$field is not a UUID", invalid)
    }
    require(parsed.toString() == value) { "$field is not a canonical UUID" }
}

private fun InputStream.readExactly(size: Int): ByteArray {
    val result = ByteArray(size)
    var offset = 0
    while (offset < size) {
        val count = read(result, offset, size - offset)
        if (count < 0) throw EOFException("Truncated outbox header")
        if (count == 0) continue
        offset += count
    }
    return result
}

private fun InputStream.readCapped(maxBytes: Long): ByteArray {
    require(maxBytes in 0..Int.MAX_VALUE.toLong()) { "Ciphertext limit is unsupported" }
    val output = ByteArrayOutputStream(minOf(maxBytes, 64 * 1024L).toInt())
    val buffer = ByteArray(64 * 1024)
    var total = 0L
    while (true) {
        val count = read(buffer)
        if (count < 0) break
        if (count == 0) continue
        total = checkedAdd(total, count.toLong(), "Ciphertext size overflow")
        require(total <= maxBytes) { "Ciphertext exceeds limit" }
        output.write(buffer, 0, count)
    }
    return output.toByteArray()
}

private fun checkedAdd(left: Long, right: Long, message: String): Long {
    require(right >= 0 && left <= Long.MAX_VALUE - right) { message }
    return left + right
}
