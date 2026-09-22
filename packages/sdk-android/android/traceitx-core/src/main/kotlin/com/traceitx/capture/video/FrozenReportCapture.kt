// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.capture.video

import com.traceitx.protocol.generated.Breadcrumb
import com.traceitx.protocol.generated.NetworkBody

internal interface ReplayCaptureOrigin {
    val sessionId: String
    fun replayAllowed(owner: VideoOwner, generation: Long): Boolean
    suspend fun export(owner: VideoOwner, generation: Long): OwnedVideoClip?
    fun cancel(owner: VideoOwner)
    fun release(owner: VideoOwner)
}
internal data class FrozenAncillarySnapshot(val breadcrumbs: List<Breadcrumb>?, val networkBodies: List<NetworkBody>?)
internal enum class FrozenCaptureState { FROZEN, EXPORTING, READY, CONSUMED, CANCELLED }

/** Immutable origin and independently consumed selections. Never resolves the installed session. */
class FrozenReportCapture internal constructor(
    val owner: VideoOwner,
    internal val originatingStartEpoch: Int,
    internal val authorizationGeneration: Long,
    private val origin: ReplayCaptureOrigin,
    snapshot: FrozenAncillarySnapshot,
) {
    init { require(owner.sessionId == origin.sessionId) }
    private val lock = Any()
    private var state = FrozenCaptureState.FROZEN
    private var breadcrumbs = snapshot.breadcrumbs?.toList()
    private var networkBodies = snapshot.networkBodies?.toList()
    private var breadcrumbsTaken = false
    private var networkBodiesTaken = false
    private var readyClip: OwnedVideoClip? = null
    private var replayRevoked = false
    private var cancelled = false

    /** Send-time config/user boundary, independent of whether optional replay is enabled. */
    fun matchesSession(session: com.traceitx.TXCapturedSession): Boolean =
        !session.isRevoked && session.user.startEpoch == originatingStartEpoch

    fun replayAllowed(): Boolean {
        val allowed = origin.replayAllowed(owner, authorizationGeneration)
        return synchronized(lock) {
            if (!allowed) replayRevoked = true
            !replayRevoked && state != FrozenCaptureState.CANCELLED
        }
    }

    suspend fun exportVideo(): OwnedVideoClip? {
        synchronized(lock) {
            if (state != FrozenCaptureState.FROZEN) return null
            state = FrozenCaptureState.EXPORTING
        }
        var clip: OwnedVideoClip? = null
        try {
            if (replayAllowed()) clip = origin.export(owner, authorizationGeneration)
            return com.traceitx.TraceItX.withReportAuthorizationLock {
                val allowed = replayAllowed()
                synchronized(lock) {
                    if (state != FrozenCaptureState.EXPORTING || !allowed || clip?.owner != owner) null
                    else {
                        state = FrozenCaptureState.READY
                        readyClip = clip
                        clip = null
                        readyClip.also { readyClip = null }
                    }
                }
            }
        } finally {
            clip?.close()
            synchronized(lock) { if (state == FrozenCaptureState.EXPORTING) state = FrozenCaptureState.READY }
        }
    }

    fun takeBreadcrumbs(): List<Breadcrumb>? = synchronized(lock) {
        if (breadcrumbsTaken || terminal()) null else breadcrumbs.also { breadcrumbsTaken = true; breadcrumbs = null }
    }
    fun takeNetworkBodies(): List<NetworkBody>? = synchronized(lock) {
        if (networkBodiesTaken || terminal()) null else networkBodies.also { networkBodiesTaken = true; networkBodies = null }
    }
    private fun terminal() = state == FrozenCaptureState.CONSUMED || state == FrozenCaptureState.CANCELLED

    // Consumption must not enter between cancel's claim revocation and terminal transition.
    // Both paths use authorization -> handle lock; bound callbacks run outside the handle lock.
    fun finishConsumption() = com.traceitx.TraceItX.withReportAuthorizationLock { terminate(false) }
    fun cancel() = com.traceitx.TraceItX.withReportAuthorizationLock {
        val consumed = synchronized(lock) {
            if (cancelled) return@withReportAuthorizationLock
            cancelled = true; replayRevoked = true
            state == FrozenCaptureState.CONSUMED
        }
        if (consumed) origin.cancel(owner) else terminate(true)
    }
    private fun terminate(cancel: Boolean) {
        val clip = synchronized(lock) {
            if (terminal()) return
            state = if (cancel) FrozenCaptureState.CANCELLED else FrozenCaptureState.CONSUMED
            breadcrumbs = null; networkBodies = null
            readyClip.also { readyClip = null }
        }
        try { clip?.close(); if (cancel) origin.cancel(owner) } finally { origin.release(owner) }
    }

    internal companion object {
        fun empty(startEpoch: Int, sessionId: String = java.util.UUID.randomUUID().toString()): FrozenReportCapture {
            val origin = object : ReplayCaptureOrigin {
                override val sessionId = sessionId
                override fun replayAllowed(owner: VideoOwner, generation: Long) = false
                override suspend fun export(owner: VideoOwner, generation: Long): OwnedVideoClip? = null
                override fun cancel(owner: VideoOwner) = Unit
                override fun release(owner: VideoOwner) = Unit
            }
            return FrozenReportCapture(VideoOwner(sessionId, java.util.UUID.randomUUID().toString()), startEpoch, -1,
                origin, FrozenAncillarySnapshot(null, null))
        }
    }
}

/** Reject new optional capture at capacity; never evict another report. */
internal object ReportCaptureSlots {
    private var occupied = 0
    @Synchronized fun acquire(): AutoCloseable? {
        if (occupied >= 2) return null
        occupied++
        val released = java.util.concurrent.atomic.AtomicBoolean()
        return AutoCloseable { synchronized(this) { if (released.compareAndSet(false, true)) occupied-- } }
    }
}
