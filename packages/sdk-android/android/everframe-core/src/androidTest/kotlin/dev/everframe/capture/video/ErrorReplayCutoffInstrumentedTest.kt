// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture.video

import android.graphics.Bitmap
import android.graphics.Color
import android.media.MediaMetadataRetriever
import android.os.SystemClock
import androidx.test.platform.app.InstrumentationRegistry
import dev.everframe.Everframe
import dev.everframe.capture.replay.ReplaySession
import dev.everframe.config.*
import dev.everframe.crash.CrashReporter
import dev.everframe.shared.SharedData
import java.io.File
import java.util.UUID
import java.util.concurrent.*
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Test

/** Real codec, muxer and decoded colors; only task entry and frame source are controlled. */
class ErrorReplayCutoffInstrumentedTest {
    @Test fun sdkErrorBoundaryExcludesBlueFrameRecordedBeforeDelayedSnapshotEntry() = runBlocking {
        val f = Fixture()
        try {
            f.start()
            f.frame(Color.RED); Thread.sleep(200); f.frame(Color.RED)
            val queued = LinkedBlockingQueue<Runnable>()
            f.session.errorReplayScope = CoroutineScope(SupervisorJob() + object : CoroutineDispatcher() {
                override fun dispatch(context: CoroutineContext, block: Runnable) { queued.add(block) }
            })
            var claim: ErrorReplaySnapshot? = null
            CrashReporter.errorReplaySource = { epoch -> f.session.beginErrorReplay(epoch).also { claim = it } }
            val before = SystemClock.elapsedRealtimeNanos()
            assertTrue(CrashReporter.captureHandledThrowable(IllegalStateException("cutoff-fixture")))
            val after = SystemClock.elapsedRealtimeNanos()
            assertNotNull(claim)
            Thread.sleep(200); f.frame(Color.BLUE)
            val work = checkNotNull(queued.poll(2, TimeUnit.SECONDS))
            // Subsequent resumptions use IO; only initial entry was suspended.
            f.session.errorReplayScope = ErrorReplayWork.scope
            val runner = Executors.newSingleThreadExecutor()
            runner.submit(work)
            val pumping = launch(Dispatchers.IO) {
                while (isActive) { queued.poll(20, TimeUnit.MILLISECONDS)?.run() }
            }
            val pair = checkNotNull(claim!!.await())
            pumping.cancelAndJoin(); runner.shutdown()
            val errorFile = File(f.root, "error.mp4").apply { writeBytes(pair.part.data) }
            val errorEnd = pair.envelope.replayStartEpochMS!! + pair.envelope.durationMS!!
            val expectedLow = f.anchor.wallEpochMs + f.anchor.ptsUs(before) / 1000.0
            val expectedHigh = f.anchor.wallEpochMs + f.anchor.ptsUs(after) / 1000.0
            assertTrue("capture endpoint $errorEnd outside $expectedLow..$expectedHigh", errorEnd >= expectedLow - 3 && errorEnd <= expectedHigh + 3)
            assertEquals(listOf(false, false), colors(errorFile))
            val report = checkNotNull(f.recorder.freeze(f.recorder.owner)())
            assertEquals(listOf(false, false, true), colors(report.file))
            report.close(); errorFile.delete(); Unit
        } finally { f.close() }
    }

    @Test fun newFramesContinueDuringRealRemuxAndAttachmentReads() = runBlocking {
        for (duringBuild in listOf(false, true)) {
            val f = Fixture()
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            try {
                f.blockExport = !duringBuild
                f.exportGate = { entered.countDown(); check(release.await(3, TimeUnit.SECONDS)) }
                f.start(); f.frame(Color.RED); Thread.sleep(100); f.frame(Color.RED)
                val pending = async(Dispatchers.IO) {
                    f.recorder.snapshot(f.recorder.owner, f.recorder.captureCutoffNanos()) { clip ->
                        NativeVideoAttachment(AndroidVideoExportScheduler, openInput = { file ->
                            if (duringBuild) { entered.countDown(); check(release.await(3, TimeUnit.SECONDS)) }
                            file.inputStream()
                        }).build(clip)
                    }
                }
                assertTrue(entered.await(2, TimeUnit.SECONDS))
                f.awaitEncoder(2)
                f.frame(Color.BLUE)
                release.countDown()
                val pair = checkNotNull(pending.await())
                val errorFile = File(f.root, "error.mp4").apply { writeBytes(pair.part.data) }
                assertEquals(listOf(false, false), colors(errorFile))
                val report = checkNotNull(f.recorder.freeze(f.recorder.owner)())
                assertEquals(listOf(false, false, true), colors(report.file))
                report.close(); errorFile.delete()
            } finally { release.countDown(); f.close() }
        }
    }

    private class Fixture : AutoCloseable {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.noBackupFilesDir, "cutoff-${UUID.randomUUID()}").apply { mkdirs() }
        val encoder = AtomicReference<H264VideoEncoder>()
        val count = java.util.concurrent.atomic.AtomicInteger()
        lateinit var recorder: NativeVideoRecorder
        lateinit var anchor: VideoTimeAnchor
        var blockExport = false
        var exportGate: () -> Unit = {}
        val session: ReplaySession
        init {
            SharedData.init(context); CrashReporter.__resetForTesting(); CrashReporter.configure(context)
            Everframe.captureGate = true
            Everframe.__setConfigForTesting(EverframeConfig(appId = "cutoff", sdkKey = "cutoff-test"))
            session = ReplaySession(sdkKey = "cutoff-test", context = context,
                provider = ReplayConfigProvider.make("https://example.invalid", "cutoff-test", ConfigFetcher { request ->
                    okhttp3.Response.Builder().request(request).protocol(okhttp3.Protocol.HTTP_1_1).code(200).message("fixture")
                        .body("""{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1,"nativeVideo":{"framesPerSecond":5}}""".toResponseBody("application/json".toMediaType())).build()
                }))
            session.videoDeviceConditions = object : VideoDeviceConditions { override fun pauseRecording() = false; override val lowRamDevice = false }
            session.videoStartupAdmission = VideoStartupAdmission(AndroidVideoCaptureScheduler) { _, _ -> true }
            session.recorderFactory = { _, owner, _ ->
                recorder = NativeVideoRecorder(owner, AndroidVideoCaptureScheduler, VideoRecorderControl::submit,
                    { VideoSize(64, 64) }, { null }, { who, time, retention ->
                        anchor = time
                        val native = H264VideoEncoder(who, root, retention, timeAnchor = time,
                            storeFactory = { clock, privacy -> VideoSegmentStore(root, who, retention, clock, privacy,
                                recordingAdmission = recorder::admitRing, storageObserver = recorder::observeRing) })
                        object : RecordingVideoEncoder {
                            override fun prepare(size: VideoSize, fps: Int): VideoSize? = native.prepare(size, fps).also {
                                if (it != null) { encoder.set(native); count.incrementAndGet() }
                            }
                            override fun offer(frame: SafeVideoFrame) = native.offer(frame)
                            override fun finish(deadline: Long) = native.finish(deadline)
                            override val isTerminal get() = native.isTerminal
                            override fun close() = native.close()
                        }
                    }, { segments, allowed -> VideoExporter(root).export(owner, segments, allowed) },
                    snapshotExporter = { segments, allowed ->
                        val media = object : VideoExportMedia {
                            override fun remux(inputs: List<VideoSegment>, target: File, check: () -> Unit): VideoMediaInfo {
                                if (blockExport) exportGate()
                                return AndroidVideoExportMedia().remux(inputs, target, check)
                            }
                        }
                        VideoExporter(root, media = media).export(owner, segments, allowed)
                    })
                recorder
            }
        }
        suspend fun start() { session.refreshConfigNow(); awaitEncoder(1) }
        fun awaitEncoder(expected: Int) {
            val until = SystemClock.elapsedRealtime() + 2000
            while (count.get() < expected && SystemClock.elapsedRealtime() < until) Thread.sleep(5)
            assertEquals(expected, count.get())
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
        }
        fun frame(color: Int) {
            val time = SystemClock.elapsedRealtimeNanos()
            val done = CountDownLatch(1); val error = AtomicReference<Throwable?>()
            AndroidVideoCaptureScheduler.worker {
                try {
                    val size = VideoSize(64, 64)
                    val bitmap = Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888).apply { eraseColor(color) }
                    val slot = checkNotNull(VideoCaptureLease().tryAcquire(recorder.owner, size))
                    assertTrue(encoder.get().offer(SafeVideoFrame.fromCapture(recorder.owner, 0, time, bitmap, slot, AndroidVideoCaptureScheduler) { true }))
                } catch (t: Throwable) { error.set(t) } finally { done.countDown() }
            }
            assertTrue("frame acquisition blocked", done.await(1, TimeUnit.SECONDS)); error.get()?.let { throw it }
        }
        override fun close() {
            session.teardown(); CrashReporter.__resetForTesting(); Everframe.__setConfigForTesting(null); Everframe.captureGate = false
            val done = CountDownLatch(1); AndroidVideoCaptureScheduler.worker { done.countDown() }; done.await(3, TimeUnit.SECONDS)
            root.deleteRecursively()
        }
    }

    private fun colors(file: File): List<Boolean> {
        val extractor = android.media.MediaExtractor()
        val retriever = MediaMetadataRetriever()
        try {
            extractor.setDataSource(file.absolutePath); extractor.selectTrack(0)
            retriever.setDataSource(file.absolutePath)
            val result = mutableListOf<Boolean>()
            do {
                val frame = checkNotNull(retriever.getFrameAtTime(extractor.sampleTime, MediaMetadataRetriever.OPTION_CLOSEST))
                val pixel = frame.getPixel(32, 32); result += Color.blue(pixel) > Color.red(pixel); frame.recycle()
            } while (extractor.advance())
            return result
        } finally { extractor.release(); retriever.release() }
    }
}
