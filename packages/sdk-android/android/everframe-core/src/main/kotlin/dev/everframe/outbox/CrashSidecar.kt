// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.outbox

import android.content.Context
import dev.everframe.diagnostics.ReportDiagnostics
import java.io.File

/** Synchronous encrypted admission. Coordination contention rejects immediately on the dying thread. */
class CrashSidecar private constructor(private val file: File, private val outbox: JSONLOutbox) {
    constructor(file: File) : this(file, JSONLOutbox(File(file.parentFile, "outbox.jsonl")))
    constructor(context: Context) : this(
        File(File(context.cacheDir, "dev.everframe"), "crash-outbox.jsonl"), JSONLOutbox(context),
    )
    internal constructor(file: File, keys: OutboxKeyProvider, ops: OutboxFileOps,
        maxEntries: Int = JSONLOutbox.DEFAULT_MAX_ENTRIES) : this(
        file, JSONLOutbox(File(file.parentFile, "outbox.jsonl"), keys, ops, maxEntries),
    )

    // Retain the existing public Unit JVM descriptor for already-compiled callers.
    fun appendSync(entry: OutboxEntry) { appendSyncAccepted(entry) }

    internal fun appendSync(entry: OutboxEntry, authorization: OutboxAuthorization?) {
        appendSyncAccepted(entry, authorization)
    }

    /** True only after encrypted admission returns a durable token; rejected entries never suppress fallback. */
    fun appendSyncAccepted(entry: OutboxEntry): Boolean = appendSyncAccepted(entry, null)

    internal fun appendSyncAccepted(entry: OutboxEntry, authorization: OutboxAuthorization?, diagnostics: ReportDiagnostics.Handle? = null): Boolean = try {
        outbox.tryEnqueueSync(entry, authorization, diagnostics) != null
    } catch (_: Exception) {
        false // Persistence failure must preserve the original crash. Errors propagate.
    }

    /** Deliberate handled capture may wait for current storage work; fatal capture never calls this. */
    internal fun appendHandledSyncAccepted(entry: OutboxEntry, authorization: OutboxAuthorization, diagnostics: ReportDiagnostics.Handle? = null): Boolean = try {
        outbox.store.enqueueSync(entry, authorization, diagnostics)
        true
    } catch (_: Exception) {
        false
    }

    /** Error replays (spec 2026-10-11): handled admission that also returns the stored entry's token. */
    internal fun appendHandledSyncToken(entry: OutboxEntry, authorization: OutboxAuthorization,
                                        diagnostics: ReportDiagnostics.Handle? = null): OutboxToken? = try {
        outbox.store.enqueueSync(entry, authorization, diagnostics)
    } catch (_: Exception) { null }

    /** Error replays: the nonblocking automatic-bridge admission that also returns the token. */
    internal fun appendSyncToken(entry: OutboxEntry, authorization: OutboxAuthorization,
                                 diagnostics: ReportDiagnostics.Handle? = null): OutboxToken? = try {
        outbox.tryEnqueueSync(entry, authorization, diagnostics)
    } catch (_: Exception) { null }

    /** Error replays: swap a still-queued error for the same report with its replay attached. */
    internal fun replaceSync(token: OutboxToken, replacement: OutboxEntry, authorization: OutboxAuthorization): Boolean = try {
        outbox.store.replaceSync(token, replacement, authorization)
    } catch (_: Exception) { false }

    /** Import known legacy sources without renaming, rewriting, or discarding blocked input. */
    suspend fun hydrateInto(outbox: JSONLOutbox): Int = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
        LegacyOutboxMigration.migrate(outbox)
    }

    companion object {
        const val MAX_ENTRIES = JSONLOutbox.DEFAULT_MAX_ENTRIES
    }
}
