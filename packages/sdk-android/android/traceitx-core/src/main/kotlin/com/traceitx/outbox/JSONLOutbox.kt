// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package com.traceitx.outbox

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import java.io.File

/**
 * One persisted entry: a serialized envelope plus the metadata needed to
 * retransmit it without re-running capture. Mirrors iOS `OutboxEntry`.
 *
 * The encrypted outbox codec writes envelope and attachment bytes directly as
 * bounded binary fields. Serializable remains for legacy sidecar compatibility.
 */
@Serializable
data class OutboxEntry(
    val reportId: String,
    val createdAt: Long,
    val envelopeBytes: ByteArray,
    val idempotencyKey: String,
    val attachmentRefs: List<AttachmentRef>,
    /**
     * The SDK key configured when this entry was queued. Drain submits with
     * THIS key, never the currently-configured one — otherwise
     * `start(projectA)` → offline submit → `start(projectB)` ships A's whole
     * report (screenshot, network bodies, reporter identity) into B.
     *
     * Required in legacy migration. A missing captured route blocks migration and
     * preserves the original source; it is never filled from live configuration.
     */
    val sdkKey: String,
    /**
     * The ingest URL this entry was queued against. Stored beside the key
     * because the endpoint is independently redirectable (`endpointOverride`
     * in ReportSubmitter), so a key alone can still reach the wrong host.
     * Also has no default, for the same reason as [sdkKey].
     */
    val endpoint: String,
    /**
     * The verified-identity subject (`sub`) this report was CAPTURED under —
     * `TXCapturedUser.identitySubject` at the moment `toEntry` ran. `null`
     * means the report was captured anonymously (no cached token, or
     * identity disabled for the project) and must never be retroactively
     * attributed on drain, however the holder is configured by then.
     *
     * Unlike required routing fields, absence in legacy input means anonymous.
     * Bounded migration preserves that null rather than using the live identity.
     */
    val identitySubject: String? = null,
) {
    @Serializable
    data class AttachmentRef(
        val name: String,
        val filename: String,
        val contentType: String,
        val data: ByteArray,
        val sha256Hex: String,
    ) {
        // ByteArray data classes need explicit equals/hashCode for content equality
        // (Kotlin's generated equals uses reference equality for arrays).
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is AttachmentRef) return false
            return name == other.name && filename == other.filename &&
                contentType == other.contentType && data.contentEquals(other.data) &&
                sha256Hex == other.sha256Hex
        }
        override fun hashCode(): Int {
            var r = name.hashCode()
            r = 31 * r + filename.hashCode()
            r = 31 * r + contentType.hashCode()
            r = 31 * r + data.contentHashCode()
            r = 31 * r + sha256Hex.hashCode()
            return r
        }
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is OutboxEntry) return false
        return reportId == other.reportId && createdAt == other.createdAt &&
            envelopeBytes.contentEquals(other.envelopeBytes) &&
            idempotencyKey == other.idempotencyKey && attachmentRefs == other.attachmentRefs &&
            sdkKey == other.sdkKey && endpoint == other.endpoint &&
            identitySubject == other.identitySubject
    }
    override fun hashCode(): Int {
        var r = reportId.hashCode()
        r = 31 * r + createdAt.hashCode()
        r = 31 * r + envelopeBytes.contentHashCode()
        r = 31 * r + idempotencyKey.hashCode()
        r = 31 * r + attachmentRefs.hashCode()
        r = 31 * r + sdkKey.hashCode()
        r = 31 * r + endpoint.hashCode()
        r = 31 * r + (identitySubject?.hashCode() ?: 0)
        return r
    }
}

/** Source-compatible facade over immutable encrypted entries. File arguments are legacy locators. */
class JSONLOutbox private constructor(
    internal val store: OutboxStore,
    private val gate: () -> Boolean = { com.traceitx.TraceItX.captureGate },
) {
    constructor(
        file: File,
        maxEntries: Int = DEFAULT_MAX_ENTRIES,
        maxTotalBytes: Long = DEFAULT_MAX_TOTAL_BYTES,
    ) : this(OutboxStore(encryptedRoot(file), AndroidOutboxKeyProvider(), AndroidOutboxFileOps(), maxEntries, maxTotalBytes, legacyFiles(file)))

    constructor(
        context: Context,
        maxEntries: Int = DEFAULT_MAX_ENTRIES,
        maxTotalBytes: Long = DEFAULT_MAX_TOTAL_BYTES,
    ) : this(OutboxStore(File(context.noBackupFilesDir, "com.traceitx/outbox-v1"),
        AndroidOutboxKeyProvider(), AndroidOutboxFileOps(), maxEntries, maxTotalBytes,
        legacyFiles(File(context.cacheDir, "com.traceitx/outbox.jsonl")))) {
        com.traceitx.TraceItX.registerOutboxForPendingRevocation(this)
    }

    internal constructor(
        file: File,
        keys: OutboxKeyProvider,
        ops: OutboxFileOps,
        maxEntries: Int = DEFAULT_MAX_ENTRIES,
        maxTotalBytes: Long = DEFAULT_MAX_TOTAL_BYTES,
        gate: () -> Boolean = { true },
    ) : this(OutboxStore(encryptedRoot(file), keys, ops, maxEntries, maxTotalBytes, legacyFiles(file)), gate)

    internal fun tryEnqueueSync(entry: OutboxEntry, authorization: OutboxAuthorization? = null): OutboxToken? =
        store.tryEnqueueSync(entry, authorization ?: object : OutboxAuthorization {
            override fun isAllowed() = gate()
        })

    suspend fun enqueue(entry: OutboxEntry) = enqueue(entry, object : OutboxAuthorization {
        override fun isAllowed() = gate()
    })

    internal suspend fun enqueue(entry: OutboxEntry, authorization: OutboxAuthorization): Unit =
        withContext(Dispatchers.IO) { LegacyOutboxMigration.migrate(this@JSONLOutbox); store.enqueueSync(entry, authorization); Unit }

    suspend fun hydrate(): List<OutboxEntry> = withContext(Dispatchers.IO) {
        LegacyOutboxMigration.migrate(this@JSONLOutbox)
        store.snapshotTokens().mapNotNull { store.readIfPresent(it)?.entry }
    }

    suspend fun count(): Int = withContext(Dispatchers.IO) { LegacyOutboxMigration.migrate(this@JSONLOutbox); store.snapshotTokens().size }

    suspend fun removeWhere(predicate: (OutboxEntry) -> Boolean): Unit = withContext(Dispatchers.IO) {
        LegacyOutboxMigration.migrate(this@JSONLOutbox)
        for (token in store.snapshotTokens()) {
            val pending = store.readIfPresent(token) ?: continue
            if (predicate(pending.entry)) store.removeIfPresent(token)
        }
    }

    suspend fun drain(predicate: suspend (OutboxEntry) -> Boolean) = drainOwned { predicate(it.entry) }

    internal suspend fun drainOwned(predicate: suspend (PendingEntry) -> Boolean) {
        store.drainMutex.withLock {
            val tokens = withContext(Dispatchers.IO) { LegacyOutboxMigration.migrate(this@JSONLOutbox); store.snapshotTokens() }
            for (token in tokens) {
                val pending = withContext(Dispatchers.IO) { store.readIfPresent(token) } ?: continue
                val consumed = try { predicate(pending) }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { false }
                if (consumed) withContext(Dispatchers.IO) { store.removeIfPresent(token) }
            }
        }
    }

    companion object {
        const val DEFAULT_MAX_ENTRIES = 50
        const val DEFAULT_MAX_TOTAL_BYTES = 64L * 1024 * 1024
        private fun legacyFiles(file: File) = listOf(file, File(file.absoluteFile.parentFile, "crash-outbox.jsonl"),
            File(file.absoluteFile.parentFile, "crash-outbox.jsonl.processing")).distinctBy { it.canonicalPath }
        private fun encryptedRoot(file: File) = File(file.absoluteFile.parentFile, "${file.name}.encrypted")
    }
}
