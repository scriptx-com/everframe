// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import dev.everframe.protocol.generated.AndroidNativeABI
import dev.everframe.protocol.generated.AndroidNativeCrashMetadata
import dev.everframe.protocol.generated.AndroidNativeFrame
import dev.everframe.protocol.generated.AndroidNativeSource
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

/** Healthy-process reader for Android debuggerd's tombstone.proto (API 31+).
 * No memory dumps, logs, registers, command lines, thread names or abort text leave this boundary.
 * Unknown fields are skipped, never recursively decoded. Does not install a signal handler.
 */
internal object AndroidTombstoneReader {
    private const val MAX_BYTES = 4 * 1024 * 1024
    private const val MAX_FIELDS = 100_000
    private const val MAX_THREADS = 1024
    private const val MAX_FRAMES = 256

    fun read(input: InputStream): AndroidNativeCrashMetadata? = try {
        input.use { stream ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (true) {
                val count = stream.read(buffer, 0, minOf(buffer.size, MAX_BYTES + 1 - output.size()))
                if (count < 0) break
                // Broken streams must not spin forever. Real OS streams obey InputStream's contract.
                require(count > 0)
                output.write(buffer, 0, count)
                require(output.size() <= MAX_BYTES)
            }
            decode(output.toByteArray())
        }
    } catch (_: Exception) { null }

    private class Budget(var fields: Int = MAX_FIELDS)
    private data class Slice(val start: Int, val end: Int)
    private class Wire(val bytes: ByteArray, val budget: Budget, val start: Int = 0, val end: Int = bytes.size) {
        var position = start
        var type = 0
        fun next(): Int? {
            if (position == end) return null
            require(--budget.fields >= 0)
            val tag = varint()
            require(tag in 1uL..0xffffffffuL)
            type = (tag and 7u).toInt()
            val field = (tag shr 3).toInt()
            require(field > 0 && type in listOf(0, 1, 2, 5))
            return field
        }
        fun varint(): ULong {
            var value = 0uL
            for (i in 0..9) {
                require(position < end)
                val part = bytes[position++].toInt() and 255
                if (i == 9) require(part <= 1)
                value = value or ((part and 127).toULong() shl (i * 7))
                if (part < 128) {
                    require(i == 0 || part != 0) // Noncanonical/overlong encodings are not OS evidence.
                    return value
                }
            }
            error("Unterminated varint")
        }
        fun number(): ULong { require(type == 0); return varint() }
        fun slice(): Slice {
            require(type == 2)
            val length = varint()
            require(length <= (end - position).toULong())
            val result = Slice(position, position + length.toInt())
            position = result.end
            return result
        }
        fun child(slice: Slice) = Wire(bytes, budget, slice.start, slice.end)
        fun text(): String {
            val value = slice()
            require(value.end - value.start <= 16384)
            return Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes, value.start, value.end - value.start)).toString()
        }
        fun skip() {
            when (type) {
                0 -> varint()
                2 -> slice()
                1, 5 -> { val length = if (type == 1) 8 else 4; require(length <= end - position); position += length }
                else -> error("Unsupported wire type")
            }
        }
    }
    private inline fun Wire.fields(visit: (Int) -> Unit) {
        while (true) visit(next() ?: break)
    }
    private fun unique(seen: MutableSet<Int>, field: Int) { require(seen.add(field)) }
    private fun uint32(value: ULong): Long { require(value <= 0xffffffffuL); return value.toLong() }
    private fun signed32(value: ULong): Long {
        val signed = value.toLong()
        require(signed in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong())
        return signed
    }
    private fun decode(bytes: ByteArray): AndroidNativeCrashMetadata {
        val wire = Wire(bytes, Budget())
        var arch = 0L
        var tid = 0L
        var signal: Long? = null
        var signalCode: Long? = null
        val threads = ArrayList<Slice>()
        val seen = HashSet<Int>()
        wire.fields { field ->
            when (field) {
                1 -> { unique(seen, field); arch = uint32(wire.number()) }
                6 -> { unique(seen, field); tid = uint32(wire.number()) }
                10 -> {
                    unique(seen, field)
                    val child = wire.child(wire.slice())
                    val signalSeen = HashSet<Int>()
                    child.fields { key ->
                        when (key) {
                            1 -> { unique(signalSeen, key); signal = signed32(child.number()); require(signal in 1L..64L) }
                            3 -> { unique(signalSeen, key); signalCode = signed32(child.number()) }
                            else -> child.skip()
                        }
                    }
                }
                16 -> { require(threads.size < MAX_THREADS); threads.add(wire.slice()) }
                else -> wire.skip()
            }
        }
        require(tid > 0)
        val abi = AndroidNativeABI.values().firstOrNull { it.value == when (arch) {
            0L -> "armeabi-v7a"; 1L -> "arm64-v8a"; 2L -> "x86"; 3L -> "x86_64"; 4L -> "riscv64"; else -> ""
        } } ?: error("Unsupported architecture")
        var crashed: Slice? = null
        for (thread in threads) {
            val entry = wire.child(thread)
            var key = 0L
            var body: Slice? = null
            val entrySeen = HashSet<Int>()
            entry.fields { field ->
                when (field) {
                    1 -> { unique(entrySeen, field); key = uint32(entry.number()) }
                    2 -> { unique(entrySeen, field); body = entry.slice() }
                    else -> entry.skip()
                }
            }
            if (key == tid) { require(crashed == null); crashed = requireNotNull(body) }
        }
        val thread = wire.child(requireNotNull(crashed))
        var embeddedId = 0L
        var sawId = false
        var incomplete = false
        val frames = ArrayList<AndroidNativeFrame>()
        thread.fields { field ->
            when (field) {
                1 -> { require(!sawId); sawId = true; embeddedId = uint32(thread.number()) }
                4 -> {
                    val frame = thread.slice()
                    if (frames.size == MAX_FRAMES) incomplete = true
                    else frames.add(frame(thread.child(frame)))
                }
                else -> thread.skip()
            }
        }
        require(embeddedId == tid)
        return AndroidNativeCrashMetadata(abi = abi, crashedThreadID = tid, frames = frames,
            framesIncomplete = incomplete || frames.isEmpty(), source = AndroidNativeSource.values().single(), signalNumber = signal, signalCode = signalCode)
    }
    private fun frame(wire: Wire): AndroidNativeFrame {
        var pc = 0uL
        var relativePc = 0uL
        var module: String? = null
        var buildId: String? = null
        val seen = HashSet<Int>()
        wire.fields { field ->
            when (field) {
                1 -> { unique(seen, field); relativePc = wire.number() }
                2 -> { unique(seen, field); pc = wire.number() }
                6 -> {
                    unique(seen, field)
                    val name = wire.text().substringAfterLast('/').substringAfterLast('\\')
                    module = name.takeIf { it.isNotEmpty() && it.length <= 256 && it.none { c -> c.code < 32 || c.code == 127 } }
                }
                8 -> {
                    unique(seen, field)
                    val identity = wire.text().lowercase(java.util.Locale.ROOT)
                    buildId = identity.takeIf { Regex("(?:[0-9a-f]{2}){1,64}").matches(it) }
                }
                else -> wire.skip()
            }
        }
        return AndroidNativeFrame(pc = "0x${pc.toString(16)}", relativePC = "0x${relativePc.toString(16)}",
            module = module, buildID = buildId.takeIf { module != null })
    }
}
