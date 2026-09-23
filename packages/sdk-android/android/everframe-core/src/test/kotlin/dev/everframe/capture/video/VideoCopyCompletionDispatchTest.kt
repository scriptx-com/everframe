// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import android.graphics.Bitmap
import android.os.Looper
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28, 29], manifest = Config.NONE)
@LooperMode(LooperMode.Mode.PAUSED)
class VideoCopyCompletionDispatchTest {
    private class Harness {
        val work = ArrayDeque<() -> Unit>()
        var onWorker = false
        var accepted = 0
        lateinit var callback: (Boolean) -> Unit
        lateinit var commit: () -> Unit
        lateinit var bitmap: Bitmap
        var observation = PrivacyObservation(Any(), 100, 100, 0, true)
        var observe: () -> PrivacyObservation = { observation }
        val scheduler = object : VideoCaptureScheduler by AndroidVideoCaptureScheduler {
            override fun worker(block: () -> Unit) { work.add(block) }
            override fun isWorkerThread() = onWorker
        }
        val capture = PixelCopyVideoCapture(object : VideoCapturePlatform {
            override fun observe(): PrivacyObservation {
                assertSame(Looper.getMainLooper(), Looper.myLooper())
                return observe.invoke()
            }
            override fun watch(onPreDraw: () -> Unit, onExtraCommit: () -> Unit): () -> Unit = {}
            override fun commit(callback: () -> Unit): () -> Unit { commit = callback; return {} }
            override fun copy(bitmap: Bitmap, callback: (Boolean) -> Unit) { this@Harness.callback = callback }
        }, scheduler, { size ->
            assertTrue(onWorker)
            Bitmap.createBitmap(size.width, size.height, Bitmap.Config.ARGB_8888).also { bitmap = it }
        })
        fun workers() {
            onWorker = true
            try { while (work.isNotEmpty()) work.removeFirst()() } finally { onWorker = false }
        }
        fun start() {
            assertTrue(capture.request(VideoOwner("session", "report"), VideoSize(100, 100)) {
                assertTrue(onWorker); accepted++; it.close()
            })
            workers(); shadowOf(Looper.getMainLooper()).idle(); commit()
        }
        fun close() { capture.cancel(); shadowOf(Looper.getMainLooper()).idle(); workers() }
    }

    // Android's hidden barrier API is isolated to tests; PAUSED Robolectric models queue barriers.
    private fun barrier(block: () -> Unit) {
        val queue = Looper.getMainLooper().queue
        val token = queue.javaClass.getDeclaredMethod("postSyncBarrier").invoke(queue) as Int
        try { block() } finally {
            queue.javaClass.getDeclaredMethod("removeSyncBarrier", Int::class.javaPrimitiveType).invoke(queue, token)
        }
    }

    @Test fun captureCompletionBypassesBarrierWhileOrdinaryMainAndTimerStayBlocked() {
        val h = Harness(); h.start()
        var sentinel = false
        var timer = false
        try {
            barrier {
                AndroidVideoCaptureScheduler.main { sentinel = true }
                AndroidVideoCaptureScheduler.later(0) { timer = true }
                h.callback(true); h.callback(true)
                assertEquals("completion must remain queued even on main", 0, h.accepted)
                shadowOf(Looper.getMainLooper()).idle(); h.workers()
                assertFalse(sentinel); assertFalse(timer)
                assertEquals("actual capture reaches worker exactly once across barrier", 1, h.accepted)
                assertTrue(h.bitmap.isRecycled)
            }
            shadowOf(Looper.getMainLooper()).idle()
            assertTrue(sentinel); assertTrue(timer)
        } finally { h.close() }
    }
    @Test fun asyncCompletionOrderIsQueuedAndStableWithinItsHandler() {
        val seen = mutableListOf<Int>()
        barrier {
            AndroidVideoCaptureScheduler.copyCompletion { seen.add(1) }
            AndroidVideoCaptureScheduler.copyCompletion { seen.add(2) }
            assertTrue(seen.isEmpty())
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(listOf(1, 2), seen)
        }
    }

    @Test fun completionCanCancelDueTimeoutThatHasNotExecutedBehindBarrier() {
        val h = Harness(); h.start()
        try {
            barrier {
                shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(1_001))
                h.callback(true)
                shadowOf(Looper.getMainLooper()).idle(); h.workers()
                assertEquals(1, h.accepted)
            }
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(1, h.accepted)
        } finally { h.close() }
    }

    @Test fun warmPrivacyGateRejectsLateSensitiveMarkerAcrossBarrier() {
        val controller = org.robolectric.Robolectric.buildActivity(android.app.Activity::class.java).setup()
        val activity = controller.get()
        val root = android.widget.FrameLayout(activity)
        activity.setContentView(root); root.layout(0, 0, 100, 100)
        val child = android.view.View(activity); root.addView(child)
        val gate = VideoPrivacyGate({ activity }, { 0L }, { true })
        val h = Harness(); h.observe = { gate.observe(root) }
        try {
            assertTrue(gate.observe(root).allowed); h.start()
            var sentinel = false
            barrier {
                AndroidVideoCaptureScheduler.main { sentinel = true }
                child.setTag(dev.everframe.R.id.tx_sensitive, true)
                h.callback(true); shadowOf(Looper.getMainLooper()).idle(); h.workers()
                assertFalse(sentinel)
                assertEquals(0, h.accepted)
                assertTrue("rejected callback actually drained through the barrier", h.bitmap.isRecycled)
                assertEquals(1L, h.capture.privacyExclusions.get())
            }
        } finally { h.close(); controller.pause().stop().destroy() }
    }

    @Test @Config(sdk = [27]) fun oldApiCompletionFallsBackToQueuedSynchronousDispatchAndTimerCancellation() {
        val seen = mutableListOf<String>()
        barrier {
            AndroidVideoCaptureScheduler.main { seen.add("main") }
            AndroidVideoCaptureScheduler.copyCompletion { seen.add("copy") }
            val cancel = AndroidVideoCaptureScheduler.later(10) { seen.add("cancelled") }
            AndroidVideoCaptureScheduler.later(10) { seen.add("timer") }
            cancel()
            shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(20))
            assertTrue(seen.isEmpty())
        }
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(listOf("main", "copy", "timer"), seen)
    }

    @Test @Config(sdk = [27]) fun oldApiRealRecorderStartupSuspendsWithoutCapture() {
        val context = androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()
        val recorder = NativeVideoRecorder.create(context, VideoOwner("old", "api")) { null }
        try {
            recorder.start(dev.everframe.config.NativeVideoSettings(framesPerSecond = 5), 30)
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(NativeVideoRecorder.State.SUSPENDED, recorder.state)
            assertEquals(0L, recorder.attempts.get())
            assertNull(PixelCopyVideoCapture.forActivity { null })
        } finally {
            recorder.close()
            shadowOf(AndroidVideoCaptureScheduler.workerHandler.looper).idle()
        }
    }

}
