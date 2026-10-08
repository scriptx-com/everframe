// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.health

import dev.everframe.config.ReleaseHealthConfig
import dev.everframe.outbox.OutboxAuthorization
import dev.everframe.outbox.OutboxStore
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

internal class ReleaseHealthRequest internal constructor(
    val epoch: Int, val enabled: Boolean, internal val revocation: Long,
    internal val previous: ReleaseHealthProducer?,
)

/** Memory-only request publication never waits for the journal. A failed purge remains an
 * obligation across every later request, including factory failures and immediate re-enable.
 */
internal class ReleaseHealthController(
    private val factory: () -> OutboxStore,
    private val processLaunchId: UUID = ProcessLaunchIdentity.id,
) {
    private data class State(val request: ReleaseHealthRequest, val producer: ReleaseHealthProducer? = null)
    private val state = AtomicReference<State?>()
    private val revocation = AtomicLong()
    private val store = AtomicReference<OutboxStore?>()
    private val storageLock = Any()
    @Volatile private var completedRevocation = 0L

    /** Called at the SDK's start/kill authorization boundary; no disk, callbacks or monitor wait. */
    fun request(epoch: Int, enabled: Boolean): ReleaseHealthRequest {
        if (!enabled) {
            revocation.incrementAndGet()
            store.get()?.invalidateSync()
        }
        while (true) {
            val prior = state.get()
            val request = ReleaseHealthRequest(epoch, enabled, revocation.get(), prior?.producer)
            if (state.compareAndSet(prior, State(request))) return request
        }
    }
    fun currentRequest(epoch: Int): ReleaseHealthRequest? = state.get()?.request?.takeIf { it.epoch == epoch }
    fun readyPointer(epoch: Int): NativeExposurePointer? {
        val current = state.get() ?: return null
        return if (current.request.epoch == epoch && current.request.enabled && current.request.revocation == revocation.get())
            current.producer?.readyPointer() else null
    }
    private fun current(request: ReleaseHealthRequest): Boolean = state.get()?.request === request &&
        request.revocation == revocation.get()

    /** Off-main for an ordinary replacement; disable/kill may explicitly wait for durable purge. */
    fun finishBoundary(request: ReleaseHealthRequest): Boolean {
        if (!current(request)) return false
        if (request.enabled) {
            request.previous?.end()
            return true
        }
        return synchronized(storageLock) {
            if (!current(request)) false else completeRevocation()
        }
    }
    private fun completeRevocation(): Boolean {
        val requested = revocation.get()
        if (completedRevocation == requested) return true
        return try {
            val old = store.get() ?: factory().also { store.set(it) }
            // Never create a journal only to purge it: an absent root holds no records.
            if (!old.isAbsent()) old.revokeSync()
            store.compareAndSet(old, null)
            // A later request can raise the counter while disk IO is blocked. Never mark that
            // later generation complete using this earlier erasure receipt.
            completedRevocation = requested
            completedRevocation == revocation.get()
        } catch (_: Exception) { false }
    }
    fun activate(request: ReleaseHealthRequest, config: ReleaseHealthConfig, sdkVersion: String,
                 sdkKey: String, endpoint: String, currentAuthorization: OutboxAuthorization,
                 retentionAuthorization: OutboxAuthorization): Boolean = synchronized(storageLock) {
        if (!request.enabled || !config.enabled || !current(request) || !currentAuthorization.isAllowed()) return@synchronized false
        state.get()?.producer?.let { return@synchronized it.readyPointer() != null }
        if (!completeRevocation() || !current(request)) return@synchronized false
        val queue = try { store.get() ?: factory().also { store.set(it) } } catch (_: Exception) { return@synchronized false }
        if (!current(request) || !currentAuthorization.isAllowed()) return@synchronized false
        val currentGate = object : OutboxAuthorization {
            override fun isAllowed() = current(request) && currentAuthorization.isAllowed()
        }
        val retainedGate = object : OutboxAuthorization {
            override fun isAllowed() = request.revocation == revocation.get() && retentionAuthorization.isAllowed()
        }
        val producer = ReleaseHealthProducer(queue, config, sdkVersion, sdkKey, endpoint,
            currentGate, retainedGate, processLaunchId)
        val expected = state.get() ?: return@synchronized false
        if (expected.request !== request || !producer.start() || !currentGate.isAllowed()) return@synchronized false
        state.compareAndSet(expected, State(request, producer))
    }
    suspend fun flush(request: ReleaseHealthRequest, transport: HealthTransport, admission: HealthAdmission): Int {
        val current = state.get() ?: return 0
        if (current.request !== request || !request.enabled) return 0
        return current.producer?.flush(transport, admission) ?: 0
    }
}
