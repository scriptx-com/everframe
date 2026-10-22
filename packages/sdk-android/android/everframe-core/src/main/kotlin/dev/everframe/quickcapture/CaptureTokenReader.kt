// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.quickcapture

import android.content.Context
import android.provider.Settings

/**
 * Reads the debug quick-capture token the host pushed with
 * `adb shell settings put global everframe_token <token>`.
 *
 * SECURITY: never log the token.
 */
internal object CaptureTokenReader {
    const val SETTINGS_KEY: String = "everframe_token"
    private const val MAX_LENGTH: Int = 512

    /** Read fresh on every call. Null when absent, invalid, or unreadable. */
    fun read(context: Context): String? {
        val raw = try {
            Settings.Global.getString(context.contentResolver, SETTINGS_KEY)
        } catch (_: SecurityException) {
            // A future Android release may restrict undocumented global keys.
            null
        }
        return validate(raw)
    }

    /** Trimmed value must be 1–512 printable ASCII (0x21–0x7E) characters. */
    fun validate(raw: String?): String? {
        val trimmed = raw?.trim() ?: return null
        if (trimmed.isEmpty() || trimmed.length > MAX_LENGTH) return null
        if (trimmed.any { it.code !in 0x21..0x7E }) return null
        return trimmed
    }
}
