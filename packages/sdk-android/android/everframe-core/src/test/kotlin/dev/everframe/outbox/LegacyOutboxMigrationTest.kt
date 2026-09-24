// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.outbox

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.builtins.serializer
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class LegacyOutboxMigrationTest {
    @get:Rule val tmp = TemporaryFolder()
    private val keys = JceTestOutboxKeyProvider()
    private fun box(file: File, capacity: Long = JSONLOutbox.DEFAULT_MAX_TOTAL_BYTES) =
        JSONLOutbox(file, keys, JvmOutboxFileOps(), maxTotalBytes = capacity)
    private fun legacy(file: File, value: OutboxEntry) = file.writeText(Json.encodeToString(OutboxEntry.serializer(), value) + "\n")
    @Test fun `valid legacy route payload and identity migrate durably`() = runTest {
        val file = File(tmp.newFolder(), "outbox.jsonl")
        val expected = entry("legacy", byteArrayOf(-128, -1, 0, 127))
        legacy(file, expected)
        assertEquals(listOf(expected), box(file).hydrate())
        assertFalse(file.exists())
        assertEquals(listOf(expected), box(file).hydrate())
    }
    @Test fun `processing source survives restart and imports once`() = runTest {
        val file = File(tmp.newFolder(), "outbox.jsonl")
        val processing = File(file.parentFile, "crash-outbox.jsonl.processing")
        legacy(processing, entry("crash"))
        assertEquals(listOf(entry("crash")), box(file).hydrate())
        assertFalse(processing.exists())
        assertEquals(1, box(file).count())
    }
    @Test fun `blocked tail preserves source and receipt after delivered prefix`() = runTest {
        val file = File(tmp.newFolder(), "outbox.jsonl")
        legacy(file, entry("prefix")); file.appendText("{broken\n")
        val original = file.readBytes()
        val first = box(file)
        assertEquals(1, first.count())
        first.drain { true }
        assertArrayEquals(original, file.readBytes())
        assertEquals(0, box(file).count())
        assertArrayEquals(original, file.readBytes())
    }
    @Test fun `inherited source quota rejects new admission without eviction`() = runTest {
        val file = File(tmp.newFolder(), "outbox.jsonl")
        legacy(file, entry("old"))
        val limited = box(file, file.length() + 1024 * 1024)
        assertTrue(runCatching { limited.enqueue(entry("new")) }.exceptionOrNull() is OutboxWriteException)
        assertTrue(file.exists())
    }
    @Test fun `kill history prevents old sources importing after reopen`() = runTest {
        val file = File(tmp.newFolder(), "outbox.jsonl")
        box(file).store.revokeSync()
        legacy(file, entry("revoked"))
        assertEquals(0, box(file).count())
    }
    private fun read(text: String, limits: OutboxLimits = OutboxLimits()): LegacyEntryResult =
        LegacyEntryReader(text.byteInputStream(), limits).next()
    private val minimal = """{"endpoint":"https://a","sdkKey":"key","reportId":"r","createdAt":-1,"envelopeBytes":[-128,-1,0,127],"idempotencyKey":"i","attachmentRefs":[]}"""
    @Test fun `schema field order unknown values escapes and absent subject`() {
        val json = minimal.dropLast(1) + """, "future":{"array":[true,null,1.25,"\u0041"]}}"""
        val actual = (read(json) as LegacyEntryResult.Record).entry
        assertNull(actual.identitySubject)
        assertEquals("https://a", actual.endpoint)
        assertArrayEquals(byteArrayOf(-128,-1,0,127), actual.envelopeBytes)
    }
    @Test fun `malformed tokens duplicates overflow and truncation block`() {
        for (bad in listOf(
            minimal.replace("-128", "128"), minimal.replace("-128", "-129"),
            minimal.replace("-128", "1.0"), minimal.replace("-128", "1e0"),
            minimal.replace("-128", "0001"), minimal.replace("-1,0", "-1,,0"),
            minimal.dropLast(2), minimal.replace("-1,\"envelope", "9223372036854775808,\"envelope"),
            minimal.dropLast(1) + """, "sdkKey":"other"}""",
            minimal.replace("https://a", "bad\\q"), minimal.replace("https://a", "bad\n"),
        )) assertTrue(bad.take(100), read(bad) is LegacyEntryResult.Blocked)
        assertEquals(LegacyReadFailure.MISSING_ROUTE,
            (read(minimal.replace("\"sdkKey\":\"key\",", "")) as LegacyEntryResult.Blocked).reason)
        assertEquals(LegacyReadFailure.OVERSIZE,
            (read(minimal, OutboxLimits(maxPayloadBytes = 3)) as LegacyEntryResult.Blocked).reason)
        assertEquals(LegacyReadFailure.OVERSIZE,
            (read(minimal, OutboxLimits(maxRoutingFieldBytes = 2)) as LegacyEntryResult.Blocked).reason)
    }
    private fun repeatedStream(count: Long, token: ByteArray) = object : java.io.InputStream() {
        var emitted = 0L
        override fun read(): Int = if (emitted == count) -1 else token[(emitted++ % token.size).toInt()].toInt() and 255
    }
    private fun largeStream(count: Int): java.io.InputStream {
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        val chunk = ByteArray(65536) { -128 }
        var remaining = count
        while (remaining > 0) { val n = minOf(remaining, chunk.size); digest.update(chunk, 0, n); remaining -= n }
        val hash = digest.digest().joinToString("") { "%02x".format(it) }
        val original = entry("large", byteArrayOf())
        val value = original.copy(attachmentRefs = listOf(original.attachmentRefs.single().copy(sha256Hex = hash)))
        val json = Json.encodeToString(OutboxEntry.serializer(), value)
        val parts = json.split("\"data\":[]")
        return java.io.SequenceInputStream(java.util.Collections.enumeration(listOf(
            (parts[0] + "\"data\":[-128").byteInputStream(),
            repeatedStream((count - 1L) * 5, ",-128".toByteArray()),
            ("]" + parts[1]).byteInputStream(),
        )))
    }
    @Test fun `generated 10 MB numeric record imports exact 2 million signed bytes`() = runTest {
        val file = File(tmp.newFolder(), "outbox.jsonl")
        largeStream(2_000_000).use { input -> file.outputStream().use { input.copyTo(it, 65536) } }
        assertTrue(file.length() > 9 * 1024 * 1024)
        val migrated = box(file).hydrate().single()
        assertEquals("https://a.example", migrated.endpoint)
        assertEquals("project-A-key", migrated.sdkKey)
        assertEquals("original-person", migrated.identitySubject)
        assertEquals("idem-large", migrated.idempotencyKey)
        val attachment = migrated.attachmentRefs.single()
        val data = attachment.data
        assertEquals(2_000_000, data.size)
        assertArrayEquals(ByteArray(2_000_000) { -128 }, data)
        val expectedHash = "a0ed5ad8d4180e55fe5fbbc0f343069cb5bb200cdb410a845d70e0a776dc7b36"
        assertEquals(expectedHash, attachment.sha256Hex)
        assertEquals(expectedHash, java.security.MessageDigest.getInstance("SHA-256").digest(data)
            .joinToString("") { "%02x".format(it) })
        assertFalse(file.exists())
    }
    @Test fun `huge routing token rejected with bounded read ahead before decoder`() {
        val prefix = "{\"sdkKey\":\"".toByteArray()
        val source = java.io.SequenceInputStream(prefix.inputStream(), repeatedStream(128L * 1024 * 1024, byteArrayOf(97)))
        var consumed = 0L
        val counted = object : java.io.FilterInputStream(source) {
            override fun read(b: ByteArray, off: Int, len: Int): Int = super.read(b, off, len).also { if (it > 0) consumed += it }
        }
        val decodedTokens = mutableListOf<String>()
        val result = LegacyEntryReader(counted, stringDecoder = {
            decodedTokens.add(it)
            Json.decodeFromString(String.serializer(), it)
        }).next()
        assertEquals(listOf("\"sdkKey\""), decodedTokens)
        assertEquals(LegacyReadFailure.OVERSIZE, (result as LegacyEntryResult.Blocked).reason)
        assertTrue(consumed <= prefix.size + 6 * 16384 + 2 + 65536)
    }
    @Test fun `parser allocations bound near limit and overflow checks precede next chunk`() {
        val allocations = mutableListOf<Int>()
        val parser = LegacyEntryReader(largeStream(23_999_979), allocator = { size -> allocations.add(size); ByteArray(size) })
        assertTrue(parser.next() is LegacyEntryResult.Record)
        assertTrue(allocations.all { it <= 65536 || it == 23_999_979 })
        assertTrue(parser.peakRetainedBytes <= 48_000_000L + 7 * 65536 + 1048576)
        allocations.clear()
        val stream = java.io.SequenceInputStream("{\"envelopeBytes\":[-128".byteInputStream(),
            repeatedStream(65536L * 5, ",-128".toByteArray()))
        val limited = LegacyEntryReader(stream, OutboxLimits(maxPayloadBytes = 65536),
            allocator = { size -> allocations.add(size); ByteArray(size) })
        assertEquals(LegacyReadFailure.OVERSIZE, (limited.next() as LegacyEntryResult.Blocked).reason)
        assertEquals(3, allocations.count { it == 65536 }) // IO, field-name token, one admitted payload chunk
    }

    @Test fun `key unavailable blocks migration and preserves plaintext original`() {
        val file = File(tmp.newFolder(), "outbox.jsonl")
        legacy(file, entry("blocked"))
        val original = file.readBytes()
        val unavailable = object : OutboxKeyProvider by keys {
            override fun createGeneration(generation: String): javax.crypto.SecretKey = error("locked")
        }
        val box = JSONLOutbox(file, unavailable, JvmOutboxFileOps())
        assertEquals(0, LegacyOutboxMigration.migrate(box))
        assertEquals("KEY_UNAVAILABLE", box.store.migrationBlocked)
        assertArrayEquals(original, file.readBytes())
    }
    @Test fun `death after encrypted commit before receipt finalization recovers once after delivery`() = runTest {
        val file = File(tmp.newFolder(), "outbox.jsonl")
        legacy(file, entry("uncertain")); file.appendText("{blocked\n")
        val original = file.readBytes()
        var fail = true
        val ops = object : OutboxFileOps by JvmOutboxFileOps() {
            override fun renameAtomic(from: File, to: File) {
                JvmOutboxFileOps().renameAtomic(from, to)
                if (to.extension == "txq" && fail) { fail = false; throw java.io.IOException("death") }
            }
        }
        val first = JSONLOutbox(file, keys, ops)
        assertEquals(0, LegacyOutboxMigration.migrate(first))
        assertEquals(1, File(file.parentFile, "outbox.jsonl.encrypted/active").listFiles()!!.count { it.extension == "intent" })
        val reopened = box(file)
        assertEquals(listOf(entry("uncertain")), reopened.hydrate())
        reopened.drain { true }
        assertEquals(0, box(file).count())
        assertArrayEquals(original, file.readBytes())
    }
    @Test fun `receipt write failure preserves original without encrypted queued success`() {
        val file = File(tmp.newFolder(), "outbox.jsonl")
        legacy(file, entry("write-failed"))
        val original = file.readBytes()
        val ops = object : OutboxFileOps by JvmOutboxFileOps() {
            override fun syncFile(file: File) {
                if (file.extension == "intent") throw java.io.IOException("receipt unavailable")
                JvmOutboxFileOps().syncFile(file)
            }
        }
        val first = JSONLOutbox(file, keys, ops)
        assertEquals(0, LegacyOutboxMigration.migrate(first))
        assertEquals("IO", first.store.migrationBlocked)
        assertArrayEquals(original, file.readBytes())
        assertEquals(0, File(file.parentFile, "outbox.jsonl.encrypted/active").listFiles()!!.count { it.extension == "txq" })
    }
    @Test fun `all legacy sources remain suppressed after kill even if plaintext unlink is impossible`() = runTest {
        val file = File(tmp.newFolder(), "outbox.jsonl")
        val sources = listOf(file, File(file.parentFile, "crash-outbox.jsonl"), File(file.parentFile, "crash-outbox.jsonl.processing"))
        sources.forEachIndexed { index, source -> legacy(source, entry("old-$index")) }
        box(file).store.revokeSync()
        val reopened = box(file)
        assertEquals(0, reopened.count())
        assertTrue(sources.all { it.exists() })
        reopened.enqueue(entry("fresh"))
        assertEquals(listOf(entry("fresh")), reopened.hydrate())
    }
    @Test fun `metadata attachment count unknown nesting and malformed UTF8 stay bounded`() {
        val serialized = Json.encodeToString(OutboxEntry.serializer(), entry("r"))
        assertEquals(LegacyReadFailure.OVERSIZE,
            (read(serialized, OutboxLimits(maxPayloadBytes = 23)) as LegacyEntryResult.Blocked).reason)
        val tooMany = entry("r").copy(attachmentRefs = List(7) { i -> entry("r").attachmentRefs.single().copy(name = "part-$i") })
        assertEquals(LegacyReadFailure.OVERSIZE,
            (read(Json.encodeToString(OutboxEntry.serializer(), tooMany)) as LegacyEntryResult.Blocked).reason)
        assertEquals(LegacyReadFailure.OVERSIZE,
            (read(serialized.replace("shot.png", "x".repeat(1025))) as LegacyEntryResult.Blocked).reason)
        assertEquals(LegacyReadFailure.MALFORMED,
            (read(serialized.replace(entry("r").attachmentRefs.single().sha256Hex, "z".repeat(64))) as LegacyEntryResult.Blocked).reason)
        val nested = minimal.dropLast(1) + ",\"future\":" + "[".repeat(17) + "0" + "]".repeat(17) + "}"
        assertEquals(LegacyReadFailure.OVERSIZE, (read(nested) as LegacyEntryResult.Blocked).reason)
        val invalidUtf8 = "{\"sdkKey\":\"".toByteArray() + byteArrayOf(0xc0.toByte(), 0xaf.toByte()) + "\"}".toByteArray()
        assertEquals(LegacyReadFailure.MALFORMED,
            (LegacyEntryReader(invalidUtf8.inputStream()).next() as LegacyEntryResult.Blocked).reason)
        val unknown = minimal.dropLast(1) + ",\"future\":\"" + "a".repeat(98000) + "\"}"
        assertTrue(read(unknown) is LegacyEntryResult.Record)
        val duplicatePart = serialized.replace("\"name\":\"shot\"", "\"name\":\"shot\",\"name\":\"other\"")
        assertTrue(read(duplicatePart) is LegacyEntryResult.Blocked)
    }

    @Test fun `worst case escaped routing token uses only fixed chunks`() {
        val allocations = mutableListOf<Int>()
        val escaped = minimal.replace("\"key\"", "\"" + "\\u0061".repeat(16384) + "\"")
        val reader = LegacyEntryReader(escaped.byteInputStream(), allocator = { size -> allocations.add(size); ByteArray(size) })
        val actual = reader.next() as LegacyEntryResult.Record
        assertEquals("a".repeat(16384), actual.entry.sdkKey)
        assertTrue(allocations.toString(), allocations.all { it <= 65536 })
    }
    @Test fun `many bounded unknown fields including repeated unknown names are skipped`() {
        val json = minimal.dropLast(1) + (1..200).joinToString("") { ",\"future\":{\"x\":[$it,true,null]}" } + "}"
        assertTrue(read(json) is LegacyEntryResult.Record)
    }

    @Test fun `migration reserves source receipt and candidate before any ciphertext staging`() = runTest {
        for (delta in listOf(0L, -1L)) {
            val file = File(tmp.newFolder(), "outbox.jsonl")
            val original = entry("budget")
            legacy(file, original)
            val receipt = original.copy(envelopeBytes = ("0|" + "0".repeat(64) + "|0|" + "0".repeat(36)).toByteArray(), attachmentRefs = emptyList())
            val required = file.length() + OutboxCipher(keys).encryptedSize(original) + OutboxCipher(keys).encryptedSize(receipt) + 1024 * 1024
            var maxObserved = 0L
            val root = File(file.parentFile, "outbox.jsonl.encrypted")
            val ops = object : OutboxFileOps by JvmOutboxFileOps() {
                override fun syncFile(candidate: File) {
                    val bytes = file.length() + root.walkTopDown().filter { it.isFile }.sumOf { it.length() }
                    maxObserved = maxOf(maxObserved, bytes)
                    assertTrue("candidate staged above reserved quota", bytes <= required + delta)
                    JvmOutboxFileOps().syncFile(candidate)
                }
            }
            val first = JSONLOutbox(file, keys, ops, maxTotalBytes = required + delta)
            assertEquals(if (delta == 0L) 1 else 0, LegacyOutboxMigration.migrate(first))
            if (delta == 0L) {
                assertEquals(required - 1024 * 1024, maxObserved)
                assertEquals(listOf(original), first.hydrate())
                assertFalse(file.exists())
            } else {
                assertEquals("CAPACITY", first.store.migrationBlocked)
                assertTrue(file.exists())
                assertEquals(0, root.walkTopDown().count { it.extension in listOf("tmp", "txq", "intent", "receipt") })
            }
        }
    }
    @Test fun `inherited above 64 MiB adds no ciphertext and never evicts old source`() = runTest {
        val file = File(tmp.newFolder(), "outbox.jsonl")
        legacy(file, entry("old"))
        java.io.RandomAccessFile(file, "rw").use { it.setLength(65L * 1024 * 1024) }
        val originalLength = file.length()
        val first = box(file)
        assertEquals(0, LegacyOutboxMigration.migrate(first))
        assertEquals("CAPACITY", first.store.migrationBlocked)
        val failure = runCatching { first.enqueue(entry("new")) }.exceptionOrNull() as OutboxWriteException
        assertEquals(OutboxFailure.CAPACITY, failure.failure)
        assertEquals(originalLength, file.length())
        val root = File(file.parentFile, "outbox.jsonl.encrypted")
        assertEquals(0L, root.walkTopDown().filter { it.isFile }.sumOf { it.length() })
    }
    @Test fun `source unlink sync failure retains receipts until fresh reopen reconciles deletion`() = runTest {
        val file = File(tmp.newFolder(), "outbox.jsonl")
        legacy(file, entry("unlink"))
        var fail = true
        val ops = object : OutboxFileOps by JvmOutboxFileOps() {
            override fun syncDirectory(dir: File) {
                if (dir.canonicalFile == requireNotNull(file.parentFile).canonicalFile && !file.exists() && fail) { fail = false; throw java.io.IOException("unsynced unlink") }
                JvmOutboxFileOps().syncDirectory(dir)
            }
        }
        val first = JSONLOutbox(file, keys, ops)
        assertEquals(1, LegacyOutboxMigration.migrate(first))
        assertEquals("IO", first.store.migrationBlocked)
        val root = File(file.parentFile, "outbox.jsonl.encrypted")
        assertEquals(1, root.walkTopDown().count { it.extension == "receipt" })
        assertFalse(file.exists())
        assertEquals(listOf(entry("unlink")), box(file).hydrate())
        assertEquals(0, root.walkTopDown().count { it.extension == "receipt" })
    }
    @Test fun `whole encoded bound applies across many individually bounded unknown tokens`() {
        val prefix = minimal.dropLast(1).byteInputStream()
        val fieldStart = ",\"future\":\"".toByteArray()
        val fieldSize = fieldStart.size + 98000L + 1
        var emitted = 0L
        val fields = object : java.io.InputStream() {
            override fun read(): Int {
                val index = emitted++ % fieldSize
                return if (index < fieldStart.size) fieldStart[index.toInt()].toInt()
                else if (index == fieldSize - 1) 34 else 97
            }
        }
        val input = java.io.SequenceInputStream(prefix, fields)
        assertEquals(LegacyReadFailure.OVERSIZE,
            (LegacyEntryReader(input).next() as LegacyEntryResult.Blocked).reason)
        assertTrue(emitted <= 134_217_728L + 65536)
    }

    @Test fun `kill invalidation during migration intent prevents admission and future reimport`() = runTest {
        val file = File(tmp.newFolder(), "outbox.jsonl")
        legacy(file, entry("racing-kill"))
        lateinit var first: JSONLOutbox
        val ops = object : OutboxFileOps by JvmOutboxFileOps() {
            override fun syncFile(file: File) {
                JvmOutboxFileOps().syncFile(file)
                if (file.extension == "intent") first.store.invalidateSync()
            }
        }
        first = JSONLOutbox(file, keys, ops)
        assertEquals(0, LegacyOutboxMigration.migrate(first))
        assertEquals("REVOKED", first.store.migrationBlocked)
        assertTrue(file.exists())
        first.store.revokeSync()
        assertEquals(0, box(file).count())
        assertTrue(file.exists())
    }

    @Test fun `cross source receipt survives removed first source while second remains blocked`() = runTest {
        val file = File(tmp.newFolder(), "outbox.jsonl")
        val second = File(file.parentFile, "crash-outbox.jsonl")
        legacy(file, entry("shared")); second.writeText("{blocked\n")
        val first = box(file)
        assertEquals(1, first.count())
        assertFalse(file.exists())
        first.drain { true }
        // A repaired historical sidecar repeats the already delivered report.
        legacy(second, entry("shared")); second.appendText("{still-blocked\n")
        assertEquals(0, box(file).count())
        assertTrue(second.exists())
        assertEquals(0, box(file).count())
    }

    @Test fun `capacity stop reports durable prefix progress and resumes after it drains`() = runTest {
        val file = File(tmp.newFolder(), "outbox.jsonl")
        legacy(file, entry("one"))
        file.appendText(Json.encodeToString(OutboxEntry.serializer(), entry("two")) + "\n")
        val first = JSONLOutbox(file, keys, JvmOutboxFileOps(), maxEntries = 1)
        assertEquals(1, LegacyOutboxMigration.migrate(first))
        assertEquals("CAPACITY", first.store.migrationBlocked)
        assertTrue(file.exists())
        first.drain { assertEquals("one", it.reportId); true }
        assertEquals(1, LegacyOutboxMigration.migrate(first))
        assertEquals(listOf(entry("two")), first.hydrate())
        assertFalse(file.exists())
    }

    @Test fun `UTF8 route budgets count multibyte characters and reject unpaired escaped surrogates`() {
        for (value in listOf("é".repeat(8192), "漢".repeat(5461), "😀".repeat(4096))) {
            assertTrue(read(minimal.replace("\"key\"", "\"$value\"")) is LegacyEntryResult.Record)
            assertEquals(LegacyReadFailure.OVERSIZE,
                (read(minimal.replace("\"key\"", "\"$value$value\"")) as LegacyEntryResult.Blocked).reason)
        }
        for (value in listOf("\\uD800", "\\uDC00", "\\uD800x")) {
            assertEquals(LegacyReadFailure.MALFORMED,
                (read(minimal.replace("\"key\"", "\"$value\"")) as LegacyEntryResult.Blocked).reason)
        }
    }

}
