// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.capture.video

import android.graphics.Bitmap
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], manifest = Config.NONE)
class PixelCopyVideoCaptureTest {
    private class Harness(val separateCompletions: Boolean = false) {
        val completions = ArrayDeque<() -> Unit>()
        val main = ArrayDeque<() -> Unit>()
        val work = ArrayDeque<() -> Unit>()
        val timers = mutableListOf<() -> Unit>()
        var worker = false
        var now = 123L
        var observeCost = 0L
        var allocations = 0
        var bitmap: Bitmap? = null
        var accepted = 0
        var observationThrows = false
        var observation = PrivacyObservation(Any(), 100, 100, 0, true)
        var preDraw: (() -> Unit)? = null
        var extraCommit: (() -> Unit)? = null
        val commits = mutableListOf<() -> Unit>()
        val copies = mutableListOf<(Boolean) -> Unit>()
        val scheduler = object : VideoCaptureScheduler {
            override fun main(block: () -> Unit) { main.add(block) }
            override fun copyCompletion(block: () -> Unit) {
                if (separateCompletions) completions.add(block) else main(block)
            }
            override fun worker(block: () -> Unit) { work.add(block) }
            override fun later(delayMs: Long, block: () -> Unit): () -> Unit {
                timers.add(block); return { timers.remove(block) }
            }
            override fun isWorkerThread() = worker
            override fun nowNanos() = now
        }
        var platform: VideoCapturePlatform = object : VideoCapturePlatform {
            override fun observe(): PrivacyObservation { now += observeCost; check(!observationThrows); return observation }
            override fun watch(onPreDraw: () -> Unit, onExtraCommit: () -> Unit): () -> Unit {
                preDraw = onPreDraw; extraCommit = onExtraCommit
                return { preDraw = null; extraCommit = null }
            }
            override fun commit(callback: () -> Unit): () -> Unit {
                commits.add(callback); return { commits.remove(callback) }
            }
            override fun copy(bitmap: Bitmap, callback: (Boolean) -> Unit) { copies.add(callback) }
        }
        fun create() = PixelCopyVideoCapture(platform, scheduler, { size ->
            assertTrue("allocation on worker", worker)
            allocations++; Bitmap.createBitmap(size.width, size.height, Bitmap.Config.ARGB_8888).also { bitmap = it }
        })
        var capture = create()
        fun drain() {
            while (main.isNotEmpty() || work.isNotEmpty() || completions.isNotEmpty()) {
                while (completions.isNotEmpty()) completions.removeFirst()()
                while (main.isNotEmpty()) main.removeFirst()()
                worker = true
                while (work.isNotEmpty()) work.removeFirst()()
                worker = false
            }
        }
        fun request(id: String = "A", consume: (SafeVideoFrame) -> Unit = { accepted++; it.close() }): Boolean {
            val result = capture.request(VideoOwner("session", id), VideoSize(100,100), consume)
            drain(); return result
        }
        fun commit() { commits.removeAt(0)(); drain() }
        fun callback() { copies.removeAt(0)(true); drain() }
        fun timeout() { timers.toList().forEach { it() }; drain() }
        fun observe(allowed: Boolean) { observation = observation.copy(epoch = observation.epoch + 1, allowed = allowed); preDraw?.invoke() }
    }
    @Test fun completionOvertakingCancellationCleanupCannotReviveOrReusePendingNativeBuffer() {
        for (disable in listOf(false, true)) {
            val h = Harness(separateCompletions = true); h.request(); h.commit()
            if (disable) h.capture.invalidateAuthorization() else h.capture.cancel()
            assertFalse(h.bitmap!!.isRecycled)
            val replacement = h.create()
            assertFalse(replacement.request(VideoOwner("s", "replacement"), VideoSize(100, 100)) { it.close() })
            h.copies.removeAt(0)(true)
            h.completions.removeFirst()() // Overtakes the queued synchronous discard.
            assertFalse(h.bitmap!!.isRecycled)
            h.drain()
            assertEquals(0, h.accepted); assertTrue(h.bitmap!!.isRecycled)
            h.capture = replacement
            assertTrue(h.request("next")); h.capture.cancel(); h.drain()
        }
    }
    @Test fun extraTraversalBeforeCompletionRejectsButTraversalAfterAdmissionHasNoWatcher() {
        for (traversalFirst in listOf(true, false)) {
            val h = Harness(separateCompletions = true); h.request(); h.commit()
            if (traversalFirst) {
                h.extraCommit!!.invoke()
                assertFalse(h.bitmap!!.isRecycled)
                assertFalse(h.request("still-pinned"))
            }
            h.copies.removeAt(0)(true); h.completions.removeFirst()()
            assertNull(h.extraCommit)
            h.drain()
            assertEquals(if (traversalFirst) 0 else 1, h.accepted)
            assertTrue(h.bitmap!!.isRecycled)
        }
    }
    @Test fun issuedPrivacyRevocationOvertakesCleanupAndStillRejectsCompletion() {
        val h = Harness(separateCompletions = true); h.request(); h.commit()
        val token = com.traceitx.TraceItX.__beginSensitiveRegistration()
        try {
            h.scheduler.main { h.capture.cancel() } // Revocation has already happened; cleanup has not.
            h.copies.removeAt(0)(true); h.completions.removeFirst()()
            assertEquals("issued revocation rejects before ordinary cleanup runs", 1L, h.capture.privacyExclusions.get())
            h.drain()
            assertEquals(0, h.accepted); assertTrue(h.bitmap!!.isRecycled)
        } finally { token.close() }
    }
    @Test fun cancellationAfterMainAdmissionStillRejectsBeforeWorkerTransfer() {
        val h = Harness(separateCompletions = true); h.request(); h.commit()
        h.copies.removeAt(0)(true); h.completions.removeFirst()()
        h.capture.cancel(); h.drain()
        assertEquals(0, h.accepted); assertTrue(h.bitmap!!.isRecycled)
    }
    @Test fun timeoutExecutionDeterminesAdmissionRegardlessOfCompletionQueuePriority() {
        for (timeoutFirst in listOf(true, false)) {
            val h = Harness(separateCompletions = true); h.request(); h.commit()
            if (timeoutFirst) {
                h.timeout()
                assertFalse(h.bitmap!!.isRecycled)
                assertFalse(h.request("still-pinned"))
            }
            h.copies.removeAt(0)(true); h.completions.removeFirst()()
            assertTrue("completion removes pending timeout", h.timers.isEmpty())
            h.timeout()
            assertEquals(if (timeoutFirst) 0 else 1, h.accepted)
            assertTrue(h.bitmap!!.isRecycled)
        }
    }
    private fun samples(capture: PixelCopyVideoCapture, phase: String): LongArray {
        return requireNotNull(capture.timingSamples()[phase]) { "Missing measured phase $phase" }
    }
    @Test fun warmRealGateRejectsLateMarkerAtEveryFrameBoundary() {
        for (boundary in listOf("preDraw", "commit", "copyCallback")) {
            val controller = org.robolectric.Robolectric.buildActivity(android.app.Activity::class.java).setup()
            val activity = controller.get()
            val root = android.widget.FrameLayout(activity)
            activity.setContentView(root); root.layout(0,0,100,100)
            val child = android.view.View(activity); root.addView(child)
            val gate = VideoPrivacyGate({ activity }, { 0L }, { true })
            val h = Harness()
            h.platform = object : VideoCapturePlatform by h.platform {
                override fun observe() = gate.observe(root)
            }
            h.capture = h.create()
            try {
                assertTrue(gate.observe(root).allowed)
                assertTrue(h.request()) // Admission reuses warm types.
                if (boundary == "copyCallback") h.commit()
                child.setTag(com.traceitx.R.id.tx_sensitive, true)
                if (boundary == "preDraw") { h.preDraw!!.invoke(); h.drain() }
                if (boundary == "commit") h.commit()
                if (boundary == "copyCallback") h.callback()
                assertEquals("late marker at $boundary", 0, h.accepted)
                assertTrue("unsafe pixels released at $boundary", h.bitmap!!.isRecycled)
                assertTrue(h.copies.isEmpty())
            } finally {
                h.capture.cancel(); h.drain()
                if (h.copies.isNotEmpty()) h.callback()
                controller.pause().stop().destroy()
            }
        }
    }

    @Test fun mainPrivacyPhasesExcludeAsyncCommitAndCopyWaits() {
        val h = Harness(); h.observeCost = 7
        try {
            h.request()
            assertArrayEquals(longArrayOf(14), samples(h.capture, "mainBeginNs"))
            h.now += 1000
            h.preDraw!!.invoke()
            assertArrayEquals(longArrayOf(7), samples(h.capture, "mainPreDrawNs"))
            h.now += 2000
            h.commit()
            assertArrayEquals(longArrayOf(3007), samples(h.capture, "frameCommitWaitNs"))
            assertArrayEquals(longArrayOf(7), samples(h.capture, "mainCommitNs"))
            h.now += 5000
            h.copies.removeAt(0)(true)
            h.now += 9000 // Main dispatch backlog is not native copy latency.
            h.drain()
            assertArrayEquals(longArrayOf(5000), samples(h.capture, "copyCallbackLatencyNs"))
            assertArrayEquals(longArrayOf(9000), samples(h.capture, "copyMainDispatchNs"))
            assertArrayEquals(longArrayOf(7), samples(h.capture, "mainCopyAdmissionNs"))
            assertEquals(1, h.accepted)
        } finally { h.capture.cancel(); h.drain() }
    }
    @Test fun deniedPrivacyStillMeasuresMainAdmissionAndReleasesLease() {
        val h = Harness(); h.observeCost = 11; h.observationThrows = true
        try {
            h.request()
            assertArrayEquals(longArrayOf(11), samples(h.capture, "mainBeginNs"))
            assertEquals(0, h.accepted); assertTrue(h.bitmap!!.isRecycled)
        } finally { h.capture.cancel(); h.drain() }
    }
    @Test fun diagnosticsCountPrivacyExclusionOnceAndSeparateTimeout() {
        val h = Harness(); h.observation = h.observation.copy(allowed = false)
        h.request(); assertEquals(1, h.capture.privacyExclusions.get())
        h.observation = h.observation.copy(allowed = true)
        h.request(); h.timeout(); assertEquals(1, h.capture.privacyExclusions.get())
    }
    @Test fun sensitiveRegistrationDuringCopyAndAfterTransferRevokesPixels() {
        val h = Harness(); h.request(); h.commit()
        com.traceitx.TraceItX.__beginSensitiveRegistration().close()
        h.callback(); assertEquals(0, h.accepted)
        h.request { frame ->
            val token = com.traceitx.TraceItX.__beginSensitiveRegistration()
            try { assertFalse(frame.isAuthorized()) } finally { token.close(); frame.close() }
        }
        h.commit(); h.callback()
    }
    @Test fun missingCallbackCannotAllocateAgainAfterRestart() {
        val h = Harness(); assertTrue(h.request()); h.commit(); h.timeout()
        repeat(100) { h.capture.cancel(); h.capture = h.create(); assertFalse(h.request("B$it")) }
        assertEquals(1, h.allocations); assertEquals(0,h.accepted)
        h.callback(); assertTrue(h.bitmap!!.isRecycled)
        assertTrue(h.request("last")); h.capture.cancel(); h.drain()
    }
    @Test fun sensitiveAppearanceAndRemovalWhileCopyPendingRejectsFrame() {
        val h = Harness(); h.request(); h.commit(); h.observe(false); h.observe(true); h.callback()
        assertEquals(0,h.accepted); assertTrue(h.bitmap!!.isRecycled)
    }
    @Test fun commitTimeoutUnregistersAndReleasesWithoutCopy() {
        val h = Harness(); h.request(); h.timeout()
        assertTrue(h.commits.isEmpty()); assertTrue(h.bitmap!!.isRecycled); assertTrue(h.copies.isEmpty())
        assertTrue(h.request()); h.capture.cancel(); h.drain()
    }
    @Test fun cleanFrameIsWorkerOwnedAndClosedExactlyOnce() {
        val h = Harness(); h.request { frame ->
            assertTrue(h.worker); assertEquals(123L, frame.captureTimeNanos)
            assertTrue(frame.withPixels { assertFalse(it.isRecycled); h.accepted++ })
            frame.close(); frame.close()
        }; h.commit(); h.callback()
        assertEquals(1,h.accepted); assertTrue(h.bitmap!!.isRecycled)
    }
    @Test fun authorizationRevocationBetweenMainAndWorkerDropsFrame() {
        val h = Harness(); h.request(); h.commit(); h.copies.removeAt(0)(true)
        while (h.main.isNotEmpty()) h.main.removeFirst()()
        h.capture.invalidateAuthorization(); h.drain()
        assertEquals(0,h.accepted); assertTrue(h.bitmap!!.isRecycled)
    }
    @Test fun unclassifiedCommitDropsPendingCopy() {
        val h = Harness(); h.request(); h.commit(); h.extraCommit!!(); h.callback()
        assertEquals(0,h.accepted)
    }
    @Test fun nativeAdapterRejectsSecondTraversalBeforeDelayedPrimaryDelivery() {
        val controller = org.robolectric.Robolectric.buildActivity(android.app.Activity::class.java).setup()
        val activity = controller.get()
        val root = activity.window.decorView
        root.layout(0,0,100,100)
        val registrations = mutableListOf<Runnable>()
        val gate = VideoPrivacyGate({ activity }, { 0L }, { true })
        val native = AndroidVideoCapturePlatform({ activity }, gate) { _, callback ->
            registrations.add(callback);
            { registrations.remove(callback); Unit }
        }
        val h = Harness()
        h.platform = object : VideoCapturePlatform by native {
            override fun copy(bitmap: Bitmap, callback: (Boolean) -> Unit) { h.copies.add(callback) }
        }
        h.capture = h.create()
        try {
            assertTrue(h.request())
            val delayedPrimary = registrations.single()
            root.viewTreeObserver.dispatchOnPreDraw()
            root.viewTreeObserver.dispatchOnPreDraw()
            delayedPrimary.run(); h.drain()
            assertTrue("second traversal must prevent native copy submission", h.copies.isEmpty())
            assertEquals(0,h.accepted)
            assertTrue(registrations.isEmpty())
        } finally {
            h.capture.cancel(); h.drain()
            if (h.copies.isNotEmpty()) h.callback()
            controller.pause().stop().destroy()
        }
    }
    @Test fun failedObservationAfterCopyReleasesWithoutAdmission() {
        val h = Harness(); h.request(); h.commit(); h.observationThrows = true
        h.callback(); assertEquals(0,h.accepted); assertTrue(h.bitmap!!.isRecycled)
    }
    @Test fun unsafeAtCommitNeverSubmitsBitmap() {
        val h = Harness(); h.request(); h.observation = h.observation.copy(allowed = false)
        h.commit(); assertTrue(h.copies.isEmpty()); assertTrue(h.bitmap!!.isRecycled)
    }
    @Test fun slowWorkerPixelAccessDoesNotBlockRevocationAndRecheckRejects() {
        val h = Harness()
        val entered = java.util.concurrent.CountDownLatch(1)
        val finish = java.util.concurrent.CountDownLatch(1)
        val rejected = java.util.concurrent.atomic.AtomicBoolean(false)
        h.request { frame ->
            frame.withPixels {
                entered.countDown()
                check(finish.await(2, java.util.concurrent.TimeUnit.SECONDS))
                assertFalse(it.isRecycled)
            }
            rejected.set(!frame.isAuthorized())
            frame.close()
        }
        h.commit(); h.copies.removeAt(0)(true)
        while (h.main.isNotEmpty()) h.main.removeFirst()()
        val worker = Thread { h.worker = true; h.work.removeFirst()() }
        worker.start()
        assertTrue(entered.await(2, java.util.concurrent.TimeUnit.SECONDS))
        try {
            h.capture.invalidateAuthorization()
            assertFalse(h.bitmap!!.isRecycled)
        } finally { finish.countDown(); worker.join(3000) }
        assertFalse(worker.isAlive); assertTrue(rejected.get()); assertTrue(h.bitmap!!.isRecycled)
    }
    @Test fun staleDuplicateCallbackNeverRecyclesNewOwner() {
        val h = Harness(); h.request(); h.commit()
        val old = h.copies.removeAt(0)
        old(true); h.drain(); assertEquals(1,h.accepted)
        h.request("B"); val next = h.bitmap!!
        old(true); h.drain(); assertFalse(next.isRecycled)
        h.capture.cancel(); h.drain(); assertTrue(next.isRecycled)
    }
    @Test fun cancellationDuringAllocationReleasesOnlyAfterWorkerFinishes() {
        val h = Harness()
        assertTrue(h.capture.request(VideoOwner("s","A"),VideoSize(100,100)) { it.close() })
        h.capture.cancel()
        while (h.main.isNotEmpty()) h.main.removeFirst()()
        assertFalse(h.capture.request(VideoOwner("s","B"),VideoSize(100,100)) { it.close() })
        h.drain(); assertTrue(h.bitmap!!.isRecycled); assertTrue(h.copies.isEmpty())
    }
    @Test fun windowAndGeometryChangesDropPendingCopy() {
        for (changedWindow in listOf(true, false)) {
            val h = Harness(); h.request(); h.commit()
            h.observation = if (changedWindow) h.observation.copy(windowIdentity = Any()) else h.observation.copy(width = 102)
            h.callback(); assertEquals(0,h.accepted)
        }
    }
}
