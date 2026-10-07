// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import dev.everframe.envelope.EnvelopeBuilder
import dev.everframe.protocol.generated.CrashCause
import dev.everframe.protocol.generated.CrashCauseChain
import dev.everframe.protocol.generated.CrashCauseFrame
import kotlinx.serialization.encodeToString
import org.json.JSONArray
import org.json.JSONObject

/** Optional enrichment owns no host references and never rejects the outer crash. */
internal fun normalizeCrashCauseChain(
    raw: Any?, redact: (String) -> String, stillOwned: () -> Boolean,
): CrashCauseChain? {
    if (raw == null) return null
    return try { CauseNormalizer(redact, stillOwned).normalize(raw) } catch (_: Throwable) { null }
}

private class CauseNormalizationCancelled : RuntimeException()
private object InvalidCauseValue

private class CauseNormalizer(val redact: (String) -> String, val stillOwned: () -> Boolean) {
    private val causes = ArrayList<CrashCause>(8)
    private var truncated = false
    private fun checkOwned() { if (!stillOwned()) throw CauseNormalizationCancelled() }
    private fun read(objectValue: JSONObject, key: String): Any? {
        checkOwned()
        val value = try { if (objectValue.has(key)) objectValue.get(key) else null } catch (_: Throwable) { InvalidCauseValue }
        checkOwned()
        return value
    }
    private fun item(array: JSONArray, index: Int): Any? {
        checkOwned()
        val value = try { array.get(index) } catch (_: Throwable) { InvalidCauseValue }
        checkOwned()
        return value
    }
    private fun length(array: JSONArray): Int {
        checkOwned()
        val size = array.length()
        checkOwned()
        return size
    }
    private fun text(value: String, limit: Int): Pair<String, Boolean> {
        checkOwned()
        val scanned = prefix(value, 8192)
        val cut = value.length > scanned.length
        val redacted = redact(repair(if (cut) dropCutToken(scanned) else scanned))
        checkOwned()
        return prefix(repair(prefix(redacted, limit + 1)), limit) to (cut || redacted.length > limit)
    }
    // Reserve false flags (one byte longer than true), matching the shared fitter.
    private fun fits(): Boolean = EnvelopeBuilder.JSON.encodeToString(CrashCauseChain(
        causes.map { it.copy(framesTruncated = false) }, false,
    )).toByteArray(Charsets.UTF_8).size <= 65_536
    private fun finish(): CrashCauseChain {
        checkOwned()
        return CrashCauseChain(causes.toList(), truncated)
    }
    fun normalize(raw: Any): CrashCauseChain {
        checkOwned()
        val root = raw as? JSONObject ?: return CrashCauseChain(emptyList(), true)
        val array = read(root, "causes") as? JSONArray
        val flag = read(root, "truncated") as? Boolean
        if (array == null || flag == null) return CrashCauseChain(emptyList(), true)
        val count = length(array)
        truncated = flag || count > 8
        for (i in 0 until minOf(count, 8)) {
            val input = item(array, i) as? JSONObject
            val type = input?.let { read(it, "exceptionType") } as? String
            val message = input?.let { read(it, "message") } as? String
            val frameFlag = input?.let { read(it, "framesTruncated") } as? Boolean
            if (input == null || type == null || message == null || frameFlag == null) { truncated = true; break }
            val (normalizedType, typeLost) = text(type, 256)
            val (normalizedMessage, messageLost) = text(message, 4096)
            causes += CrashCause(normalizedType, emptyList(), frameFlag, normalizedMessage)
            if (!fits()) { causes.removeAt(causes.lastIndex); truncated = true; break }
            truncated = truncated || typeLost || messageLost
            val frameArray = read(input, "frames") as? JSONArray
            if (frameArray == null) { markFramesLost(); continue }
            val frameCount = length(frameArray)
            if (frameCount > 32) markFramesLost()
            for (j in 0 until minOf(frameCount, 32)) {
                val frame = item(frameArray, j) as? JSONObject
                val rawText = frame?.let { read(it, "raw") } as? String
                if (frame == null || rawText == null) { markFramesLost(); break }
                val (normalizedRaw, rawLost) = text(rawText, 1024)
                if (rawLost) markFramesLost()
                fun optionalText(key: String, cap: Int): String? {
                    val value = read(frame, key) ?: return null
                    if (value !is String) { markFramesLost(); return null }
                    val (result, lost) = text(value, cap)
                    if (lost) markFramesLost()
                    return result
                }
                fun position(key: String): Long? {
                    val value = read(frame, key) ?: return null
                    val number = when (value) { is Int -> value.toDouble(); is Long -> value.toDouble(); is Double -> value; is Float -> value.toDouble(); else -> Double.NaN }
                    if (!number.isFinite() || number < 0 || number > 9007199254740991.0 || number % 1 != 0.0) {
                        markFramesLost(); return null
                    }
                    return number.toLong()
                }
                val fitted = CrashCauseFrame(raw = normalizedRaw, file = optionalText("file", 1024),
                    function = optionalText("function", 512), line = position("line"), col = position("col"))
                val previous = causes.last()
                causes[causes.lastIndex] = previous.copy(frames = previous.frames + fitted)
                if (!fits()) {
                    causes[causes.lastIndex] = previous.copy(framesTruncated = true)
                    truncated = true
                    return finish()
                }
            }
        }
        return finish()
    }
    private fun markFramesLost() {
        causes[causes.lastIndex] = causes.last().copy(framesTruncated = true)
    }
}

private fun prefix(value: String, limit: Int): String {
    if (value.length <= limit) return value
    val end = if (limit > 0 && Character.isHighSurrogate(value[limit - 1]) && Character.isLowSurrogate(value[limit])) limit - 1 else limit
    return value.substring(0, end)
}
/**
 * A scan cut can end inside a secret that redaction only matches whole, such as
 * a JWT without its last segment. Drop that token and any digit group before it,
 * exactly as the shared TypeScript normalizer does.
 */
private fun dropCutToken(value: String): String {
    var end = value.length
    while (end > 0 && isTokenUnit(value[end - 1])) end--
    while (end > 0 && isDigitGroupUnit(value[end - 1])) end--
    return value.substring(0, end)
}
// Units of the tokens the shared redaction patterns match (JWT, bearer).
private fun isTokenUnit(unit: Char) = unit in 'A'..'Z' || unit in 'a'..'z' || unit in '0'..'9' || unit in "+-./=_~"
// Digits, dashes and JavaScript whitespace: the units of card and SSN numbers.
private fun isDigitGroupUnit(unit: Char) = unit in '0'..'9' || unit == '-' || unit in '\u0009'..'\u000D' ||
    unit == ' ' || unit == '\u00A0' || unit == '\u1680' || unit in '\u2000'..'\u200A' || unit == '\u2028' ||
    unit == '\u2029' || unit == '\u202F' || unit == '\u205F' || unit == '\u3000' || unit == '\uFEFF'
private fun repair(value: String): String = buildString(value.length) {
    var index = 0
    while (index < value.length) {
        val unit = value[index++]
        when {
            unit == '\u0000' -> append('\uFFFD')
            Character.isHighSurrogate(unit) -> {
                if (index < value.length && Character.isLowSurrogate(value[index])) { append(unit); append(value[index++]) }
                else append('\uFFFD')
            }
            Character.isLowSurrogate(unit) -> append('\uFFFD')
            else -> append(unit)
        }
    }
}
