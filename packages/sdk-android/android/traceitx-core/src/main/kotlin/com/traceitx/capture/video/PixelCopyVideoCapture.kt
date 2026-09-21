// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.capture.video

import android.app.Activity
import android.graphics.Bitmap
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import android.view.PixelCopy
import android.view.View
import android.view.ViewTreeObserver
import java.lang.ref.WeakReference

internal interface VideoCaptureScheduler {
    fun main(block: () -> Unit)
    fun copyCompletion(block: () -> Unit) = main(block)
    fun worker(block: () -> Unit)
    fun later(delayMs: Long, block: () -> Unit): () -> Unit
    fun isWorkerThread(): Boolean
    fun nowNanos(): Long
}
internal interface VideoCapturePlatform {
    fun observe(): PrivacyObservation
    fun watch(onPreDraw: () -> Unit, onExtraCommit: () -> Unit): () -> Unit
    fun commit(callback: () -> Unit): () -> Unit
    fun copy(bitmap: Bitmap, callback: (Boolean) -> Unit)
}

/** No startup/config integration: caller must authorize construction and stop on revocation. */
internal class PixelCopyVideoCapture(
    private val platform: VideoCapturePlatform,
    private val scheduler: VideoCaptureScheduler,
    private val allocate: (VideoSize) -> Bitmap = { Bitmap.createBitmap(it.width, it.height, Bitmap.Config.ARGB_8888) },
) {
    val mainRequestNs = VideoEncoderTimings.Counter()
    val mainBeginNs = VideoEncoderTimings.Counter()
    val mainPreDrawNs = VideoEncoderTimings.Counter()
    val mainInvalidationNs = VideoEncoderTimings.Counter()
    val mainCommitNs = VideoEncoderTimings.Counter()
    val mainCopyAdmissionNs = VideoEncoderTimings.Counter()
    val frameCommitWaitNs = VideoEncoderTimings.Counter()
    val copyCallbackLatencyNs = VideoEncoderTimings.Counter()
    val copyMainDispatchNs = VideoEncoderTimings.Counter()
    val privacyExclusions = java.util.concurrent.atomic.AtomicLong()
    private val lock = Any()
    private var generation = 0L
    private var enabled = true
    private var active: Pending? = null

    private class Pending(val lease: VideoCaptureLease.Lease, val generation: Long, val accept: (SafeVideoFrame) -> Unit) {
        val privacyGeneration = VideoPrivacyRevocation.current
        var bitmap: Bitmap? = null
        var observation: PrivacyObservation? = null
        var submitted = false
        var invalid = false
        var privacyExcluded = false
        var finished = false
        var callbackSeen = false
        var captureTime = 0L
        var commitRequestedAt = 0L
        var copyStartedAt = 0L
        var unwatch: (() -> Unit)? = null
        var uncommit: (() -> Unit)? = null
        var untimer: (() -> Unit)? = null
    }

    fun request(owner: VideoOwner, size: VideoSize, accept: (SafeVideoFrame) -> Unit): Boolean {
        val phaseStarted = scheduler.nowNanos()
        try {
            val pending = synchronized(lock) {
                if (!enabled || active != null || VideoPrivacyRevocation.blocked) return false
                val lease = VideoCaptureLease().tryAcquire(owner, size) ?: return false
                Pending(lease, generation, accept).also { active = it }
            }
            scheduler.worker {
                try { pending.bitmap = allocate(size) } catch (_: Throwable) {
                    scheduler.main { discard(pending) }; return@worker
                }
                scheduler.main { begin(pending) }
            }
            return true
        } finally { mainRequestNs.add(scheduler.nowNanos() - phaseStarted) }
    }

    fun cancel() = invalidate(false)
    fun invalidateAuthorization() = invalidate(true)

    private fun invalidate(disable: Boolean) {
        val pending = synchronized(lock) {
            generation++
            if (disable) enabled = false
            active?.also { it.invalid = true }
        }
        if (pending != null) scheduler.main { discard(pending) }
    }

    private fun valid(p: Pending): Boolean = synchronized(lock) {
        VideoPrivacyRevocation.permits(p.privacyGeneration) && enabled && generation == p.generation && !p.invalid && !p.finished
    }

    private fun matches(p: Pending, next: PrivacyObservation): Boolean {
        val before = p.observation ?: return false
        return next.allowed && before.epoch == next.epoch && before.windowIdentity === next.windowIdentity &&
            before.width == next.width && before.height == next.height
    }

    private fun excludePrivacy(p: Pending) = synchronized(lock) {
        if (!p.privacyExcluded) { p.privacyExcluded = true; privacyExclusions.incrementAndGet() }
    }
    private fun revalidate(p: Pending): Boolean {
        val okay = try {
            if (!VideoPrivacyRevocation.permits(p.privacyGeneration)) excludePrivacy(p)
            valid(p) && platform.observe().let { next ->
                if (!next.allowed) excludePrivacy(p)
                matches(p, next)
            }
        } catch (_: Throwable) { excludePrivacy(p); false }
        if (!okay) synchronized(lock) { p.invalid = true }
        return okay
    }

    private fun begin(p: Pending) {
        val phaseStarted = scheduler.nowNanos()
        try {
            if (!valid(p)) { discard(p); return }
            try {
                p.observation = platform.observe()
                if (p.observation?.allowed != true) { excludePrivacy(p); discard(p); return }
                p.unwatch = platform.watch(
                    { measure(mainPreDrawNs) { if (!revalidate(p)) discard(p) } },
                    { measure(mainInvalidationNs) { synchronized(lock) { p.invalid = true }; discard(p) } },
                )
                // Observe at the exact registration boundary, after listener installation.
                if (!revalidate(p)) { discard(p); return }
                p.untimer = scheduler.later(1_000) { discard(p) }
                p.commitRequestedAt = scheduler.nowNanos()
                p.uncommit = platform.commit { committed(p) }
            } catch (_: Throwable) { discard(p) }
        } finally { mainBeginNs.add(scheduler.nowNanos() - phaseStarted) }
    }

    private fun committed(p: Pending) {
        val phaseStarted = scheduler.nowNanos()
        try {
            frameCommitWaitNs.add(scheduler.nowNanos() - p.commitRequestedAt)
            p.uncommit?.invoke(); p.uncommit = null
            if (p.submitted || !revalidate(p)) { discard(p); return }
            p.untimer?.invoke()
            p.untimer = scheduler.later(1_000) { discard(p) }
            p.captureTime = scheduler.nowNanos()
            // Submission ownership is decided under the same short lock as cancellation.
            val submit = synchronized(lock) {
                if (valid(p)) { p.submitted = true; true } else false
            }
            if (!submit) { discard(p); return }
            p.copyStartedAt = scheduler.nowNanos()
            try { platform.copy(p.bitmap!!) { success ->
                val callbackAt = scheduler.nowNanos()
                scheduler.copyCompletion { copied(p, success, callbackAt) }
            } }
            catch (_: Throwable) {
                // Submission may have reached Android before an adapter throws: pin until callback.
                discard(p)
            }
        } finally { mainCommitNs.add(scheduler.nowNanos() - phaseStarted) }
    }

    private fun copied(p: Pending, success: Boolean, callbackAt: Long) {
        val phaseStarted = scheduler.nowNanos()
        try {
            if (p.callbackSeen) return
            p.callbackSeen = true
            copyCallbackLatencyNs.add(callbackAt - p.copyStartedAt)
            copyMainDispatchNs.add(scheduler.nowNanos() - callbackAt)
            val admitted = success && revalidate(p)
            cleanup(p)
            val transfer = synchronized(lock) {
                val okay = admitted && valid(p)
                p.finished = true
                if (active === p) active = null
                okay
            }
            scheduler.worker {
                val bitmap = p.bitmap
                if (!transfer || bitmap == null) { release(p); return@worker }
                val frame = SafeVideoFrame.fromCapture(p.lease.owner, p.generation, p.captureTime, bitmap, p.lease, scheduler, p.privacyGeneration) {
                    synchronized(lock) { VideoPrivacyRevocation.permits(p.privacyGeneration) && enabled && generation == p.generation && !p.invalid }
                }
                if (!frame.isAuthorized()) { frame.close(); return@worker }
                try { p.accept(frame) } catch (_: Throwable) { frame.close() }
            }
        } finally { mainCopyAdmissionNs.add(scheduler.nowNanos() - phaseStarted) }
    }

    private fun discard(p: Pending) {
        synchronized(lock) { p.invalid = true }
        cleanup(p)
        if (p.submitted && !p.callbackSeen) {
            p.lease.quarantine()
            // Listener closures need not retain the old root while Android owns the buffer.
            synchronized(lock) { if (active === p) active = null }
        } else if (!p.finished) {
            synchronized(lock) { p.finished = true; if (active === p) active = null }
            scheduler.worker { release(p) }
        }
    }

    private fun cleanup(p: Pending) {
        p.uncommit?.invoke(); p.uncommit = null
        p.unwatch?.invoke(); p.unwatch = null
        p.untimer?.invoke(); p.untimer = null
    }
    private fun release(p: Pending) { p.bitmap?.recycle(); p.bitmap = null; p.lease.complete() }

    private inline fun measure(counter: VideoEncoderTimings.Counter, block: () -> Unit) {
        val began = scheduler.nowNanos()
        try { block() } finally { counter.add(scheduler.nowNanos() - began) }
    }

    internal fun timingSamples(): Map<String, LongArray> = mapOf(
        "mainRequestNs" to mainRequestNs.snapshot(),
        "mainBeginNs" to mainBeginNs.snapshot(),
        "mainPreDrawNs" to mainPreDrawNs.snapshot(),
        "mainInvalidationNs" to mainInvalidationNs.snapshot(),
        "mainCommitNs" to mainCommitNs.snapshot(),
        "mainCopyAdmissionNs" to mainCopyAdmissionNs.snapshot(),
        "frameCommitWaitNs" to frameCommitWaitNs.snapshot(),
        "copyCallbackLatencyNs" to copyCallbackLatencyNs.snapshot(),
        "copyMainDispatchNs" to copyMainDispatchNs.snapshot(),
    )

    companion object {
        /** Activity supplier should hold only a weak reference. API <29 never creates a worker. */
        fun forActivity(activity: () -> Activity?): PixelCopyVideoCapture? {
            if (Build.VERSION.SDK_INT < 29) return null
            return PixelCopyVideoCapture(AndroidVideoCapturePlatform(activity), AndroidVideoCaptureScheduler)
        }
    }
}

/** Exactly one lazy process-lifetime callback/allocation worker, also when a callback never returns. */
internal object AndroidVideoCaptureScheduler : VideoCaptureScheduler {
    val mainHandler = Handler(Looper.getMainLooper())
    val workerHandler by lazy { Handler(HandlerThread("TraceItXVideoCapture").apply { start() }.looper) }
    // Only native copy admission bypasses display barriers; setup, ticks and timers stay synchronous.
    private val copyCompletionHandler by lazy {
        if (Build.VERSION.SDK_INT >= 28) Handler.createAsync(Looper.getMainLooper()) else mainHandler
    }
    override fun copyCompletion(block: () -> Unit) { copyCompletionHandler.post(block) }
    override fun main(block: () -> Unit) { mainHandler.post(block) }
    override fun worker(block: () -> Unit) { workerHandler.post(block) }
    override fun later(delayMs: Long, block: () -> Unit): () -> Unit {
        val task = Runnable(block); mainHandler.postDelayed(task, delayMs)
        return { mainHandler.removeCallbacks(task) }
    }
    override fun isWorkerThread() = Looper.myLooper() == workerHandler.looper
    override fun nowNanos() = SystemClock.elapsedRealtimeNanos()
}

internal class AndroidVideoCapturePlatform(
    private val activity: () -> Activity?,
    private val privacy: VideoPrivacyGate = VideoPrivacyGate(activity),
    private val registerCommit: (View, Runnable) -> (() -> Unit) = { root, callback ->
        check(root.isHardwareAccelerated)
        val observer = root.viewTreeObserver
        observer.registerFrameCommitCallback(callback);
        { if (observer.isAlive) observer.unregisterFrameCommitCallback(callback); Unit }
    },
) : VideoCapturePlatform {
    private var rootRef = WeakReference<View>(null)
    private var awaitingPrimaryTraversal = false
    override fun observe(): PrivacyObservation {
        check(Looper.myLooper() == Looper.getMainLooper())
        val root = activity()?.window?.decorView
            ?: return PrivacyObservation(null, 0, 0, Long.MIN_VALUE, false)
        rootRef = WeakReference(root)
        return privacy.observe(root)
    }
    override fun watch(onPreDraw: () -> Unit, onExtraCommit: () -> Unit): () -> Unit {
        val root = rootRef.get() ?: error("Detached root")
        val observer = root.viewTreeObserver
        var watching = true
        val preDraw = ViewTreeObserver.OnPreDrawListener {
            onPreDraw()
            if (watching) {
                if (awaitingPrimaryTraversal) {
                    awaitingPrimaryTraversal = false
                } else {
                    // A later traversal may precede delivery of the primary commit callback.
                    // Conservatively reject immediately; no asynchronous guard can be missed.
                    onExtraCommit()
                }
            }
            true
        }
        val attach = object : View.OnAttachStateChangeListener {
            override fun onViewAttachedToWindow(v: View) = Unit
            override fun onViewDetachedFromWindow(v: View) { onExtraCommit() }
        }
        val focus = ViewTreeObserver.OnWindowFocusChangeListener { focused -> if (!focused) onExtraCommit() }
        observer.addOnPreDrawListener(preDraw); observer.addOnWindowFocusChangeListener(focus)
        root.addOnAttachStateChangeListener(attach)
        val weak = WeakReference(root)
        return {
            watching = false
            if (observer.isAlive) {
                observer.removeOnPreDrawListener(preDraw); observer.removeOnWindowFocusChangeListener(focus)
            }
            weak.get()?.removeOnAttachStateChangeListener(attach)
        }
    }
    override fun commit(callback: () -> Unit): () -> Unit {
        val root = rootRef.get() ?: error("Detached root")
        awaitingPrimaryTraversal = true
        val runnable = Runnable { callback() }
        val unregister = registerCommit(root, runnable)
        root.invalidate()
        return { awaitingPrimaryTraversal = false; unregister() }
    }
    override fun copy(bitmap: Bitmap, callback: (Boolean) -> Unit) {
        val window = activity()?.window ?: error("Missing window")
        PixelCopy.request(window, bitmap, { callback(it == PixelCopy.SUCCESS) }, AndroidVideoCaptureScheduler.workerHandler)
    }
}
