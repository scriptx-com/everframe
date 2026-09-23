// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Port of packages/sdk-web/src/vitals/sanitize-source.ts. Signed CDN and
// licence URLs carry tokens in the query — stripped by default.
package dev.everframe.vitals

import java.net.URI

data class SanitizedSource(val src: String, val protocol: String)

private val UNKNOWN = SanitizedSource("unknown", "unknown")
private val PROGRESSIVE_EXT = setOf("mp4", "m4v", "webm", "ogg", "ogv", "mov", "mp3", "aac", "m4a", "wav", "flac")

fun protocolForPath(path: String): String {
    val dot = path.lastIndexOf('.')
    if (dot < 0) return "unknown"
    return when (val ext = path.substring(dot + 1).lowercase()) {
        "m3u8" -> "hls"
        "mpd" -> "dash"
        else -> if (ext in PROGRESSIVE_EXT) "progressive" else "unknown"
    }
}

fun protocolForMime(mime: String?): String? {
    val m = mime?.lowercase() ?: return null
    return when {
        m == "application/x-mpegurl" || m == "application/vnd.apple.mpegurl" -> "hls"
        m == "application/dash+xml" -> "dash"
        m.startsWith("video/") || m.startsWith("audio/") -> "progressive"
        else -> null
    }
}

fun sanitizeSource(raw: String?, keepQuery: Boolean = false): SanitizedSource {
    if (raw.isNullOrBlank()) return UNKNOWN
    for (local in listOf("content:", "file:", "asset:")) if (raw.startsWith(local)) return SanitizedSource(local, "unknown")
    val uri = try { URI(raw) } catch (_: Throwable) { return UNKNOWN }
    val scheme = uri.scheme?.lowercase()
    if (scheme != "http" && scheme != "https") return UNKNOWN
    val host = uri.host ?: return UNKNOWN
    val port = if (uri.port >= 0) ":${uri.port}" else ""
    val path = uri.rawPath ?: ""
    val query = if (keepQuery && uri.rawQuery != null) "?${uri.rawQuery}" else ""
    return SanitizedSource("$scheme://$host$port$path$query", protocolForPath(path))
}
