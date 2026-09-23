// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Loads packages/protocol/data/*.json (mirrored into packages/sdk-android/android/everframe-core/src/main/assets/everframe/
// by the `copyProtocolData` Gradle task) into the SDK at first-access. Lazy-init
// means each file is parsed exactly once per process, then cached.
//
// Per CONTEXT decision 4: shared data JSON is the cross-language source of
// truth. iOS / Android / web cannot drift on what counts as "sensitive".
//
// Mirrors `packages/sdk-ios/Sources/Everframe/SharedData/SharedData.swift`.
package dev.everframe.shared

import android.content.Context
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
data class RedactionPattern(
    val id: String,
    val regex: String,
    val replacement: String? = null,
    val description: String? = null,
)

@Serializable
internal data class RedactionPatternsFile(
    val version: Int = 1,
    val description: String? = null,
    val patterns: List<RedactionPattern>,
)

@Serializable
data class SensitiveHeadersData(
    val version: Int = 1,
    val description: String? = null,
    @SerialName("sensitive_to_redact") val sensitiveToRedact: List<String>,
    @SerialName("allowed_to_capture") val allowedToCapture: List<String>,
)

@Serializable
data class NetworkPathPattern(
    val id: String,
    val regex: String,
    val redact: String,
    val replacement: String? = null,
)

@Serializable
internal data class NetworkPathPatternsFile(
    val version: Int = 1,
    val description: String? = null,
    @SerialName("sensitive_paths") val sensitivePaths: List<NetworkPathPattern>,
)

object SharedData {
    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = false
    }

    @Volatile
    private var appContext: Context? = null

    /**
     * Initialize with the host's application context. Plan 05-02 wires this
     * inside `Everframe.start(context, config)` before captureGate flips.
     */
    fun init(context: Context) {
        appContext = context.applicationContext
    }

    /**
     * Test/diagnostic seam — reset cached parsed JSON so a subsequent call
     * re-reads from assets. Production code does not call this.
     */
    @androidx.annotation.VisibleForTesting
    internal fun __resetForTesting() {
        appContext = null
        _redactionPatterns = null
        _sensitiveHeaders = null
        _networkPathPatterns = null
        _sensitiveToRedactLower = null
        _allowedToCaptureLower = null
    }

    @Volatile private var _redactionPatterns: List<RedactionPattern>? = null
    @Volatile private var _sensitiveHeaders: SensitiveHeadersData? = null
    @Volatile private var _networkPathPatterns: List<NetworkPathPattern>? = null
    @Volatile private var _sensitiveToRedactLower: Set<String>? = null
    @Volatile private var _allowedToCaptureLower: Set<String>? = null

    val redactionPatterns: List<RedactionPattern>
        get() = _redactionPatterns ?: synchronized(this) {
            _redactionPatterns ?: loadJson("redaction-patterns.json") { txt ->
                json.decodeFromString<RedactionPatternsFile>(txt).patterns
            }.also { _redactionPatterns = it }
        }

    val sensitiveHeaders: SensitiveHeadersData
        get() = _sensitiveHeaders ?: synchronized(this) {
            _sensitiveHeaders ?: loadJson("sensitive-headers.json") { txt ->
                json.decodeFromString<SensitiveHeadersData>(txt)
            }.also { _sensitiveHeaders = it }
        }

    val networkPathPatterns: List<NetworkPathPattern>
        get() = _networkPathPatterns ?: synchronized(this) {
            _networkPathPatterns ?: loadJson("network-path-patterns.json") { txt ->
                json.decodeFromString<NetworkPathPatternsFile>(txt).sensitivePaths
            }.also { _networkPathPatterns = it }
        }

    /** Lower-cased view of the sensitive header names — case-insensitive lookup. */
    val sensitiveHeadersToRedact: Set<String>
        get() = _sensitiveToRedactLower ?: synchronized(this) {
            _sensitiveToRedactLower
                ?: sensitiveHeaders.sensitiveToRedact.map { it.lowercase() }.toSet()
                    .also { _sensitiveToRedactLower = it }
        }

    /** Lower-cased view of the allowlist header names — case-insensitive lookup. */
    val allowedHeadersToCapture: Set<String>
        get() = _allowedToCaptureLower ?: synchronized(this) {
            _allowedToCaptureLower
                ?: sensitiveHeaders.allowedToCapture.map { it.lowercase() }.toSet()
                    .also { _allowedToCaptureLower = it }
        }

    private inline fun <T> loadJson(name: String, parse: (String) -> T): T {
        val ctx = appContext ?: error(
            "SharedData not initialized — call SharedData.init(context) before reading shared JSON. " +
                "Everframe.start(context, config) handles this automatically."
        )
        val text = ctx.assets.open("everframe/$name").bufferedReader().use { it.readText() }
        return parse(text)
    }
}
