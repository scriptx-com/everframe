// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.config

/** Explicit release observation. Build IDs identify running artifacts; identity is opt-in. */
data class ReleaseHealthConfig(
    val nativeBuildId: String,
    val loadedBuildId: String? = null,
    val loadedBundleStatus: ReleaseHealthBundleStatus = ReleaseHealthBundleStatus.NOT_APPLICABLE,
    val enabled: Boolean = true,
    /**
     * Project-local opaque ID, frozen into each session this configuration opens. Never inferred from setUser. Nonblank, at most 128
     * UTF-16 units, no U+0000-U+001F or unpaired surrogates; otherwise release health does not become ready.
     */
    val userId: String? = null,
)
enum class ReleaseHealthBundleStatus(val wireValue: String) {
    KNOWN("known"), NOT_APPLICABLE("not_applicable"), UNKNOWN("unknown"),
}
