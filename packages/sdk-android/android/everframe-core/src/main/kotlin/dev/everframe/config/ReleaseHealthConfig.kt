// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.config

/** Explicit anonymous release observation. Build IDs identify the running artifacts. */
data class ReleaseHealthConfig(
    val nativeBuildId: String,
    val loadedBuildId: String? = null,
    val loadedBundleStatus: ReleaseHealthBundleStatus = ReleaseHealthBundleStatus.NOT_APPLICABLE,
    val enabled: Boolean = true,
)
enum class ReleaseHealthBundleStatus(val wireValue: String) {
    KNOWN("known"), NOT_APPLICABLE("not_applicable"), UNKNOWN("unknown"),
}
