// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package com.traceitx.crash

import com.traceitx.CaptureExceptionOptions
import com.traceitx.ErrorSeverity
import com.traceitx.envelope.RedactionEngine
import com.traceitx.protocol.generated.CrashDetails
import org.json.JSONArray
import org.json.JSONObject

/** Transient views: the bounded native projector alone traverses optional wire metadata. */
internal fun normalizeRNCrashDetails(raw: Any?): CrashDetails? {
    if (raw == null) return null
    var lost = raw !is JSONObject
    fun field(name: String): Any? = if (raw is JSONObject) {
        try { if (raw.has(name)) raw.get(name) else null } catch (_: Throwable) {
            lost = true
            UnsupportedWireValue
        }
    } else null
    val severity = when (val value = field("severity")) {
        null -> ErrorSeverity.ERROR
        is String -> when (value) {
            "error" -> ErrorSeverity.ERROR
            "info" -> ErrorSeverity.INFO
            "warning" -> ErrorSeverity.WARNING
            else -> { lost = true; ErrorSeverity.ERROR }
        }
        else -> { lost = true; ErrorSeverity.ERROR }
    }
    val context = when (val value = field("context")) {
        null -> null
        is String -> value
        else -> { lost = true; null }
    }
    val metadata = when (val value = field("metadata")) {
        null -> null
        is JSONObject -> WireObject(value)
        else -> { lost = true; null }
    }
    when (val value = field("truncated")) {
        null -> Unit
        is Boolean -> if (value) lost = true
        else -> lost = true
    }
    return normalizeCrashDetails(
        CaptureExceptionOptions(severity, context, metadata), RedactionEngine::redact, lost,
    )
}

private object UnsupportedWireValue

private fun wireValue(value: Any?): Any? = when {
    value == null || value === JSONObject.NULL -> null
    value is Boolean || value is String -> value
    value is Byte || value is Short || value is Int || value is Long || value is Float || value is Double ->
        (value as Number).toDouble()
    value is JSONObject -> WireObject(value)
    value is JSONArray -> WireArray(value)
    else -> UnsupportedWireValue
}

private class WireObject(private val source: JSONObject) : AbstractMap<String, Any?>() {
    override val entries: Set<Map.Entry<String, Any?>> get() = object : AbstractSet<Map.Entry<String, Any?>>() {
        override val size: Int get() = source.length()
        override fun iterator(): Iterator<Map.Entry<String, Any?>> {
            val keys = source.keys()
            return object : Iterator<Map.Entry<String, Any?>> {
                override fun hasNext() = keys.hasNext()
                override fun next(): Map.Entry<String, Any?> {
                    val name = keys.next()
                    // The projector checks/masks this key before it ever asks for value.
                    return object : Map.Entry<String, Any?> {
                        override val key: String = name
                        override val value: Any? get() = wireValue(source.get(name))
                    }
                }
            }
        }
    }
}

private class WireArray(private val source: JSONArray) : AbstractList<Any?>() {
    override val size: Int get() = source.length()
    override fun get(index: Int): Any? = wireValue(source.get(index))
}
