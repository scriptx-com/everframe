// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.everframe.Everframe
import dev.everframe.capture.video.ErrorReplaySnapshot
import dev.everframe.capture.video.ErrorReplayWork
import dev.everframe.capture.video.VideoAttachmentPair
import dev.everframe.capture.video.sha256
import dev.everframe.config.EverframeConfig
import dev.everframe.outbox.CrashSidecar
import dev.everframe.outbox.JSONLOutbox
import dev.everframe.outbox.JceTestOutboxKeyProvider
import dev.everframe.outbox.JvmOutboxFileOps
import dev.everframe.outbox.OutboxEntry
import dev.everframe.protocol.generated.Attachment
import dev.everframe.protocol.generated.AttachmentKind
import dev.everframe.protocol.generated.Format
import dev.everframe.shared.SharedData
import dev.everframe.transport.ReportSubmitter
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class ErrorReplayCaptureTest {
    @get:Rule val tmp = TemporaryFolder()
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val appContextField = Everframe::class.java.getDeclaredField("appContext").apply { isAccessible = true }
    private var previousAppContext: Any? = null
    private val keys = JceTestOutboxKeyProvider()
    private lateinit var storageDir: File
    private val asked = AtomicInteger()

    private class Fake(started: Long = System.nanoTime(), now: () -> Long = System::nanoTime) {
        val result = CompletableDeferred<VideoAttachmentPair?>()
        @Volatile var allowed = true
        val settled = CopyOnWriteArrayList<Boolean>()
        val snapshot = ErrorReplaySnapshot(result, started, { allowed }, { settled += it }, now)
    }

    private suspend fun entries() = JSONLOutbox(File(storageDir, "outbox.jsonl"), keys, JvmOutboxFileOps()).hydrate()
    private fun json(entry: OutboxEntry) = Json.parseToJsonElement(String(entry.envelopeBytes)).jsonObject
    private fun reason(entry: OutboxEntry) = json(entry)["captureControl"]!!.jsonObject["degradedReason"]?.jsonPrimitive?.content
    private suspend fun idle() { ErrorReplayWork.scope.coroutineContext[Job]!!.children.toList().forEach { it.join() } }
    private fun pair(bytes: ByteArray = byteArrayOf(7, 8, 9)): VideoAttachmentPair {
        val sha = sha256(bytes)
        return VideoAttachmentPair(
            Attachment(byteLength = bytes.size.toDouble(), contentType = "video/mp4", durationMS = 1_000.0,
                format = Format.EverframeVideoV1, height = 4.0, kind = AttachmentKind.SessionReplay, partName = "replay",
                replayStartEpochMS = 12_000.0, sha256 = sha, width = 4.0),
            ReportSubmitter.Attachment("replay", "replay.mp4", "video/mp4", bytes, sha))
    }

    @Before fun setUp() {
        previousAppContext = appContextField.get(null)
        appContextField.set(null, null) // no live drains: the outbox stays observable
        SharedData.init(context)
        CrashReporter.__resetForTesting()
        storageDir = tmp.newFolder()
        CrashReporter.sidecarFactory = { CrashSidecar(File(storageDir, "crash-outbox.jsonl"), keys, JvmOutboxFileOps()) }
        CrashReporter.configure(context)
        Everframe.captureGate = true
        Everframe.__setConfigForTesting(EverframeConfig(appId = "app", sdkKey = "sk", r8MappingId = "mapping-A"))
        Everframe.setUser(null)
    }

    @After fun tearDown() {
        ErrorReplayHolds.clock = System::nanoTime
        Everframe.setUser(null)
        appContextField.set(null, previousAppContext)
        Everframe.__setConfigForTesting(null)
        Everframe.captureGate = false
        CrashReporter.__resetForTesting()
    }

    @Test fun `handled error is stored at once and upgraded with its replay`() = runBlocking {
        val fake = Fake()
        CrashReporter.errorReplaySource = { asked.incrementAndGet(); fake.snapshot }
        Everframe.captureException(IllegalStateException("with replay"))
        val original = entries().single()
        assertTrue(original.attachmentRefs.isEmpty())
        assertEquals("crash-capture;replay_omitted", reason(original))
        assertTrue("drains wait while the replay exports", ErrorReplayHolds.isHeld(original.reportId))
        fake.result.complete(pair()); idle()
        val stored = entries().single()
        assertEquals(original.reportId, stored.reportId); assertEquals(original.createdAt, stored.createdAt)
        assertEquals(json(original)["submittedAt"], json(stored)["submittedAt"])
        assertEquals("crash-capture", reason(stored))
        assertEquals(listOf("replay"), stored.attachmentRefs.map { it.name })
        assertEquals("video/mp4", stored.attachmentRefs.single().contentType)
        val attachment = json(stored)["attachments"]!!.jsonArray.single().jsonObject
        assertEquals("session-replay", attachment["kind"]!!.jsonPrimitive.content)
        assertEquals("everframe-video-v1", attachment["format"]!!.jsonPrimitive.content)
        assertEquals("replay", attachment["partName"]!!.jsonPrimitive.content)
        assertEquals("error", json(stored)["source"]!!.jsonPrimitive.content)
        assertEquals(sha256(stored.envelopeBytes), stored.idempotencyKey)
        assertFalse(ErrorReplayHolds.isHeld(original.reportId))
        assertEquals(listOf(true), fake.settled.toList()); assertEquals(1, asked.get())
    }

    @Test fun `a replay over the decimal byte limit leaves the durable error flagged`() = runBlocking {
        val fake = Fake(); CrashReporter.errorReplaySource = { fake.snapshot }
        Everframe.captureException(IllegalStateException("oversized"))
        fake.result.complete(pair(ByteArray(8_000_001))); idle()
        val stored = entries().single()
        assertTrue(stored.attachmentRefs.isEmpty())
        assertEquals("crash-capture;replay_omitted", reason(stored))
        assertEquals(listOf(false), fake.settled.toList())
    }

    @Test fun `reopening storage after losing the in-memory hold preserves the replay-free error`() = runBlocking {
        val fake = Fake(); CrashReporter.errorReplaySource = { fake.snapshot }
        Everframe.captureException(IllegalStateException("restart before export"))
        val original = entries().single()
        // Model lost process memory: only the encrypted queue survives. No replay bytes or hold
        // are persisted. This is a storage-reopen test, not a real process-kill test.
        ErrorReplayHolds.release(original.reportId)
        val reopened = JSONLOutbox(File(storageDir, "outbox.jsonl"), keys, JvmOutboxFileOps()).hydrate().single()
        assertEquals(original, reopened)
        assertTrue(reopened.attachmentRefs.isEmpty())
        assertEquals("crash-capture;replay_omitted", reason(reopened))
        assertFalse(ErrorReplayHolds.isHeld(reopened.reportId))
        fake.result.complete(pair()); idle()
        assertEquals("orphaned work cannot replace an error after its hold is lost", listOf(original), entries())
        assertEquals(listOf(false), fake.settled.toList())
    }

    @Test fun `missed deadline leaves the flagged error without a replay`() = runBlocking {
        val fake = Fake(started = 0L, now = { 3_000_000_001L })
        CrashReporter.errorReplaySource = { fake.snapshot }
        Everframe.captureException(IllegalStateException("too slow"))
        idle(); fake.result.complete(pair())
        val stored = entries().single()
        assertTrue(stored.attachmentRefs.isEmpty()); assertTrue(json(stored)["attachments"]!!.jsonArray.isEmpty())
        assertEquals("crash-capture;replay_omitted", reason(stored))
        assertFalse(ErrorReplayHolds.isHeld(stored.reportId)); assertEquals(listOf(false), fake.settled.toList())
    }

    @Test fun `an export that yields nothing, such as an over-limit clip, keeps the flag`() = runBlocking {
        val fake = Fake(); CrashReporter.errorReplaySource = { fake.snapshot }
        Everframe.captureException(IllegalStateException("too big"))
        fake.result.complete(null); idle()
        val stored = entries().single()
        assertTrue(stored.attachmentRefs.isEmpty()); assertEquals("crash-capture;replay_omitted", reason(stored))
        assertEquals(listOf(false), fake.settled.toList())
    }

    @Test fun `a replay that lands after the 5 s hold lapses never replaces the stored error`() = runBlocking {
        var now = 0L
        ErrorReplayHolds.clock = { now }
        val fake = Fake(); CrashReporter.errorReplaySource = { fake.snapshot }
        Everframe.captureException(IllegalStateException("late swap"))
        val original = entries().single()
        now = ErrorReplayHolds.HOLD_NANOS // from here a drain may be sending the stored error
        assertFalse(ErrorReplayHolds.isHeld(original.reportId))
        fake.result.complete(pair()); idle()
        assertEquals("the stored error is untouched", listOf(original), entries())
        assertEquals("crash-capture;replay_omitted", reason(entries().single()))
        assertEquals(listOf(false), fake.settled.toList())
    }

    @Test fun `a replay revoked before storage is never attached`() = runBlocking {
        val fake = Fake(); CrashReporter.errorReplaySource = { fake.snapshot }
        Everframe.captureException(IllegalStateException("revoked"))
        fake.allowed = false; fake.result.complete(pair()); idle()
        val stored = entries().single()
        assertTrue(stored.attachmentRefs.isEmpty()); assertEquals(listOf(false), fake.settled.toList())
    }

    @Test fun `without a recording the error is stored exactly as before`() = runBlocking {
        CrashReporter.errorReplaySource = { asked.incrementAndGet(); null }
        Everframe.captureException(IllegalStateException("plain"))
        val stored = entries().single()
        assertEquals("crash-capture", reason(stored)); assertFalse(ErrorReplayHolds.isHeld(stored.reportId))
        assertEquals(1, asked.get())
    }

    @Test fun `crashes, fatal JavaScript errors, every Flutter path and the old bridge calls never snapshot`() = runBlocking {
        CrashReporter.errorReplaySource = { asked.incrementAndGet(); Fake().snapshot }
        CrashReporter.captureThrowable(Thread.currentThread(), IllegalStateException("fatal"))
        assertTrue(CrashReporter.captureFactsAcceptedWithReplay("Error", "fatal js", emptyList(), "errorutils", true,
            "2026-10-11T00:00:00Z", null, null, null))
        Everframe.captureException(IllegalStateException("flutter"), null, "everframe-flutter")
        // The Flutter plugin's own call (EverframeFlutterPlugin "captureException"), and the replay
        // entry point with the Flutter identity: Flutter reports replay the host VTree, never native video.
        assertTrue(CrashReporter.captureHandledFacts("FlutterError", "plugin", emptyList(), "2026-10-11T00:00:00Z",
            jsBundle = null, sdkName = "everframe-flutter"))
        assertTrue(CrashReporter.captureHandledFactsWithReplay("FlutterError", "forced", emptyList(), "2026-10-11T00:00:00Z",
            null, null, null, "everframe-flutter"))
        assertTrue(CrashReporter.captureFactsAcceptedWithCauses("Error", "old bridge", emptyList(), "errorutils", false,
            "2026-10-11T00:00:00Z", null, null, null))
        assertEquals(0, asked.get())
        val stored = entries()
        assertEquals(6, stored.size)
        assertTrue(stored.all { it.attachmentRefs.isEmpty() && reason(it) == "crash-capture" })
    }

    @Test fun `React Native entry points snapshot nonfatal JavaScript errors`() = runBlocking {
        val fakes = CopyOnWriteArrayList<Fake>()
        CrashReporter.errorReplaySource = { Fake().also { fakes += it }.snapshot }
        assertTrue(CrashReporter.captureHandledFactsWithReplay("TypeError", "explicit", listOf("at f (app.js:1:1)"),
            "2026-10-11T00:00:00Z", null, null, null, "everframe-android"))
        assertTrue(CrashReporter.captureFactsAcceptedWithReplay("Error", "rejection", emptyList(), "unhandledrejection", false,
            "2026-10-11T00:00:00Z", null, null, null))
        assertEquals(2, fakes.size)
        assertTrue(entries().all { ErrorReplayHolds.isHeld(it.reportId) && reason(it) == "crash-capture;replay_omitted" })
        fakes.forEach { it.result.complete(pair()) }; idle()
        assertTrue(entries().all { it.attachmentRefs.single().name == "replay" && reason(it) == "crash-capture" })
    }
}
