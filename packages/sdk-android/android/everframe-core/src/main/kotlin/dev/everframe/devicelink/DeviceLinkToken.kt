// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture: the device link token, its owner, the scope it was
// issued for, and the per-request link nonce.
//
// SECURITY: never log, print, toast or put in a URL a device token or a nonce.

package dev.everframe.devicelink

import dev.everframe.quickcapture.CaptureTokenReader
import java.security.MessageDigest
import java.security.SecureRandom

internal object DeviceLinkToken {
    const val PREFIX: String = "evf_dev_"
    private val SHAPE = Regex("^evf_dev_[0-9A-Za-z]{32}$")

    fun isValid(raw: String?): Boolean = raw != null && SHAPE.matches(raw)
}

/**
 * Who a linked device files captures for. Public only because the negotiated [dev.everframe.config.ReplayConfig]
 * carries it in its `deviceLinking` block; apps never need it.
 */
public sealed interface DeviceLinkOwner {
    public data class User(val name: String) : DeviceLinkOwner
    public data object Team : DeviceLinkOwner
}

private const val MAX_DISPLAY_NAME = 40

/**
 * The name shown in toasts: control characters become spaces, whitespace runs collapse, the result
 * is trimmed and capped at 40 characters (then `…`). A blank name shows as `teammate`.
 */
internal fun DeviceLinkOwner.User.displayName(): String {
    val cleaned = name
        .map { if (Character.isISOControl(it)) ' ' else it }
        .joinToString("")
        .replace(Regex("\\s+"), " ")
        .trim()
    if (cleaned.isEmpty()) return "teammate"
    return if (cleaned.length > MAX_DISPLAY_NAME) cleaned.take(MAX_DISPLAY_NAME) + "…" else cleaned
}

/**
 * A stored link. [scope] binds it to the ingest origin and SDK key that linked it.
 *
 * SECURITY: never log. [toString] redacts the token.
 */
internal class StoredDeviceLink(
    val token: String, // SECURITY: never log
    val owner: DeviceLinkOwner,
    val scope: String,
) {
    override fun toString(): String = "StoredDeviceLink(token=<redacted>, owner=$owner, scope=$scope)"
}

/**
 * A token is used only for the origin and SDK key it was issued for, so switching between staging
 * and production (or two apps) never sends it elsewhere.
 */
internal object DeviceLinkScope {
    /** Lowercase hex SHA-256 of `"<scheme>://<host>:<port>\n<sdkKey>"`; null for an unparseable endpoint. */
    fun of(endpoint: String, sdkKey: String): String? {
        val (scheme, host, port) = CaptureTokenReader.originOf(endpoint) ?: return null
        return sha256Hex("$scheme://$host:$port\n$sdkKey")
    }
}

/** A fresh random nonce for a hello, an attempt check, or a quick-capture upload. SECURITY: never log. */
internal object LinkNonce {
    private const val ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    private const val LENGTH = 40
    private val random = SecureRandom()

    fun generate(): String {
        val chars = CharArray(LENGTH) { ALPHABET[random.nextInt(ALPHABET.length)] }
        return String(chars)
    }
}

internal fun sha256Hex(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }
