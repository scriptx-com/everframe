// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.config

/**
 * Turns on release health: crash-free sessions for each version of the app. The SDK reads the
 * version and build from the app's package info, so nothing here names a release.
 */
data class ReleaseHealthConfig(
    val enabled: Boolean = true,
    /**
     * Project-local opaque ID, frozen into each session this configuration opens. Never inferred from setUser. Nonblank, at most 128
     * UTF-16 units, no U+0000-U+001F or unpaired surrogates; otherwise release health does not become ready.
     */
    val userId: String? = null,
    /** The loaded JavaScript bundle. The React Native bridge sets it from validated Hermes metadata; native apps leave it unset. */
    val loadedBuildId: String? = null,
    val loadedBundleStatus: ReleaseHealthBundleStatus = ReleaseHealthBundleStatus.NOT_APPLICABLE,
)
enum class ReleaseHealthBundleStatus(val wireValue: String) {
    KNOWN("known"), NOT_APPLICABLE("not_applicable"), UNKNOWN("unknown"),
}
