// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.gradle

import java.io.File
import java.security.MessageDigest
import org.gradle.api.GradleException

internal const val BUILD_IDENTITY_ASSET: String = "everframe/build-identity.properties"
internal const val R8_MAPPING_ID_KEY: String = "r8MappingId"

/** Content-derived, so retries and rebuilds of identical bytes reuse the same ID. */
internal fun r8MappingId(mapping: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    mapping.inputStream().use { input ->
        val buffer = ByteArray(64 * 1024)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            digest.update(buffer, 0, read)
        }
    }
    return "r8-" + digest.digest().joinToString("") { "%02x".format(it) }
}

internal fun readR8MappingId(properties: File): String =
    properties.readLines().firstNotNullOfOrNull { line -> line.trim().removePrefix("$R8_MAPPING_ID_KEY=").takeIf { it != line.trim() } }
        ?: throw GradleException("everframe: $properties has no $R8_MAPPING_ID_KEY")
