// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.config

/** Explicit release observation. Build IDs identify running artifacts; identity is opt-in. */
data class ReleaseHealthConfig(
    val nativeBuildId: String,
    val loadedBuildId: String? = null,
    val loadedBundleStatus: ReleaseHealthBundleStatus = ReleaseHealthBundleStatus.NOT_APPLICABLE,
    val enabled: Boolean = true,
    /** Project-local opaque ID, frozen for this segment. Never inferred from setUser. */
    val userId: String? = null,
)
enum class ReleaseHealthBundleStatus(val wireValue: String) {
    KNOWN("known"), NOT_APPLICABLE("not_applicable"), UNKNOWN("unknown"),
}
