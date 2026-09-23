// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

/** The slot belongs to the process, never to a recorder instance or worker. */
internal class VideoCaptureLease {
    fun tryAcquire(owner: VideoOwner, size: VideoSize): Lease? = synchronized(lock) {
        if (current != null) null else Lease(owner, size).also { current = it }
    }

    class Lease internal constructor(val owner: VideoOwner, val size: VideoSize) {
        private enum class State { OWNED, QUARANTINED, COMPLETE }
        private var state = State.OWNED
        /** Only actual copy completion permits completion after quarantine. */
        fun quarantine() = synchronized(lock) { if (current === this) state = State.QUARANTINED }
        /** Caller must first recycle its buffer, and must own actual copy completion. */
        fun complete() = synchronized(lock) {
            if (current === this && state != State.COMPLETE) { state = State.COMPLETE; current = null }
        }
    }

    private companion object {
        val lock = Any()
        var current: Lease? = null
    }
}
