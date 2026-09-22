// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.capture.video

import android.graphics.Bitmap

data class VideoSize internal constructor(val width: Int, val height: Int) {
    init { require(width in 2..854 && height in 2..854 && width % 2 == 0 && height % 2 == 0) }
}
data class VideoOwner internal constructor(val sessionId: String, val captureId: String)
internal data class PrivacyObservation(
    val windowIdentity: Any?, val width: Int, val height: Int, val epoch: Long, val allowed: Boolean,
)

/** Worker-exclusive pixels. Call close on the capture worker; never retain the bitmap. */
internal class SafeVideoFrame private constructor(
    val owner: VideoOwner,
    val authorizationGeneration: Long,
    val captureTimeNanos: Long,
    val privacyGeneration: Long,
    private val bitmap: Bitmap,
    private val lease: VideoCaptureLease.Lease,
    private val scheduler: VideoCaptureScheduler,
    private val authorized: () -> Boolean,
) : AutoCloseable {
    private var closed = false

    /** Short admission linearization point, also required immediately before codec queueing.
     * Revocation after this point belongs to the future encoder's output-discard protocol.
     */
    fun isAuthorized(): Boolean { check(scheduler.isWorkerThread()); return !closed && authorized() }

    fun withPixels(block: (Bitmap) -> Unit): Boolean {
        if (!isAuthorized()) return false
        // No lock needed by main is held across arbitrary pixel/codec work.
        block(bitmap)
        return true
    }

    override fun close() {
        check(scheduler.isWorkerThread())
        if (!closed) { closed = true; bitmap.recycle(); lease.complete() }
    }

    companion object {
        // Creation is centralized at the capture boundary; no public bitmap constructor.
        internal fun fromCapture(owner: VideoOwner, generation: Long, time: Long, bitmap: Bitmap,
            lease: VideoCaptureLease.Lease, scheduler: VideoCaptureScheduler, privacyGeneration: Long = VideoPrivacyRevocation.current, authorized: () -> Boolean
        ) = SafeVideoFrame(owner, generation, time, privacyGeneration, bitmap, lease, scheduler, authorized)
    }
}

/** Segment PTS are relative to this encoder origin; wall epoch is sampled once beside monotonic time. */
internal data class VideoTimeAnchor(val wallEpochMs: Long, val elapsedAnchorNanos: Long) {
    fun ptsUs(captureTimeNanos: Long): Long = (captureTimeNanos - elapsedAnchorNanos) / 1_000
}
