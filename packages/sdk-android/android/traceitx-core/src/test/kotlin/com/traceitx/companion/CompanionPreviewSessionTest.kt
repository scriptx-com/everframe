// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Task 11 — CompanionPreviewSession unit tests (task-11-brief.md Step 1),
// rewritten for task-11 review round 2's design corrections: two capture
// seams (`capturePreview`/`captureShot`), `PreviewCapture` carries its own
// `mime`, `stop(reason: PreviewStopReason)` instead of an unconstrained
// `String`, `handleShotRequest`/`requestShot` take the correlation id as an
// explicit argument (no more `lastCorrelationId`), and a `nowMs` wall-clock
// seam for the 2-minute cap.
//
// DEVIATION from the brief's literal test code (round 1, still true here):
// `CompanionPreviewSession`'s default `scope` is
// `CoroutineScope(Dispatchers.Main + SupervisorJob())`, and `advanceTimeBy`
// only virtualizes the specific `TestCoroutineScheduler` behind the
// `TestScope` a given `runTest { }` call created. A coroutine dispatched via
// `Dispatchers.Main` is on a DIFFERENT scheduler unless `Dispatchers.Main` is
// pointed at that exact same scheduler first — this file installs a
// `StandardTestDispatcher` via `Dispatchers.setMain` and drives every
// `runTest` off that SAME instance, exactly like
// `ReplaySessionRefreshLoopTest.kt` in this same module.
package com.traceitx.companion

import com.traceitx.protocol.generated.PreviewFrame
import com.traceitx.protocol.generated.PreviewStop
import com.traceitx.protocol.generated.RelayMessage
import com.traceitx.protocol.generated.ShotAssembled
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CompanionPreviewSessionTest {

    private val mainDispatcher = StandardTestDispatcher()

    // The DEFE-03 capture gate defaults CLOSED and is opened by `TraceItX.start()`.
    // These tests drive the session directly, so they model a started SDK —
    // otherwise every capture is (correctly) refused by the kill-switch check.
    private var previousCaptureGate = false

    @Before
    fun setUp() {
        previousCaptureGate = com.traceitx.TraceItX.captureGate
        com.traceitx.TraceItX.captureGate = true
        Dispatchers.setMain(mainDispatcher)
    }

    @After
    fun tearDown() {
        com.traceitx.TraceItX.captureGate = previousCaptureGate
        Dispatchers.resetMain()
    }

    private class Spy {
        sealed class Event {
            data class Header(val message: RelayMessage) : Event()
            data class Binary(val bytes: ByteArray) : Event()
        }

        val events = mutableListOf<Event>()
        fun send(m: RelayMessage) { events += Event.Header(m) }
        fun sendBinary(b: ByteArray) { events += Event.Binary(b) }
        fun countOf(type: String) = events.count { it is Event.Header && it.message::class.simpleName == type }
        val sent: List<RelayMessage> get() = events.filterIsInstance<Event.Header>().map { it.message }
        val binaries: List<ByteArray> get() = events.filterIsInstance<Event.Binary>().map { it.bytes }
    }

    private fun jpeg(w: Int = 854, h: Int = 480) = PreviewCapture(ByteArray(4), w, h, "image/jpeg")
    private fun png(w: Int = 1000, h: Int = 500) = PreviewCapture(ByteArray(4), w, h, "image/png")

    // ==================== live preview declined by default (product call 2026-08-27) ====================
    //
    // Every loop test below injects `livePreviewEnabled = true` — the loop
    // machinery is kept proven for per-tier re-enablement, but production
    // constructs the session with the default (OFF): each frame is a full
    // screen capture, a continuous CPU tax for a nice-to-have viewfinder.

    @Test
    fun `declines preview_start with capture_unavailable by default`() = runTest(mainDispatcher) {
        val spy = Spy()
        val session = CompanionPreviewSession(
            send = spy::send,
            sendBinary = spy::sendBinary,
            capturePreview = { jpeg() },
            captureShot = { jpeg() },
            intervalMs = 100,
            maxDurationMs = 120_000,
        )
        session.start("c1")
        advanceTimeBy(500)

        assertFalse(session.isRunning)
        assertEquals(0, spy.countOf("PreviewFrame"))
        assertTrue(spy.sent.any { it is PreviewStop && it.reason == "capture_unavailable" })
    }

    @Test
    fun `a declined preview still authorizes single-shot capture`() = runTest(mainDispatcher) {
        val spy = Spy()
        val session = CompanionPreviewSession(
            send = spy::send,
            sendBinary = spy::sendBinary,
            capturePreview = { jpeg() },
            captureShot = { png() },
        )
        session.start("c1")
        session.requestShot("c1", "s1", null)
        advanceTimeBy(200)

        assertEquals(1, spy.countOf("ShotAssembled"))
        assertEquals(0, spy.countOf("PreviewFrame"))
    }

    // ==================== Brief's four tests, transcribed and adapted to the new two-seam / enum-reason / explicit-correlationId API ====================

    @Test
    fun `emits a header and a binary per tick`() = runTest(mainDispatcher) {
        val spy = Spy()
        val session = CompanionPreviewSession(
            livePreviewEnabled = true,
            send = spy::send,
            sendBinary = spy::sendBinary,
            capturePreview = { jpeg() },
            captureShot = { jpeg() },
            intervalMs = 100,
            maxDurationMs = 120_000,
        )
        session.start("c1")
        advanceTimeBy(350)
        session.stop(PreviewStopReason.USER)

        assertTrue(spy.countOf("PreviewFrame") >= 2)
        assertEquals(spy.countOf("PreviewFrame"), spy.binaries.size)
    }

    @Test
    fun `stops at the time cap and announces it`() = runTest(mainDispatcher) {
        val spy = Spy()
        val session = CompanionPreviewSession(
            livePreviewEnabled = true,
            send = spy::send,
            sendBinary = spy::sendBinary,
            capturePreview = { jpeg(8, 4) },
            captureShot = { jpeg(8, 4) },
            intervalMs = 50,
            maxDurationMs = 200,
            // Task 11 review round 2, IMPORTANT 5 — the cap is wall-clock
            // now, not a tick count, so the test drives it off the SAME
            // virtual clock `advanceTimeBy` manipulates (`TestScope.currentTime`,
            // bound here via `runTest(mainDispatcher)`), not a bare tick
            // counter.
            nowMs = { currentTime },
        )
        session.start("c1")
        advanceTimeBy(500)

        assertFalse(session.isRunning)
        assertTrue(spy.sent.any { it is PreviewStop && it.reason == "time_cap" })
    }

    @Test
    fun `stops with capture_unavailable when the capture seam returns nothing`() = runTest(mainDispatcher) {
        // The web client (ReporterSurface) keys on this exact reason string,
        // combined with a no-frame heuristic, to distinguish "this device has
        // no preview implementation" from a transient loss it should offer to
        // Resume. This must exercise the real production path — `capturePreview()`
        // returning null throws inside the loop's own try/catch, which is what
        // actually announces the reason, not a hand-rolled assertion against
        // the enum.
        val spy = Spy()
        val session = CompanionPreviewSession(
            livePreviewEnabled = true,
            send = spy::send,
            sendBinary = spy::sendBinary,
            capturePreview = { null },
            captureShot = { jpeg() },
            intervalMs = 50,
            maxDurationMs = 120_000,
        )
        session.start("c1")
        advanceTimeBy(60)

        assertFalse(session.isRunning)
        assertTrue(spy.sent.any { it is PreviewStop && it.reason == "capture_unavailable" })
    }

    @Test
    fun `re-crops from the stash without capturing twice`() = runTest(mainDispatcher) {
        val spy = Spy()
        var captures = 0
        val session = CompanionPreviewSession(
            livePreviewEnabled = true,
            send = spy::send,
            sendBinary = spy::sendBinary,
            capturePreview = { jpeg() },
            captureShot = { captures++; png(1000, 500) },
            crop = { src, _ -> PreviewCapture(src.bytes, 500, 250, src.mime) },
            intervalMs = 100,
            maxDurationMs = 120_000,
        )
        // Finding A: a FRESH capture requires the correlation id to have been
        // authorised via start() first — see previewAuthorizedForStash.
        session.start("c1")
        session.stop(PreviewStopReason.USER)
        session.handleShotRequest("c1", "s1", null)
        session.handleShotRequest("c1", "s1", NormalizedRect(0.0, 0.0, 0.5, 0.5))

        assertEquals(1, captures)
        assertEquals(2, spy.countOf("ShotAssembled"))
    }

    @Test
    fun `a failed shot does not fail the report`() = runTest(mainDispatcher) {
        val spy = Spy()
        val session = CompanionPreviewSession(
            livePreviewEnabled = true,
            send = spy::send,
            sendBinary = spy::sendBinary,
            capturePreview = { jpeg() },
            captureShot = { throw IllegalStateException("no_surface") },
            intervalMs = 100,
            maxDurationMs = 120_000,
        )
        // Finding A: authorise "c1" first so the request reaches captureShot()
        // (and fails THERE, which is what this test is actually about)
        // instead of being refused earlier by the new authorisation gate.
        session.start("c1")
        session.stop(PreviewStopReason.USER)
        session.handleShotRequest("c1", "s1", null)

        assertEquals(1, spy.countOf("ShotFailed"))
        assertEquals(0, spy.countOf("ReportFailed"))
    }

    // ==================== Auto-stop trigger coverage carried over from round 1 ====================

    @Test
    fun `explicit stop announces preview stop with the given reason`() = runTest(mainDispatcher) {
        val spy = Spy()
        val session = CompanionPreviewSession(
            livePreviewEnabled = true,
            send = spy::send,
            sendBinary = spy::sendBinary,
            capturePreview = { jpeg(8, 4) },
            captureShot = { jpeg(8, 4) },
            intervalMs = 100,
            maxDurationMs = 120_000,
        )
        session.start("c1")
        advanceTimeBy(150)
        session.stop(PreviewStopReason.USER)

        assertFalse(session.isRunning)
        assertTrue(spy.sent.any { it is PreviewStop && it.reason == "user" })
    }

    @Test
    fun `stopSilently cancels without announcing — the peer-stop, phone-disconnect, pair-expiry and background shape`() = runTest(mainDispatcher) {
        val spy = Spy()
        val session = CompanionPreviewSession(
            livePreviewEnabled = true,
            send = spy::send,
            sendBinary = spy::sendBinary,
            capturePreview = { jpeg(8, 4) },
            captureShot = { jpeg(8, 4) },
            intervalMs = 100,
            maxDurationMs = 120_000,
        )
        session.start("c1")
        advanceTimeBy(150)
        val eventsBeforeStop = spy.events.size

        session.stopSilently()

        assertFalse(session.isRunning)
        assertEquals("stopSilently must not add any frame", eventsBeforeStop, spy.events.size)
        assertTrue(spy.sent.none { it is PreviewStop })
    }

    @Test
    fun `stopSilently on a session that never started is a harmless no-op`() = runTest(mainDispatcher) {
        val spy = Spy()
        val session = CompanionPreviewSession(
            livePreviewEnabled = true,
            send = spy::send,
            sendBinary = spy::sendBinary,
            capturePreview = { jpeg(8, 4) },
            captureShot = { jpeg(8, 4) },
        )

        session.stopSilently()

        assertFalse(session.isRunning)
        assertTrue(spy.sent.isEmpty())
    }

    // ==================== task-11 review round 2 — regressions for CRITICAL 1, CRITICAL 3, IMPORTANT 4/5/6/7 ====================

    @Test
    fun `CRITICAL 1 — handleShotRequest uses the id it was called with, not stale session state`() = runTest(mainDispatcher) {
        val spy = Spy()
        val session = CompanionPreviewSession(
            livePreviewEnabled = true,
            send = spy::send,
            sendBinary = spy::sendBinary,
            capturePreview = { jpeg(8, 4) },
            captureShot = { png(8, 4) },
            intervalMs = 100,
            maxDurationMs = 120_000,
        )
        // Round-1 shape's bug required BOTH: the session's own `correlationId`
        // field must be null/stale, AND a shot request must still need an
        // answer. The fixed signature takes the id explicitly, so this must
        // work regardless of what `start()` was ever called with.
        //
        // Finding A: a FRESH capture now also requires "c2" to have been
        // authorised via start() at some point — see previewAuthorizedForStash
        // — so unlike the original version of this test (which called
        // handleShotRequest against a session that had NEVER started
        // anything), "c2" is explicitly started then immediately stopped
        // (mirroring the phone's own snap-then-stop ordering, which nulls
        // `this.correlationId` back to null) before the request. That keeps
        // this test proving the SAME thing — the id comes from the request,
        // not from internal state, which here is null after the stop.
        session.start("c2")
        session.stop(PreviewStopReason.USER)
        session.handleShotRequest("c2", "s1", null)

        val assembled = spy.sent.single { it is ShotAssembled } as ShotAssembled
        assertEquals("c2", assembled.correlationId)
    }

    @Test
    fun `IMPORTANT 4 — the loop and the stash use separate capture seams and mime is never hardcoded`() = runTest(mainDispatcher) {
        val spy = Spy()
        var previewCalls = 0
        var fullCalls = 0
        val session = CompanionPreviewSession(
            livePreviewEnabled = true,
            send = spy::send,
            sendBinary = spy::sendBinary,
            capturePreview = { previewCalls++; PreviewCapture(ByteArray(4), 854, 480, "image/jpeg") },
            captureShot = { fullCalls++; PreviewCapture(ByteArray(4), 4000, 3000, "image/png") },
            intervalMs = 100,
            maxDurationMs = 120_000,
        )
        session.start("c1")
        advanceTimeBy(150)
        session.handleShotRequest("c1", "s1", null)
        session.stop(PreviewStopReason.USER)

        assertTrue("the loop must use capturePreview, never captureShot", previewCalls >= 1)
        assertEquals("a shot must use captureShot exactly once (then stash)", 1, fullCalls)

        val frame = spy.sent.single { it is PreviewFrame } as PreviewFrame
        assertEquals("image/jpeg", frame.mime)

        val assembled = spy.sent.single { it is ShotAssembled } as ShotAssembled
        assertEquals("a shot's announced mime must match what captureShot actually produced, not a hardcoded value", "image/png", assembled.mime)
    }

    @Test
    fun `IMPORTANT 5 — the cap is wall-clock and accounts for capture duration, not just tick count`() = runTest(mainDispatcher) {
        val spy = Spy()
        val session = CompanionPreviewSession(
            livePreviewEnabled = true,
            send = spy::send,
            sendBinary = spy::sendBinary,
            capturePreview = {
                delay(150) // capture itself is slow — 50ms interval + 150ms capture = 200ms/cycle
                jpeg(8, 4)
            },
            captureShot = { jpeg(8, 4) },
            intervalMs = 50,
            maxDurationMs = 200,
            nowMs = { currentTime },
        )
        session.start("c1")
        advanceTimeBy(1000)

        // A tick-counting cap (round-1 shape) would allow 4 ticks
        // (200ms / 50ms) regardless of capture cost. Each real cycle here
        // costs 200ms (50 delay + 150 capture), so the cap must trip after
        // exactly ONE.
        assertEquals(1, spy.countOf("PreviewFrame"))
        assertFalse(session.isRunning)
    }

    @Test
    fun `IMPORTANT 6 — start with a new correlationId while running restarts under the new identity`() = runTest(mainDispatcher) {
        val spy = Spy()
        val session = CompanionPreviewSession(
            livePreviewEnabled = true,
            send = spy::send,
            sendBinary = spy::sendBinary,
            capturePreview = { jpeg(8, 4) },
            captureShot = { jpeg(8, 4) },
            intervalMs = 50,
            maxDurationMs = 120_000,
        )
        session.start("c1")
        advanceTimeBy(60)
        val framesUnderC1 = spy.sent.filterIsInstance<PreviewFrame>().map { it.correlationId }
        assertTrue(framesUnderC1.isNotEmpty() && framesUnderC1.all { it == "c1" })

        session.start("c2") // a NEW report cycle while c1's preview was still running
        advanceTimeBy(120)

        val framesAfterRestart = spy.sent.filterIsInstance<PreviewFrame>().map { it.correlationId }.drop(framesUnderC1.size)
        assertTrue("frames must resume after the restart", framesAfterRestart.isNotEmpty())
        assertTrue(
            "frames after a restart with a NEW id must carry that id, not the stale one — " +
                "otherwise every one fails the phone's correlation-id filter and the preview looks dead until the cap",
            framesAfterRestart.all { it == "c2" },
        )
        // Must stop before the test ends: `maxDurationMs` here is real-clock
        // (default `nowMs`), which never trips inside a fast test, so
        // `runTest`'s implicit end-of-test drain would otherwise try to run
        // this loop to natural completion and spin for the full 120s.
        session.stop(PreviewStopReason.USER)
    }

    @Test
    fun `IMPORTANT 6 — start with the SAME correlationId while running is still idempotent`() = runTest(mainDispatcher) {
        val spy = Spy()
        val session = CompanionPreviewSession(
            livePreviewEnabled = true,
            send = spy::send,
            sendBinary = spy::sendBinary,
            capturePreview = { jpeg(8, 4) },
            captureShot = { jpeg(8, 4) },
            intervalMs = 50,
            maxDurationMs = 120_000,
        )
        session.start("c1")
        session.start("c1") // repeat — must NOT restart (would double the emit rate)
        advanceTimeBy(60)

        assertEquals(1, spy.countOf("PreviewFrame"))
        // See the sibling test's comment — must stop before the test ends.
        session.stop(PreviewStopReason.USER)
    }

    @Test
    fun `IMPORTANT 7 — stop clears the stash, a later session cannot re-crop an old capture`() = runTest(mainDispatcher) {
        val spy = Spy()
        var fullCaptures = 0
        val session = CompanionPreviewSession(
            livePreviewEnabled = true,
            send = spy::send,
            sendBinary = spy::sendBinary,
            capturePreview = { jpeg(8, 4) },
            captureShot = { fullCaptures++; png(1000, 500) },
            intervalMs = 50,
            maxDurationMs = 120_000,
        )
        session.start("c1")
        session.handleShotRequest("c1", "s1", null)
        assertEquals(1, fullCaptures)

        session.stop(PreviewStopReason.USER)

        // A later, unrelated preview session for the same pair — which on the
        // wire means a NEW REPORT CYCLE, and therefore a new correlation id.
        // This test used to reuse "c1" here and call it unrelated; it isn't.
        // Re-reading it that way is what let the carried follow-up F1 be fixed
        // without weakening this one: the stash is scoped to the correlation
        // id, so it survives the stop/start churn WITHIN a report (the phone
        // sends preview.stop after every snap) and is dropped the moment a
        // different report begins. See `stashCorrelationId`.
        session.start("c2")
        session.handleShotRequest("c2", "s1", null) // same shot_id reused

        assertEquals(
            "a stash must not answer a shot request from a later, unrelated report cycle",
            2,
            fullCaptures,
        )
        // See the earlier IMPORTANT 6 tests' comment — must stop before the
        // test ends, since this second `start()` is still running.
        session.stop(PreviewStopReason.USER)
    }

    @Test
    fun `teardown permanently disables the session — a later start does nothing`() = runTest(mainDispatcher) {
        val spy = Spy()
        val session = CompanionPreviewSession(
            livePreviewEnabled = true,
            send = spy::send,
            sendBinary = spy::sendBinary,
            capturePreview = { jpeg(8, 4) },
            captureShot = { jpeg(8, 4) },
            intervalMs = 50,
            maxDurationMs = 120_000,
        )
        session.start("c1")
        session.teardown()
        assertFalse(session.isRunning)

        session.start("c2")
        advanceTimeBy(500)

        assertFalse("a torn-down session must not resume capturing on a later start()", session.isRunning)
        assertTrue(spy.sent.filterIsInstance<PreviewFrame>().none { it.correlationId == "c2" })
    }

    @Test
    fun `CRITICAL 3 — a shot capture running concurrently with the preview loop never interleaves a header from its own binary`() = runTest(mainDispatcher) {
        val spy = Spy()
        val session = CompanionPreviewSession(
            livePreviewEnabled = true,
            send = spy::send,
            sendBinary = spy::sendBinary,
            capturePreview = { jpeg(8, 4) },
            captureShot = {
                delay(120) // slow — deliberately overlaps several preview ticks
                png(100, 50)
            },
            intervalMs = 50,
            maxDurationMs = 120_000,
        )
        session.start("c1")
        session.requestShot("c1", "s1", null)
        advanceTimeBy(400)
        session.stop(PreviewStopReason.USER)

        assertTrue(spy.countOf("PreviewFrame") >= 1)
        assertEquals(1, spy.countOf("ShotAssembled"))

        // Round-1 shape ran the loop on this session's own scope but
        // `handleShotRequest` on a SEPARATE `Dispatchers.IO` scope owned by
        // RelayWSClient — a genuine race that could deliver a ShotAssembled's
        // binary into the phone's `await-preview` slot or vice versa. Both
        // now funnel through the SAME single scope (see the class doc), so
        // every binary-bearing header must be followed immediately — with
        // nothing else interposed — by its own binary.
        for (i in spy.events.indices) {
            val event = spy.events[i]
            val bearsBinary = event is Spy.Event.Header &&
                (event.message::class.simpleName == "PreviewFrame" || event.message::class.simpleName == "ShotAssembled")
            if (bearsBinary) {
                assertTrue(
                    "header at index $i (${(event as Spy.Event.Header).message::class.simpleName}) " +
                        "must be immediately followed by its own binary, got ${spy.events.getOrNull(i + 1)}",
                    spy.events.getOrNull(i + 1) is Spy.Event.Binary,
                )
            }
        }
    }

    // ==================== Carried follow-up F1: what actually clears the stash ====================
    //
    // Task 11 review round 2 IMPORTANT 7 made `cancelInternal()` clear the
    // stash, which over-corrected: the phone sends `preview.stop` right after
    // EVERY snap, so the stash never survived its own preview. A later
    // re-crop of a stashed shot would then MISS, re-capture whatever is on
    // screen at that moment, and announce those pixels under the original
    // shot's id — silently wrong evidence, timing-dependent. Unreachable only
    // because no crop UI exists yet, which is precisely why it needs a test
    // now rather than a bug report later.
    //
    // The privacy intent behind IMPORTANT 7 is preserved by clearing on the
    // triggers that actually mean "this pairing is over": RelayWSClient
    // already calls clearStash() explicitly alongside stopSilently() for
    // phone.disconnected, pair.expired and backgrounding, and teardown()
    // clears it directly.

    @Test
    fun `a preview stop keeps the stash, so a later re-crop is not a fresh capture`() = runTest(mainDispatcher) {
        val spy = Spy()
        var captures = 0
        val session = CompanionPreviewSession(
            livePreviewEnabled = true,
            send = spy::send,
            sendBinary = spy::sendBinary,
            capturePreview = { jpeg() },
            captureShot = { captures++; png(1000, 500) },
            crop = { src, _ -> PreviewCapture(src.bytes, 500, 250, src.mime) },
            intervalMs = 50,
            maxDurationMs = 120_000,
        )
        session.start("c1")
        advanceTimeBy(60)
        session.handleShotRequest("c1", "s1", null)
        assertEquals(1, captures)

        // Exactly what the phone does after a snap.
        session.stopSilently()
        session.handleShotRequest("c1", "s1", NormalizedRect(0.0, 0.0, 0.5, 0.5))

        assertEquals(
            "a re-crop must come from the stash; re-capturing here would announce the CURRENT " +
                "screen under the original shot's id",
            1,
            captures,
        )
    }

    @Test
    fun `the kill switch stops the preview and refuses shots`() = runTest(mainDispatcher) {
        // DEFE-03: `kill()` closes the capture gate but leaves the companion
        // client and session alive, so without a check the loop kept reading
        // the user's screen for up to two minutes AFTER the host invoked the
        // emergency stop — and new report-grade shots were still served.
        val previous = com.traceitx.TraceItX.captureGate
        try {
            com.traceitx.TraceItX.captureGate = false
            val spy = Spy()
            var previewCalls = 0
            var shotCalls = 0
            val session = CompanionPreviewSession(
                livePreviewEnabled = true,
                send = spy::send,
                sendBinary = spy::sendBinary,
                capturePreview = { previewCalls++; jpeg() },
                captureShot = { shotCalls++; png(1000, 500) },
                intervalMs = 20,
                maxDurationMs = 120_000,
            )

            session.start("c1")
            advanceTimeBy(200)
            session.handleShotRequest("c1", "s1", null)

            assertFalse("the preview must stop when the gate closes", session.isRunning)
            assertEquals("no preview frame may be captured after kill()", 0, previewCalls)
            assertEquals("no shot may be captured after kill()", 0, shotCalls)
            assertEquals(1, spy.countOf("ShotFailed"))
        } finally {
            com.traceitx.TraceItX.captureGate = previous
        }
    }

    @Test
    fun `a kill during capture does not put the captured bytes on the wire`() = runTest(mainDispatcher) {
        // The gate was checked BEFORE the suspending capture only, so a kill()
        // landing inside that window still shipped the frame it produced.
        val previous = com.traceitx.TraceItX.captureGate
        try {
            val spy = Spy()
            val session = CompanionPreviewSession(
                livePreviewEnabled = true,
                send = spy::send,
                sendBinary = spy::sendBinary,
                capturePreview = {
                    // The host hits the emergency stop mid-capture.
                    com.traceitx.TraceItX.captureGate = false
                    jpeg()
                },
                captureShot = { com.traceitx.TraceItX.captureGate = false; png(1000, 500) },
                intervalMs = 20,
                maxDurationMs = 120_000,
            )

            session.start("c1")
            advanceTimeBy(200)

            assertEquals("a frame captured as the gate closed must not be sent", 0, spy.countOf("PreviewFrame"))
            assertFalse(session.isRunning)

            com.traceitx.TraceItX.captureGate = true
            val spy2 = Spy()
            val session2 = CompanionPreviewSession(
                livePreviewEnabled = true,
                send = spy2::send,
                sendBinary = spy2::sendBinary,
                capturePreview = { jpeg() },
                captureShot = { com.traceitx.TraceItX.captureGate = false; png(1000, 500) },
                intervalMs = 20,
                maxDurationMs = 120_000,
            )
            // Finding A: authorise "c1" first so the request actually reaches
            // captureShot() — which is the mid-capture kill this test exists
            // to prove — instead of being refused earlier by the new gate.
            session2.start("c1")
            session2.stop(PreviewStopReason.USER)
            session2.handleShotRequest("c1", "s1", null)

            assertEquals("a shot captured as the gate closed must not be sent", 0, spy2.countOf("ShotAssembled"))
            assertEquals(1, spy2.countOf("ShotFailed"))
        } finally {
            com.traceitx.TraceItX.captureGate = previous
        }
    }

    @Test
    fun `a kill followed by start does not resurrect the running preview`() = runTest(mainDispatcher) {
        // The boolean gate alone cannot express this: kill() lowers it and
        // start() raises it again, so a tick suspended across BOTH never
        // observes `false` and would carry on streaming under the pre-kill
        // request. The epoch is monotonic, so it can.
        val previous = com.traceitx.TraceItX.captureGate
        try {
            com.traceitx.TraceItX.captureGate = true
            val spy = Spy()
            val session = CompanionPreviewSession(
                livePreviewEnabled = true,
                send = spy::send,
                sendBinary = spy::sendBinary,
                capturePreview = { jpeg() },
                captureShot = { png(1000, 500) },
                intervalMs = 20,
                maxDurationMs = 120_000,
            )
            session.start("c1")
            advanceTimeBy(60)
            val framesBefore = spy.countOf("PreviewFrame")
            assertTrue("the loop must have been streaming first", framesBefore > 0)

            // The host kills, then the app restarts the SDK — between ticks.
            CompanionAuthEpoch.invalidate()
            com.traceitx.TraceItX.captureGate = true
            advanceTimeBy(200)

            assertFalse("the pre-kill preview must not resume", session.isRunning)
            assertEquals(
                "no frame may be sent under the pre-kill request after a kill",
                framesBefore,
                spy.countOf("PreviewFrame"),
            )
        } finally {
            com.traceitx.TraceItX.captureGate = previous
        }
    }

    @Test
    fun `a shot whose authorisation ends mid-capture is not transmitted`() = runTest(mainDispatcher) {
        // Coroutine cancellation is COOPERATIVE: once captureShot() returns
        // there is no suspension point left before the wire, so a cancel()
        // arriving after that last suspension cannot stop the send. A rapid
        // re-bond could therefore hand the previous phone's report-grade
        // screenshot to a different phone.
        val spy = Spy()
        val session = CompanionPreviewSession(
            livePreviewEnabled = true,
            send = spy::send,
            sendBinary = spy::sendBinary,
            capturePreview = { jpeg() },
            captureShot = {
                // The pair is lost while this capture runs.
                CompanionAuthEpoch.invalidate()
                png(1000, 500)
            },
            intervalMs = 50,
            maxDurationMs = 120_000,
        )

        // Finding A: authorise "c1" first — see the earlier tests' comments.
        session.start("c1")
        session.stop(PreviewStopReason.USER)
        session.handleShotRequest("c1", "s1", null)

        assertEquals(
            "a capture whose authorisation ended mid-flight must not reach whoever re-bonded",
            0,
            spy.countOf("ShotAssembled"),
        )
    }

    @Test
    fun `start runs without any indicator gate`() = runTest(mainDispatcher) {
        // The indicator used to gate the preview: a pill that could not be
        // proven on screen refused the capture loop. With it gone, nothing
        // may stand between start() and a running session — there is no
        // longer even an `indicator` parameter to inject a refusing double
        // through.
        val spy = Spy()
        var previewCalls = 0
        val session = CompanionPreviewSession(
            livePreviewEnabled = true,
            send = spy::send,
            sendBinary = spy::sendBinary,
            capturePreview = { previewCalls++; jpeg() },
            captureShot = { png(1000, 500) },
            intervalMs = 50,
            maxDurationMs = 120_000,
        )

        session.start("corr-1")
        advanceTimeBy(60)

        assertTrue(session.isRunning)
        assertTrue("the capture loop must actually run — nothing may refuse it now that the indicator gate is gone", previewCalls >= 1)
        session.stop(PreviewStopReason.USER)
    }

    @Test
    fun `the stash is bounded — a peer looping over fresh shot ids cannot grow it without limit`() =
        runTest(mainDispatcher) {
            // `report.submit`'s `shots` array is capped at 8 by the protocol, so
            // a ninth capture could never be submitted anyway — but nothing
            // capped the STASH itself, and `shot_id` is phone-chosen. Each entry
            // is a report-grade PNG of the user's screen.
            val spy = Spy()
            var shotCalls = 0
            val session = CompanionPreviewSession(
                livePreviewEnabled = true,
                send = spy::send,
                sendBinary = spy::sendBinary,
                capturePreview = { jpeg() },
                captureShot = { shotCalls++; png(1000, 500) },
                intervalMs = 50,
                maxDurationMs = 120_000,
            )

            // Finding A: authorise "c1" once — every request below reuses it,
            // so this exercises the CAP, not the new authorisation gate.
            session.start("c1")
            session.stop(PreviewStopReason.USER)
            repeat(12) { i -> session.handleShotRequest("c1", "s$i", null) }

            assertEquals("the ninth distinct shot must not be captured", 8, shotCalls)
            assertEquals(8, spy.countOf("ShotAssembled"))
            assertEquals("the phone must be told, not silently ignored", 4, spy.countOf("ShotFailed"))
        }

    @Test
    fun `a duplicate shot id already in flight is refused, not captured twice`() = runTest(mainDispatcher) {
        // The reservation is a Set, so two concurrent requests for ONE id both
        // passed the cap (it counted one), each launched its own PixelCopy +
        // PNG encode, and the first to finish removed the shared id while the
        // other was still reading the screen.
        val spy = Spy()
        var shotCalls = 0
        val session = CompanionPreviewSession(
            livePreviewEnabled = true,
            send = spy::send,
            sendBinary = spy::sendBinary,
            capturePreview = { jpeg() },
            captureShot = { shotCalls++; delay(20); png(1000, 500) },
            intervalMs = 50,
            maxDurationMs = 120_000,
        )

        // Finding A: authorise "c1" once first — see the stash-bound test's comment.
        session.start("c1")
        session.stop(PreviewStopReason.USER)
        repeat(5) { launch { session.handleShotRequest("c1", "sameId", null) } }
        advanceTimeBy(500)

        assertEquals("one capture for one id, however many requests raced", 1, shotCalls)
        assertEquals(1, spy.countOf("ShotAssembled"))
        assertEquals("the duplicates must be answered, not dropped", 4, spy.countOf("ShotFailed"))
    }

    @Test
    fun `concurrent shot requests cannot exceed the cap`() = runTest(mainDispatcher) {
        // The cap read `stash.size` BEFORE the suspending capture and wrote the
        // stash after, so a burst of requests all saw the same empty stash and
        // every one of them launched a report-grade capture. The ceiling
        // existed but bound nothing under concurrency — exactly the case a cap
        // on memory has to survive.
        val spy = Spy()
        var shotCalls = 0
        val session = CompanionPreviewSession(
            livePreviewEnabled = true,
            send = spy::send,
            sendBinary = spy::sendBinary,
            capturePreview = { jpeg() },
            captureShot = {
                shotCalls++
                // Suspend, so every concurrent request is inside the window
                // between the cap check and the stash write.
                delay(20)
                png(1000, 500)
            },
            intervalMs = 50,
            maxDurationMs = 120_000,
        )

        // Finding A: authorise "c1" once first — see the stash-bound test's comment.
        session.start("c1")
        session.stop(PreviewStopReason.USER)
        // Launch 10 at once on the session's own dispatcher.
        repeat(10) { i ->
            launch { session.handleShotRequest("c1", "s$i", null) }
        }
        advanceTimeBy(500)

        assertEquals("the cap must hold under a burst, not just sequentially", 8, shotCalls)
        assertEquals(2, spy.countOf("ShotFailed"))
    }

    @Test
    fun `a known shot id still re-crops once the cap is reached`() = runTest(mainDispatcher) {
        // The cap governs how many distinct captures are HELD, not how often
        // each is re-cropped — otherwise reaching it would break the crop flow
        // for shots already taken.
        val spy = Spy()
        var shotCalls = 0
        val session = CompanionPreviewSession(
            livePreviewEnabled = true,
            send = spy::send,
            sendBinary = spy::sendBinary,
            capturePreview = { jpeg() },
            captureShot = { shotCalls++; png(1000, 500) },
            crop = { src, _ -> PreviewCapture(src.bytes, 5, 5, src.mime) },
            intervalMs = 50,
            maxDurationMs = 120_000,
        )
        // Finding A: authorise "c1" once first — see the stash-bound test's comment.
        session.start("c1")
        session.stop(PreviewStopReason.USER)
        repeat(8) { i -> session.handleShotRequest("c1", "s$i", null) }
        assertEquals(8, shotCalls)

        session.handleShotRequest("c1", "s0", NormalizedRect(0.0, 0.0, 0.5, 0.5))

        assertEquals("a re-crop must not capture again", 8, shotCalls)
        assertEquals("and must not be refused by the cap", 0, spy.countOf("ShotFailed"))
        assertEquals(9, spy.countOf("ShotAssembled"))
    }

    @Test
    fun `a new report cycle drops the previous cycle's stash`() = runTest(mainDispatcher) {
        // The other half of the same rule, without a preview ever running:
        // a shot can arrive with no live loop, so the correlation scope has to
        // be adopted in handleShotRequest too, not only in start().
        val spy = Spy()
        var captures = 0
        val session = CompanionPreviewSession(
            livePreviewEnabled = true,
            send = spy::send,
            sendBinary = spy::sendBinary,
            capturePreview = { jpeg() },
            captureShot = { captures++; png(1000, 500) },
            intervalMs = 50,
            maxDurationMs = 120_000,
        )
        // Finding A: authorise each correlation id before requesting under
        // it — a fresh capture with no active/ever-authorised preview is
        // exactly what this branch's fix now refuses.
        session.start("c1")
        session.stop(PreviewStopReason.USER)
        session.handleShotRequest("c1", "s1", null)
        session.start("c2")
        session.stop(PreviewStopReason.USER)
        session.handleShotRequest("c2", "s1", null)

        assertEquals("the same shot_id under a new correlation id must capture afresh", 2, captures)
    }

    @Test
    fun `clearStash drops it — the pair-loss path RelayWSClient calls explicitly`() = runTest(mainDispatcher) {
        val spy = Spy()
        var captures = 0
        val session = CompanionPreviewSession(
            livePreviewEnabled = true,
            send = spy::send,
            sendBinary = spy::sendBinary,
            capturePreview = { jpeg() },
            captureShot = { captures++; png(1000, 500) },
            intervalMs = 50,
            maxDurationMs = 120_000,
        )
        // Finding A: authorise "c1" before each request. clearStash() (below)
        // resets that authorisation along with everything else — a NEW
        // pairing means a NEW preview.start, same as production.
        session.start("c1")
        session.stop(PreviewStopReason.USER)
        session.handleShotRequest("c1", "s1", null)
        assertEquals(1, captures)

        session.clearStash()
        session.start("c1")
        session.stop(PreviewStopReason.USER)
        session.handleShotRequest("c1", "s1", null)

        assertEquals("a shot captured before the pair was lost must never be reachable after it", 2, captures)
    }

    @Test
    fun `teardown drops the stash`() = runTest(mainDispatcher) {
        val spy = Spy()
        var captures = 0
        val session = CompanionPreviewSession(
            livePreviewEnabled = true,
            send = spy::send,
            sendBinary = spy::sendBinary,
            capturePreview = { jpeg() },
            captureShot = { captures++; png(1000, 500) },
            intervalMs = 50,
            maxDurationMs = 120_000,
        )
        // Finding A: authorise "c1" first.
        session.start("c1")
        session.stop(PreviewStopReason.USER)
        session.handleShotRequest("c1", "s1", null)

        session.teardown()

        assertEquals(
            "teardown is permanent — full-resolution pixels of the user's screen must not outlive it",
            0,
            stashSizeOf(session),
        )
        assertEquals(1, captures)
    }

    // ==================== Finding A (companion-window-polish codex review round 2) ====================
    //
    // `handleShotRequest` used to accept a shot request with no active or
    // ever-authorised preview at all. Combined with the stash being keyed by
    // a peer-chosen correlation id, rotating that id reset the eight-shot
    // ceiling every time — an attached peer could pull unlimited report-grade
    // screenshots. This was made silent (not created) by this branch removing
    // the on-device sharing indicator that used to sit in this path; the fix
    // below does NOT reintroduce that indicator, and closes the limit itself.

    @Test
    fun `Finding A — rotating the correlation id without ever starting a preview captures nothing, however many ids are tried`() =
        runTest(mainDispatcher) {
            val spy = Spy()
            var shotCalls = 0
            val session = CompanionPreviewSession(
                livePreviewEnabled = true,
                send = spy::send,
                sendBinary = spy::sendBinary,
                capturePreview = { jpeg() },
                captureShot = { shotCalls++; png(1000, 500) },
                intervalMs = 50,
                maxDurationMs = 120_000,
            )

            // The exact bypass the reviewer described: a peer that never
            // sends `preview.start` at all, just a stream of `shot.request`
            // frames each under a brand-new correlation id, to keep resetting
            // the per-id stash ceiling.
            repeat(20) { i -> session.handleShotRequest("id-$i", "s$i", null) }

            assertEquals(
                "no preview was ever started for ANY of these ids — none may capture, however many are tried",
                0,
                shotCalls,
            )
            assertEquals(20, spy.countOf("ShotFailed"))
            assertTrue(
                "the phone must be told why, not left to guess",
                spy.sent.filterIsInstance<com.traceitx.protocol.generated.ShotFailed>()
                    .all { it.reason == "no_active_session" },
            )
        }

    @Test
    fun `Finding A — the normal snap-then-stop sequence still captures a fresh shot`() = runTest(mainDispatcher) {
        // Exactly what the web client's `snapShot` does (ReporterSurface.tsx):
        // it sends `shot.request` and then IMMEDIATELY closes the preview —
        // so a legitimate FRESH capture can arrive (or, as modelled here,
        // start running on this session's own scope) after `preview.stop`
        // has already cancelled the loop and nulled the session's internal
        // `correlationId`. The fix must not reject this.
        val spy = Spy()
        var shotCalls = 0
        val session = CompanionPreviewSession(
            livePreviewEnabled = true,
            send = spy::send,
            sendBinary = spy::sendBinary,
            capturePreview = { jpeg() },
            captureShot = { shotCalls++; png(1000, 500) },
            intervalMs = 50,
            maxDurationMs = 120_000,
        )

        session.start("c1")
        session.stop(PreviewStopReason.USER) // preview already stopping, as the finding describes
        session.handleShotRequest("c1", "s1", null) // first request for "s1" — a FRESH capture, not a re-crop

        assertEquals("a legitimate snap-then-stop request must still capture", 1, shotCalls)
        assertEquals(1, spy.countOf("ShotAssembled"))
        assertEquals(0, spy.countOf("ShotFailed"))
    }

    @Test
    fun `Finding A — a re-crop of a known shot_id succeeds without the preview still running`() =
        runTest(mainDispatcher) {
            // The documented re-crop contract must survive the new gate: it
            // is not a NEW capture, so it must not require the preview to
            // still be RUNNING (as opposed to merely having been authorised
            // at some point) at re-crop time. Complements "a preview stop
            // keeps the stash" above with an explicit Finding-A framing:
            // previewAuthorizedForStash persists across an ordinary stop()
            // (only clearStash()/teardown() reset it), so this is the
            // realistic "authorisation lapsed, running-wise, but the id is
            // still known" state — not an artificial one.
            val spy = Spy()
            var shotCalls = 0
            val session = CompanionPreviewSession(
                livePreviewEnabled = true,
                send = spy::send,
                sendBinary = spy::sendBinary,
                capturePreview = { jpeg() },
                captureShot = { shotCalls++; png(1000, 500) },
                crop = { src, _ -> PreviewCapture(src.bytes, 5, 5, src.mime) },
                intervalMs = 50,
                maxDurationMs = 120_000,
            )
            session.start("c1")
            session.handleShotRequest("c1", "s1", null) // fresh
            session.stop(PreviewStopReason.USER) // preview no longer running; authorisation persists
            assertEquals(1, shotCalls)
            assertFalse(session.isRunning)

            session.handleShotRequest("c1", "s1", NormalizedRect(0.0, 0.0, 0.5, 0.5))

            assertEquals("a re-crop of a KNOWN id must not require captureShot() at all", 1, shotCalls)
            assertEquals(0, spy.countOf("ShotFailed"))
            assertEquals(2, spy.countOf("ShotAssembled"))
        }

    /** Reads the private stash by reflection — asserting emptiness has no public surface. */
    private fun stashSizeOf(session: CompanionPreviewSession): Int {
        val field = CompanionPreviewSession::class.java.getDeclaredField("stash")
        field.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        return (field.get(session) as Map<String, PreviewCapture>).size
    }
}
