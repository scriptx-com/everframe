// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Port of packages/sdk-core/src/vitals/bound-json.ts. Same never-throw
// discipline; measures UTF-8 bytes of the serialised form.
package dev.everframe.vitals

import dev.everframe.vitals.wire.VitalsLimits
import dev.everframe.vitals.wire.VitalsWireCodec.utf8Length
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

data class BoundedJson(val data: JsonElement?, val truncated: Boolean)
data class BoundedStructuredJson(val data: JsonObject?, val truncated: Boolean)

private const val MAX_NESTED_FIELD_BYTES = 256

private fun withinCap(el: JsonElement, maxBytes: Int) = utf8Length(el.toString()) <= maxBytes

/** Cut to at most [maxBytes] of UTF-8 without splitting a code point (surrogate pairs stay together). */
internal fun cutUtf8(s: String, maxBytes: Int): String {
    val out = StringBuilder()
    var bytes = 0
    var i = 0
    while (i < s.length) {
        val cp = s.codePointAt(i)
        val len = Character.charCount(cp)
        val b = String(Character.toChars(cp)).toByteArray(Charsets.UTF_8).size
        if (bytes + b > maxBytes) break
        bytes += b
        out.appendCodePoint(cp)
        i += len
    }
    return out.toString()
}

fun boundJson(value: JsonElement?, maxBytes: Int = VitalsLimits.MAX_CUSTOM_DATA_BYTES): BoundedJson {
    if (value == null) return BoundedJson(null, false)
    val serialised = value.toString()
    if (utf8Length(serialised) <= maxBytes) return BoundedJson(value, false)
    var budget = maxBytes / 2
    while (budget > 0) {
        val candidate = JsonObject(mapOf("truncated" to JsonPrimitive(true), "preview" to JsonPrimitive(cutUtf8(serialised, budget))))
        if (withinCap(candidate, maxBytes)) return BoundedJson(candidate, true)
        budget = budget shr 1
    }
    val shell = JsonObject(mapOf("truncated" to JsonPrimitive(true), "preview" to JsonPrimitive("")))
    return if (withinCap(shell, maxBytes)) BoundedJson(shell, true) else BoundedJson(null, true)
}

private fun fieldFragmentBytes(key: String, value: JsonElement): Int =
    utf8Length(JsonPrimitive(key).toString() + ":" + value.toString())

private fun truncateFieldToFit(key: String, raw: String, fragBudget: Int): String? {
    if (fragBudget < 0) return null
    var rawBudget = fragBudget / 2
    while (rawBudget > 0) {
        val candidate = cutUtf8(raw, rawBudget)
        if (fieldFragmentBytes(key, JsonPrimitive(candidate)) <= fragBudget) return candidate
        rawBudget = rawBudget shr 1
    }
    return if (fieldFragmentBytes(key, JsonPrimitive("")) <= fragBudget) "" else null
}

fun boundStructuredJson(value: JsonObject?, maxBytes: Int): BoundedStructuredJson {
    if (value == null) return BoundedStructuredJson(null, false)
    if (withinCap(value, maxBytes)) return BoundedStructuredJson(value, false)

    val kept = LinkedHashMap<String, JsonElement>()
    data class Str(val key: String, val raw: String, val fragBytes: Int)
    val strings = ArrayList<Str>()
    for ((k, v) in value) {
        when {
            v is JsonPrimitive && v.isString -> strings.add(Str(k, v.content, fieldFragmentBytes(k, v)))
            v is JsonPrimitive -> kept[k] = v
            utf8Length(v.toString()) <= MAX_NESTED_FIELD_BYTES -> kept[k] = v
        }
    }
    strings.sortBy { it.fragBytes }
    val n = strings.size
    val prefix = LongArray(n + 1)
    for (i in 0 until n) prefix[i + 1] = prefix[i] + strings[i].fragBytes

    var keptFragBytes = 0L
    for ((k, v) in kept) keptFragBytes += fieldFragmentBytes(k, v)
    val assumedFieldCount = kept.size + n
    val commaBytes = if (assumedFieldCount > 0) assumedFieldCount - 1 else 0
    val budgetForStrings = maxBytes - 2 - commaBytes - keptFragBytes

    var k = 0
    while (k < n && prefix[k + 1] <= budgetForStrings) k++

    val finalStrings = LinkedHashMap<String, JsonElement>()
    for (i in 0 until k) finalStrings[strings[i].key] = JsonPrimitive(strings[i].raw)
    if (k < n) {
        val leftover = (budgetForStrings - prefix[k]).toInt()
        truncateFieldToFit(strings[k].key, strings[k].raw, leftover)?.let { finalStrings[strings[k].key] = JsonPrimitive(it) }
    }

    val candidate = JsonObject(kept + finalStrings)
    if (withinCap(candidate, maxBytes)) return BoundedStructuredJson(candidate, true)
    if (k < n) {
        finalStrings.remove(strings[k].key)
        val without = JsonObject(kept + finalStrings)
        if (withinCap(without, maxBytes)) return BoundedStructuredJson(without, true)
    }
    val keptOnly = JsonObject(kept)
    return if (withinCap(keptOnly, maxBytes)) BoundedStructuredJson(keptOnly, true) else BoundedStructuredJson(null, true)
}
