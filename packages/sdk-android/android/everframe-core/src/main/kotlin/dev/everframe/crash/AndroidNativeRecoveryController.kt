// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import dev.everframe.health.NativeExposurePointer
import dev.everframe.health.ProcessLaunchIdentity
import dev.everframe.outbox.OutboxAuthorization
import dev.everframe.outbox.OutboxEntry
import java.util.concurrent.atomic.AtomicLong

internal interface AndroidNativeExitPlatform {
    val apiLevel: Int
    val pid: Int
    val processName: String
    fun history(): List<AndroidNativeExit>
    fun setStateSummary(value: ByteArray?)
}

/** OS reads run outside the lifecycle monitor; only registration and revocation serialize.
 * Authorization uses the SDK's lock-free epoch/consent mirrors. Never call under stateLock.
 */
internal class AndroidNativeRecoveryController(
    private val factory: () -> AndroidNativeRecovery,
    private val platform: AndroidNativeExitPlatform,
    private val processLaunchId: String = ProcessLaunchIdentity.id.toString(),
    private val exposure: (Int) -> NativeExposurePointer? = { null },
    /** API30 overlap: whether optional signal capture owns an ended launch's native fault. */
    private val signalCapture: (String) -> NativeSignalCapture = { NativeSignalCapture.NONE },
    /** Called when exit history shows another writer's process-state summary. */
    private val onSummaryConflict: () -> Unit = ProcessStateSummaryConflict::warn,
    /** Called when arming had to free context slots: (records that can no longer be reported, oldest records). */
    private val onJournalFull: (Int, Int) -> Unit = ::warnJournalFull,
) {
    private class Active(val epoch: Int, val engine: AndroidNativeRecovery, val authorization: OutboxAuthorization, val diagnostics: Boolean, val template: () -> OutboxEntry, val nowMs: Long, val admit: (OutboxEntry) -> Boolean, val appId: String?) {
        val operations = Any()
        // Volatile: readiness is read without the lock, which an arm holds across journal and Binder IO.
        @Volatile var ready = false
        @Volatile var claimed = false
        /** The exit history this owner's recovery read; a full journal frees slots against it. */
        var exits: List<AndroidNativeExit> = emptyList()
    }
    private val lock = Any()
    private val publication = Any()
    private val exposureGeneration = AtomicLong()
    @Volatile private var active: Active? = null
    /** The OS token as last written, or null once cleared; read without a lock by [markJvmFatal]. */
    @Volatile private var published: ByteArray? = null

    /** [appId] keys the low-memory kill's issue to this app; it is frozen into each context. */
    fun enable(epoch: Int, authorization: OutboxAuthorization, nowMs: Long, template: () -> OutboxEntry,
               appId: String? = null, admit: (OutboxEntry) -> Boolean): Boolean =
        enableMode(epoch, authorization, nowMs, false, template, admit, appId)

    fun enableDiagnostics(epoch: Int, authorization: OutboxAuthorization, nowMs: Long, template: () -> OutboxEntry,
                          appId: String? = null, admit: (OutboxEntry) -> Boolean): Boolean =
        enableMode(epoch, authorization, nowMs, true, template, admit, appId)

    private fun enableMode(epoch: Int, authorization: OutboxAuthorization, nowMs: Long, diagnostics: Boolean,
                           template: () -> OutboxEntry, admit: (OutboxEntry) -> Boolean, appId: String?): Boolean {
        if (platform.apiLevel < (if (diagnostics) 30 else 31) || !authorization.isAllowed()) return false
        val owner = synchronized(lock) {
            if (!authorization.isAllowed()) return false
            active?.let {
                if (it.authorization.isAllowed() && it.diagnostics == diagnostics) {
                    if (it.epoch != epoch) return false
                    if (it.ready) return true
                    return@synchronized it
                }
                active = null
                // A mode change or a newer start keeps both journals for the new owner's recovery;
                // only the old registration and its own context go. Erasure belongs to kill().
                replace(it)
            }
            Active(epoch, factory(), authorization, diagnostics, template, nowMs, admit, appId).also { active = it }
        }
        return initialize(owner)
    }

    /** Interrupted initial recovery must finish before a live context can be refreshed. */
    private fun initialize(owner: Active): Boolean = synchronized(owner.operations) {
        val generation = exposureGeneration.get()
        val gate = object : OutboxAuthorization {
            override fun isAllowed() = exposureGeneration.get() == generation && active === owner && owner.authorization.isAllowed()
        }
        try {
            if (!gate.isAllowed()) return false
            if (owner.ready) return true
            val exits = platform.history()
            owner.exits = exits
            if (ProcessStateSummaryConflict.foreign(exits, platform.processName)) runCatching { onSummaryConflict() }
            if (!gate.isAllowed()) return false
            owner.engine.recover(exits, owner.nowMs, gate, allowDiagnostics = owner.diagnostics, signalCapture = signalCapture) {
                if (gate.isAllowed()) owner.admit(it) else false
            }
            synchronized(lock) {
                if (!gate.isAllowed()) return false
                owner.engine.arm(owner.template(), platform.pid, platform.processName, gate, owner.diagnostics, processLaunchId, platform.apiLevel,
                    nativeExposure = exposure(owner.epoch), exits = exits, onReclaimed = ::journalFull, appId = owner.appId) {
                    synchronized(publication) {
                        check(gate.isAllowed())
                        owner.claimed = true // An exception may follow a successful remote Binder write.
                        publish(it)
                    }
                }
                owner.ready = true
                return true
            }
        } catch (_: Exception) { return false }
        finally {
            synchronized(lock) {
                if (active === owner && !owner.ready) {
                    // A lifecycle fence cancels readiness, not the host's explicit opt-in.
                    if (!owner.authorization.isAllowed()) active = null
                    if (owner.claimed) runCatching { publish(null) }
                }
            }
        }
    }

    /** Clears the OS token without waiting for journal IO; stale arm callbacks are fenced. */
    fun invalidateExposure() {
        exposureGeneration.incrementAndGet()
        synchronized(publication) { if (active?.claimed == true) runCatching { publish(null) } }
    }

    /** Replaces only the live context, preserving previous-process recovery receipts and mode. */
    fun refreshExposure(epoch: Int): Boolean {
        val owner = synchronized(lock) { active?.takeIf { it.epoch == epoch && it.authorization.isAllowed() } } ?: return false
        synchronized(owner.operations) {
            if (!owner.ready) return initialize(owner)
            val generation = exposureGeneration.get()
            synchronized(lock) {
                val gate = object : OutboxAuthorization {
                    override fun isAllowed() = active === owner && owner.epoch == epoch &&
                        exposureGeneration.get() == generation && owner.authorization.isAllowed()
                }
                if (!gate.isAllowed()) return false
                return try {
                    owner.engine.disarm()
                    owner.engine.arm(owner.template(), platform.pid, platform.processName, gate, owner.diagnostics,
                        processLaunchId, platform.apiLevel, nativeExposure = exposure(epoch), exits = owner.exits,
                        onReclaimed = ::journalFull, appId = owner.appId) { token ->
                        synchronized(publication) {
                            check(gate.isAllowed()); owner.claimed = true; publish(token)
                        }
                    }
                    owner.ready = gate.isAllowed()
                    owner.ready
                } catch (_: Exception) {
                    owner.ready = false
                    synchronized(publication) { runCatching { publish(null) } }
                    false
                }
            }
        }
    }

    /** Lock-free: an arm holds the lock across journal and Binder IO, and callers poll this on the main thread. */
    fun ready(epoch: Int): Boolean =
        active?.let { it.epoch == epoch && it.ready && it.authorization.isAllowed() } == true

    private fun journalFull(unreportable: Int, oldest: Int) { runCatching { onJournalFull(unreportable, oldest) } }

    /** Every OS token write goes through here, so [published] never names a token the OS no longer holds. */
    private fun publish(value: ByteArray?) {
        if (value == null) published = null
        platform.setStateSummary(value)
        if (value != null) published = value
    }

    /**
     * The JVM uncaught-exception handler admitted this process's fatal crash. A low-memory kill that
     * ends the process while the handler runs (a Java OOM) is the same death: the token gains
     * [AndroidNativeRecovery.JVM_FATAL_SUFFIX], so recovery does not report a second issue for it.
     * Native crashes and ANRs with the suffix are still reported. Runs on the crashing thread, so it
     * takes no lock: a token cleared at the same moment only leaves the exit unmatched.
     */
    fun markJvmFatal() {
        val token = published ?: return
        if (active?.authorization?.isAllowed() != true) return
        runCatching { platform.setStateSummary(token + AndroidNativeRecovery.JVM_FATAL_SUFFIX) }
    }

    /** Caller holds [lock]. Clears the old owner's OS token and drops only its own context. */
    private fun replace(owner: Active) {
        if (owner.claimed) runCatching { publish(null) }
        runCatching { owner.engine.disarm() }
    }

    /**
     * Replacement start retires only a prior live owner and keeps earlier processes' unadmitted
     * evidence for the next owner; kill() (erasePersisted) also erases the journals.
     */
    fun retire(epoch: Int, erasePersisted: Boolean, isCurrent: () -> Boolean) {
        if (platform.apiLevel < 30) return
        synchronized(lock) {
            if (!isCurrent()) return
            val owner = active
            if (owner != null && (owner.epoch > epoch || (owner.epoch == epoch && !erasePersisted))) return
            active = null
            if (owner != null && !erasePersisted) replace(owner)
            else if (owner != null) {
                owner.engine.invalidate()
                if (owner.claimed) runCatching { publish(null) }
                owner.engine.revoke()
            } else if (erasePersisted) factory().revoke()
        }
    }
}

private fun warnJournalFull(unreportable: Int, oldest: Int) {
    android.util.Log.w("Everframe", "OS exit capture: context journal full; dropped $unreportable record(s) " +
        "that can no longer be reported and $oldest oldest record(s) to arm this process.")
}
