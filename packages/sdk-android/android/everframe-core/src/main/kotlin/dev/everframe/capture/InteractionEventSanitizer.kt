// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import dev.everframe.envelope.RedactionEngine
import dev.everframe.protocol.generated.BreadcrumbKind
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import kotlinx.serialization.json.*

/** The only path from transient observations to retained interaction evidence. */
internal object InteractionEventSanitizer {
    fun kind(type: String): BreadcrumbKind = when (type) {
        "deep_link" -> BreadcrumbKind.Navigation
        "permission", "launch" -> BreadcrumbKind.Lifecycle
        else -> BreadcrumbKind.Custom
    }
    fun message(type: String): String = when (type) {
        "text_edit" -> "Text edited"
        "control_change" -> "Control changed"
        "scroll" -> "Scrolled"
        "deep_link" -> "Link opened"
        "permission" -> "Permission observed"
        else -> "App entered foreground"
    }

    fun sanitize(input: JsonObject, policy: InteractionEventPolicy, liveTestId: String? = null): JsonObject? {
        if (policy.disabled) return null
        val values = input.toMutableMap()
        if (liveTestId == null || liveTestId !in policy.valueTestIds) values.remove("value")
        if (input.string("type") == "deep_link") {
            val url = sanitizeUrl(input.string("url") ?: return null, policy) ?: return null
            values["url"] = JsonPrimitive(url)
        }
        if (input.string("type") == "launch") {
            val arguments = input["arguments"] as? JsonObject
            values.remove("arguments")
            if (arguments != null) {
                val permitted = arguments.filterKeys { it in policy.launchArgumentKeys }.entries.take(16)
                    .associate { it.key to it.value }
                if (permitted.isNotEmpty()) values["arguments"] = JsonObject(permitted)
            }
        }
        return bound(redact(JsonObject(values)) as JsonObject)
    }

    /** Strict field selection and bounds, also applied AFTER the buffer's final redaction. */
    fun bound(input: JsonObject): JsonObject? {
        val type = input.string("type") ?: return null
        val source = input.string("source")?.takeIf { it in setOf("native", "app") } ?: return null
        val time = input.number("observedAt")?.takeIf { it >= 0 } ?: return null
        val out = linkedMapOf<String, JsonElement>("type" to JsonPrimitive(type), "source" to JsonPrimitive(source), "observedAt" to JsonPrimitive(time))
        fun required(key: String, options: Set<String>): Boolean {
            val value = input.string(key)?.takeIf { it in options } ?: return false
            out[key] = JsonPrimitive(value); return true
        }
        fun requiredText(key: String, max: Int): Boolean {
            val value = boundedText(input.string(key), max)?.takeIf { it.isNotEmpty() } ?: return false
            out[key] = JsonPrimitive(value); return true
        }
        fun value() { boundedText(input.string("value"), 256)?.let { out["value"] = JsonPrimitive(it) } }
        when (type) {
            "text_edit" -> {
                val length = input.number("length")?.takeIf { it >= 0 && it <= 9007199254740991.0 && it % 1.0 == 0.0 } ?: return null
                out["length"] = JsonPrimitive(length.toLong())
                if (!required("reason", setOf("idle", "end", "submit", "freeze"))) return null
                value()
            }
            "control_change" -> {
                if (!required("control", setOf("switch", "checkbox", "slider", "radio", "picker"))) return null
                when (input.string("control")) {
                    "switch", "checkbox" -> out["checked"] = JsonPrimitive((input["checked"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: return null)
                    "slider" -> out["position"] = JsonPrimitive(input.number("position") ?: return null)
                    else -> { if (!requiredText("optionId", 128)) return null; value() }
                }
            }
            "scroll" -> {
                if (!required("axis", setOf("x", "y")) || !required("direction", setOf("forward", "backward"))) return null
                (input["item"] as? JsonObject)?.let { target(it) }?.let { out["item"] = it }
            }
            "deep_link" -> {
                var url = input.string("url")?.takeIf { validInteractionUnicode(it) } ?: return null
                if (url.length > 1024) url = url.substringBefore('?')
                if (url.isEmpty() || url.length > 1024) return null
                out["url"] = JsonPrimitive(url)
                if (!required("delivery", setOf("initial", "subsequent"))) return null
            }
            "permission" -> {
                if (!requiredText("permission", 128) || !required("phase", setOf("requested", "result"))) return null
                if (input.string("phase") == "result" && !required("result", setOf("granted", "denied", "blocked", "limited", "unavailable", "unknown"))) return null
            }
            "launch" -> {
                if (!required("start", setOf("cold", "warm"))) return null
                input.string("trigger")?.takeIf { it in setOf("link", "notification") }?.let { out["trigger"] = JsonPrimitive(it) }
                (input["arguments"] as? JsonObject)?.entries?.take(16)?.mapNotNull { (key, item) ->
                    val safeKey = boundedText(RedactionEngine.redact(key), 128)?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                    val primitive = item as? JsonPrimitive ?: return@mapNotNull null
                    val safe = if (primitive.isString) boundedText(primitive.content, 128)?.let { JsonPrimitive(it) }
                        else primitive.takeIf { it.booleanOrNull != null || it.doubleOrNull?.isFinite() == true }
                    safe?.let { safeKey to it }
                }?.toMap()?.takeIf { it.isNotEmpty() }?.let { out["arguments"] = JsonObject(it) }
            }
            else -> return null
        }
        fun oversized() = JsonObject(out).toString().toByteArray(Charsets.UTF_8).size > 4096
        if (oversized()) out.remove("arguments")
        if (oversized() && type == "deep_link") out["url"] = JsonPrimitive(out.getValue("url").jsonPrimitive.content.substringBefore('?'))
        if (oversized()) out.remove("value")
        if (oversized()) out.remove("item")
        return if (oversized()) null else JsonObject(out)
    }

    fun storageData(data: JsonObject): JsonObject? {
        val interaction = bound(data["interaction"] as? JsonObject ?: return null) ?: return null
        val out = linkedMapOf<String, JsonElement>("interaction" to interaction)
        (data["target"] as? JsonObject)?.let { target(it) }?.let { out["target"] = it }
        return JsonObject(out)
    }

    fun target(input: JsonObject): JsonObject? {
        val out = linkedMapOf<String, JsonElement>()
        for (key in listOf("name", "testId", "role", "screen")) {
            boundedText(input.string(key), if (key == "role") 64 else 256)?.takeIf { it.isNotEmpty() }?.let { out[key] = JsonPrimitive(it) }
        }
        input.string("nameFrom")?.takeIf { it in setOf("accessibility", "text", "testId", "className", "annotation") }?.let { out["nameFrom"] = JsonPrimitive(it) }
        if (input["masked"] == JsonPrimitive(true)) out["masked"] = JsonPrimitive(true)
        (input["container"] as? JsonObject)?.let { container ->
            val fields = linkedMapOf<String, JsonElement>()
            for (key in listOf("name", "testId", "role")) boundedText(container.string(key), if (key == "role") 64 else 256)?.takeIf { it.isNotEmpty() }?.let { fields[key] = JsonPrimitive(it) }
            val index = container.number("index")?.takeIf { it >= 0 && it <= 9007199254740991.0 && it % 1.0 == 0.0 }
            val count = container.number("count")?.takeIf { it >= 0 && it <= 9007199254740991.0 && it % 1.0 == 0.0 }
            if (index == null || count == null || index < count) {
                if (index != null) fields["index"] = JsonPrimitive(index.toLong())
                if (count != null) fields["count"] = JsonPrimitive(count.toLong())
            }
            if (fields.isNotEmpty()) out["container"] = JsonObject(fields)
        }
        return JsonObject(out).takeIf { it.isNotEmpty() }
    }

    fun redact(value: JsonElement): JsonElement = when (value) {
        is JsonObject -> JsonObject(value.mapValues { redact(it.value) })
        is JsonArray -> JsonArray(value.map { redact(it) })
        is JsonPrimitive -> if (value.isString) JsonPrimitive(RedactionEngine.redact(value.content)) else value
    }

    private fun sanitizeUrl(raw: String, policy: InteractionEventPolicy): String? = try {
        if (raw.length > 8192 || !validInteractionUnicode(raw) || raw.any { it <= '\u0020' || it == '\\' }) null else {
            val uri = URI(raw)
            val origin = interactionOrigin(uri)
            if (origin == null) null else {
                val rule = policy.urlRules.firstOrNull { it.origin == origin }
                val path = uri.rawPath.orEmpty()
                val safePath = rule?.literalPaths?.firstOrNull { it == path } ?: rule?.routes?.firstOrNull { route ->
                    val parts = route.split('/'); val actual = path.split('/')
                    parts.size == actual.size && parts.indices.all { parts[it] == actual[it] || (parts[it].startsWith(':') && actual[it].isNotEmpty()) }
                }.orEmpty()
                val query = uri.rawQuery?.split('&')?.mapNotNull { pair ->
                    val key = URLDecoder.decode(pair.substringBefore('='), "UTF-8")
                    if (rule == null || key !in rule.queryKeys) null else {
                        val value = boundedText(RedactionEngine.redact(URLDecoder.decode(pair.substringAfter('=', ""), "UTF-8")), 128) ?: return@mapNotNull null
                        val safeKey = boundedText(RedactionEngine.redact(key), 128) ?: return@mapNotNull null
                        URLEncoder.encode(safeKey, "UTF-8") + "=" + URLEncoder.encode(value, "UTF-8")
                    }
                }?.distinctBy { it.substringBefore('=') }?.take(16).orEmpty()
                origin + safePath + if (query.isEmpty()) "" else "?" + query.joinToString("&")
            }
        }
    } catch (_: Exception) { null }

    private fun boundedText(value: String?, max: Int): String? {
        if (value == null || !validInteractionUnicode(value)) return null
        val end = if (value.length > max && value[max - 1].isHighSurrogate()) max - 1 else minOf(value.length, max)
        return value.substring(0, end)
    }
}

internal fun JsonObject.string(key: String): String? = (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content
internal fun JsonObject.number(key: String): Double? = (get(key) as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.takeIf { it.isFinite() }
