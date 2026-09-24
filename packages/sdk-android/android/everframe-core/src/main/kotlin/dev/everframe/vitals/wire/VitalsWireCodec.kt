// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Two Json instances on purpose: entries/chunks omit absent optionals
// (zod `.optional()` rejects null), the summary writes its two `.nullable()`
// fields explicitly (zod requires the key). `SessionSummaryDims` rides inside
// the summary encoder, so its optional fields are re-omitted by hand.
//
// `plainNumberLiterals` fixes a JVM `Double.toString()` quirk that the
// fixture/TS side never hits: kotlinx.serialization renders any Double
// magnitude >= 1e7 (e.g. `extras.javaHeap = 41943040.0`) in scientific
// notation ("4.194304E7"), whereas `JSON.stringify` on the TS side — and the
// canonical fixture — always emit plain digits. Both sides carry the same
// numeric value, but `JsonPrimitive` equality (and the fixture-parity test)
// compares literal text, so every encoded payload is walked afterward to
// reformat scientific-notation numbers back to plain decimal.
//
// The `BigDecimal` MUST be built from `el.content` (the string
// `Double.toString()` already produced), never from the re-parsed `Double`
// itself: `BigDecimal(el.content.toDouble())` captures the exact binary
// value of the double, which for a non-integral magnitude like 12345678.9
// is 12345678.90000000037252902984619140625 — reintroducing IEEE-754 noise
// `toString()`'s shortest-round-trip algorithm had already discarded.
// `BigDecimal(String)` instead parses the same shortest-round-trip digits
// `Double.toString()` wrote, so `toPlainString()` only ever removes the
// exponent field, never adds precision that wasn't already there.
package dev.everframe.vitals.wire

import java.math.BigDecimal
import kotlin.math.abs
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonUnquotedLiteral
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject

/** ECMAScript Number::toString spelling used by JSON.stringify. */
internal fun esNumberText(value: Double): String {
    if (!value.isFinite()) return "null"
    if (value == 0.0) return "0"

    val negative = value < 0
    var source = abs(value).toString()
    var exponent = 0
    val exponentIndex = source.indexOfFirst { it == 'e' || it == 'E' }
    if (exponentIndex >= 0) {
        exponent = source.substring(exponentIndex + 1).toInt()
        source = source.substring(0, exponentIndex)
    }
    val point = source.indexOf('.')
    val integer = if (point >= 0) source.substring(0, point) else source
    val fraction = if (point >= 0) source.substring(point + 1) else ""
    var digits = integer + fraction
    var decimalPosition = integer.length + exponent
    while (digits.startsWith('0')) {
        digits = digits.drop(1)
        decimalPosition -= 1
    }
    digits = digits.trimEnd('0')
    if (digits.isEmpty()) return "0"

    val sign = if (negative) "-" else ""
    val digitCount = digits.length
    if (digitCount <= decimalPosition && decimalPosition <= 21) {
        return sign + digits + "0".repeat(decimalPosition - digitCount)
    }
    if (decimalPosition > 0 && decimalPosition <= 21) {
        return sign + digits.substring(0, decimalPosition) + "." + digits.substring(decimalPosition)
    }
    if (decimalPosition > -6 && decimalPosition <= 0) {
        return sign + "0." + "0".repeat(-decimalPosition) + digits
    }
    val outputExponent = decimalPosition - 1
    val exponentText = "e" + (if (outputExponent >= 0) "+" else "-") + abs(outputExponent)
    return if (digitCount == 1) sign + digits + exponentText else {
        sign + digits.substring(0, 1) + "." + digits.substring(1) + exponentText
    }
}

object VitalsWireCodec {
    private val omitNulls = Json {
        classDiscriminator = "kind"
        encodeDefaults = true
        explicitNulls = false
    }
    private val keepNulls = Json {
        classDiscriminator = "kind"
        encodeDefaults = true
        explicitNulls = true
    }

    private val SCIENTIFIC_NOTATION = Regex("""^-?\d+(?:\.\d+)?[eE][+-]?\d+$""")

    private fun formatPlainDecimal(content: String): String =
        BigDecimal(content).stripTrailingZeros().toPlainString()

    @OptIn(ExperimentalSerializationApi::class)
    private fun plainNumberLiterals(el: JsonElement): JsonElement = when (el) {
        is JsonObject -> JsonObject(el.mapValues { (_, v) -> plainNumberLiterals(v) })
        is JsonArray -> JsonArray(el.map { plainNumberLiterals(it) })
        is JsonPrimitive ->
            if (!el.isString && el !is JsonNull && SCIENTIFIC_NOTATION.matches(el.content)) {
                JsonUnquotedLiteral(formatPlainDecimal(el.content))
            } else {
                el
            }
    }

    fun encodePayload(p: VitalsIngestPayload): JsonElement = plainNumberLiterals(
        when (p) {
            is VitalsChunk -> omitNulls.encodeToJsonElement(VitalsIngestPayload.serializer(), p)
            is SessionSummary -> {
                val raw = keepNulls.encodeToJsonElement(VitalsIngestPayload.serializer(), p).jsonObject
                val dims = raw.getValue("dims").jsonObject.filterValues { it !is JsonNull }
                JsonObject(raw + ("dims" to JsonObject(dims)))
            }
        },
    )

    fun encodeRequestPayloadOnly(p: VitalsIngestPayload): String = encodePayload(p).toString()

    fun encodeRequest(p: VitalsIngestPayload): String =
        buildJsonObject { put("payload", encodePayload(p)) }.toString()

    fun encodeChunk(c: VitalsChunk): String = encodePayload(c).toString()

    /**
     * One entry, encoded exactly as it appears inside a chunk's `entries`
     * array — same `omitNulls` settings, same plain-number normalisation.
     *
     * Final review, I5: the collector used to measure the byte cap by
     * re-encoding the WHOLE pending chunk (and re-walking it for
     * `plainNumberLiterals`) on every single `addEntry`, on the app looper —
     * O(n²) over a chunk for a check that almost never fires. It now keeps a
     * running sum of these per-entry lengths and only pays for the exact
     * framed encode when that estimate comes within a few KB of the budget.
     *
     * The sum is a safe LOWER bound on the framed cost by exactly the chunk
     * envelope plus one bracket pair (~70 bytes for a 36-char session id),
     * which is why the collector's trigger margin is kilobytes, not bytes.
     */
    fun encodeEntry(e: VitalsEntry): String =
        plainNumberLiterals(omitNulls.encodeToJsonElement(VitalsEntry.serializer(), e)).toString()

    fun decodePayload(json: String): VitalsIngestPayload =
        omitNulls.decodeFromString(VitalsIngestPayload.serializer(), json)

    fun utf8Length(s: String): Int = s.toByteArray(Charsets.UTF_8).size
}
