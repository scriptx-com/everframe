// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import android.graphics.Bitmap
import android.graphics.Color
import android.media.MediaExtractor
import android.os.SystemClock
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.*
import org.junit.Test

/** The vendor encoder at the new lowest rate (spec 2026-10-11). Synthetic pixels only. */
class LowFrameRateEncoderInstrumentedTest {
    @Test fun oneFramePerSecondKeepsTheEncoderAliveAndRotatesSyncSegments() {
        val context = InstrumentationRegistry.getInstrumentation().context
        val owner = VideoOwner(UUID.randomUUID().toString(), UUID.randomUUID().toString())
        val directory = File(File(File(context.noBackupFilesDir, "everframe-video"), owner.sessionId), owner.captureId)
        val lease = VideoDirectoryLeases.acquire()
        val encoder = H264VideoEncoder(owner, directory, 30_000_000)
        try {
            val size = checkNotNull(encoder.prepare(VideoSize(384, 852), 1)) { "No baseline AVC encoder accepts 1 fps" }
            repeat(9) { index ->
                if (index > 0) Thread.sleep(1_000)
                val time = SystemClock.elapsedRealtimeNanos()
                onWorker {
                    val bitmap = Bitmap.createBitmap(size.width, size.height, Bitmap.Config.ARGB_8888)
                    bitmap.eraseColor(if (index % 2 == 0) Color.RED else Color.BLUE)
                    val slot = checkNotNull(VideoCaptureLease().tryAcquire(owner, size))
                    assertTrue("frame $index", encoder.offer(SafeVideoFrame.fromCapture(owner, 0, time, bitmap, slot, AndroidVideoCaptureScheduler) { true }))
                }
                assertFalse("the no-progress watchdog must tolerate a 1 s frame interval", encoder.isTerminal)
            }
            val segments = encoder.finish(SystemClock.elapsedRealtime() + 3_000)
            assertTrue("8 s at 1 fps closes at least three GOPs, got ${segments.size}", segments.size >= 3)
            for (segment in segments) {
                val extractor = MediaExtractor()
                try {
                    extractor.setDataSource(segment.path.absolutePath); extractor.selectTrack(0)
                    assertTrue("each segment opens on a sync frame", extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0)
                } finally { extractor.release() }
            }
            onWorker { segments.forEach { it.close() } }
        } finally { encoder.close(); lease.close() }
    }

    private fun onWorker(block: () -> Unit) {
        val latch = CountDownLatch(1); val error = AtomicReference<Throwable?>()
        AndroidVideoCaptureScheduler.worker { try { block() } catch (t: Throwable) { error.set(t) } finally { latch.countDown() } }
        assertTrue("Capture worker did not return", latch.await(3, TimeUnit.SECONDS))
        error.get()?.let { throw it }
    }
}
