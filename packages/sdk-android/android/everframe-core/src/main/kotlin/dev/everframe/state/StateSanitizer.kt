// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.state
import dev.everframe.envelope.RedactionEngine
import dev.everframe.protocol.generated.StateValue
internal object StateSanitizer {
    fun validKey(key: String): Boolean = key.isNotEmpty() && key != "__proto__" && key.length <= 64 &&
        key.none { it.code < 32 || it.code in 127..159 } && validUnicode(key) && RedactionEngine.redact(key) == key
    private fun validUnicode(s: String): Boolean {
        var i = 0
        while (i < s.length) {
            val c = s[i++]
            if (c.isHighSurrogate()) { if (i >= s.length || !s[i++].isLowSurrogate()) return false }
            else if (c.isLowSurrogate()) return false
        }
        return true
    }
    fun value(value: StateValue, key: String): StateValue? {
        if (value is StateValue.DoubleValue && !value.value.isFinite()) return null
        if (value is StateValue.StringValue && (value.value.length > 256 || !validUnicode(value.value))) return null
        val canonical = key.lowercase().filter { it in 'a'..'z' || it in '0'..'9' }
        if (listOf("password", "passwd", "secret", "token", "authorization", "cookie", "apikey").any(canonical::contains)) return StateValue.StringValue("[REDACTED]")
        if (value is StateValue.StringValue) {
            val safe = RedactionEngine.redact(value.value).replace('\u0000', '�')
            return StateValue.StringValue(if (safe.length <= 256) safe else "[REDACTED]")
        }
        return value
    }
}
