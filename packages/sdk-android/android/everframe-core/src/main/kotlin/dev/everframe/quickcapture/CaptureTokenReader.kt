// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.quickcapture

import android.content.Context
import android.provider.Settings
import java.net.URI
import java.util.Locale

/**
 * Reads the debug quick-capture token the host pushed with
 * `adb shell settings put global everframe_token <token>`.
 *
 * `npx @everframe/cli link` also writes `everframe_token_origin`, the origin that issued the token.
 * When it is set, the token is attached only to an ingest endpoint with that same origin. Without
 * it (a token set by hand) the token goes to the ingest endpoint as before.
 *
 * SECURITY: never log the token.
 */
internal object CaptureTokenReader {
    const val SETTINGS_KEY: String = "everframe_token"
    const val ORIGIN_SETTINGS_KEY: String = "everframe_token_origin"
    private const val MAX_LENGTH: Int = 512

    /**
     * Read fresh on every call. Null when absent, invalid, unreadable, or issued by an origin other
     * than [ingestEndpoint]'s.
     */
    fun read(context: Context, ingestEndpoint: String): String? {
        val (raw, origin) = try {
            val resolver = context.contentResolver
            Settings.Global.getString(resolver, SETTINGS_KEY) to Settings.Global.getString(resolver, ORIGIN_SETTINGS_KEY)
        } catch (_: SecurityException) {
            // A future Android release may restrict undocumented global keys.
            return null
        }
        if (origin != null && !sameOrigin(origin, ingestEndpoint)) return null
        return validate(raw)
    }

    /** Trimmed value must be 1–512 printable ASCII (0x21–0x7E) characters. */
    fun validate(raw: String?): String? {
        val trimmed = raw?.trim() ?: return null
        if (trimmed.isEmpty() || trimmed.length > MAX_LENGTH) return null
        if (trimmed.any { it.code !in 0x21..0x7E }) return null
        return trimmed
    }

    /** Scheme, host (case-insensitive) and port, with default ports filled in. Unparseable never matches. */
    internal fun sameOrigin(a: String, b: String): Boolean {
        val left = originOf(a) ?: return false
        return left == originOf(b)
    }

    private fun originOf(url: String): Triple<String, String, Int>? {
        val uri = runCatching { URI(url.trim()) }.getOrNull() ?: return null
        val scheme = uri.scheme?.lowercase(Locale.ROOT)?.takeIf { it == "https" || it == "http" } ?: return null
        val host = uri.host?.lowercase(Locale.ROOT)?.takeIf { it.isNotEmpty() } ?: return null
        val port = if (uri.port != -1) uri.port else if (scheme == "https") 443 else 80
        return Triple(scheme, host, port)
    }
}
