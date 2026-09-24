// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.outbox

import javax.crypto.SecretKey

internal data class OutboxToken(val generation: String, val fileId: String)

internal enum class OutboxFailure { CAPACITY, KEY_UNAVAILABLE, CORRUPT, IO, REVOKED, INVALID_ENTRY }

internal class OutboxWriteException(
    val failure: OutboxFailure,
    cause: Throwable? = null,
) : Exception(failure.name, cause)

internal data class PendingEntry(val token: OutboxToken, val entry: OutboxEntry)

internal interface OutboxAuthorization {
    fun isAllowed(): Boolean
}

internal data class OutboxLimits(
    val maxPayloadBytes: Long = 24_000_000L,
    val maxEncodedEntryBytes: Long = 24_250_000L,
    val maxEnvelopeBytes: Int = 1_000_000,
    val maxAttachments: Int = 6,
    val maxPartMetadataBytes: Int = 1_024,
    val maxRoutingFieldBytes: Int = 16_384,
    val maxReportIdBytes: Int = 256,
)

internal interface OutboxKeyProvider {
    fun createGeneration(generation: String): SecretKey
    fun loadGeneration(generation: String): SecretKey
    fun deleteGeneration(generation: String)
}
