// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class FrozenReportCaptureTest {
    private class Origin(override val sessionId: String = "A") : ReplayCaptureOrigin {
        var allowed = true
        var exports = 0
        var releases = 0
        var cancels = 0
        val entered = CompletableDeferred<Unit>()
        val proceed = CompletableDeferred<Unit>()
        override fun replayAllowed(owner: VideoOwner, generation: Long) = allowed
        override suspend fun export(owner: VideoOwner, generation: Long): OwnedVideoClip? {
            exports++; entered.complete(Unit); proceed.await(); return null
        }
        override fun cancel(owner: VideoOwner) { cancels++ }
        override fun release(owner: VideoOwner) { releases++ }
    }
    private fun capture(origin: Origin) = FrozenReportCapture(VideoOwner(origin.sessionId, "one"), 1, 0, origin,
        FrozenAncillarySnapshot(emptyList(), emptyList()))

    @Test fun independentSelectionsAndFinishReleaseOnlyOnce() {
        val origin = Origin(); val capture = capture(origin)
        assertEquals(emptyList<Any>(), capture.takeBreadcrumbs())
        assertNull(capture.takeBreadcrumbs())
        assertEquals(emptyList<Any>(), capture.takeNetworkBodies())
        capture.finishConsumption(); capture.finishConsumption(); capture.cancel()
        assertEquals(1, origin.releases)
        assertEquals(1, origin.cancels)
        assertFalse(capture.replayAllowed())
    }
    @Test fun cancellationDuringExportIsOwnerBoundAndSingleWinner() = runBlocking {
        val a = Origin(); val b = Origin("B"); val old = capture(a); val replacement = capture(b)
        val export = async { old.exportVideo() }; a.entered.await()
        old.cancel(); old.cancel(); a.proceed.complete(Unit)
        assertNull(export.await()); assertNull(old.exportVideo())
        assertEquals(1, a.exports); assertEquals(1, a.cancels); assertEquals(1, a.releases)
        assertNull(old.takeBreadcrumbs()); assertNotNull(replacement.takeBreadcrumbs())
        assertTrue(replacement.replayAllowed()); assertEquals(0, b.releases)
        replacement.cancel()
    }
    @Test fun revokedReplayNeverRevivesAndAncillarySurvives() {
        val origin = Origin(); val capture = capture(origin)
        origin.allowed = false; assertFalse(capture.replayAllowed())
        origin.allowed = true; assertFalse(capture.replayAllowed())
        assertNotNull(capture.takeBreadcrumbs()); capture.finishConsumption()
    }
    @Test fun cancellationFirstSerializesConsumptionAndCallsOriginExactlyOnce() = terminalRace(cancelFirst = true)
    @Test fun consumptionFirstSerializesCancellationAndCallsOriginExactlyOnce() = terminalRace(cancelFirst = false)

    private fun terminalRace(cancelFirst: Boolean) {
        val origin = Origin(); val capture = capture(origin)
        val firstEntered = java.util.concurrent.CountDownLatch(1)
        val releaseFirst = java.util.concurrent.CountDownLatch(1)
        val secondEntered = java.util.concurrent.CountDownLatch(1)
        val secondFinished = java.util.concurrent.CountDownLatch(1)
        val failures = java.util.concurrent.ConcurrentLinkedQueue<Throwable>()
        val first = Thread {
            try {
                // Hold the real shared transition guard at the first operation's entry.
                // The competing operation must not mutate handle state within this interval.
                dev.everframe.Everframe.withReportAuthorizationLock {
                    firstEntered.countDown()
                    check(releaseFirst.await(2, java.util.concurrent.TimeUnit.SECONDS))
                    if (cancelFirst) capture.cancel() else capture.finishConsumption()
                }
            } catch (failure: Throwable) { failures.add(failure) }
        }.apply { start() }
        var second: Thread? = null
        try {
            assertTrue(firstEntered.await(2, java.util.concurrent.TimeUnit.SECONDS))
            second = Thread {
                try {
                    secondEntered.countDown()
                    if (cancelFirst) capture.finishConsumption() else capture.cancel()
                } catch (failure: Throwable) { failures.add(failure) }
                finally { secondFinished.countDown() }
            }.apply { start() }
            assertTrue(secondEntered.await(2, java.util.concurrent.TimeUnit.SECONDS))
            assertFalse("A competing terminal mutation must wait for the shared transition guard",
                secondFinished.await(100, java.util.concurrent.TimeUnit.MILLISECONDS))
        } finally {
            releaseFirst.countDown(); first.join(2_000); second?.join(2_000)
        }
        assertFalse(first.isAlive); assertFalse(second!!.isAlive); assertTrue(failures.toString(), failures.isEmpty())
        capture.cancel(); capture.finishConsumption()
        assertEquals(1, origin.cancels); assertEquals(1, origin.releases)
        assertFalse(capture.replayAllowed()); assertNull(capture.takeBreadcrumbs()); assertNull(capture.takeNetworkBodies())
    }

    @Test(expected = IllegalArgumentException::class) fun mismatchedOriginRejected() {
        FrozenReportCapture(VideoOwner("B", "one"), 0, 0, Origin(), FrozenAncillarySnapshot(null, null))
    }
}
