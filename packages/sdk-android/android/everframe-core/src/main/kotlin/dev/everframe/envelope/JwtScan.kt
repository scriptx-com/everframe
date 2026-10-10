// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.envelope

import java.util.regex.Matcher
import java.util.regex.Pattern

/**
 * Applies the shared JWT rule (`jwt` in redaction-patterns.json) in linear time, with exactly the
 * regex's own result; mirrors redactJwt in packages/protocol/src/redaction.ts.
 *
 * The plain scan retries the pattern at every header prefix (`eyJ`, `eyA`, `ewo`, `ewk`, `ew0`: a
 * JSON `{` followed by `"`, a space, a newline, a tab or a carriage return), and each try runs to the
 * end of its segment, so `eyJ-eyJ-…` costs O(n²): seconds for a 64 KB body. Every match starts with
 * a header prefix and a header that runs to the end of its [A-Za-z0-9_-] segment, where a '.' must
 * follow. All starts inside one
 * segment therefore end their header at the same place and succeed or fail on the same text after
 * it; a later start only has a shorter header. So the leftmost start, then the leftmost start at a
 * word boundary (inside a segment only '-' gives one), decide the whole segment.
 */
internal object JwtScan {
    /** A three-character prefix plus five: the shortest header the rule accepts. */
    private const val MIN_HEADER = 8

    fun replace(pattern: Pattern, input: String, replacement: String): String {
        // Transparent bounds let `\b` see the character before a try's start.
        val matcher = pattern.matcher(input).useTransparentBounds(true).useAnchoringBounds(false)
        var out: StringBuilder? = null
        var copied = 0
        var from = 0
        while (true) {
            val first = nextHeaderPrefix(input, from)
            if (first < 0) break
            var end = first + 3
            while (end < input.length && isSegmentChar(input[end])) end++
            if (end - first >= MIN_HEADER && end < input.length && input[end] == '.') {
                var start = first
                var matchEnd = endAt(matcher, input, first)
                if (matchEnd < 0) {
                    val boundary = boundaryStart(input, first + 1, end)
                    if (boundary >= 0) {
                        start = boundary
                        matchEnd = endAt(matcher, input, boundary)
                    }
                }
                if (matchEnd >= 0) {
                    val builder = out ?: StringBuilder(input.length).also { out = it }
                    builder.append(input, copied, start).append(replacement)
                    copied = matchEnd
                    from = matchEnd
                    continue
                }
            }
            from = end
        }
        val builder = out ?: return input
        return builder.append(input, copied, input.length).toString()
    }

    private fun endAt(matcher: Matcher, input: String, start: Int): Int {
        matcher.region(start, input.length)
        return if (matcher.lookingAt()) matcher.end() else -1
    }

    /** Whether a JSON header's base64url can start at [index]: `eyJ`, `eyA`, `ewo`, `ewk` or `ew0`. */
    private fun headerPrefixAt(input: String, index: Int): Boolean {
        if (index + 3 > input.length || input[index] != 'e') return false
        val third = input[index + 2]
        return when (input[index + 1]) {
            'y' -> third == 'J' || third == 'A'
            'w' -> third == 'o' || third == 'k' || third == '0'
            else -> false
        }
    }

    private fun nextHeaderPrefix(input: String, from: Int): Int {
        var index = from
        while (index + 3 <= input.length) {
            if (headerPrefixAt(input, index)) return index
            index++
        }
        return -1
    }

    /** The first header prefix after a '-' in [from, end) that still leaves a full header; -1 when none. */
    private fun boundaryStart(input: String, from: Int, end: Int): Int {
        var index = from
        while (index + MIN_HEADER <= end) {
            if (input[index - 1] == '-' && headerPrefixAt(input, index)) return index
            index++
        }
        return -1
    }

    private fun isSegmentChar(c: Char) =
        c in '0'..'9' || c in 'A'..'Z' || c in 'a'..'z' || c == '_' || c == '-'
}
