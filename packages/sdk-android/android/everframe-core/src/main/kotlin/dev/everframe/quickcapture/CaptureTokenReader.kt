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

    /**
     * Scheme, host (case-insensitive) and port, with default ports filled in. Unparseable never
     * matches. The emulator reaches the host's loopback as 10.0.2.2, so a token issued by
     * `localhost` or `127.0.0.1` also matches an ingest endpoint on 10.0.2.2 with the same scheme
     * and port: both name the developer's own machine.
     */
    internal fun sameOrigin(a: String, b: String): Boolean {
        val issued = originOf(a) ?: return false
        val ingest = originOf(b) ?: return false
        if (issued == ingest) return true
        return issued.second in HOST_LOOPBACK && ingest.second == EMULATOR_HOST_ALIAS &&
            issued.first == ingest.first && issued.third == ingest.third
    }

    private val HOST_LOOPBACK = setOf("localhost", "127.0.0.1")
    private const val EMULATOR_HOST_ALIAS = "10.0.2.2"

    private fun originOf(url: String): Triple<String, String, Int>? {
        val uri = runCatching { URI(url.trim()) }.getOrNull() ?: return null
        val scheme = uri.scheme?.lowercase(Locale.ROOT)?.takeIf { it == "https" || it == "http" } ?: return null
        val host = uri.host?.lowercase(Locale.ROOT)?.takeIf { it.isNotEmpty() } ?: return null
        val port = if (uri.port != -1) uri.port else if (scheme == "https") 443 else 80
        return Triple(scheme, host, port)
    }
}
