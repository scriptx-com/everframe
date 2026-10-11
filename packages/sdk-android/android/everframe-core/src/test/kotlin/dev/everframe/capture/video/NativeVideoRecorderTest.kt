// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import dev.everframe.config.NativeVideoSettings
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.launch
import kotlinx.coroutines.async
import org.junit.Assert.*
import org.junit.Test

class NativeVideoRecorderTest {
    @Test fun bugReportOpenedDuringSnapshotKeepsIndependentFullHistory() = runBlocking {
        for (freezeDuringBuild in listOf(false, true)) {
            val h = VideoExporterTest.Harness(); val scheduler = RecorderScheduler()
            val first = h.segment(2_000_000); val second = h.segment(4_000_000)
            val entered = kotlinx.coroutines.CompletableDeferred<Unit>()
            val release = kotlinx.coroutines.CompletableDeferred<Unit>()
            val recorder = snapshotRecorder(h, scheduler, ArrayDeque(listOf(listOf(first, second))),
                snapshotExporter = { segments, allowed ->
                    if (!freezeDuringBuild) { entered.complete(Unit); release.await() }
                    h.exporter.exportBorrowed(h.owner, segments, allowed)
                })
            try {
                recorder.start(NativeVideoSettings(2), 30); scheduler.mainTasks.removeAt(0).invoke()
                val error = async(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) {
                    recorder.snapshot(h.owner) { clip ->
                        if (freezeDuringBuild) { entered.complete(Unit); release.await() }
                        NativeVideoAttachment(h.scheduler).build(clip)
                    }
                }
                entered.await()
                val frozen = recorder.freeze(h.owner)
                scheduler.now = 90_000_000_000L // Editing must retain the window captured at freeze.
                val report = async(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) { frozen() }
                assertFalse("report must wait for the borrowed inputs and shared worker admission", report.isCompleted)
                assertTrue(first.path.exists()); assertTrue(second.path.exists())
                release.complete(Unit)
                assertNotNull("the already-started error keeps its own replay", error.await())
                val clip = checkNotNull(report.await())
                assertEquals(listOf(listOf(2_000_000L, 4_000_000L), listOf(2_000_000L, 4_000_000L)), h.inputs)
                clip.close()
                assertFalse(first.path.exists()); assertFalse(second.path.exists())
            } finally { release.complete(Unit); recorder.close() }
            assertEquals(0, h.budget.usedBytes)
        }
    }

    @Test fun freezeRacingARefusedSnapshotControlTaskKeepsTheWritingEncoder() = runBlocking {
        val h = VideoExporterTest.Harness(); val scheduler = RecorderScheduler()
        val segment = h.segment()
        lateinit var recorder: NativeVideoRecorder
        lateinit var frozen: suspend () -> OwnedVideoClip?
        var refuse = false
        recorder = snapshotRecorder(h, scheduler, ArrayDeque(listOf(listOf(segment))), control = { block ->
            if (refuse) { frozen = recorder.freeze(h.owner); false } else { block(); true }
        })
        try {
            recorder.start(NativeVideoSettings(2), 30); scheduler.mainTasks.removeAt(0).invoke()
            refuse = true
            assertNull(recorder.snapshot(h.owner) { error("refused") })
            refuse = false
            assertNotNull("freeze must keep the untouched encoder after a refused snapshot", frozen()?.also { it.close() })
        } finally { recorder.close() }
        assertEquals(0, h.budget.usedBytes)
    }

    @Test fun reporterTimeoutDoesNotCancelTheSnapshotOrConsumeItsHistory() = runBlocking {
        val h = VideoExporterTest.Harness(); val scheduler = RecorderScheduler()
        val entered = kotlinx.coroutines.CompletableDeferred<Unit>()
        val release = kotlinx.coroutines.CompletableDeferred<Unit>()
        val recorder = snapshotRecorder(h, scheduler, ArrayDeque(listOf(listOf(h.segment()))))
        try {
            recorder.start(NativeVideoSettings(2), 30); scheduler.mainTasks.removeAt(0).invoke()
            val error = async(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) {
                recorder.snapshot(h.owner) { clip ->
                    entered.complete(Unit); release.await(); NativeVideoAttachment(h.scheduler).build(clip)
                }
            }
            entered.await()
            val frozen = recorder.freeze(h.owner)
            assertNull(kotlinx.coroutines.withTimeout(13_000) { frozen() })
            assertTrue("a report timeout must not quarantine the snapshot's native work", error.isActive)
            release.complete(Unit)
            assertNotNull(error.await())
            assertNotNull("a retry still owns the full history", frozen()?.also { it.close() })
        } finally { release.complete(Unit); recorder.close() }
        assertEquals(0, h.budget.usedBytes)
    }

    private fun snapshotRecorder(
        h: VideoExporterTest.Harness, scheduler: RecorderScheduler, finishes: ArrayDeque<List<VideoSegment>>,
        control: (() -> Unit) -> Boolean = { block -> block(); true },
        encoders: java.util.concurrent.atomic.AtomicInteger = java.util.concurrent.atomic.AtomicInteger(),
        snapshotExporter: suspend (List<VideoSegment>, () -> Boolean) -> OwnedVideoClip? =
            { segments, allowed -> h.exporter.exportBorrowed(h.owner, segments, allowed) },
    ) = NativeVideoRecorder(h.owner, scheduler, control, { VideoSize(4, 4) }, { null }, { _, _, _ ->
        encoders.incrementAndGet()
        object : RecordingVideoEncoder {
            override fun prepare(size: VideoSize, fps: Int) = size
            override fun offer(frame: SafeVideoFrame) = false
            override fun finish(deadline: Long) = finishes.removeFirstOrNull().orEmpty()
            override val isTerminal = false
            override fun close() = Unit
        }
    }, { segments, allowed -> h.exporter.export(h.owner, segments, allowed) }, snapshotExporter = snapshotExporter)

    @Test fun snapshotKeepsRecordingAndALaterFreezeStillHasTheWholeHistory() = runBlocking {
        val h = VideoExporterTest.Harness(); val scheduler = RecorderScheduler()
        val first = h.segment(2_000_000); val second = h.segment(4_000_000)
        val encoders = java.util.concurrent.atomic.AtomicInteger()
        val recorder = snapshotRecorder(h, scheduler, ArrayDeque(listOf(listOf(first), listOf(second))), encoders = encoders)
        try {
            recorder.start(NativeVideoSettings(2), 30)
            scheduler.mainTasks.removeAt(0).invoke(); assertEquals(1, encoders.get())
            val pair = recorder.snapshot(h.owner) { clip -> NativeVideoAttachment(h.scheduler).build(clip) }
            assertNotNull(pair); assertEquals(sha256(pair!!.part.data), pair.envelope.sha256)
            assertTrue("the snapshot borrows; the recorder keeps the segment", first.path.exists())
            assertEquals(NativeVideoRecorder.State.BUFFERING, recorder.state)
            while (scheduler.mainTasks.isNotEmpty()) scheduler.mainTasks.removeAt(0).invoke()
            assertEquals("recording continues into a new encoder", 2, encoders.get())
            val clip = recorder.freeze(h.owner)()!!
            assertEquals(listOf(listOf(2_000_000L), listOf(2_000_000L, 4_000_000L)), h.inputs)
            clip.close(); assertFalse(first.path.exists()); assertFalse(second.path.exists())
        } finally { recorder.close() }
        assertEquals(0, h.budget.usedBytes)
    }

    @Test fun aFrozenBugReportRefusesTheSnapshotWithoutTouchingItsEncoder() = runBlocking {
        val h = VideoExporterTest.Harness(); val scheduler = RecorderScheduler()
        val finishes = ArrayDeque(listOf(listOf(h.segment())))
        val recorder = snapshotRecorder(h, scheduler, finishes)
        try {
            recorder.start(NativeVideoSettings(2), 30); scheduler.mainTasks.removeAt(0).invoke()
            val export = recorder.freeze(h.owner)
            assertNull(recorder.snapshot(h.owner) { error("no build while a report owns the buffer") })
            assertEquals("the report's encoder was not finished by the snapshot", 1, finishes.size)
            export()!!.close()
        } finally { recorder.close() }
        assertEquals(0, h.budget.usedBytes)
    }

    @Test fun revocationDuringTheSnapshotOmitsTheReplayAndDiscardsHistory() = runBlocking {
        val h = VideoExporterTest.Harness(); val scheduler = RecorderScheduler()
        val segment = h.segment()
        lateinit var recorder: NativeVideoRecorder
        recorder = snapshotRecorder(h, scheduler, ArrayDeque(listOf(listOf(segment))), snapshotExporter = { segments, allowed ->
            recorder.revoke(); h.exporter.exportBorrowed(h.owner, segments, allowed)
        })
        try {
            recorder.start(NativeVideoSettings(2), 30); scheduler.mainTasks.removeAt(0).invoke()
            assertNull(recorder.snapshot(h.owner) { clip -> NativeVideoAttachment(h.scheduler).build(clip) })
            assertFalse("revocation still deletes history the snapshot borrowed", segment.path.exists())
        } finally { recorder.close() }
        assertEquals(0, h.budget.usedBytes)
    }

    @Test fun aFullControlLaneKeepsRecordingIntoTheSameEncoder() = runBlocking {
        val h = VideoExporterTest.Harness(); val scheduler = RecorderScheduler()
        val finishes = ArrayDeque(listOf(listOf(h.segment())))
        var accept = true; val encoders = java.util.concurrent.atomic.AtomicInteger()
        val recorder = snapshotRecorder(h, scheduler, finishes,
            control = { block -> if (accept) { block(); true } else false }, encoders = encoders)
        try {
            recorder.start(NativeVideoSettings(2), 30); scheduler.mainTasks.removeAt(0).invoke()
            accept = false
            assertNull(recorder.snapshot(h.owner) { error("no export without the control lane") })
            accept = true
            while (scheduler.mainTasks.isNotEmpty()) scheduler.mainTasks.removeAt(0).invoke()
            assertEquals("the restored encoder kept its ring", 1, finishes.size)
            assertEquals(1, encoders.get())
            assertNotNull(recorder.freeze(h.owner)()?.also { it.close() })
        } finally { recorder.close() }
        assertEquals(0, h.budget.usedBytes)
    }

    @Test fun mainEnvironmentTimingIncludesSuspendedRechecksWithoutWaitTime() {
        val scheduler = RecorderScheduler()
        val recorder = NativeVideoRecorder(VideoOwner("sensitive-session", "sensitive-capture"), scheduler,
            { block -> block(); true }, { scheduler.now += 17; null }, { null },
            { _, _, _ -> error("No environment") }, { _, _ -> null })
        try {
            recorder.start(NativeVideoSettings(5), 30)
            scheduler.mainTasks.removeAt(0).invoke()
            scheduler.now += 10000
            scheduler.timers.removeAt(0).invoke()
            scheduler.mainTasks.removeAt(0).invoke()
            val output = recorder.diagnosticSnapshot().toString()
            val json = kotlinx.serialization.json.Json.parseToJsonElement(output)
            val fields = json as kotlinx.serialization.json.JsonObject
            assertEquals("[17,17]", fields["mainEnvironmentNs"].toString())
            assertEquals("[17]", fields["mainTickNs"].toString())
            assertFalse(output.contains("sensitive"))
            fun numeric(value: kotlinx.serialization.json.JsonElement): Boolean = when (value) {
                is kotlinx.serialization.json.JsonObject -> value.values.all { numeric(it) }
                is kotlinx.serialization.json.JsonArray -> value.size <= 256 && value.all { numeric(it) }
                is kotlinx.serialization.json.JsonPrimitive -> !value.isString && value.content.toLongOrNull() != null
            }
            assertTrue("Only numeric values may cross this boundary", numeric(json))
        } finally { recorder.close() }
    }
    @Test fun pauseAndFrozenPausePreserveClaimButRevocationNeverRevives() = runBlocking {
        val scheduler = RecorderScheduler()
        val owner = VideoOwner("a", "c")
        val recorder = NativeVideoRecorder(owner, scheduler, { block -> block(); true },
            { null }, { null }, { _, _, _ -> error("No dimensions") }, { _, _ -> null })
        recorder.start(NativeVideoSettings(5), 30)
        assertEquals(NativeVideoRecorder.State.BUFFERING, recorder.state)
        recorder.pause(); assertEquals(NativeVideoRecorder.State.SUSPENDED, recorder.state)
        recorder.resume(); assertEquals(NativeVideoRecorder.State.BUFFERING, recorder.state)
        val export = recorder.freeze(owner)
        recorder.pause(); recorder.resume()
        assertEquals(NativeVideoRecorder.State.FROZEN, recorder.state)
        assertTrue(recorder.replayAllowed)
        recorder.revoke(); assertFalse(recorder.replayAllowed)
        assertNull(export()); recorder.close()
        assertEquals(NativeVideoRecorder.State.CLOSED, recorder.state)
    }
    @Test fun cancelQueuedMainAcquisitionDoesNotCreateEncoder() {
        val scheduler = RecorderScheduler(); var dimensions = 0
        val recorder = NativeVideoRecorder(VideoOwner("a", "c"), scheduler, { block -> block(); true },
            { dimensions++; VideoSize(4, 4) }, { null }, { _, _, _ -> error("cancelled") }, { _, _ -> null })
        recorder.start(NativeVideoSettings(10), 30); recorder.close()
        scheduler.mainTasks.toList().forEach { it() }
        assertEquals(0, dimensions)
    }

    @Test fun frozenExportPreservesOriginalOwnerAcrossPauseAndCompletesOnce() = runBlocking {
        val h = VideoExporterTest.Harness()
        val segment = h.segment()
        val scheduler = RecorderScheduler()
        val anchors = mutableListOf<VideoTimeAnchor>()
        val recorder = NativeVideoRecorder(h.owner, scheduler, { block -> block(); true },
            { VideoSize(4, 4) }, { null }, { _, anchor, _ ->
                anchors += anchor
                object : RecordingVideoEncoder {
                    override fun prepare(size: VideoSize, fps: Int) = size
                    override fun offer(frame: SafeVideoFrame) = false
                    override fun finish(deadline: Long) = listOf(segment)
                    override val isTerminal = false
                    override fun close() = Unit
                }
            }, { segments, allowed -> h.exporter.export(h.owner, segments, allowed) })
        recorder.start(NativeVideoSettings(5), 30)
        scheduler.mainTasks.removeAt(0).invoke()
        recorder.pause(); recorder.resume()
        val export = recorder.freeze(h.owner)
        recorder.pause()
        val clip = export()!!
        assertEquals(h.owner, clip.owner); assertEquals(1, anchors.size)
        assertNull(export()); assertFalse(segment.path.exists())
        clip.close(); recorder.close(); assertEquals(0, h.budget.usedBytes)
    }

    @Test fun delayedSendAndQueuedFinalizationRetainHistoryFromReporterOpen() = runBlocking {
        for (delayFinish in listOf(false, true)) {
            val h = VideoExporterTest.Harness(); val segment = h.segment(2_000_000)
            val scheduler = RecorderScheduler(); val control = java.util.ArrayDeque<() -> Unit>()
            val recorder = NativeVideoRecorder(h.owner, scheduler, { block -> control.add(block); true },
                { VideoSize(4, 4) }, { null }, { _, _, _ -> object : RecordingVideoEncoder {
                    override fun prepare(size: VideoSize, fps: Int) = size
                    override fun offer(frame: SafeVideoFrame) = false
                    override fun finish(deadline: Long) = listOf(segment)
                    override val isTerminal = false
                    override fun close() = Unit
                } }, { segments, allowed -> h.exporter.export(h.owner, segments, allowed) })
            try {
                recorder.start(NativeVideoSettings(5), 30)
                scheduler.mainTasks.removeAt(0).invoke(); control.removeFirst().invoke()
                scheduler.now = 10_000_000_000L
                val export = recorder.freeze(h.owner)
                scheduler.now = 71_000_000_000L // Editing the report must not age frozen evidence.
                val pending = async(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) { export() }
                if (delayFinish) scheduler.now = 132_000_000_000L
                control.removeFirst().invoke()
                val clip = pending.await()
                assertNotNull("freeze-time history survives delayed Send and queued finish=$delayFinish", clip)
                assertEquals(h.owner, clip!!.owner)
                assertEquals(12_000, clip.metadata.replayStartEpochMs)
                assertNull(export()); clip.close()
                assertFalse(segment.path.exists())
                assertEquals(0, h.budget.usedBytes)
            } finally { recorder.close(); h.root.deleteRecursively() }
        }
    }

    @Test fun cancellationBeforeQueuedFinishRetainsCleanupOwnership() = runBlocking {
        val h = VideoExporterTest.Harness(); val segment = h.segment()
        val scheduler = RecorderScheduler(); val tasks = java.util.ArrayDeque<() -> Unit>()
        val recorder = NativeVideoRecorder(h.owner, scheduler, { block -> tasks.add(block); true },
            { VideoSize(4, 4) }, { null }, { _, _, _ ->
                object : RecordingVideoEncoder {
                    override fun prepare(size: VideoSize, fps: Int) = size
                    override fun offer(frame: SafeVideoFrame) = false
                    override fun finish(deadline: Long) = listOf(segment)
                    override val isTerminal = false
                    override fun close() = Unit
                }
            }, { _, _ -> error("Cancelled export must not reach media") })
        recorder.start(NativeVideoSettings(5), 30); scheduler.mainTasks.removeAt(0).invoke(); tasks.removeFirst().invoke()
        val export = recorder.freeze(h.owner)
        val job = launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) { export() }
        job.cancel(); job.join(); recorder.close()
        assertTrue(segment.path.exists())
        tasks.removeFirst().invoke()
        assertFalse(segment.path.exists()); assertEquals(0, h.budget.usedBytes)
    }


    @Test fun failingFinalizationOmitsAndClosesEncoder() = runBlocking {
        val scheduler = RecorderScheduler(); var closes = 0
        val recorder = NativeVideoRecorder(VideoOwner("a", "c"), scheduler, { block -> block(); true },
            { VideoSize(4, 4) }, { null }, { _, _, _ ->
                object : RecordingVideoEncoder {
                    override fun prepare(size: VideoSize, fps: Int) = size
                    override fun offer(frame: SafeVideoFrame) = false
                    override fun finish(deadline: Long): List<VideoSegment> = error("finish failed")
                    override val isTerminal = false
                    override fun close() { closes++ }
                }
            }, { _, _ -> error("Failed finish cannot export") })
        recorder.start(NativeVideoSettings(5), 30); scheduler.mainTasks.removeAt(0).invoke()
        val export = recorder.freeze(recorder.owner)
        assertNull(kotlinx.coroutines.withTimeout(500) { export() })
        assertEquals(1, closes); recorder.close()
    }

    @Test fun unavailableForegroundSuspendsAcquisitionAndResumesOriginalRecording() {
        val scheduler = RecorderScheduler(); var available = false
        val recorder = NativeVideoRecorder(VideoOwner("a", "c"), scheduler, { block -> block(); true },
            { if (available) VideoSize(4, 4) else null }, { null }, { _, _, _ -> error("Only checking resumption scheduling") }, { _, _ -> null })
        recorder.start(NativeVideoSettings(5), 30); scheduler.mainTasks.removeAt(0).invoke()
        assertEquals(NativeVideoRecorder.State.SUSPENDED, recorder.state)
        assertTrue(recorder.replayAllowed)
        available = true; scheduler.timers.removeAt(0).invoke(); scheduler.mainTasks.removeAt(0).invoke()
        assertEquals(NativeVideoRecorder.State.BUFFERING, recorder.state)
        recorder.close()
    }

    @Test fun resumeWhilePreparationIsQueuedCannotLoseFutureTicks() {
        val scheduler = RecorderScheduler(); val control = java.util.ArrayDeque<() -> Unit>()
        val recorder = NativeVideoRecorder(VideoOwner("a", "c"), scheduler, { block -> control.add(block); true },
            { VideoSize(4, 4) }, { null }, { _, _, _ -> error("stale prepare") }, { _, _ -> null })
        recorder.start(NativeVideoSettings(5), 30); scheduler.mainTasks.removeAt(0).invoke()
        recorder.pause(); recorder.resume(); scheduler.mainTasks.removeAt(0).invoke()
        control.removeFirst().invoke()
        assertTrue("Resume needs a fresh generation tick after stale prepare returns", scheduler.mainTasks.isNotEmpty())
        recorder.close()
    }

    @Test fun platformObservationAndEncoderConstructionFailuresStayOptional() {
        val scheduler = RecorderScheduler()
        val recorder = NativeVideoRecorder(VideoOwner("a", "c"), scheduler, { block -> block(); true },
            { error("Activity supplier failed") }, { null }, { _, _, _ -> error("codec") }, { _, _ -> null })
        recorder.start(NativeVideoSettings(5), 30); scheduler.mainTasks.removeAt(0).invoke()
        assertEquals(NativeVideoRecorder.State.SUSPENDED, recorder.state); recorder.close()
        val encoderFailure = NativeVideoRecorder(VideoOwner("a", "d"), scheduler, { block -> block(); true },
            { VideoSize(4, 4) }, { null }, { _, _, _ -> error("codec") }, { _, _ -> null })
        encoderFailure.start(NativeVideoSettings(5), 30); scheduler.mainTasks.removeAt(0).invoke()
        assertFalse(encoderFailure.replayAllowed); encoderFailure.close()
    }
    private class RecorderScheduler : VideoCaptureScheduler {
        var now = 0L
        val mainTasks = mutableListOf<() -> Unit>()
        val timers = mutableListOf<() -> Unit>()
        val delays = mutableListOf<Long>()
        override fun main(block: () -> Unit) { mainTasks += block }
        override fun worker(block: () -> Unit) = block()
        override fun later(delayMs: Long, block: () -> Unit): () -> Unit { delays += delayMs; timers += block; return { timers.remove(block); Unit } }
        override fun isWorkerThread() = false
        override fun nowNanos() = now
    }

    @Test fun lowFrameRatesRecordAndTickOncePerFrameInterval() {
        for ((fps, interval) in listOf(1 to 1_000L, 2 to 500L)) {
            val scheduler = RecorderScheduler()
            val recorder = NativeVideoRecorder(VideoOwner("a", "c"), scheduler, { block -> block(); true },
                { VideoSize(4, 4) }, { null }, { _, _, _ -> object : RecordingVideoEncoder {
                    override fun prepare(size: VideoSize, fps: Int) = size
                    override fun offer(frame: SafeVideoFrame) = false
                    override fun finish(deadline: Long) = emptyList<VideoSegment>()
                    override val isTerminal = false
                    override fun close() = Unit
                } }, { _, _ -> null })
            try {
                recorder.start(NativeVideoSettings(fps), 30)
                assertEquals(NativeVideoRecorder.State.BUFFERING, recorder.state)
                scheduler.mainTasks.removeAt(0).invoke() // installs the encoder
                scheduler.mainTasks.removeAt(0).invoke() // first acquisition, then the next tick
                assertEquals("fps=$fps", listOf(interval), scheduler.delays)
            } finally { recorder.close() }
        }
        val rejected = NativeVideoRecorder(VideoOwner("a", "d"), RecorderScheduler(), { block -> block(); true },
            { VideoSize(4, 4) }, { null }, { _, _, _ -> error("unsupported rate") }, { _, _ -> null })
        rejected.start(NativeVideoSettings(3), 30)
        assertEquals(NativeVideoRecorder.State.DISABLED, rejected.state); rejected.close()
    }

    @Test fun devicePauseSuspendsLikeALostWindowAndResumesWhenCleared() {
        val scheduler = RecorderScheduler(); var paused = true; var dimensionReads = 0
        val recorder = NativeVideoRecorder(VideoOwner("a", "c"), scheduler, { block -> block(); true },
            { dimensionReads++; VideoSize(4, 4) }, { null }, { _, _, _ -> error("no encoder while paused") }, { _, _ -> null },
            devicePause = { paused })
        try {
            recorder.start(NativeVideoSettings(2), 30); scheduler.mainTasks.removeAt(0).invoke()
            assertEquals(NativeVideoRecorder.State.SUSPENDED, recorder.state)
            assertTrue("same claim semantics as the existing environment pause", recorder.replayAllowed)
            assertEquals("the device gate is read before any window state", 0, dimensionReads)
            scheduler.timers.removeAt(0).invoke(); scheduler.mainTasks.removeAt(0).invoke()
            assertEquals("still paused: the 500 ms watch re-arms", NativeVideoRecorder.State.SUSPENDED, recorder.state)
            paused = false
            scheduler.timers.removeAt(0).invoke(); scheduler.mainTasks.removeAt(0).invoke()
            assertEquals(NativeVideoRecorder.State.BUFFERING, recorder.state)
        } finally { recorder.close() }
    }
}
