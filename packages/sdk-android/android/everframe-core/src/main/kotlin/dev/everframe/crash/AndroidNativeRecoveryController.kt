// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import dev.everframe.outbox.OutboxAuthorization
import dev.everframe.outbox.OutboxEntry

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
) {
    private class Active(val epoch: Int, val engine: AndroidNativeRecovery, val authorization: OutboxAuthorization) {
        var ready = false
        var claimed = false
    }
    private val lock = Any()
    @Volatile private var active: Active? = null

    fun enable(epoch: Int, authorization: OutboxAuthorization, nowMs: Long, template: () -> OutboxEntry,
               admit: (OutboxEntry) -> Boolean): Boolean {
        if (platform.apiLevel < 31 || !authorization.isAllowed()) return false
        val owner = synchronized(lock) {
            if (!authorization.isAllowed()) return false
            active?.let {
                if (it.authorization.isAllowed()) return it.epoch == epoch && it.ready
                active = null
                it.engine.invalidate()
                if (it.claimed) runCatching { platform.setStateSummary(null) }
                it.engine.revoke()
            }
            Active(epoch, factory(), authorization).also { active = it }
        }
        val gate = object : OutboxAuthorization {
            override fun isAllowed() = active === owner && authorization.isAllowed()
        }
        try {
            val exits = platform.history()
            if (!gate.isAllowed()) return false
            owner.engine.recover(exits, nowMs, gate) { if (gate.isAllowed()) admit(it) else false }
            synchronized(lock) {
                if (!gate.isAllowed()) return false
                owner.engine.arm(template(), platform.pid, platform.processName, gate) {
                    owner.claimed = true // An exception may follow a successful remote Binder write.
                    platform.setStateSummary(it)
                }
                owner.ready = true
                return true
            }
        } catch (_: Exception) { return false }
        finally {
            synchronized(lock) {
                if (active === owner && !owner.ready) {
                    active = null
                    if (owner.claimed) runCatching { platform.setStateSummary(null) }
                }
            }
        }
    }

    fun ready(epoch: Int): Boolean = synchronized(lock) {
        active?.let { it.epoch == epoch && it.ready && it.authorization.isAllowed() } == true
    }

    /** Replacement start retires only a prior live owner; explicit disable/kill also erase old journals. */
    fun retire(epoch: Int, erasePersisted: Boolean, isCurrent: () -> Boolean) {
        if (platform.apiLevel < 31) return
        synchronized(lock) {
            if (!isCurrent()) return
            val owner = active
            if (owner != null && (owner.epoch > epoch || (owner.epoch == epoch && !erasePersisted))) return
            active = null
            if (owner != null) {
                owner.engine.invalidate()
                if (owner.claimed) runCatching { platform.setStateSummary(null) }
                owner.engine.revoke()
            } else if (erasePersisted) factory().revoke()
        }
    }
}
