// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package com.traceitx.outbox

import kotlinx.coroutines.sync.Mutex
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** Lock order: drain mutex (when draining), canonical-root coordinator, OS file lock, authorizer.
 * No provider suspension/network or disk IO under a transport authorization lock is permitted.
 * Instances capture a lease; revoke invalidates it even before any disk mutation can fail.
 */
internal class OutboxStore(
    root: File,
    private val keys: OutboxKeyProvider,
    private val ops: OutboxFileOps,
    private val maxEntries: Int = JSONLOutbox.DEFAULT_MAX_ENTRIES,
    private val maxTotalBytes: Long = JSONLOutbox.DEFAULT_MAX_TOTAL_BYTES,
    legacyFiles: List<File> = emptyList(),
) {
    private val root = root.canonicalFile
    private val legacyFiles = legacyFiles.map { it.canonicalFile }.distinct()
    private val coordinator = coordinators.computeIfAbsent(this.root.path) { Coordinator() }
    private val lease = coordinator.epoch.get()
    private var generation: String? = null
    private val active get() = File(root, "active")
    private val cipher = OutboxCipher(keys)
    val drainMutex: Mutex get() = coordinator.drain

    init { require(maxEntries >= 0); require(maxTotalBytes >= 0) }

    fun enqueueSync(entry: OutboxEntry, authorization: OutboxAuthorization): OutboxToken {
        // A deliberate capture may wait for another thread's current storage
        // operation, but must never recurse into this store's OS file lock.
        if (coordinator.lock.isHeldByCurrentThread) throw OutboxWriteException(OutboxFailure.IO)
        return locked { enqueueLocked(entry, authorization) }
    }

    /** Never wait for another storage operation, including reentrant crash entry. */
    fun tryEnqueueSync(entry: OutboxEntry, authorization: OutboxAuthorization): OutboxToken? {
        if (coordinator.lock.isHeldByCurrentThread || !coordinator.lock.tryLock()) return null
        return try { locked(tryOnly = true) { enqueueLocked(entry, authorization) } }
        finally { coordinator.lock.unlock() }
    }

    private fun enqueueLocked(entry: OutboxEntry, authorization: OutboxAuthorization, candidate: OutboxToken? = null): OutboxToken {
        val size = try { cipher.encryptedSize(entry) }
        catch (invalid: IllegalArgumentException) { throw OutboxWriteException(OutboxFailure.INVALID_ENTRY, invalid) }
        checkAllowed(authorization)
        val current = currentGeneration(create = true) ?: error("Generation missing")
        checkAllowed(authorization)
        for (file in committedFiles()) {
            val token = token(current, file)
            val existing = decode(token, file)
            if (existing.reportId == entry.reportId) {
                if (existing != entry) throw OutboxWriteException(OutboxFailure.INVALID_ENTRY)
                // Reconcile a previous uncertain rename by syncing it before claiming durability.
                ops.syncFile(file)
                ops.syncDirectory(active)
                finishAdmission(token, authorization)
                return token
            }
        }
        val used = physicalUsage()
        if (committedFiles().size >= maxEntries || size > maxTotalBytes - MAINTENANCE_RESERVE ||
            used > maxTotalBytes - MAINTENANCE_RESERVE - size) throw OutboxWriteException(OutboxFailure.CAPACITY)
        val token = candidate ?: OutboxToken(current, UUID.randomUUID().toString())
        val tmp = File(active, "${token.fileId}.tmp")
        val target = file(token)
        // Failure leaves temp/tombstone bytes accounted; recovery retries their deletion.
        tmp.outputStream().use { cipher.write(entry, token, it) }
        ops.syncFile(tmp)
        checkAllowed(authorization)
        ops.renameAtomic(tmp, target)
        ops.syncDirectory(active)
        finishAdmission(token, authorization)
        return token
    }

    /** Bounded, nonsensitive upgrade-debt diagnostic. Originals remain plaintext until imported. */
    @Volatile internal var migrationBlocked: String? = null
        private set

    fun migrateLegacy(): Int {
        var imported = 0
        return try { locked {
            migrationBlocked = null
            if (File(root, "kill.history").exists() || File(root, "kill.pending").exists()) return@locked 0
            checkAllowed(MIGRATION_ALLOWED)
            for ((index, source) in legacyFiles.withIndex()) {
                val parent = source.parentFile ?: throw IOException("Missing legacy source parent")
                if (!source.exists()) {
                    // Reconcile a source unlink that may have preceded a failed parent sync.
                    if (parent.isDirectory) ops.syncDirectory(parent)
                    continue
                }
                if (!source.isFile) throw IOException("Unsupported legacy source")
                val fingerprint = fingerprint(source)
                source.inputStream().use { input ->
                    val reader = LegacyEntryReader(input)
                    while (true) {
                        when (val next = reader.next()) {
                            LegacyEntryResult.End -> break
                            is LegacyEntryResult.Blocked -> {
                                migrationBlocked = next.reason.name
                                return@locked imported
                            }
                            is LegacyEntryResult.Record -> {
                                if (importLegacyRecord(index, fingerprint, next)) imported++
                            }
                        }
                    }
                }
                checkAllowed(MIGRATION_ALLOWED)
                // Detect source changes observed while parsing before considering removal.
                if (fingerprint(source) != fingerprint) throw IOException("Legacy source changed")
                if (!source.delete()) throw IOException("Cannot remove migrated source")
                ops.syncDirectory(parent)
            }
            // Keep cross-source dedup receipts until every known source removal is synced.
            legacyFiles.indices.forEach { removeReceiptsForSource(it) }
            imported
        } } catch (failure: OutboxWriteException) {
            migrationBlocked = failure.failure.name
            imported
        }
    }

    private fun fingerprint(source: File): String {
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(65536)
        source.inputStream().use { input ->
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun receiptFiles(extension: String = "receipt") = active.listFiles()?.filter { it.isFile && it.extension == extension }
        ?: if (active.exists()) throw IOException("Cannot enumerate migration receipts") else emptyList()

    private fun receiptEntry(current: String, receipt: File) = decode(token(current, receipt), receipt)
    private fun receiptParts(entry: OutboxEntry): List<String> {
        if (entry.envelopeBytes.size > 256) throw OutboxWriteException(OutboxFailure.CORRUPT)
        return entry.envelopeBytes.toString(Charsets.US_ASCII).split('|').also {
            if (it.size != 4) throw OutboxWriteException(OutboxFailure.CORRUPT)
        }
    }
    private fun importLegacyRecord(source: Int, fingerprint: String, record: LegacyEntryResult.Record): Boolean {
        val current = currentGeneration(true) ?: throw OutboxWriteException(OutboxFailure.REVOKED)
        val receiptId = UUID.nameUUIDFromBytes("$source:$fingerprint:${record.offset}".toByteArray()).toString()
        val receiptToken = OutboxToken(current, receiptId)
        val receipt = File(active, "$receiptId.receipt")
        if (receipt.exists()) {
            val prior = receiptEntry(current, receipt)
            if (prior.reportId != record.entry.reportId || prior.idempotencyKey != record.entry.idempotencyKey) {
                throw OutboxWriteException(OutboxFailure.CORRUPT)
            }
            ops.syncFile(receipt); ops.syncDirectory(active)
            return false
        }
        var alreadyDelivered = false
        for (prior in receiptFiles()) {
            val entry = receiptEntry(current, prior)
            if (entry.reportId == record.entry.reportId) {
                if (entry.idempotencyKey != record.entry.idempotencyKey) throw OutboxWriteException(OutboxFailure.INVALID_ENTRY)
                alreadyDelivered = true
            }
        }
        var existing: OutboxToken? = null
        for (committed in committedFiles()) {
            val decoded = decode(token(current, committed), committed)
            if (decoded.reportId == record.entry.reportId) {
                if (decoded != record.entry) throw OutboxWriteException(OutboxFailure.INVALID_ENTRY)
                existing = token(current, committed)
                break
            }
        }
        val candidate = existing ?: OutboxToken(current, UUID.randomUUID().toString())
        val metadata = record.entry.copy(envelopeBytes = "$source|$fingerprint|${record.offset}|${candidate.fileId}".toByteArray(), attachmentRefs = emptyList())
        val receiptBytes = cipher.encryptedSize(metadata)
        val candidateBytes = if (existing != null || alreadyDelivered) 0L else cipher.encryptedSize(record.entry)
        if ((!alreadyDelivered && existing == null && committedFiles().size >= maxEntries) ||
            physicalUsage() > maxTotalBytes - MAINTENANCE_RESERVE - receiptBytes - candidateBytes) {
            throw OutboxWriteException(OutboxFailure.CAPACITY)
        }
        checkAllowed(MIGRATION_ALLOWED)
        // An encrypted intent retains the exact candidate token across commit-before-receipt death.
        // Recovery finalizes it before any snapshot can expose that candidate to a drain.
        val intent = File(active, "$receiptId.intent")
        intent.outputStream().use { cipher.write(metadata, receiptToken, it) }
        ops.syncFile(intent); ops.syncDirectory(active)
        if (!alreadyDelivered) enqueueLocked(record.entry, MIGRATION_ALLOWED, candidate)
        checkAllowed(MIGRATION_ALLOWED)
        ops.renameAtomic(intent, receipt); ops.syncFile(receipt); ops.syncDirectory(active)
        return existing == null && !alreadyDelivered
    }

    private fun recoverReceiptIntents() {
        val intents = receiptFiles("intent")
        if (intents.isEmpty()) return
        val current = currentGeneration(false) ?: throw OutboxWriteException(OutboxFailure.REVOKED)
        for (intent in intents) {
            val metadata = receiptEntry(current, intent)
            val candidate = OutboxToken(current, receiptParts(metadata)[3])
            if (file(candidate).isFile) {
                // Admission's rename might have reached disk before its own directory sync.
                ops.syncFile(file(candidate)); ops.syncDirectory(active)
                ops.renameAtomic(intent, File(active, "${intent.nameWithoutExtension}.receipt"))
                ops.syncDirectory(active)
            } else {
                if (!intent.delete()) throw IOException("Cannot remove uncommitted migration intent")
                ops.syncDirectory(active)
            }
        }
    }
    private fun removeReceiptsForSource(source: Int) {
        val receipts = receiptFiles()
        if (receipts.isEmpty()) return
        val current = currentGeneration(false) ?: throw OutboxWriteException(OutboxFailure.REVOKED)
        for (receipt in receipts) {
            if (receiptParts(receiptEntry(current, receipt))[0] == source.toString()) {
                if (!receipt.delete()) throw IOException("Cannot remove completed migration receipt")
                ops.syncDirectory(active)
            }
        }
    }
    private fun physicalUsage(): Long {
        var total = physicalBytes(root)
        for (source in legacyFiles) {
            // Locators are external to the encrypted root; never omit inherited upgrade debt.
            val size = if (source.isDirectory) physicalBytes(source) else source.length()
            if (total > Long.MAX_VALUE - size) throw OutboxWriteException(OutboxFailure.CAPACITY)
            total += size
        }
        return total
    }

    fun snapshotTokens(): List<OutboxToken> = locked {
        val current = currentGeneration(false) ?: return@locked emptyList()
        // Only ordering metadata survives each decode; never retain a decoded queue here.
        committedFiles().map { file ->
            val token = token(current, file)
            token to decode(token, file).createdAt
        }.sortedWith(compareBy<Pair<OutboxToken, Long>> { it.second }.thenBy { it.first.fileId }).map { it.first }
    }

    fun readIfPresent(token: OutboxToken): PendingEntry? = locked {
        if (!presentLocked(token)) null else PendingEntry(token, decode(token, file(token)))
    }

    fun isPresent(token: OutboxToken): Boolean = locked { presentLocked(token) }

    /** Short non-suspending transport-start seam. Caller may only initiate asynchronous work here. */
    fun <T> withPresent(token: OutboxToken, action: () -> T): T? = locked {
        if (presentLocked(token)) action() else null
    }

    fun removeIfPresent(token: OutboxToken): Unit = locked { removeLocked(token) }

    /** Atomic only: safe alongside TraceItX's monotonic kill boundary under stateLock. */
    fun invalidateSync() { coordinator.epoch.incrementAndGet() }
    fun hasCurrentLease(): Boolean = lease == coordinator.epoch.get() && !isRevocationPending()
    fun isRevocationPending(): Boolean = coordinator.epoch.get() != coordinator.completedEpoch.get()

    /** A permanent nonsensitive kill history for O5's legacy migration suppression. */
    fun hasRevocationHistory(): Boolean = locked { File(root, "kill.history").exists() || File(root, "kill.pending").exists() }

    fun revokeSync() {
        invalidateSync()
        val revokingEpoch = coordinator.epoch.get()
        try {
            locked(recoverIntent = false) {
                val old = diskGeneration()
                try {
                    val intent = File(root, "kill.pending")
                    if (!intent.exists() && !intent.createNewFile()) throw IOException("Cannot record revocation")
                    ops.syncFile(intent)
                    ops.syncDirectory(root)
                } catch (failure: Exception) {
                    // Exact generation only; never invalidate a shared alias or replacement key.
                    if (old != null) try { keyOperation { keys.deleteGeneration(old) } }
                    catch (keyFailure: Exception) { failure.addSuppressed(keyFailure) }
                    throw failure
                }
                retireRevokedGeneration()
                coordinator.completedEpoch.set(revokingEpoch)
            }
        } catch (failure: Exception) {
            // Initialization may fail before binding this facade. Reacquire coordination and
            // the existing root's OS lock without requiring another directory fsync, so a
            // readable exact generation can still lose its key while admission is poisoned.
            try {
                coordinator.lock.withLock {
                    if (coordinator.epoch.get() == revokingEpoch && coordinator.completedEpoch.get() < revokingEpoch) {
                        val bound = generation
                        if (bound != null) keys.deleteGeneration(bound)
                        else if (root.isDirectory) {
                            RandomAccessFile(File(root, "store.lock"), "rw").use { handle ->
                                handle.channel.lock().use { diskGeneration()?.let { keys.deleteGeneration(it) } }
                            }
                        }
                    }
                }
            } catch (keyFailure: Exception) { failure.addSuppressed(keyFailure) }
            throw failure
        }
    }

    private fun retireRevokedGeneration() {
        val history = File(root, "kill.history")
        if (!history.exists() && !history.createNewFile()) throw IOException("Cannot record kill history")
        ops.syncFile(history)
        ops.syncDirectory(root)
        val old = diskGeneration()
        if (old != null) keyOperation { keys.deleteGeneration(old) }
        if (active.exists()) ops.renameAtomic(active, File(root, "${UUID.randomUUID()}.revoked"))
        // Always reconcile an uncertain prior rename, including when active is already absent.
        ops.syncDirectory(root)
        val intent = File(root, "kill.pending")
        if (intent.exists() && !intent.delete()) throw IOException("Cannot clear revocation intent")
        ops.syncDirectory(root)
        cleanup(root)
    }

    private fun finishAdmission(token: OutboxToken, authorization: OutboxAuthorization) {
        try { checkAllowed(authorization) }
        catch (revoked: OutboxWriteException) {
            try { removeLocked(token) } catch (cleanup: Exception) { revoked.addSuppressed(cleanup) }
            throw revoked
        }
    }

    private fun removeLocked(token: OutboxToken) {
        if (!presentLocked(token)) {
            // Absence may follow a rename/deletion whose directory fsync failed in another
            // instance or process. Reconcile the namespace before claiming durable removal.
            if (active.isDirectory) ops.syncDirectory(active)
            ops.syncDirectory(root)
            return
        }
        val removed = File(active, "${token.fileId}.removed")
        ops.renameAtomic(file(token), removed)
        ops.syncDirectory(active)
        if (!removed.delete()) throw IOException("Cannot delete outbox tombstone")
        ops.syncDirectory(active)
    }

    private fun presentLocked(token: OutboxToken): Boolean =
        lease == coordinator.epoch.get() && currentGeneration(false) == token.generation && file(token).isFile

    private fun checkAllowed(authorization: OutboxAuthorization) {
        if ((coordinator.epoch.get() != coordinator.completedEpoch.get()) || lease != coordinator.epoch.get() || !authorization.isAllowed() ||
            (generation != null && generation != diskGeneration())) throw OutboxWriteException(OutboxFailure.REVOKED)
    }

    private fun currentGeneration(create: Boolean): String? {
        if ((coordinator.epoch.get() != coordinator.completedEpoch.get()) || lease != coordinator.epoch.get()) return null
        var disk = diskGeneration()
        if (generation != null && generation != disk) return null
        if (disk == null && create) {
            if (active.exists() && active.listFiles()?.isNotEmpty() == true) throw OutboxWriteException(OutboxFailure.CORRUPT)
            ensureDirectory(active)
            disk = UUID.randomUUID().toString()
            keyOperation { keys.createGeneration(disk) }
            val marker = File(active, "generation.$disk")
            if (!marker.createNewFile()) throw IOException("Cannot create generation marker")
            ops.syncFile(marker)
            ops.syncDirectory(active)
            ops.syncDirectory(root)
        }
        if (disk != null) {
            keyOperation { keys.loadGeneration(disk) }
            generation = disk
        }
        return disk
    }

    private fun diskGeneration(): String? {
        val markers = active.listFiles()?.filter { it.name.startsWith("generation.") } ?: return null
        if (markers.isEmpty()) return null
        if (markers.size != 1) throw OutboxWriteException(OutboxFailure.CORRUPT)
        val id = markers.single().name.removePrefix("generation.")
        if (runCatching { UUID.fromString(id).toString() == id }.getOrDefault(false).not()) {
            throw OutboxWriteException(OutboxFailure.CORRUPT)
        }
        return id
    }

    private fun committedFiles() = active.listFiles()?.filter { it.isFile && it.extension == "txq" }
        ?: if (active.exists()) throw IOException("Cannot enumerate outbox") else emptyList()
    private fun token(generation: String, file: File) = OutboxToken(generation, file.nameWithoutExtension)
    private fun file(token: OutboxToken): File {
        if (runCatching { UUID.fromString(token.fileId).toString() == token.fileId }.getOrDefault(false).not()) {
            throw OutboxWriteException(OutboxFailure.CORRUPT)
        }
        return File(active, "${token.fileId}.txq")
    }
    private fun decode(token: OutboxToken, file: File): OutboxEntry {
        keyOperation { keys.loadGeneration(token.generation) }
        return try { file.inputStream().use { cipher.read(token, it) } }
        catch (io: IOException) { throw io }
        catch (failure: Exception) { throw OutboxWriteException(OutboxFailure.CORRUPT, failure) }
    }
    private fun <T> keyOperation(action: () -> T): T = try { action() }
    catch (failure: Exception) { throw OutboxWriteException(OutboxFailure.KEY_UNAVAILABLE, failure) }

    private fun <T> locked(tryOnly: Boolean = false, recoverIntent: Boolean = true, action: () -> T): T = coordinator.lock.withLock {
        try {
            ensureDirectory(root)
            RandomAccessFile(File(root, "store.lock"), "rw").use { handle ->
                val fileLock = if (tryOnly) handle.channel.tryLock() ?: throw OutboxWriteException(OutboxFailure.IO)
                    else handle.channel.lock()
                fileLock.use {
                    if (recoverIntent && coordinator.epoch.get() == coordinator.completedEpoch.get() &&
                        File(root, "kill.pending").exists()) {
                        // Fresh process recovery: retire before exposing any active generation.
                        retireRevokedGeneration()
                    }
                    cleanup(root)
                    if (recoverIntent) recoverReceiptIntents()
                    action()
                }
            }
        } catch (failure: OutboxWriteException) { throw failure }
        catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
        catch (failure: Exception) { throw OutboxWriteException(OutboxFailure.IO, failure) }
    }
    private fun ensureDirectory(dir: File) {
        val parent = dir.parentFile ?: throw IOException("Missing outbox parent")
        if (!dir.isDirectory) {
            ensureDirectory(parent)
            if (!dir.mkdir() && !dir.isDirectory) throw IOException("Cannot create outbox directory")
        }
        // Existing directories may be the result of mkdir followed by a failed parent fsync.
        // Reconcile that link on every attempt; namespace existence does not prove durability.
        ops.syncDirectory(parent)
    }
    private fun cleanup(dir: File) {
        val children = dir.listFiles() ?: throw IOException("Cannot enumerate outbox directory")
        for (child in children) {
            if (child.name.endsWith(".revoked")) {
                if (child.deleteRecursively()) ops.syncDirectory(dir)
            } else if (child.name.endsWith(".tmp") || child.name.endsWith(".removed")) {
                if (child.delete()) ops.syncDirectory(dir)
            } else if (child.name == "active" && child.isDirectory) cleanup(child)
        }
    }
    private fun physicalBytes(dir: File): Long {
        val children = dir.listFiles() ?: throw IOException("Cannot enumerate quota")
        return children.fold(0L) { total, child ->
            val size = if (child.isDirectory) physicalBytes(child) else child.length()
            if (total > Long.MAX_VALUE - size) throw OutboxWriteException(OutboxFailure.CAPACITY)
            total + size
        }
    }
    private class Coordinator {
        val lock = ReentrantLock()
        val drain = Mutex()
        val epoch = AtomicLong(0)
        val completedEpoch = AtomicLong(0)
    }
    private companion object {
        val MIGRATION_ALLOWED = object : OutboxAuthorization { override fun isAllowed() = true }
        const val MAINTENANCE_RESERVE = 1024L * 1024
        val coordinators = ConcurrentHashMap<String, Coordinator>()
    }
}
