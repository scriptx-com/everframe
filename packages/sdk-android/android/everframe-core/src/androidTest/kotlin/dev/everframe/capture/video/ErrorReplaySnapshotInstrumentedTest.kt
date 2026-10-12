// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import android.graphics.Bitmap
import android.graphics.Color
import android.os.SystemClock
import androidx.test.platform.app.InstrumentationRegistry
import dev.everframe.protocol.generated.AttachmentKind
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

/** What a snapshot leaves behind with the vendor codec (spec 2026-10-11). Synthetic pixels only. */
class ErrorReplaySnapshotInstrumentedTest {
    @Test fun rotatedEncoderKeepsFormatIdentityAndTheBorrowedExportLeavesHistory() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().context
        val owner = VideoOwner(UUID.randomUUID().toString(), UUID.randomUUID().toString())
        val directory = File(File(File(context.noBackupFilesDir, "everframe-video"), owner.sessionId), owner.captureId)
        val lease = VideoDirectoryLeases.acquire()
        val first = H264VideoEncoder(owner, directory, 30_000_000)
        var second: H264VideoEncoder? = null
        try {
            val size = checkNotNull(first.prepare(VideoSize(384, 852), 2))
            feed(first, owner, size, Color.RED)
            val before = first.finish(SystemClock.elapsedRealtime() + 3_000)
            assertTrue(before.isNotEmpty())
            val clip = checkNotNull(VideoExporter(context).exportBorrowed(owner, before) { true })
            assertTrue("the snapshot leaves its inputs in the recorder's history", before.all { it.path.exists() })
            val pair = checkNotNull(NativeVideoAttachment().build(clip))
            assertEquals(AttachmentKind.SessionReplay, pair.envelope.kind)
            val next = H264VideoEncoder(owner, directory, 30_000_000, timeAnchor = first.timeAnchor).also { second = it }
            assertNotNull(next.prepare(size, 2))
            feed(next, owner, size, Color.BLUE)
            val after = next.finish(SystemClock.elapsedRealtime() + 3_000)
            assertTrue(after.isNotEmpty())
            assertEquals("a fresh codec must keep the format identity, or a later export drops pre-snapshot history",
                before.last().format, after.first().format)
            val full = checkNotNull(VideoExporter(context).export(owner, before + after) { true })
            assertTrue(full.metadata.durationMs > pair.envelope.durationMS!!.toLong())
            full.close()
        } finally { first.close(); second?.close(); lease.close() }
    }

    private fun feed(encoder: H264VideoEncoder, owner: VideoOwner, size: VideoSize, color: Int) {
        repeat(8) { index ->
            if (index > 0) Thread.sleep(500)
            val time = SystemClock.elapsedRealtimeNanos()
            onWorker {
                val bitmap = Bitmap.createBitmap(size.width, size.height, Bitmap.Config.ARGB_8888).apply { eraseColor(color) }
                val slot = checkNotNull(VideoCaptureLease().tryAcquire(owner, size))
                assertTrue(encoder.offer(SafeVideoFrame.fromCapture(owner, 0, time, bitmap, slot, AndroidVideoCaptureScheduler) { true }))
            }
        }
    }

    private fun onWorker(block: () -> Unit) {
        val latch = CountDownLatch(1); val error = AtomicReference<Throwable?>()
        AndroidVideoCaptureScheduler.worker { try { block() } catch (t: Throwable) { error.set(t) } finally { latch.countDown() } }
        assertTrue("Capture worker did not return", latch.await(3, TimeUnit.SECONDS))
        error.get()?.let { throw it }
    }
}
