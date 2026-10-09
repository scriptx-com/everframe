// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import dev.everframe.envelope.txGuardVoid
import dev.everframe.health.ProcessLaunchIdentity
import dev.everframe.outbox.OutboxAuthorization
import dev.everframe.outbox.OutboxEntry
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/** Native pause must be lock-free and perform no disk or socket IO. Other calls run off stateLock. */
internal interface AndroidNativeSignalProducer {
    fun arm(epoch: String, key: ByteArray, generation: Long): Boolean
    fun generation(): Long
    fun pause()
    fun revoke(): Boolean
}

/** Whether this path owns an ended launch's native fault, so API30 exit-info recovery adds no
 * second report: DELIVERED once its report entered the outbox, PENDING while its authenticated
 * record awaits import or admission. */
internal enum class NativeSignalCapture { NONE, PENDING, DELIVERED }

/** One controller per app process; IO is serialized separately from immediate command fences. */
internal class AndroidNativeSignalController(
    private val factory: () -> AndroidNativeRecordImport,
    private val producer: AndroidNativeSignalProducer,
    private val readRecord: (String) -> ByteArray?,
    /** Shared with exit-info contexts, which match an OS exit to the same launch. */
    private val processLaunchId: String = ProcessLaunchIdentity.id.toString(),
    private val now: () -> Long = System::currentTimeMillis,
    private val cleanup: (Set<String>) -> Unit = {},
) {
    private data class Owner(val command: Long, val epoch: Int, val reportId: String, val engine: AndroidNativeRecordImport)
    private val operations = Any()
    private val revision = AtomicLong()
    private val erasePending = AtomicBoolean()
    @Volatile private var owner: Owner? = null
    @Volatile private var readyCommand = -1L

    /** Called synchronously at start/disable/kill. Never waits for provisioning or storage. */
    fun request(erase: Boolean = false): Long {
        if (erase) erasePending.set(true)
        val command = revision.incrementAndGet()
        readyCommand = -1
        if (erase) owner?.engine?.invalidate()
        // A mismatched optional module's reflective pause must not break the start, kill or erase fence.
        txGuardVoid("nativeSignal.pause") { producer.pause() }
        return command
    }

    fun ready(epoch: Int): Boolean = owner?.let {
        it.epoch == epoch && it.command == revision.get() && readyCommand == it.command && !erasePending.get()
    } == true

    /** Complete durable erasure even when no producer was armed in this process. Retry on failure. */
    fun finishRevocation(): Boolean = synchronized(operations) {
        if (!erasePending.getAndSet(false)) return@synchronized true
        readyCommand = -1
        val previous = owner
        try {
            (previous?.engine ?: factory()).revoke(producer::revoke)
            owner = null
            true
        } catch (_: Exception) {
            erasePending.set(true)
            false
        }
    }

    fun retireCurrent(): Boolean = synchronized(operations) {
        readyCommand = -1
        if (!producer.revoke()) return@synchronized false
        owner?.let { it.engine.retireArmed(it.reportId); cleanup(it.engine.retainedEpochs()) }
        owner = null
        true
    }

    /** IO caller. Recover immutable prior-process reports before arming the new frozen context. */
    fun enable(command: Long, epoch: Int, authorization: OutboxAuthorization,
               template: () -> OutboxEntry, admit: (OutboxEntry, OutboxAuthorization) -> Boolean): Boolean = synchronized(operations) {
        val gate = object : OutboxAuthorization {
            override fun isAllowed() = revision.get() == command && !erasePending.get() && authorization.isAllowed()
        }
        if (revision.get() != command || !authorization.isAllowed() || !finishRevocation() || !gate.isAllowed()) return@synchronized false
        if (ready(epoch)) return@synchronized true
        try {
            // Pause already happened at the command fence. Wait for the handler to revoke
            // before retiring this process's capsule; previous-process evidence is untouched.
            if (!producer.revoke()) return@synchronized false
            owner?.let { it.engine.retireArmed(it.reportId) }
            owner = null
            val engine = factory()
            engine.recover(processLaunchId, now(), gate, readRecord, admit)
            cleanup(engine.retainedEpochs())
            val nativeGeneration = producer.generation()
            if (!gate.isAllowed()) return@synchronized false
            val entry = template()
            owner = Owner(command, epoch, entry.reportId, engine)
            if (!engine.arm(entry, processLaunchId, gate) { id, key -> producer.arm(id, key, nativeGeneration) } || !gate.isAllowed()) {
                producer.pause()
                if (producer.revoke()) {
                    engine.retireArmed(entry.reportId)
                    cleanup(engine.retainedEpochs())
                    owner = null
                }
                return@synchronized false
            }
            readyCommand = command
            // A concurrent fence can occur between publication and this final read.
            ready(epoch)
        } catch (_: Exception) {
            readyCommand = -1
            producer.pause()
            producer.revoke()
            // Keep the owner for a later retry/erase if source retirement failed.
            false
        }
    }
}
