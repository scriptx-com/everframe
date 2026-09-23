// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.vitals

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Host `Any?` → JsonElement. Never throws; anything it cannot represent becomes a marker object. */
object JsonCoerce {
    private const val MAX_PREVIEW_CHARS = 256

    fun toJsonElement(v: Any?): JsonElement = when (v) {
        null -> JsonNull
        is JsonElement -> v
        is String -> JsonPrimitive(v)
        is Boolean -> JsonPrimitive(v)
        is Double -> if (v.isNaN() || v.isInfinite()) JsonNull else JsonPrimitive(v)
        is Float -> if (v.isNaN() || v.isInfinite()) JsonNull else JsonPrimitive(v)
        is Number -> JsonPrimitive(v)
        is Char -> JsonPrimitive(v.toString())
        is Map<*, *> -> JsonObject(v.entries.associate { (k, value) -> k.toString() to toJsonElement(value) })
        is Iterable<*> -> JsonArray(v.map { toJsonElement(it) })
        is Array<*> -> JsonArray(v.map { toJsonElement(it) })
        // JVM primitive arrays (IntArray, DoubleArray, ...) are neither
        // Array<*> nor Iterable<*> — without these branches they fall to
        // the `else` unserializable marker below. Boxing each element and
        // recursing keeps a single source of truth for per-type encoding
        // (NaN/infinity handling for Double/Float, Char → one-char string).
        is IntArray -> JsonArray(v.map { toJsonElement(it) })
        is LongArray -> JsonArray(v.map { toJsonElement(it) })
        is DoubleArray -> JsonArray(v.map { toJsonElement(it) })
        is FloatArray -> JsonArray(v.map { toJsonElement(it) })
        is ShortArray -> JsonArray(v.map { toJsonElement(it) })
        is ByteArray -> JsonArray(v.map { toJsonElement(it) })
        is BooleanArray -> JsonArray(v.map { toJsonElement(it) })
        is CharArray -> JsonArray(v.map { toJsonElement(it) })
        else -> JsonObject(
            mapOf(
                "unserializable" to JsonPrimitive(true),
                "value" to JsonPrimitive(runCatching { v.toString() }.getOrDefault(v.javaClass.name).take(MAX_PREVIEW_CHARS)),
            ),
        )
    }

    fun toJsonObject(m: Map<String, Any?>?): JsonObject? =
        m?.let { JsonObject(it.mapValues { (_, value) -> toJsonElement(value) }) }
}
