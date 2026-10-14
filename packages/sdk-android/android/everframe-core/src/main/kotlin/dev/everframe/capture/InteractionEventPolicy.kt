// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import java.net.URI
import kotlinx.serialization.json.*

/** Local permissions. Remote config can veto capture, never expand these allowlists. */
class InteractionEventPolicy private constructor(
    val disabled: Boolean,
    val valueTestIds: Set<String>,
    val urlRules: List<UrlRule>,
    val launchArgumentKeys: Set<String>,
) {
    data class UrlRule internal constructor(
        val origin: String, val queryKeys: Set<String>, val routes: Set<String>, val literalPaths: Set<String>,
    )
    companion object {
        fun parse(json: String?): InteractionEventPolicy {
            if (json == null) return empty(false)
            if (json.toByteArray(Charsets.UTF_8).size > 262144) return empty(true)
            return try {
                val input = Json.parseToJsonElement(json) as? JsonObject ?: return empty(true)
                if (input.containsKey("disabled") && input["disabled"] != JsonPrimitive(false)) return empty(true)
                val rules = entries(input["urlRules"]).mapNotNull { value ->
                    val rule = value as? JsonObject ?: return@mapNotNull null
                    val declared = (rule["origin"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return@mapNotNull null
                    val uri = runCatching { URI(declared) }.getOrNull() ?: return@mapNotNull null
                    val origin = interactionOrigin(uri) ?: return@mapNotNull null
                    if (declared != origin && declared != "$origin/") return@mapNotNull null
                    if (uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) return@mapNotNull null
                    UrlRule(origin, strings(rule["queryKeys"], 128),
                        strings(rule["routes"], 1024).filter { path(it, true) }.toSet(),
                        strings(rule["literalPaths"], 1024).filter { path(it, false) }.toSet())
                }
                InteractionEventPolicy(false, strings(input["valueTestIds"], 256), rules, strings(input["launchArgumentKeys"], 128))
            } catch (_: Exception) { empty(true) }
        }
        private fun empty(disabled: Boolean) = InteractionEventPolicy(disabled, emptySet(), emptyList(), emptySet())
        private fun entries(value: JsonElement?): List<JsonElement> = (value as? JsonArray)?.takeIf { it.size <= 64 }.orEmpty()
        private fun strings(value: JsonElement?, max: Int): Set<String> = entries(value).mapNotNull {
            (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content?.takeIf { s -> identifier(s, max) }
        }.toSet()
        internal fun identifier(value: String, max: Int): Boolean = value.isNotEmpty() && value.length <= max &&
            value.trim() == value && value.none { it <= '\u001f' || it == '\u007f' || it == '*' } && validInteractionUnicode(value)
        private fun path(value: String, template: Boolean): Boolean = value.startsWith('/') &&
            value.none { it in "?#\\%" } && value.split('/').all {
                it != "." && it != ".." && (':' !in it || (template && Regex(":[A-Za-z][A-Za-z0-9_]*").matches(it)))
            }
    }
}

internal fun validInteractionUnicode(value: String): Boolean {
    var i = 0
    while (i < value.length) {
        val c = value[i++]
        if (c == '\u0000') return false
        if (c.isHighSurrogate()) { if (i >= value.length || !value[i++].isLowSurrogate()) return false }
        else if (c.isLowSurrogate()) return false
    }
    return true
}

internal fun interactionOrigin(uri: URI): String? {
    val scheme = uri.scheme?.lowercase() ?: return null
    val host = uri.host?.lowercase() ?: return null
    if (host.isEmpty() || uri.isOpaque) return null
    val port = uri.port.takeIf { it >= 0 && !(scheme == "http" && it == 80) && !(scheme == "https" && it == 443) }
    return "$scheme://$host" + (port?.let { ":$it" } ?: "")
}
