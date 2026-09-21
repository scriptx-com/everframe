// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.gradle

import java.nio.charset.StandardCharsets
import java.security.MessageDigest

private val BUILD_ID_PATTERN = Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,127}")

internal fun identity(buildId: String, projectPath: String, variantName: String): String {
    require(BUILD_ID_PATTERN.matches(buildId)) {
        "TraceItX R8 buildId must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}"
    }
    val bytes = "$buildId\n$projectPath\n$variantName".toByteArray(StandardCharsets.UTF_8)
    val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
    return "r8-" + digest.joinToString("") { "%02x".format(it) }
}
