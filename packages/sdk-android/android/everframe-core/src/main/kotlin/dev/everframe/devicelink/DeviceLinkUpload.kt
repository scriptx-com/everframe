// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// A linked device's quick-capture upload (wire contract: "Takeover through a
// quick-capture upload" and "Ingest with a device token").
//
// Every upload from a linked device carries a fresh `X-Everframe-Link-Nonce`.
// A 200 body may name a pending attempt (`linkPending`): another teammate is
// linking this device, and the device checks that attempt with the same nonce.
// A `403 {"error":"device_unlinked"}` means the token was revoked and nothing
// was stored.
//
// A transient failure queues the capture with the token's FINGERPRINT, never
// the token. A drain sends it with the current token only while the stored
// token has that fingerprint, and drops it otherwise, so a retry never lands
// in the shared inbox or under the device's next owner.
//
// SECURITY: never log the nonce or the token.

package dev.everframe.devicelink

import androidx.annotation.RestrictTo
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import java.security.MessageDigest

/** A pending link attempt named by an ingest response. SDK plumbing, public only for the composer's inputs. */
@RestrictTo(RestrictTo.Scope.LIBRARY_GROUP)
data class LinkPending(val attemptId: String, val number: Int)

/**
 * What a linked device's quick-capture upload needs beyond its token: the per-upload link nonce, and where
 * to deliver a `linkPending` answer. SDK plumbing, public only because the composer's inputs are.
 *
 * SECURITY: never log. [toString] redacts the nonce.
 */
@RestrictTo(RestrictTo.Scope.LIBRARY_GROUP)
class DeviceLinkUpload(
    val nonce: String, // SECURITY: never log
    val onLinkPending: (LinkPending) -> Unit,
) {
    override fun toString(): String = "DeviceLinkUpload(nonce=<redacted>)"
}

internal object IngestLinkResponse {
    const val LINK_NONCE_HEADER: String = "X-Everframe-Link-Nonce"
    const val DEVICE_UNLINKED: String = "device_unlinked"

    /** A linked capture that failed and could not be queued (no usable token to fingerprint). */
    const val NOT_QUEUED: String = "not_queued"

    /** `linkPending` from an ingest 200 body; null when absent or out of bounds. */
    fun parseLinkPending(body: String?): LinkPending? {
        val obj = parse(body) ?: return null
        val pending = obj["linkPending"] as? JsonObject ?: return null
        val attemptId = (pending["attemptId"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
            ?.takeIf { id -> id.length in 1..64 && id.all { it.code in 0x21..0x7E } } ?: return null
        val number = (pending["number"] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull
            ?.takeIf { it in 0..99 } ?: return null
        return LinkPending(attemptId, number)
    }

    fun isDeviceUnlinked(status: Int, body: String?): Boolean {
        if (status != 403) return false
        val error = (parse(body)?.get("error") as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
        return error == DEVICE_UNLINKED
    }

    private fun parse(body: String?): JsonObject? {
        if (body.isNullOrEmpty()) return null
        return runCatching { Json.parseToJsonElement(body) as? JsonObject }.getOrNull()
    }
}

/** Lowercase hex of the first 8 bytes of SHA-256 of the token: 16 characters. Not reversible. */
internal object DeviceLinkFingerprint {
    private val SHAPE = Regex("^[0-9a-f]{16}$")

    fun of(token: String): String =
        MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.UTF_8))
            .take(8).joinToString("") { "%02x".format(it) }

    fun isValid(raw: String?): Boolean = raw != null && SHAPE.matches(raw)
}
