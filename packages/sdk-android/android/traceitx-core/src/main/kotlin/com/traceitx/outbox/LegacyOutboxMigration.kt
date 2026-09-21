// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package com.traceitx.outbox

import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import java.io.InputStream
import java.nio.charset.CodingErrorAction

internal sealed interface LegacyEntryResult {
    data class Record(val entry: OutboxEntry, val offset: Long) : LegacyEntryResult
    data class Blocked(val offset: Long, val reason: LegacyReadFailure) : LegacyEntryResult
    data object End : LegacyEntryResult
}
internal enum class LegacyReadFailure { OVERSIZE, MALFORMED, MISSING_ROUTE }

/** Schema-specific, incremental compatibility reader. It never constructs a JSON tree or line. */
internal class LegacyEntryReader(
    private val input: InputStream,
    private val limits: OutboxLimits = OutboxLimits(),
    private val allocator: (Int) -> ByteArray = { ByteArray(it) },
    private val stringDecoder: (String) -> String = { Json.decodeFromString(String.serializer(), it) },
) {
    // Conservative reserve for bounded metadata strings, UTF8 decoder and scalar/token scratch.
    private var retained = TOKEN_MEMORY_RESERVE
    var peakRetainedBytes = 0L; private set
    private fun allocate(size: Int): ByteArray {
        retained += size
        peakRetainedBytes = maxOf(peakRetainedBytes, retained)
        return allocator(size)
    }
    private val scratch = allocate(CHUNK)
    private var position = 0
    private var available = 0
    private var offset = 0L
    private var start = 0L
    private var aggregate = 0L
    private var stopped: LegacyEntryResult.Blocked? = null
    private class Invalid(val reason: LegacyReadFailure) : Exception()
    private fun bad(reason: LegacyReadFailure = LegacyReadFailure.MALFORMED): Nothing = throw Invalid(reason)
    private fun peek(): Int {
        if (available < 0) return -1
        if (position == available) {
            available = input.read(scratch)
            position = 0
            if (available < 0) return -1
            if (available == 0) return peek()
        }
        return scratch[position].toInt() and 255
    }
    private fun take(): Int {
        val c = peek()
        if (c < 0) bad()
        if (offset - start >= MAX_RECORD) bad(LegacyReadFailure.OVERSIZE)
        position++; offset++
        return c
    }
    private fun ws() { while (peek() == 32 || peek() == 9 || peek() == 13) take() }
    private fun expect(c: Char) { ws(); if (take() != c.code) bad() }
    private fun literal(value: String) { value.forEach { if (take() != it.code) bad() } }

    fun next(): LegacyEntryResult {
        stopped?.let { return it }
        retained = CHUNK + TOKEN_MEMORY_RESERVE // Previous entry ownership passed to the caller.
        aggregate = 0
        start = offset
        return try {
            while (peek() == 32 || peek() == 9 || peek() == 13 || peek() == 10) { take(); start = offset }
            if (peek() < 0) return LegacyEntryResult.End
            start = offset
            val entry = record()
            ws()
            if (peek() != -1 && peek() != 10) bad()
            if (peek() == 10) take()
            LegacyEntryResult.Record(entry, start)
        } catch (failure: Invalid) {
            LegacyEntryResult.Blocked(start, failure.reason).also { stopped = it }
        }
    }

    private inner class Bytes {
        private val chunks = ArrayList<ByteArray>()
        var size = 0; private set
        fun append(value: Int) {
            if (size % CHUNK == 0) chunks.add(allocate(CHUNK))
            chunks.last()[size % CHUNK] = value.toByte(); size++
        }
        fun tokenString(): String {
            val streams = chunks.mapIndexed { index, chunk ->
                java.io.ByteArrayInputStream(chunk, 0, minOf(CHUNK, size - index * CHUNK))
            }
            val input = java.io.SequenceInputStream(java.util.Collections.enumeration(streams))
            val decoder = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
            val token = StringBuilder()
            java.io.InputStreamReader(input, decoder).use { reader ->
                val chars = CharArray(4096)
                while (true) {
                    val count = reader.read(chars)
                    if (count < 0) break
                    token.append(chars, 0, count)
                }
            }
            chunks.forEach { retained -= it.size }; chunks.clear()
            return token.toString()
        }
        fun finish(): ByteArray {
            val result = allocate(size)
            var copied = 0
            for (chunk in chunks) {
                val count = minOf(CHUNK, size - copied)
                chunk.copyInto(result, copied, 0, count); copied += count
                retained -= chunk.size
            }
            chunks.clear()
            return result
        }
    }
    private fun string(limit: Int, rawLimit: Long = 6L * limit + 2): String {
        ws()
        val bytes = Bytes()
        val cap = rawLimit
        fun append(c: Int) {
            if (bytes.size >= cap) bad(LegacyReadFailure.OVERSIZE)
            bytes.append(c)
        }
        if (take() != 34) bad()
        append(34)
        while (true) {
            val c = take(); append(c)
            if (c == 34) break
            if (c < 32) bad()
            if (c == 92) {
                val escape = take(); append(escape)
                if (escape == 117) repeat(4) {
                    val hex = take(); append(hex)
                    if (hex !in 48..57 && hex !in 65..70 && hex !in 97..102) bad()
                } else if (escape !in intArrayOf(34,92,47,98,102,110,114,116)) bad()
            }
        }
        return try {
            stringDecoder(bytes.tokenString()).also {
                // Count strict UTF8 without an encoder allocating a whole unknown-field byte buffer.
                var utf8Bytes = 0L
                var index = 0
                while (index < it.length) {
                    val char = it[index++]
                    utf8Bytes += when {
                        char.code < 0x80 -> 1
                        char.code < 0x800 -> 2
                        char.isHighSurrogate() -> {
                            if (index == it.length || !it[index++].isLowSurrogate()) bad()
                            4
                        }
                        char.isLowSurrogate() -> bad()
                        else -> 3
                    }
                    if (utf8Bytes > limit) bad(LegacyReadFailure.OVERSIZE)
                }
            }
        } catch (failure: Invalid) { throw failure }
        catch (_: Exception) { bad() }
    }
    private fun number(cap: Int): String {
        ws()
        val token = StringBuilder()
        while (peek() != -1 && peek() !in intArrayOf(32,9,13,10,44,93,125)) {
            if (token.length >= cap) bad()
            token.append(take().toChar())
        }
        return token.toString()
    }
    private fun integer(cap: Int): Long {
        ws()
        var count = 0
        val negative = peek() == 45
        if (negative) { take(); count++ }
        val first = peek()
        if (first !in 48..57) bad()
        var result = 0L
        val minimum = if (negative) Long.MIN_VALUE else -Long.MAX_VALUE
        var digits = 0
        while (peek() in 48..57) {
            if (++count > cap || (digits > 0 && first == 48)) bad()
            val digit = take() - 48
            if (result < minimum / 10) bad()
            result *= 10
            if (result < minimum + digit) bad()
            result -= digit; digits++
        }
        val end = peek()
        if (end != -1 && end != 32 && end != 9 && end != 13 && end != 10 && end != 44 && end != 93 && end != 125) bad()
        return if (negative) result else -result
    }
    private fun bytes(envelope: Boolean): ByteArray {
        expect('[')
        val bytes = Bytes()
        ws()
        if (peek() != 93) while (true) {
            val value = integer(4)
            if (value !in -128..127) bad()
            // Count before allocating or appending the next byte.
            if (aggregate >= limits.maxPayloadBytes || (envelope && bytes.size >= limits.maxEnvelopeBytes)) {
                bad(LegacyReadFailure.OVERSIZE)
            }
            aggregate++; bytes.append(value.toInt())
            ws()
            if (peek() != 44) break
            take()
        }
        expect(']')
        return bytes.finish()
    }
    private inline fun fields(known: Set<String> = ENTRY_FIELDS, consume: (String) -> Unit) {
        expect('{'); ws()
        // Only recognized names affect routing/schema and need duplicate detection.
        // Unknown forward-compatible fields (including repeated names) are discarded without retention.
        val seen = HashSet<String>()
        if (peek() != 125) while (true) {
            val name = string(limits.maxPartMetadataBytes)
            if (name in known && !seen.add(name)) bad()
            expect(':'); ws(); consume(name); ws()
            if (peek() != 44) break
            take()
        }
        expect('}')
    }
    private fun record(): OutboxEntry {
        var id: String? = null; var created: Long? = null; var envelope: ByteArray? = null
        var idem: String? = null; var parts: List<OutboxEntry.AttachmentRef>? = null
        var key: String? = null; var endpoint: String? = null; var subject: String? = null
        fields { name -> when (name) {
            "reportId" -> id = string(limits.maxReportIdBytes)
            "createdAt" -> created = integer(20)
            "envelopeBytes" -> envelope = bytes(true)
            "idempotencyKey" -> idem = string(limits.maxRoutingFieldBytes)
            "attachmentRefs" -> parts = attachments()
            "sdkKey" -> key = string(limits.maxRoutingFieldBytes)
            "endpoint" -> endpoint = string(limits.maxRoutingFieldBytes)
            "identitySubject" -> subject = if (peek() == 110) { literal("null"); null } else string(limits.maxRoutingFieldBytes)
            else -> skip(0)
        } }
        if (key == null || endpoint == null) bad(LegacyReadFailure.MISSING_ROUTE)
        return OutboxEntry(id ?: bad(), created ?: bad(), envelope ?: bad(), idem ?: bad(),
            parts ?: bad(), key!!, endpoint!!, subject)
    }
    private fun attachments(): List<OutboxEntry.AttachmentRef> {
        expect('['); ws()
        val result = ArrayList<OutboxEntry.AttachmentRef>()
        if (peek() != 93) while (true) {
            if (result.size >= limits.maxAttachments) bad(LegacyReadFailure.OVERSIZE)
            var name: String? = null; var filename: String? = null; var type: String? = null
            var data: ByteArray? = null; var hash: String? = null
            fields(PART_FIELDS) { field -> when (field) {
                "name" -> name = string(limits.maxPartMetadataBytes)
                "filename" -> filename = string(limits.maxPartMetadataBytes)
                "contentType" -> type = string(limits.maxPartMetadataBytes)
                "data" -> data = bytes(false)
                "sha256Hex" -> hash = string(64)
                else -> skip(0)
            } }
            if (hash?.matches(Regex("[0-9a-fA-F]{64}")) != true) bad()
            if (name == "envelope" || result.any { it.name == name }) bad()
            result.add(OutboxEntry.AttachmentRef(name ?: bad(), filename ?: bad(), type ?: bad(), data ?: bad(), hash!!))
            ws(); if (peek() != 44) break
            take()
        }
        expect(']'); return result
    }
    private fun skip(depth: Int) {
        ws()
        when (peek()) {
            123, 91 -> {
                if (depth >= 16) bad(LegacyReadFailure.OVERSIZE)
                val objectValue = take() == 123
                val close = if (objectValue) 125 else 93
                ws()
                if (peek() != close) while (true) {
                    if (objectValue) { string(98304, 98306); expect(':') }
                    skip(depth + 1); ws()
                    if (peek() != 44) break
                    take()
                }
                expect(close.toChar())
            }
            34 -> { string(98304, 98306) }
            116 -> literal("true")
            102 -> literal("false")
            110 -> literal("null")
            else -> if (!NUMBER.matches(number(98306))) bad()
        }
    }
    private companion object {
        const val CHUNK = 65536
        const val MAX_RECORD = 134_217_728L
        const val TOKEN_MEMORY_RESERVE = 1_048_576L
        val ENTRY_FIELDS = setOf("reportId", "createdAt", "envelopeBytes", "idempotencyKey", "attachmentRefs", "sdkKey", "endpoint", "identitySubject")
        val PART_FIELDS = setOf("name", "filename", "contentType", "data", "sha256Hex")
        val NUMBER = Regex("-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?")
    }
}

internal object LegacyOutboxMigration {
    fun migrate(outbox: JSONLOutbox): Int = outbox.store.migrateLegacy()
}
