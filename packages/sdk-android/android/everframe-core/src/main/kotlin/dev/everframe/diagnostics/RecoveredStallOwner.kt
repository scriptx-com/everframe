// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.diagnostics

internal interface RecoveredStallSession {
    val ready: Boolean
    fun start()
    fun close()
}

/** Synchronous epoch revocation; construction/cleanup never holds this owner's lock. */
internal class RecoveredStallOwner {
    private val lock = Any()
    private var generation = 0L
    private var epoch = -1
    private var enabled = false
    private var preparing: Long? = null
    private var session: RecoveredStallSession? = null

    fun request(epoch: Int, enabled: Boolean): Long {
        val retired: RecoveredStallSession?
        val token: Long
        synchronized(lock) {
            if (enabled && this.enabled && this.epoch == epoch) return generation
            generation++; token = generation
            this.epoch = epoch; this.enabled = enabled; preparing = null
            retired = session; session = null
        }
        runCatching { retired?.close() }
        return token
    }
    fun invalidate() { request(-1, false) }
    fun allows(request: Long, epoch: Int): Boolean = synchronized(lock) {
        enabled && this.epoch == epoch && generation == request
    }
    fun ready(epoch: Int): Boolean = synchronized(lock) { enabled && this.epoch == epoch && session?.ready == true }

    fun enable(request: Long, epoch: Int, live: () -> Boolean,
               create: ((() -> Boolean)) -> RecoveredStallSession): Boolean {
        val allowed = { allows(request, epoch) && runCatching(live).getOrDefault(false) }
        if (!allowed()) return false
        synchronized(lock) {
            if (!allows(request, epoch)) return false
            if (session != null) return true
            if (preparing == request) return false
            preparing = request
        }
        val candidate = try { create(allowed) } catch (_: Exception) {
            synchronized(lock) { if (preparing == request) preparing = null }
            return false
        }
        val accepted = synchronized(lock) {
            if (preparing == request) preparing = null
            if (allowed() && session == null) { session = candidate; true } else false
        }
        if (!accepted) { runCatching { candidate.close() }; return false }
        try { candidate.start() } catch (_: Exception) {
            synchronized(lock) { if (session === candidate) session = null }
            runCatching { candidate.close() }; return false
        }
        return allowed()
    }
}

internal fun stallEligible(lifecycleForeground: Boolean, processForeground: Boolean, interactive: Boolean,
                           debugger: Boolean, waitingForDebugger: Boolean): Boolean =
    lifecycleForeground && processForeground && interactive && !debugger && !waitingForDebugger
