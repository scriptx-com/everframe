// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.outbox

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.security.GeneralSecurityException
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class OutboxCipherTest {
    private lateinit var generation: String
    private lateinit var token: OutboxToken
    private lateinit var keys: JceTestOutboxKeyProvider
    private lateinit var cipher: OutboxCipher

    @Before
    fun setUp() {
        generation = UUID.randomUUID().toString()
        token = OutboxToken(generation, UUID.randomUUID().toString())
        keys = JceTestOutboxKeyProvider()
        keys.createGeneration(generation)
        cipher = OutboxCipher(keys)
    }

    @Test
    fun `roundtrips entry including nullable subject and attachment bytes`() {
        val withSubject = entry("report-1", byteArrayOf(0, 1, 2, -1))
        val anonymous = withSubject.copy(reportId = "report-2", identitySubject = null)

        assertEquals(withSubject, roundTrip(withSubject, token))
        assertEquals(anonymous, roundTrip(anonymous, token.copy(fileId = UUID.randomUUID().toString())))
    }

    @Test
    fun `ciphertext hides routing metadata and payload`() {
        val encoded = encode(entry("private-report"))
        val text = encoded.toString(Charsets.ISO_8859_1)

        assertTrue(encoded.copyOfRange(0, 4).contentEquals("TXOB".toByteArray()))
        assertFalse(text.contains("private-report"))
        assertFalse(text.contains("captured"))
        assertFalse(text.contains("project-A-key"))
        assertFalse(text.contains("original-person"))
        assertFalse(text.contains("shot.png"))
    }

    @Test
    fun `changed ciphertext and authentication tag are rejected`() {
        val encoded = encode(entry("tamper"))
        val changedCiphertext = encoded.clone().also { it[17] = (it[17].toInt() xor 1).toByte() }
        val changedTag = encoded.clone().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }

        assertThrows(GeneralSecurityException::class.java) { decode(changedCiphertext) }
        assertThrows(GeneralSecurityException::class.java) { decode(changedTag) }
    }

    @Test
    fun `changed magic version and iv are rejected`() {
        val encoded = encode(entry("header"))
        val changedMagic = encoded.clone().also { it[0] = 'U'.code.toByte() }
        val changedVersion = encoded.clone().also { it[4] = 2 }
        val changedIv = encoded.clone().also { it[5] = (it[5].toInt() xor 1).toByte() }

        assertThrows(IllegalArgumentException::class.java) { decode(changedMagic) }
        assertThrows(IllegalArgumentException::class.java) { decode(changedVersion) }
        assertThrows(GeneralSecurityException::class.java) { decode(changedIv) }
    }

    @Test
    fun `blob authenticates immutable generation and file id`() {
        val encoded = encode(entry("bound"))

        assertThrows(GeneralSecurityException::class.java) {
            cipher.read(
                token.copy(fileId = UUID.randomUUID().toString()),
                ByteArrayInputStream(encoded),
            )
        }

        val otherGeneration = UUID.randomUUID().toString()
        keys.createGeneration(otherGeneration)
        assertThrows(GeneralSecurityException::class.java) {
            cipher.read(
                token.copy(generation = otherGeneration),
                ByteArrayInputStream(encoded),
            )
        }
    }

    @Test
    fun `truncated header iv ciphertext and tag are rejected`() {
        val encoded = encode(entry("truncated"))
        val cutoffs = listOf(0, 3, 4, 5, 16, 17, encoded.size - 17, encoded.size - 1)

        cutoffs.forEach { cutoff ->
            assertThrows("cutoff=$cutoff", Exception::class.java) {
                decode(encoded.copyOf(cutoff))
            }
        }
    }

    @Test
    fun `negative and oversized declared lengths are rejected before allocation`() {
        val negativeReportId = plaintext { writeInt(-1) }
        val oversizedReportId = plaintext { writeInt(257) }

        assertThrows(IllegalArgumentException::class.java) {
            decode(encryptPlaintext(negativeReportId, token, keys.loadGeneration(generation)))
        }
        assertThrows(IllegalArgumentException::class.java) {
            decode(encryptPlaintext(oversizedReportId, token, keys.loadGeneration(generation)))
        }
    }

    @Test
    fun `oversized input is rejected at the ciphertext cap`() {
        val limits = OutboxLimits(maxEncodedEntryBytes = 64)
        val boundedCipher = OutboxCipher(keys, limits)
        val oversized = ByteArray(4 + 1 + 12 + 64 + 16 + 1)
        "TXOB".toByteArray().copyInto(oversized)
        oversized[4] = 1

        assertThrows(IllegalArgumentException::class.java) {
            boundedCipher.read(token, ByteArrayInputStream(oversized))
        }
    }

    @Test
    fun `write rejects invalid limits reserved or duplicate names and sha mismatch`() {
        val base = entry("invalid")
        val duplicate = base.copy(attachmentRefs = base.attachmentRefs + base.attachmentRefs.first())
        val reserved = base.copy(
            attachmentRefs = listOf(base.attachmentRefs.first().copy(name = "envelope")),
        )
        val badSha = base.copy(
            attachmentRefs = listOf(base.attachmentRefs.first().copy(sha256Hex = "0".repeat(64))),
        )

        assertThrows(IllegalArgumentException::class.java) { encode(base.copy(reportId = "r".repeat(257))) }
        assertThrows(IllegalArgumentException::class.java) {
            OutboxCipher(keys, OutboxLimits(maxEnvelopeBytes = 1)).write(base, token, ByteArrayOutputStream())
        }
        assertThrows(IllegalArgumentException::class.java) { encode(duplicate) }
        assertThrows(IllegalArgumentException::class.java) { encode(reserved) }
        assertThrows(IllegalArgumentException::class.java) { encode(badSha) }
    }

    @Test
    fun `write rejects malformed retained strings before emitting output`() {
        val malformed = "\uD800"
        val base = entry("malformed-string")
        val invalidEntries = listOf(
            base.copy(reportId = malformed),
            base.copy(idempotencyKey = malformed),
            base.copy(sdkKey = malformed),
            base.copy(endpoint = malformed),
            base.copy(identitySubject = malformed),
        )

        invalidEntries.forEach(::assertWriteRejectedWithoutOutput)
    }

    @Test
    fun `write rejects attachment names that collide after lossy UTF8 replacement before output`() {
        val attachment = entry("name-collision").attachmentRefs.single()
        val value = entry("name-collision").copy(
            attachmentRefs = listOf(
                attachment.copy(name = "\uD800"),
                attachment.copy(name = "?", filename = "second.png"),
            ),
        )

        assertWriteRejectedWithoutOutput(value)
    }

    @Test
    fun `read rejects authenticated trailing plaintext invalid names and sha mismatch`() {
        val valid = validPlaintext(entry("malformed"))
        val trailing = valid + 0
        val duplicateEntry = entry("duplicate").let {
            it.copy(attachmentRefs = it.attachmentRefs + it.attachmentRefs.first())
        }
        val reservedEntry = entry("reserved").let {
            it.copy(attachmentRefs = listOf(it.attachmentRefs.first().copy(name = "envelope")))
        }
        val badShaEntry = entry("bad-sha").let {
            it.copy(attachmentRefs = listOf(it.attachmentRefs.first().copy(sha256Hex = "0".repeat(64))))
        }

        listOf(
            trailing,
            validPlaintext(duplicateEntry),
            validPlaintext(reservedEntry),
            validPlaintext(badShaEntry),
        ).forEach { plaintext ->
            assertThrows(IllegalArgumentException::class.java) {
                decode(encryptPlaintext(plaintext, token, keys.loadGeneration(generation)))
            }
        }
    }

    @Test
    fun `codec loads an existing generation and propagates provider failure`() {
        class FailingProvider : OutboxKeyProvider {
            var loads = 0
            override fun createGeneration(generation: String): SecretKey = error("must not create")
            override fun loadGeneration(generation: String): SecretKey {
                loads++
                error("keystore unavailable")
            }
            override fun deleteGeneration(generation: String) = Unit
        }

        val provider = FailingProvider()
        val failingCipher = OutboxCipher(provider)

        assertThrows(IllegalStateException::class.java) {
            failingCipher.write(entry("write-failure"), token, ByteArrayOutputStream())
        }
        assertEquals(1, provider.loads)

        val valid = encode(entry("read-failure"))
        assertThrows(IllegalStateException::class.java) {
            failingCipher.read(token, ByteArrayInputStream(valid))
        }
        assertEquals(2, provider.loads)
    }

    @Test
    fun `test provider persists across reopen rejects duplicate create and deletes exact alias`() {
        val shared = mutableMapOf<String, SecretKey>()
        val first = JceTestOutboxKeyProvider(shared)
        val generationA = UUID.randomUUID().toString()
        val generationB = UUID.randomUUID().toString()
        val keyA = first.createGeneration(generationA)
        val keyB = first.createGeneration(generationB)
        val reopened = JceTestOutboxKeyProvider(shared)

        assertArrayEquals(keyA.encoded, reopened.loadGeneration(generationA).encoded)
        assertThrows(IllegalStateException::class.java) { reopened.createGeneration(generationA) }
        reopened.deleteGeneration(generationA)
        assertThrows(IllegalStateException::class.java) { first.loadGeneration(generationA) }
        assertArrayEquals(keyB.encoded, first.loadGeneration(generationB).encoded)
    }

    @Test
    fun `non-canonical token UUIDs are rejected`() {
        val canonicalWithLetters = "abcdefab-cdef-4abc-8def-abcdefabcdef"
        keys.createGeneration(canonicalWithLetters)
        val uppercaseGeneration = token.copy(generation = canonicalWithLetters.uppercase())
        val paddedFileId = token.copy(fileId = "1-1-1-1-1")

        assertThrows(IllegalArgumentException::class.java) {
            cipher.write(entry("bad-generation"), uppercaseGeneration, ByteArrayOutputStream())
        }
        assertThrows(IllegalArgumentException::class.java) {
            cipher.write(entry("bad-file"), paddedFileId, ByteArrayOutputStream())
        }
    }

    private fun roundTrip(value: OutboxEntry, token: OutboxToken): OutboxEntry {
        val encoded = encode(value, token)
        return cipher.read(token, ByteArrayInputStream(encoded))
    }

    private fun encode(value: OutboxEntry, token: OutboxToken = this.token): ByteArray =
        ByteArrayOutputStream().also { cipher.write(value, token, it) }.toByteArray()

    private fun decode(encoded: ByteArray): OutboxEntry = cipher.read(token, ByteArrayInputStream(encoded))

    private fun assertWriteRejectedWithoutOutput(value: OutboxEntry) {
        val output = ByteArrayOutputStream()
        assertThrows(IllegalArgumentException::class.java) { cipher.write(value, token, output) }
        assertEquals(0, output.size())
    }

    /** Independent literal v1 encoder used only to produce authenticated malformed plaintext. */
    private fun validPlaintext(value: OutboxEntry): ByteArray = plaintext {
        writeUtf8(value.reportId)
        writeLong(value.createdAt)
        writeBlob(value.envelopeBytes)
        writeUtf8(value.idempotencyKey)
        writeUtf8(value.sdkKey)
        writeUtf8(value.endpoint)
        writeBoolean(value.identitySubject != null)
        value.identitySubject?.let { writeUtf8(it) }
        writeInt(value.attachmentRefs.size)
        value.attachmentRefs.forEach {
            writeUtf8(it.name)
            writeUtf8(it.filename)
            writeUtf8(it.contentType)
            writeBlob(it.data)
            writeUtf8(it.sha256Hex)
        }
    }

    private fun plaintext(block: DataOutputStream.() -> Unit): ByteArray =
        ByteArrayOutputStream().also { bytes -> DataOutputStream(bytes).use(block) }.toByteArray()

    private fun DataOutputStream.writeUtf8(value: String) = writeBlob(value.toByteArray(Charsets.UTF_8))

    private fun DataOutputStream.writeBlob(value: ByteArray) {
        writeInt(value.size)
        write(value)
    }

    private fun encryptPlaintext(plaintext: ByteArray, token: OutboxToken, key: SecretKey): ByteArray {
        val iv = ByteArray(12) { (it + 1).toByte() }
        val aad = plaintext {
            write("TXOB".toByteArray())
            writeByte(1)
            writeUtf8(token.generation)
            writeUtf8(token.fileId)
        }
        val encryptor = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, iv))
            updateAAD(aad)
        }
        return ByteArrayOutputStream().also {
            it.write("TXOB".toByteArray())
            it.write(1)
            it.write(iv)
            it.write(encryptor.doFinal(plaintext))
        }.toByteArray()
    }
}
