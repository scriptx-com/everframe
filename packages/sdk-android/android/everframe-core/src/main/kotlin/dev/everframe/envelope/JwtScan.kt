// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.envelope

/**
 * JWT and JWE redaction by structure; mirrors redactJwt in packages/protocol/src/redaction.ts, and
 * the shared corpus (packages/protocol/__tests__/fixtures/jwt-redaction-corpus.v1.json) pins both.
 *
 * A candidate is a header segment of base64url characters (at least 8), a '.', a payload or
 * encrypted-key segment, a '.', and a third segment (possibly empty); a JWE adds two more. It is
 * redacted only when the header decodes to a JOSE header: RFC 7515 and RFC 7516 require a JSON
 * object with an "alg" member, so after any leading JSON whitespace the decoded header must start
 * with '{' and contain "alg". Dotted class, package and module names never decode to that.
 *
 * Linear: each segment run is a header candidate once, a candidate reads at most four more
 * segments, and it tries at most [MAX_GLUE] + 1 starts (text glued before the header, such as `x_`
 * or the `3D` of `%3D`, stays), each decoding at most [MAX_HEADER_DECODE] characters.
 */
internal object JwtScan {
    const val MAX_GLUE = 64
    const val MAX_HEADER_DECODE = 1024
    private const val MIN_HEADER = 8
    private val BASE64URL = IntArray(128) { -1 }.also { table ->
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".forEachIndexed { index, c -> table[c.code] = index }
    }
    private val ALG = "\"alg\"".toByteArray(Charsets.US_ASCII)
    private val ENC = "\"enc\"".toByteArray(Charsets.US_ASCII)

    fun replace(input: String, replacement: String): String {
        val decoded = ByteArray(MAX_HEADER_DECODE / 4 * 3)
        var out: StringBuilder? = null
        var copied = 0
        var index = 0
        while (index < input.length) {
            if (!isSegmentChar(input[index])) { index++; continue }
            val runEnd = segmentEnd(input, index)
            val token = if (runEnd - index >= MIN_HEADER && runEnd < input.length && input[runEnd] == '.')
                tokenAt(input, index, runEnd, decoded) else null
            if (token == null) { index = runEnd; continue }
            val builder = out ?: StringBuilder(input.length).also { out = it }
            builder.append(input, copied, token.first).append(replacement)
            copied = token.second
            index = token.second
        }
        val builder = out ?: return input
        return builder.append(input, copied, input.length).toString()
    }

    /** A JWE header with two more segments takes all five; otherwise three, with a payload of 2+. */
    private fun tokenAt(input: String, runStart: Int, headerEnd: Int, decoded: ByteArray): Pair<Int, Int>? {
        val payloadEnd = segmentEnd(input, headerEnd + 1)
        if (payloadEnd >= input.length || input[payloadEnd] != '.') return null
        val thirdEnd = segmentEnd(input, payloadEnd + 1)
        var fifthEnd = -1
        if (thirdEnd < input.length && input[thirdEnd] == '.') {
            val fourthEnd = segmentEnd(input, thirdEnd + 1)
            if (fourthEnd < input.length && input[fourthEnd] == '.') fifthEnd = segmentEnd(input, fourthEnd + 1)
        }
        val payloadLength = payloadEnd - headerEnd - 1
        val last = minOf(runStart + MAX_GLUE, headerEnd - MIN_HEADER)
        for (start in runStart..last) {
            val kind = joseHeaderKind(input, start, headerEnd, decoded)
            if (kind == 0) continue
            if (kind == 2 && fifthEnd >= 0) return start to fifthEnd
            if (payloadLength >= 2) return start to thirdEnd
        }
        return null
    }

    /** 0: not a JOSE header; 1: a header with "alg"; 2: it also names "enc" (a JWE). */
    internal fun joseHeaderKind(input: String, start: Int, end: Int, decoded: ByteArray): Int {
        val stop = minOf(end, start + MAX_HEADER_DECODE)
        var length = 0
        var opened = false
        var index = start
        while (stop - index >= 2) {
            val remaining = stop - index
            val a = BASE64URL[input[index].code]
            val b = BASE64URL[input[index + 1].code]
            val c = if (remaining > 2) BASE64URL[input[index + 2].code] else -1
            val d = if (remaining > 3) BASE64URL[input[index + 3].code] else -1
            val count = if (c < 0) 1 else if (d < 0) 2 else 3
            for (k in 0 until count) {
                val byte = when (k) {
                    0 -> (a shl 2) or (b shr 4)
                    1 -> ((b and 15) shl 4) or (c shr 2)
                    else -> ((c and 3) shl 6) or d
                }
                if (!opened) {
                    if (byte == 0x7B) opened = true
                    else if (byte != 0x20 && byte != 0x09 && byte != 0x0A && byte != 0x0D) return 0
                }
                decoded[length++] = byte.toByte()
            }
            index += 4
        }
        if (!opened || !contains(decoded, length, ALG)) return 0
        return if (contains(decoded, length, ENC)) 2 else 1
    }

    private fun contains(bytes: ByteArray, length: Int, needle: ByteArray): Boolean {
        var index = 0
        while (index + needle.size <= length) {
            var k = 0
            while (k < needle.size && bytes[index + k] == needle[k]) k++
            if (k == needle.size) return true
            index++
        }
        return false
    }

    private fun segmentEnd(input: String, from: Int): Int {
        var end = from
        while (end < input.length && isSegmentChar(input[end])) end++
        return end
    }

    private fun isSegmentChar(c: Char) = c.code < 128 && BASE64URL[c.code] >= 0
}
