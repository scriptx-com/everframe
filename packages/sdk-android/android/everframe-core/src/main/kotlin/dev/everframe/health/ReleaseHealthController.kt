// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.health

import dev.everframe.config.ReleaseHealthConfig
import dev.everframe.outbox.OutboxAuthorization
import dev.everframe.outbox.OutboxStore
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

internal class ReleaseHealthRequest internal constructor(
    val epoch: Int, val enabled: Boolean, internal val revocation: Long,
)

/** Memory-only request publication never waits for the journal. A failed purge remains an
 * obligation across every later request, including factory failures and immediate re-enable.
 */
internal class ReleaseHealthController(
    private val factory: () -> OutboxStore,
    private val processLaunchId: UUID = ProcessLaunchIdentity.id,
    private val initiallyForeground: Boolean = false,
) {
    private data class State(val request: ReleaseHealthRequest, val producer: ReleaseHealthProducer? = null,
        val foreground: Boolean = false, val generation: Long = 0, val drainProducer: ReleaseHealthProducer? = null)
    private val state = AtomicReference<State?>()
    private val revocation = AtomicLong()
    private val store = AtomicReference<OutboxStore?>()
    private val storageLock = Any()
    private val endings = ArrayBlockingQueue<ReleaseHealthProducer>(256)
    @Volatile private var completedRevocation = 0L

    /** Called at the SDK's start/kill authorization boundary; no disk, callbacks or monitor wait. */
    fun request(epoch: Int, enabled: Boolean): ReleaseHealthRequest {
        if (!enabled) {
            revocation.incrementAndGet()
            store.get()?.invalidateSync()
        }
        while (true) {
            val prior = state.get()
            val request = ReleaseHealthRequest(epoch, enabled, revocation.get())
            if (state.compareAndSet(prior, State(request, foreground = initiallyForeground))) {
                if (enabled) prior?.producer?.let { it.close(); endings.offer(it) }
                else endings.clear()
                return request
            }
        }
    }
    fun currentRequest(epoch: Int): ReleaseHealthRequest? = state.get()?.request?.takeIf { it.epoch == epoch }
    fun readyPointer(epoch: Int): NativeExposurePointer? {
        val current = state.get() ?: return null
        return if (current.request.epoch == epoch && current.request.enabled && current.request.revocation == revocation.get())
            current.producer?.readyPointer() else null
    }
    /** Memory-only lifecycle fence; the caller persists the returned session off main. */
    fun foreground(request: ReleaseHealthRequest, value: Boolean): ReleaseHealthProducer? {
        while (true) {
            val prior = state.get() ?: return null
            if (prior.request !== request || !current(request) || !request.enabled || prior.foreground == value) return null
            val next = prior.copy(foreground = value, generation = prior.generation + 1,
                producer = null, drainProducer = prior.producer ?: prior.drainProducer)
            if (state.compareAndSet(prior, next)) {
                if (!value) prior.producer?.close("background")
                return if (value) null else prior.producer
            }
        }
    }
    private fun current(request: ReleaseHealthRequest): Boolean = state.get()?.request === request &&
        request.revocation == revocation.get()

    /** Off-main for an ordinary replacement; disable/kill may explicitly wait for durable purge. */
    fun finishBoundary(request: ReleaseHealthRequest): Boolean {
        if (!current(request)) return false
        if (request.enabled) {
            for (producer in endings.toList()) if (producer.end()) endings.remove(producer)
            return true
        }
        return synchronized(storageLock) {
            if (!current(request)) false else completeRevocation()
        }
    }
    /** Publish retry eligibility only after the caller clears actual native attribution. */
    fun rememberForegroundBoundary(producer: ReleaseHealthProducer) { endings.offer(producer) }
    fun finishForegroundBoundary(producer: ReleaseHealthProducer) {
        if (producer.end("background")) endings.remove(producer)
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
        if (!request.enabled || !config.enabled || state.get()?.foreground != true || !current(request) || !currentAuthorization.isAllowed()) return@synchronized false
        state.get()?.producer?.let { return@synchronized it.readyPointer() != null }
        if (!completeRevocation() || !current(request)) return@synchronized false
        val queue = try { store.get() ?: factory().also { store.set(it) } } catch (_: Exception) { return@synchronized false }
        if (!current(request) || !currentAuthorization.isAllowed()) return@synchronized false
        val generation = state.get()?.generation ?: return@synchronized false
        val currentGate = object : OutboxAuthorization {
            override fun isAllowed() = current(request) && state.get()?.let { it.foreground && it.generation == generation } == true && currentAuthorization.isAllowed()
        }
        val retainedGate = object : OutboxAuthorization {
            override fun isAllowed() = request.revocation == revocation.get() && retentionAuthorization.isAllowed()
        }
        val producer = ReleaseHealthProducer(queue, config, sdkVersion, sdkKey, endpoint,
            currentGate, retainedGate, processLaunchId)
        val expected = state.get() ?: return@synchronized false
        if (expected.request !== request) return@synchronized false
        if (producer.start() && currentGate.isAllowed() &&
            state.compareAndSet(expected, expected.copy(producer = producer, drainProducer = producer))) return@synchronized true
        // A background or replacement that landed after the durable start never saw this unpublished
        // session, so its end is still owed. Its pointer never became readable; revocation purges it.
        if (producer.startCommitted && request.revocation == revocation.get()) {
            producer.close(if (state.get()?.request === request) "background" else "sdk_stop")
            endings.offer(producer)
        }
        false
    }
    suspend fun flush(request: ReleaseHealthRequest, transport: HealthTransport, admission: HealthAdmission): Int {
        val current = state.get() ?: return 0
        if (current.request !== request || !request.enabled) return 0
        return (current.producer ?: current.drainProducer)?.flush(transport, admission) ?: 0
    }
}
