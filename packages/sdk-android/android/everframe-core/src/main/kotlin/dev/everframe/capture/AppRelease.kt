// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import dev.everframe.health.validHealthText

/** The app version and build that releases are grouped by, and whether this is a debug build. */
internal data class AppRelease(val version: String, val build: String?, val debug: Boolean)

/**
 * One rule for the app version. Release health sessions and every report's
 * `context.app.version` use it, so errors join to the version their sessions report.
 */
internal object AppReleaseRule {
    const val MAX_LENGTH = 64
    const val UNKNOWN_VERSION = "0.0.0"

    /**
     * The version is the trimmed [versionName] when it is valid text (non-blank, at most 64
     * UTF-16 units, no control characters or unpaired surrogates). Otherwise it is the
     * [versionCode] as text, and "0.0.0" only when the package info was unreadable.
     * The build is the [versionCode] as text. [debug] is carried through unchanged.
     */
    fun of(versionName: String?, versionCode: Long?, debug: Boolean): AppRelease {
        val build = versionCode?.toString()
        val name = versionName?.trim()?.takeIf { validHealthText(it, MAX_LENGTH) }
        return AppRelease(name ?: build ?: UNKNOWN_VERSION, build, debug)
    }
}
