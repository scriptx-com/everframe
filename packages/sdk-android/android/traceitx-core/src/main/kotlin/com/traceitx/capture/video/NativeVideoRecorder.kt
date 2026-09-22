// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.capture.video

import android.app.Activity
import android.content.Context
import android.os.Build
import android.os.PowerManager
import com.traceitx.config.NativeVideoSettings
import kotlinx.serialization.json.*
import kotlinx.coroutines.CompletableDeferred
import java.io.File
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

internal interface RecordingVideoEncoder : AutoCloseable {
    fun prepare(size: VideoSize, fps: Int): VideoSize?
    fun offer(frame: SafeVideoFrame): Boolean
    fun finish(deadline: Long): List<VideoSegment>
    val isTerminal: Boolean
}

/** One bounded process control lane. Vendor work itself always uses the existing capture worker. */
internal object VideoRecorderControl {
    private val executor = ThreadPoolExecutor(1, 1, 30, TimeUnit.SECONDS, ArrayBlockingQueue(8),
        { task -> Thread(task, "TraceItXVideoControl").apply { isDaemon = true } }).apply { allowCoreThreadTimeOut(true) }
    fun submit(block: () -> Unit): Boolean = try { executor.execute(block); true } catch (_: java.util.concurrent.RejectedExecutionException) { false }
}

internal class NativeVideoRecorder(
    val owner: VideoOwner,
    private val scheduler: VideoCaptureScheduler,
    private val control: (() -> Unit) -> Boolean,
    private val dimensions: () -> VideoSize?,
    private val captureFactory: () -> PixelCopyVideoCapture?,
    private val encoderFactory: (VideoOwner, VideoTimeAnchor, Long) -> RecordingVideoEncoder,
    private val exporter: suspend (List<VideoSegment>, () -> Boolean) -> OwnedVideoClip?,
) : AutoCloseable {
    enum class State { DISABLED, BUFFERING, SUSPENDED, FROZEN, CLOSED }
    private val lock = Any()
    @Volatile var state = State.DISABLED; private set
    @Volatile private var revoked = false
    val replayAllowed: Boolean get() = !revoked && state != State.DISABLED && state != State.CLOSED
    private var generation = 0L
    private var settings: NativeVideoSettings? = null
    private var durationUs = 0L
    private var anchor: VideoTimeAnchor? = null
    // Owner-local, immutable after freeze; worker disposal must not age evidence while the form is open.
    @Volatile private var frozenAtNanos: Long? = null
    @Volatile private var capture: PixelCopyVideoCapture? = null
    private var encoder: RecordingVideoEncoder? = null
    private var size: VideoSize? = null
    private var requestedSize: VideoSize? = null
    private var preparing = false
    private var manuallyPaused = false
    private var cancelTick: (() -> Unit)? = null
    private var exported = false
    private val lease = VideoDirectoryLeases.acquire()
    private var leaseReleased = false
    private var releaseRequested = false
    private var controlTasks = 0
    private var ownershipTasks = 0
    // History is accessed only on the one capture worker, including replacement admission.
    private val history = ArrayDeque<VideoSegment>()
    val timings = VideoEncoderTimings()
    val retainedPhysicalBytes = AtomicLong()
    val retainedPhysicalFiles = AtomicLong()
    val privacyExclusions: Long get() = capture?.privacyExclusions?.get() ?: 0
    val attempts = AtomicLong()
    val acceptedFrames = AtomicLong()
    val acquisitionDrops = AtomicLong()
    val mainTickNs = VideoEncoderTimings.Counter()
    val mainEnvironmentNs = VideoEncoderTimings.Counter()
    val finalizationNs = VideoEncoderTimings.Counter()

    fun start(settings: NativeVideoSettings, durationSec: Int) {
        synchronized(lock) {
            if (state != State.DISABLED || revoked || settings.framesPerSecond !in listOf(5, 10) || durationSec <= 0) return
            this.settings = settings; durationUs = minOf(durationSec, 60) * 1_000_000L
            anchor = VideoTimeAnchor(System.currentTimeMillis(), scheduler.nowNanos())
            state = State.BUFFERING
        }
        tick()
    }
    fun pause() {
        synchronized(lock) { manuallyPaused = true; if (state != State.BUFFERING) return; state = State.SUSPENDED; generation++ }
        cancelTick?.invoke(); capture?.cancel()
    }
    fun resume() {
        synchronized(lock) { manuallyPaused = false; if (state != State.SUSPENDED || revoked) return; state = State.BUFFERING }
        tick()
    }
    private fun tick() {
        val epoch = synchronized(lock) { if (state != State.BUFFERING || revoked) return; generation }
        scheduler.main main@{
            val began = scheduler.nowNanos()
            try {
                if (!buffering(epoch)) return@main
                val requested = observeDimensions()
                if (requested == null) { suspendForEnvironment(epoch); return@main }
                val existing = synchronized(lock) { encoder }
                if (existing == null || existing.isTerminal || requestedSize != requested) {
                    prepare(epoch, requested); return@main
                }
                if (capture == null) capture = captureFactory()
                attempts.incrementAndGet()
                val admitted = capture?.request(owner, size!!) { frame ->
                    if (!buffering(epoch)) frame.close()
                    else if (existing.offer(frame)) acceptedFrames.incrementAndGet()
                    else acquisitionDrops.incrementAndGet()
                } == true
                if (!admitted) acquisitionDrops.incrementAndGet()
                schedule(epoch)
            } finally { mainTickNs.add(scheduler.nowNanos() - began) }
        }
    }
    private fun observeDimensions(): VideoSize? {
        val began = scheduler.nowNanos()
        return try { runCatching { dimensions() }.getOrNull() }
        finally { mainEnvironmentNs.add(scheduler.nowNanos() - began) }
    }

    /** Numeric-only, detached rolling samples. Called on demand, never uploaded. */
    internal fun diagnosticSnapshot(): JsonObject = buildJsonObject {
        put("state", state.ordinal)
        put("attempts", attempts.get())
        put("acceptedFrames", acceptedFrames.get())
        put("acquisitionDrops", acquisitionDrops.get())
        put("privacyExclusions", privacyExclusions)
        put("retainedPhysicalBytes", retainedPhysicalBytes.get())
        put("retainedPhysicalFiles", retainedPhysicalFiles.get())
        val samples = mapOf(
            "mainTickNs" to mainTickNs.snapshot(),
            "mainEnvironmentNs" to mainEnvironmentNs.snapshot(),
            "finalizationNs" to finalizationNs.snapshot(),
            "rgbReadNs" to timings.rgbReadNs.snapshot(),
            "yuvConversionNs" to timings.yuvConversionNs.snapshot(),
            "textureUploadNs" to timings.textureUploadNs.snapshot(),
            "inputSubmissionNs" to timings.inputSubmissionNs.snapshot(),
            "outputDrainNs" to timings.outputDrainNs.snapshot(),
        ) + capture?.timingSamples().orEmpty()
        for ((name, values) in samples) put(name, JsonArray(values.map { JsonPrimitive(it) }))
    }

    private fun suspendForEnvironment(epoch: Long) {
        synchronized(lock) {
            if (!buffering(epoch)) return
            state = State.SUSPENDED; generation++
        }
        acquisitionDrops.incrementAndGet(); capture?.cancel(); watchEnvironment()
    }
    private fun watchEnvironment() {
        synchronized(lock) {
            if (state != State.SUSPENDED || manuallyPaused || revoked) return
            val epoch = generation
            cancelTick = scheduler.later(500) {
                scheduler.main {
                    val active = synchronized(lock) { state == State.SUSPENDED && !manuallyPaused && !revoked && generation == epoch }
                    if (active) {
                        if (observeDimensions() != null) resume() else watchEnvironment()
                    }
                }
            }
        }
    }
    private fun buffering(epoch: Long) = synchronized(lock) { !revoked && generation == epoch && state == State.BUFFERING }
    private fun schedule(epoch: Long) {
        synchronized(lock) {
            if (!buffering(epoch)) return
            cancelTick = scheduler.later(1_000L / settings!!.framesPerSecond) { tick() }
        }
    }
    private fun prepare(epoch: Long, requested: VideoSize) {
        val previous = synchronized(lock) {
            if (!buffering(epoch) || preparing) return
            preparing = true; controlTasks++
            encoder.also { encoder = null }
        }
        capture?.cancel()
        if (!submitControl {
            val retained = try { previous?.finish(scheduler.nowNanos() / 1_000_000 + 3_000).orEmpty() }
                catch (_: Throwable) { previous?.close(); emptyList() }
            ownedWorker { if (replayAllowed) history.addAll(retained) else retained.forEach { it.close() } }
            if (!buffering(epoch)) { synchronized(lock) { preparing = false }; tick(); return@submitControl }
            val next = try { encoderFactory(owner, anchor!!, durationUs) } catch (_: Throwable) {
                synchronized(lock) { preparing = false }
                revoke(); releaseLeaseAfterWorker(); return@submitControl
            }
            val actual = try { next.prepare(requested, settings!!.framesPerSecond) } catch (_: Throwable) { null }
            val installed = synchronized(lock) {
                preparing = false
                if (actual != null && buffering(epoch)) { encoder = next; size = actual; requestedSize = requested; true } else false
            }
            if (!installed) next.close()
            if (installed || !buffering(epoch)) tick() else schedule(epoch)
        }) {
            previous?.close(); synchronized(lock) { preparing = false }; revoke()
        }
    }
    fun freeze(owner: VideoOwner): suspend () -> OwnedVideoClip? {
        require(owner == this.owner)
        synchronized(lock) {
            if (state == State.CLOSED || state == State.DISABLED || state == State.FROZEN) return { null }
            frozenAtNanos = scheduler.nowNanos()
            state = State.FROZEN; generation++
        }
        cancelTick?.invoke(); capture?.cancel()
        return { exportFrozen() }
    }
    private fun retentionTimeNanos(): Long = frozenAtNanos ?: scheduler.nowNanos()

    private suspend fun exportFrozen(): OwnedVideoClip? {
        val current = synchronized(lock) {
            if (exported || !replayAllowed || state != State.FROZEN) return null
            exported = true; controlTasks++; encoder.also { encoder = null }
        }
        val finished = CompletableDeferred<List<VideoSegment>>()
        val began = System.nanoTime()
        if (!submitControl {
            val segments = try { current?.finish(scheduler.nowNanos() / 1_000_000 + 3_000).orEmpty() }
                catch (_: Throwable) { current?.close(); emptyList() }
            ownedWorker {
                history.addAll(segments)
                trimHistory(anchor!!.ptsUs(retentionTimeNanos()), 0, 0)
                val transferred = history.toList(); history.clear(); observeRing(0, 0)
                finished.complete(transferred)
            }
        }) { current?.close(); revoke(); return null }
        val claimed = java.util.concurrent.atomic.AtomicBoolean()
        try {
            val input = finished.await()
            check(claimed.compareAndSet(false, true))
            if (input.isEmpty()) return null
            return exporter(input) { replayAllowed }
        } finally {
            finalizationNs.add(System.nanoTime() - began)
            // Cancellation before the control task returns must leave it owning exact late output.
            if (!claimed.get()) finished.invokeOnCompletion { ownedWorker {
                if (claimed.compareAndSet(false, true)) {
                    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
                    finished.getCompleted().forEach { it.close() }
                }
            } }
            releaseLeaseAfterWorker()
        }
    }
    /** Worker-only shared admission across closed replacement history and the current ring. */
    internal fun observeRing(bytes: Long, files: Int) {
        retainedPhysicalBytes.set(history.sumOf { it.ownedFile.physicalBytes } + bytes)
        retainedPhysicalFiles.set((history.size + files).toLong())
    }
    internal fun admitRing(now: Long, ringBytes: Long, ringFiles: Int): Boolean {
        trimHistory(now, ringBytes, ringFiles)
        return history.sumOf { it.byteLength } + ringBytes <= VideoSegmentStore.RING_CAP &&
            history.size + ringFiles <= VideoSegmentStore.MAX_FILES
    }
    private fun trimHistory(now: Long, bytes: Long, files: Int) {
        VideoDiskBudget.process.retryCleanup()
        while (history.isNotEmpty() && (now - history.first().firstPtsUs > durationUs ||
                history.sumOf { it.byteLength } + bytes > VideoSegmentStore.RING_CAP || history.size + files > VideoSegmentStore.MAX_FILES)) {
            history.removeFirst().close()
        }
    }
    fun revoke() {
        synchronized(lock) { if (revoked) return; revoked = true; generation++; if (state != State.CLOSED) state = State.DISABLED }
        cancelTick?.invoke(); capture?.invalidateAuthorization(); encoder?.close()
        ownedWorker { history.forEach { it.close() }; history.clear(); observeRing(0, 0); VideoDiskBudget.process.retryCleanup() }
    }
    override fun close() { revoke(); synchronized(lock) { state = State.CLOSED }; releaseLeaseAfterWorker() }
    private fun ownedWorker(block: () -> Unit) {
        synchronized(lock) { ownershipTasks++ }
        scheduler.worker {
            try { block() } finally { synchronized(lock) { ownershipTasks-- }; maybeReleaseLease() }
        }
    }
    private fun submitControl(block: () -> Unit): Boolean {
        val submitted = control {
            try { block() } finally { synchronized(lock) { controlTasks-- }; maybeReleaseLease() }
        }
        if (!submitted) { synchronized(lock) { controlTasks-- }; maybeReleaseLease() }
        return submitted
    }
    private fun releaseLeaseAfterWorker() {
        synchronized(lock) { releaseRequested = true }
        maybeReleaseLease()
    }
    private fun maybeReleaseLease() {
        val release = synchronized(lock) {
            if (!releaseRequested || controlTasks != 0 || ownershipTasks != 0 || leaseReleased) false else { leaseReleased = true; true }
        }
        // Every control task has returned after posting its native work. A stuck native call
        // pins this cleanup behind it on the same worker, with no replacement thread.
        if (release) scheduler.worker { lease.close() }
    }

    companion object {
        fun create(context: Context, owner: VideoOwner, activity: () -> Activity?): NativeVideoRecorder {
            val scheduler = AndroidVideoCaptureScheduler
            lateinit var recorder: NativeVideoRecorder
            recorder = NativeVideoRecorder(owner, scheduler, VideoRecorderControl::submit, {
                val a = activity()
                val root = a?.window?.decorView
                val thermal = if (Build.VERSION.SDK_INT >= 29) (context.getSystemService(Context.POWER_SERVICE) as? PowerManager)?.currentThermalStatus ?: 0 else 0
                if (Build.VERSION.SDK_INT < 29 || root == null || !root.hasWindowFocus() || thermal >= PowerManager.THERMAL_STATUS_SEVERE) null
                else {
                    val scale = minOf(1.0, 854.0 / maxOf(root.width, root.height).coerceAtLeast(1))
                    val width = (root.width * scale).toInt() / 2 * 2
                    val height = (root.height * scale).toInt() / 2 * 2
                    if (width < 2 || height < 2) null else VideoSize(width, height)
                }
            }, { PixelCopyVideoCapture.forActivity(activity) }, { who, anchor, retention ->
                val directory = File(File(File(context.noBackupFilesDir, "traceitx-video"), owner.sessionId), owner.captureId)
                val encoder = H264VideoEncoder(who, directory, retention, timeAnchor = anchor, timings = recorder.timings,
                    retentionTimeNanos = recorder::retentionTimeNanos,
                    storeFactory = { time, privacy -> VideoSegmentStore(directory, who, retention, time, privacy,
                        recordingAdmission = recorder::admitRing, storageObserver = recorder::observeRing) })
                object : RecordingVideoEncoder {
                    override fun prepare(size: VideoSize, fps: Int) = encoder.prepare(size, fps)
                    override fun offer(frame: SafeVideoFrame) = encoder.offer(frame)
                    override fun finish(deadline: Long) = encoder.finish(deadline)
                    override val isTerminal get() = encoder.isTerminal
                    override fun close() = encoder.close()
                }
            }, { segments, allowed -> VideoExporter(context).export(owner, segments, allowed) })
            return recorder
        }
    }
}
