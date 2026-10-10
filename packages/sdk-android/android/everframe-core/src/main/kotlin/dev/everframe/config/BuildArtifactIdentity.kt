// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.config

import android.content.Context
import java.io.InputStream

/** Build identities that the dev.everframe Gradle plugin packages as `assets/everframe/build-identity.properties`. */
internal object BuildArtifactIdentity {
    const val ASSET_PATH: String = "everframe/build-identity.properties"
    private const val R8_MAPPING_ID_KEY = "r8MappingId"
    private val MAPPING_ID = Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,127}")

    fun r8MappingId(open: (String) -> InputStream?): String? = runCatching {
        open(ASSET_PATH)?.use { stream ->
            stream.bufferedReader().readLines().firstNotNullOfOrNull { line ->
                val trimmed = line.trim()
                trimmed.removePrefix("$R8_MAPPING_ID_KEY=").takeIf { it != trimmed }
            }
        }
    }.getOrNull()?.takeIf(MAPPING_ID::matches)

    /** An explicit `EverframeConfig.r8MappingId` wins; otherwise the packaged asset supplies it. */
    fun withBuildIdentity(config: EverframeConfig, open: (String) -> InputStream?): EverframeConfig =
        if (config.r8MappingId != null) config
        else r8MappingId(open)?.let { config.copy(r8MappingId = it) } ?: config

    fun withBuildIdentity(config: EverframeConfig, context: Context): EverframeConfig =
        withBuildIdentity(config) { path -> context.applicationContext.assets.open(path) }
}
