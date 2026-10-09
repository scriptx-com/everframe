// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.health

import dev.everframe.config.ReleaseHealthBundleStatus
import kotlinx.serialization.json.*
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

internal data class NativeExposurePointer(
    val exposureId: String, val processLaunchId: String, val startedAt: String,
    val nativeBuildId: String, val loadedBuildId: String?, val loadedBundleStatus: ReleaseHealthBundleStatus,
) {
    fun valid(): Boolean = canonicalUuid(exposureId) && canonicalUuid(processLaunchId) &&
        runCatching { timestamp(requireNotNull(formatter().parse(startedAt)).time) == startedAt }.getOrDefault(false) &&
        validHealthText(nativeBuildId, 200) && (loadedBuildId == null || validHealthText(loadedBuildId, 200)) &&
        ((loadedBundleStatus == ReleaseHealthBundleStatus.KNOWN) == (loadedBuildId != null))

    fun toJson(): JsonObject = buildJsonObject {
        put("exposureId", exposureId); put("processLaunchId", processLaunchId); put("startedAt", startedAt)
        put("nativeBuildId", nativeBuildId); put("loadedBuildId", loadedBuildId?.let(::JsonPrimitive) ?: JsonNull)
        put("loadedBundleStatus", loadedBundleStatus.wireValue)
    }
    companion object {
        // Health runs on the core API24 floor without requiring host library desugaring.
        // Formatters are mutable, so every call owns its own strict UTC formatter.
        private fun formatter() = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC"); isLenient = false
        }
        fun timestamp(millis: Long): String = formatter().format(Date(millis))
        fun parse(value: JsonObject): NativeExposurePointer? = runCatching {
            require(value.keys == setOf("exposureId", "processLaunchId", "startedAt", "nativeBuildId", "loadedBuildId", "loadedBundleStatus"))
            fun text(key: String): String = value.getValue(key).jsonPrimitive.also { require(it.isString) }.content
            val pointer = NativeExposurePointer(text("exposureId"), text("processLaunchId"), text("startedAt"), text("nativeBuildId"),
                if (value["loadedBuildId"] == JsonNull) null else text("loadedBuildId"),
                ReleaseHealthBundleStatus.entries.single { it.wireValue == text("loadedBundleStatus") })
            pointer.takeIf { it.valid() }
        }.getOrNull()
        private fun canonicalUuid(value: String): Boolean = runCatching { UUID.fromString(value).toString() == value }.getOrDefault(false)
    }
}
internal fun validHealthText(value: String, maximum: Int): Boolean {
    if (value.isBlank() || value.length > maximum) return false
    var index = 0
    while (index < value.length) {
        val c = value[index++]
        if (c.code < 32 || Character.isLowSurrogate(c)) return false
        if (Character.isHighSurrogate(c) && (index >= value.length || !Character.isLowSurrogate(value[index++]))) return false
    }
    return true
}
