// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.health

import dev.everframe.config.ReleaseHealthConfig
import dev.everframe.outbox.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

/** Request preparation may allocate; the returned closure only starts asynchronous transport. */
internal fun interface HealthTransport { fun prepare(entry: OutboxEntry): () -> Deferred<Int> }
/** Serializes the final memory-only consent check and HTTP admission with SDK revocation. */
internal fun interface HealthAdmission {
    fun start(allowed: () -> Boolean, prepared: () -> Deferred<Int>): Deferred<Int>?
}

internal class ReleaseHealthProducer(
    private val queue: OutboxStore,
    private val config: ReleaseHealthConfig,
    private val sdkVersion: String,
    private val sdkKey: String,
    private val endpoint: String,
    private val currentAuthorization: OutboxAuthorization,
    private val retentionAuthorization: OutboxAuthorization,
    processLaunchId: UUID = ProcessLaunchIdentity.id,
    private val nowMillis: () -> Long = System::currentTimeMillis,
    private val elapsedNanos: () -> Long = System::nanoTime,
) {
    private val startedMs = nowMillis()
    private val startedNanos = elapsedNanos()
    private val pointer = NativeExposurePointer(UUID.randomUUID().toString(), processLaunchId.toString(),
        NativeExposurePointer.timestamp(startedMs), config.nativeBuildId, config.loadedBuildId, config.loadedBundleStatus)
    private val exposure = buildJsonObject {
        put("exposureId", pointer.exposureId); put("processLaunchId", pointer.processLaunchId); put("startedAt", pointer.startedAt)
        put("platform", "android"); put("sdkVersion", sdkVersion)
        putJsonObject("nativeRelease") { put("buildId", config.nativeBuildId) }
        put("loadedBuildId", config.loadedBuildId?.let(::JsonPrimitive) ?: JsonNull)
        put("loadedBundleStatus", config.loadedBundleStatus.wireValue); put("sessionPolicy", "foreground-v1")
        putJsonObject("subject") {
            val id = config.userId
            put("kind", if (id == null) "anonymous" else "provided")
            if (id != null) put("id", id)
        }
        putJsonObject("coverage") { put("policy", "android-sdk-segment-v1"); put("sampleRate", 1)
            put("priorQueueLosses", JsonNull); put("queueLossAccounting", "unavailable") }
    }
    private val startEntry by lazy { entry(false, startedMs, 0, null) }
    private data class Ending(val reason: String, val capturedMs: Long, val elapsedMs: Long)
    private val ending = AtomicReference<Ending?>()
    private var endEntry: OutboxEntry? = null
    @Volatile private var started = false
    @Volatile private var ended = false

    fun readyPointer(): NativeExposurePointer? = pointer.takeIf {
        started && !ended && ending.get() == null && currentAuthorization.isAllowed() && queue.hasCurrentLease()
    }
    @Synchronized fun start(): Boolean {
        if (ended || ending.get() != null || !config.enabled || (config.userId != null && (!validHealthText(config.userId, 128) || config.userId.replace("\ufeff", "").isBlank())) || !pointer.valid() || !validHealthText(sdkVersion, 64) || !currentAuthorization.isAllowed()) return false
        return try {
            prune()
            queue.enqueueSync(startEntry, currentAuthorization)
            started = currentAuthorization.isAllowed() && queue.hasCurrentLease()
            started
        } catch (_: Exception) { false }
    }
    /** Memory-only boundary snapshot; a failed durable end never republishes this pointer. */
    fun close(reason: String = "sdk_stop") {
        require(reason == "background" || reason == "sdk_stop")
        ending.compareAndSet(null, Ending(reason, nowMillis().coerceAtLeast(startedMs),
            ((elapsedNanos() - startedNanos) / 1_000_000).coerceIn(0, 31L * 24 * 60 * 60 * 1000)))
    }
    @Synchronized fun end(reason: String = "sdk_stop"): Boolean {
        if (!started || !retentionAuthorization.isAllowed()) return false
        if (ended) return true
        close(reason)
        val boundary = requireNotNull(ending.get())
        return try {
            val record = endEntry ?: entry(true, boundary.capturedMs, boundary.elapsedMs, boundary.reason).also { endEntry = it }
            queue.enqueueSync(record, retentionAuthorization)
            ended = true
            true
        } catch (_: Exception) { false }
    }
    private fun entry(end: Boolean, capturedMs: Long, elapsedMs: Long, reason: String?): OutboxEntry {
        val id = UUID.randomUUID().toString()
        val bytes = buildJsonObject {
            put("schemaVersion", 3); put("recordId", id); put("exposure", exposure)
            put("capturedAt", NativeExposurePointer.timestamp(capturedMs)); put("phase", if (end) "end" else "start")
            put("sequence", if (end) 1 else 0); put("elapsedMs", elapsedMs)
            if (end) { require(reason == "background" || reason == "sdk_stop"); put("endReason", reason); put("outcome", "completed") }
        }.toString().toByteArray(Charsets.UTF_8)
        require(bytes.size <= 8192)
        return OutboxEntry(id, capturedMs, bytes, id, emptyList(), sdkKey, endpoint, null)
    }
    private fun prune() {
        val now = nowMillis()
        for (token in queue.snapshotTokens()) {
            val entry = queue.readIfPresent(token)?.entry ?: continue
            if (now >= entry.createdAt && now - entry.createdAt > MAX_LOCAL_AGE_MS) queue.removeIfPresent(token)
        }
    }
    suspend fun flush(transport: HealthTransport, admission: HealthAdmission): Int = queue.drainMutex.withLock {
        var delivered = 0
        try {
            prune()
            for (token in queue.snapshotTokens()) {
                if (!retentionAuthorization.isAllowed()) break
                val entry = queue.readIfPresent(token)?.entry ?: continue
                val prepared = transport.prepare(entry)
                val call = queue.withPresent(token) {
                    admission.start({ retentionAuthorization.isAllowed() && queue.hasCurrentLease() &&
                        nowMillis() - entry.createdAt <= MAX_LOCAL_AGE_MS }, prepared)
                } ?: break
                val status = call.await()
                if (status in 200..299 || status in setOf(400, 401, 403, 404, 409, 410)) {
                    queue.removeIfPresent(token)
                    if (status in 200..299) delivered++
                }
            }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { /* The immutable queue is the retry receipt. */ }
        delivered
    }
    companion object { private const val MAX_LOCAL_AGE_MS = 7L * 24 * 60 * 60 * 1000 }
}
