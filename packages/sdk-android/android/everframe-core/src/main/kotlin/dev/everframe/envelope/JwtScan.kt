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
 * segments, it checks the 8-character prefix of at most [MAX_GLUE] + 1 starts (text glued before
 * the header, such as `x_` or the `3D` of `%3D`, stays), and it decodes the whole header, with no
 * cap, at most [MAX_FULL_DECODES] times: certificate chains (x5c) make headers kilobytes long.
 */
internal object JwtScan {
    const val MAX_GLUE = 64
    const val MAX_FULL_DECODES = 4
    private const val MIN_HEADER = 8
    private val BASE64URL = IntArray(128) { -1 }.also { table ->
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".forEachIndexed { index, c -> table[c.code] = index }
    }
    private const val ALG = 0x22616c6722L // "alg"
    private const val ENC = 0x22656e6322L // "enc"
    private const val WINDOW = 0xFFFFFFFFFFL // five bytes

    fun replace(input: String, replacement: String): String {
        var out: StringBuilder? = null
        var copied = 0
        var index = 0
        while (index < input.length) {
            if (!isSegmentChar(input[index])) { index++; continue }
            val runEnd = segmentEnd(input, index)
            val token = if (runEnd - index >= MIN_HEADER && runEnd < input.length && input[runEnd] == '.')
                tokenAt(input, index, runEnd) else null
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
    private fun tokenAt(input: String, runStart: Int, headerEnd: Int): Pair<Int, Int>? {
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
        var decodes = 0
        for (start in runStart..last) {
            if (decodes == MAX_FULL_DECODES) break
            if (!joseHeaderPrefix(input, start)) continue
            decodes++
            val kind = joseHeaderKind(input, start, headerEnd)
            if (kind == 0) continue
            if (kind == 2 && fifthEnd >= 0) return start to fifthEnd
            if (payloadLength >= 2) return start to thirdEnd
        }
        return null
    }

    private fun byteAt(a: Int, b: Int, c: Int, d: Int, k: Int) = when (k) {
        0 -> (a shl 2) or (b shr 4)
        1 -> ((b and 15) shl 4) or (c shr 2)
        else -> ((c and 3) shl 6) or d
    }

    private fun isJsonWhitespace(byte: Int) = byte == 0x20 || byte == 0x09 || byte == 0x0A || byte == 0x0D

    /**
     * The first 8 characters at [start] (6 bytes) decode to optional JSON whitespace, '{', optional
     * whitespace and '"' (a JOSE header's first member name). Whitespace that runs past them passes.
     */
    internal fun joseHeaderPrefix(input: String, start: Int): Boolean {
        var opened = false
        var index = start
        while (index < start + 8) {
            val a = BASE64URL[input[index].code]; val b = BASE64URL[input[index + 1].code]
            val c = BASE64URL[input[index + 2].code]; val d = BASE64URL[input[index + 3].code]
            for (k in 0 until 3) {
                val byte = byteAt(a, b, c, d, k)
                if (isJsonWhitespace(byte)) continue
                if (!opened && byte == 0x7B) { opened = true; continue }
                return opened && byte == 0x22
            }
            index += 4
        }
        return true
    }

    /**
     * Decodes the whole header once, keeping only the last five bytes: 0 when it is not a JOSE header
     * (optional JSON whitespace, '{', and "alg" anywhere after it); 1 with "alg"; 2 when it also
     * names "enc" (a JWE).
     */
    internal fun joseHeaderKind(input: String, start: Int, end: Int): Int {
        var opened = false
        var alg = false
        var enc = false
        var window = 0L
        var index = start
        while (end - index >= 2) {
            val remaining = end - index
            val a = BASE64URL[input[index].code]
            val b = BASE64URL[input[index + 1].code]
            val c = if (remaining > 2) BASE64URL[input[index + 2].code] else -1
            val d = if (remaining > 3) BASE64URL[input[index + 3].code] else -1
            val count = if (c < 0) 1 else if (d < 0) 2 else 3
            for (k in 0 until count) {
                val byte = byteAt(a, b, c, d, k)
                if (!opened) {
                    if (byte == 0x7B) opened = true
                    else if (!isJsonWhitespace(byte)) return 0
                }
                window = ((window shl 8) or byte.toLong()) and WINDOW
                if (window == ALG) alg = true else if (window == ENC) enc = true
            }
            index += 4
        }
        if (!opened || !alg) return 0
        return if (enc) 2 else 1
    }

    private fun segmentEnd(input: String, from: Int): Int {
        var end = from
        while (end < input.length && isSegmentChar(input[end])) end++
        return end
    }

    private fun isSegmentChar(c: Char) = c.code < 128 && BASE64URL[c.code] >= 0
}
