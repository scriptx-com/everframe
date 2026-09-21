// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Default-deny redaction engine. Loads regex patterns + sensitive-header
// allowlist from SharedData (mirrors packages/protocol/data/*.json).
//
// Behavior contract (mirrors packages/sdk-core/src/redaction/engine.ts and
// packages/sdk-ios/Sources/TraceItX/Envelope/RedactionEngine.swift):
//   • redact(input)        — applies all patterns to a freeform string. Luhn-CC
//                            pattern has an extra Luhn-validation gate to reject
//                            phone numbers / order IDs.
//   • filterHeaders(map)   — default-deny: only allowlisted headers are kept;
//                            sensitive headers have values replaced with `[REDACTED]`;
//                            any other header is dropped entirely.
package com.traceitx.envelope

import com.traceitx.shared.SharedData

object RedactionEngine {

    private const val REDACTED = "[REDACTED]"

    // Compiled-regex cache, keyed by pattern id. Built lazily on first redact() call.
    private val regexCache = HashMap<String, Regex>()

    /**
     * Apply default-deny redaction to a freeform string. Used on log lines,
     * description fields, query strings, etc.
     */
    fun redact(input: String): String {
        if (input.isEmpty()) return input
        var out = input
        for (pattern in SharedData.redactionPatterns) {
            val regex = regexCache.getOrPut(pattern.id) {
                // RFC: pattern.regex strings come from packages/protocol/data/redaction-patterns.json
                // (vetted, no catastrophic-backtracking risk). T-05-02-D mitigation.
                runCatching { Regex(pattern.regex) }.getOrNull() ?: return@getOrPut Regex("$^") // never matches
            }
            val replacement = pattern.replacement ?: REDACTED
            out = if (pattern.id == "luhn-cc") {
                // Luhn-validate the matched substring before replacing — most digit runs
                // are NOT credit cards (phone numbers, order IDs, timestamps).
                regex.replace(out) { match ->
                    val digitsOnly = match.value.filter(Char::isDigit)
                    if (isLuhnValid(digitsOnly)) replacement else match.value
                }
            } else {
                regex.replace(out, replacement)
            }
        }
        return out
    }

    /**
     * Filter HTTP headers — default-deny semantics.
     *  • Headers whose lowercase name is in `allowedHeadersToCapture` → kept verbatim
     *  • Headers whose lowercase name is in `sensitiveHeadersToRedact` → value replaced with [REDACTED]
     *  • Any other header → dropped entirely
     */
    fun filterHeaders(headers: Map<String, String>): Map<String, String> {
        val allow = SharedData.allowedHeadersToCapture
        val sensitive = SharedData.sensitiveHeadersToRedact
        val out = LinkedHashMap<String, String>(headers.size)
        for ((k, v) in headers) {
            val lower = k.lowercase()
            when {
                lower in allow -> out[k] = v
                lower in sensitive -> out[k] = REDACTED
                // else: default-deny — drop entirely.
            }
        }
        return out
    }

    /**
     * Luhn (mod-10) checksum validation for credit-card numbers.
     * Accepts 13–19 digit strings (Visa/MC/Amex/Discover/Diners/JCB/UnionPay range).
     */
    internal fun isLuhnValid(digits: String): Boolean {
        if (digits.length !in 13..19) return false
        var sum = 0
        var alt = false
        for (i in digits.indices.reversed()) {
            val d = digits[i].digitToIntOrNull() ?: return false
            val add = if (alt) {
                val doubled = d * 2
                if (doubled > 9) doubled - 9 else doubled
            } else d
            sum += add
            alt = !alt
        }
        return sum % 10 == 0
    }
}
