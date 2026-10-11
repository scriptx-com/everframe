// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.health

import dev.everframe.capture.AppRelease
import dev.everframe.capture.AppReleaseRule
import dev.everframe.config.ReleaseHealthBundleStatus
import kotlinx.serialization.json.*
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

internal data class NativeExposurePointer(
    val exposureId: String, val processLaunchId: String, val startedAt: String,
    val app: AppRelease, val loadedBuildId: String?, val loadedBundleStatus: ReleaseHealthBundleStatus,
) {
    fun valid(): Boolean = canonicalUuid(exposureId) && canonicalUuid(processLaunchId) &&
        runCatching { timestamp(requireNotNull(formatter().parse(startedAt)).time) == startedAt }.getOrDefault(false) &&
        validHealthText(app.version, AppReleaseRule.MAX_LENGTH) &&
        (app.build?.let { validHealthText(it, AppReleaseRule.MAX_LENGTH) } ?: true) &&
        (loadedBuildId == null || validHealthText(loadedBuildId, 200)) &&
        ((loadedBundleStatus == ReleaseHealthBundleStatus.KNOWN) == (loadedBuildId != null))

    /** The API links a crash to its session by comparing this whole object, so null fields are written, never omitted. */
    fun toJson(): JsonObject = buildJsonObject {
        put("exposureId", exposureId); put("processLaunchId", processLaunchId); put("startedAt", startedAt)
        put("app", app.toJson()); put("loadedBuildId", loadedBuildId?.let(::JsonPrimitive) ?: JsonNull)
        put("loadedBundleStatus", loadedBundleStatus.wireValue)
    }
    companion object {
        // Health runs on the core API24 floor without requiring host library desugaring.
        // Formatters are mutable, so every call owns its own strict UTC formatter.
        private fun formatter() = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC"); isLenient = false
        }
        fun timestamp(millis: Long): String = formatter().format(Date(millis))
        /** Restores a persisted pointer. One frozen before the app version existed is dropped. */
        fun parse(value: JsonObject): NativeExposurePointer? = runCatching {
            require(value.keys == setOf("exposureId", "processLaunchId", "startedAt", "app", "loadedBuildId", "loadedBundleStatus"))
            fun text(source: JsonObject, key: String): String =
                source.getValue(key).jsonPrimitive.also { require(it.isString) }.content
            val app = value.getValue("app").jsonObject
            require(app.keys == setOf("version", "build"))
            val pointer = NativeExposurePointer(text(value, "exposureId"), text(value, "processLaunchId"), text(value, "startedAt"),
                AppRelease(text(app, "version"), if (app["build"] == JsonNull) null else text(app, "build")),
                if (value["loadedBuildId"] == JsonNull) null else text(value, "loadedBuildId"),
                ReleaseHealthBundleStatus.entries.single { it.wireValue == text(value, "loadedBundleStatus") })
            pointer.takeIf { it.valid() }
        }.getOrNull()
        private fun canonicalUuid(value: String): Boolean = runCatching { UUID.fromString(value).toString() == value }.getOrDefault(false)
    }
}
/** `{"version", "build"}` with `"build": null` written explicitly, as the pointer comparison needs. */
internal fun AppRelease.toJson(): JsonObject = buildJsonObject {
    put("version", version); put("build", build?.let(::JsonPrimitive) ?: JsonNull)
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
