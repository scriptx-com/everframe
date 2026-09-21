// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Plan 06.2-08 Task 2 — RelayWSClient listener + state-machine tests.
//
// Strategy (per Plan 06.2-08 advisor + RESEARCH §Pattern 3):
//   • Drive the WebSocketListener with the socket the client ACTUALLY
//     installed. `FakeWebSocketOkHttpClient` hands `openSocket` a hand-rolled
//     `FakeWebSocket`, so the real connect path (generation check, install,
//     cancel-the-predecessor) runs and `isCurrentSocket` is live — feeding
//     the listener an uninstalled socket would test nothing, because every
//     callback now drops frames from a socket this client does not own.
//   • `computeBackoff` is `@VisibleForTesting internal` — test the delay
//     table directly rather than driving the real Handler.
//   • `onStart`/`onStop` are public overrides from DefaultLifecycleObserver
//     — call them with a fake LifecycleOwner to exercise the lifecycle path.
//
// The announce leg (spec 2026-08-07) is covered end-to-end against a real
// MockWebServer in `RelayWSClientAnnounceTest`; this file stays on fakes and
// covers frame routing, close-code mapping and reconnect arming.
//
// Robolectric test runner is used because `ProcessLifecycleOwner.get()`
// accesses the Application instance; even though we never call it inside
// these tests, `RelayWSClient.start()` does — left untested here on
// purpose (it's an integration concern owned by Plan 09).

package com.traceitx.companion

import androidx.lifecycle.Lifecycle
import com.traceitx.protocol.generated.PreviewStop
import com.traceitx.protocol.generated.ReportCompleted
import com.traceitx.protocol.generated.ReportFailed
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import okhttp3.OkHttpClient
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class RelayWSClientTest {

    private lateinit var client: RelayWSClient
    private lateinit var okHttp: FakeWebSocketOkHttpClient
    private lateinit var fakeWs: FakeWebSocket
    private lateinit var scheduled: MutableList<Long>
    private lateinit var previewSession: RecordingPreviewSession

    @Before
    fun setUp() {
        resetCompanion()
        scheduled = mutableListOf()
        okHttp = FakeWebSocketOkHttpClient()
        previewSession = RecordingPreviewSession()
        client = RelayWSClient(
            client = okHttp,
            baseUrl = "https://relay.example.test",
            scheduler = { delayMs, _ ->
                // Record delay; do NOT run the action — keeps the test
                // deterministic (no reconnect attempts churning).
                scheduled.add(delayMs)
            },
            previewSessionForTesting = previewSession,
        )
        // Open the socket through the production path so the listener
        // callbacks below are talking about a socket the client owns.
        client.onStart(FakeLifecycleOwner())
        fakeWs = okHttp.sockets.last()
    }

    @After
    fun tearDown() {
        resetCompanion()
        // Don't leak provider seams — or half-paired submit/binary frames —
        // across tests. `CompanionCaptureBridge` is an `object`, so both are
        // process-global.
        CompanionCaptureBridge.__teardownForTesting()
    }

    /**
     * `Companion` is a Kotlin `object`, so its StateFlows are process-global
     * and leak between tests. Reset all four, or one test's bond state makes
     * the next one pass for the wrong reason.
     */
    private fun resetCompanion() {
        Companion.__setState(CompanionState.Unpaired)
        Companion.__setPairUrl(null)
        Companion.__setCode(null)
        Companion.__setAttachedUserName(null)
        Companion.__setAttachChallenge(null)
    }

    // ---------------- onMessage routing ----------------

    @Test
    fun onMessage_pairCreated_setsPairUrlAndStaysUnpaired() {
        val raw = """{"type":"pair.created","pair_id":"pair_abc","pair_token":"tok_xyz"}"""
        client.listener.onMessage(fakeWs, raw)
        assertEquals("https://relay.example.test/r/tok_xyz", Companion.pairUrl.value)
        assertEquals(CompanionState.Unpaired, Companion.state.value)
    }

    @Test
    fun onMessage_pairBonded_transitionsToPairedAndRetainsPairUrl() {
        // Create the pair first so a pairUrl is present to retain.
        client.listener.onMessage(
            fakeWs,
            """{"type":"pair.created","pair_id":"pair_abc","pair_token":"tok_xyz"}""",
        )
        assertEquals("https://relay.example.test/r/tok_xyz", Companion.pairUrl.value)

        val raw = """{"type":"pair.bonded","pair_id":"pair_abc",
            |"device_token":"dev_xyz",
            |"device_token_expires_at":"2026-06-01T00:00:00.000Z"}""".trimMargin().replace("\n", "")
        client.listener.onMessage(fakeWs, raw)
        assertEquals(CompanionState.Paired, Companion.state.value)
        // pairUrl is RETAINED on bond — nulled only on socket close.
        assertEquals("https://relay.example.test/r/tok_xyz", Companion.pairUrl.value)
    }

    @Test
    fun onMessage_pairExpired_clearsTokensReturnsToUnpairedAndRetainsPairUrl() {
        // First bond, then expire.
        val bonded = """{"type":"pair.bonded","pair_id":"pair_abc",
            |"device_token":"dev_xyz","device_token_expires_at":"2026-06-01T00:00:00.000Z"}"""
            .trimMargin().replace("\n", "")
        client.listener.onMessage(fakeWs, bonded)
        Companion.__setPairUrl("https://relay.example.test/r/tok_xyz")

        val expired = """{"type":"pair.expired","pair_id":"pair_abc","reason":"inactivity"}"""
        client.listener.onMessage(fakeWs, expired)
        assertEquals(CompanionState.Unpaired, Companion.state.value)
        // pairUrl is RETAINED on expiry — nulled only on socket close.
        assertEquals("https://relay.example.test/r/tok_xyz", Companion.pairUrl.value)
    }

    @Test
    fun onMessage_reportRequest_flipsStateAndDispatchesToBridge() {
        // Provider returns null -> bridge sends ReportFailed and returns Paired.
        // We assert the state transitions, not the bridge's send contents
        // (that's the bridge's own test scope; we cover it indirectly).
        CompanionCaptureBridge.__captureProvider = { _, _ -> null }
        // We need to first reach Paired so the post-bridge Paired transition
        // is observable from a known prior state.
        client.listener.onMessage(
            fakeWs,
            """{"type":"pair.bonded","pair_id":"p","device_token":"d","device_token_expires_at":"2026-06-01T00:00:00.000Z"}""",
        )
        assertEquals(CompanionState.Paired, Companion.state.value)

        val raw = """{"type":"report.request","correlation_id":"corr_001"}"""
        client.listener.onMessage(fakeWs, raw)
        // After bridge handles the missing-payload case, state returns to Paired.
        // (Transient ReportInProgress flip happens inside the listener; the
        // bridge synchronously resets to Paired.)
        assertEquals(CompanionState.Paired, Companion.state.value)
        // ReportFailed JSON was sent on the same socket.
        assertTrue(
            "expected a report.failed text frame to be sent",
            fakeWs.sentText.any { it.contains("\"type\":\"report.failed\"") },
        )
    }

    @Test
    fun onMessage_reportRequest_whileAlreadyInProgress_rejectsWithInFlightAndDoesNotDispatch() {
        // Serial-report invariant (review finding 3): a second overlapping
        // report.request mid-submit could wipe the frozen snapshot the
        // in-flight composer is about to consume. Simulate an in-flight
        // report by setting state directly (as a prior report.request would
        // have) without routing through the bridge.
        Companion.__setState(CompanionState.ReportInProgress)
        var providerInvoked = false
        CompanionCaptureBridge.__captureProvider = { _, _ -> providerInvoked = true; null }

        val raw = """{"type":"report.request","correlation_id":"corr_overlap"}"""
        client.listener.onMessage(fakeWs, raw)

        assertEquals(
            "state must stay ReportInProgress — the guard must not re-set it",
            CompanionState.ReportInProgress,
            Companion.state.value,
        )
        assertTrue(
            "must NOT dispatch to the bridge while a report is already in flight",
            !providerInvoked,
        )
        assertTrue(
            "expected a report.rejected(in_flight) text frame to be sent",
            fakeWs.sentText.any {
                it.contains("\"type\":\"report.rejected\"") &&
                    it.contains("\"reason\":\"in_flight\"") &&
                    it.contains("\"correlation_id\":\"corr_overlap\"")
            },
        )
    }

    @Test
    fun onMessage_reportRequest_whileAlreadyInProgress_doesNotOverwriteTheAttributionToken() {
        // The other half of the serial-report invariant, and the half the
        // rejection branch used to miss: the session token was written on the
        // line ABOVE the in-flight check, so a rejected request handed its own
        // token to the session. That token is single-use and was minted for a
        // report that will never run, so the next request carrying none (an
        // older relay) would fall back to it and attribute to nobody.
        client.listener.onMessage(fakeWs, bondedFrame(attributionToken = "attr_bond"))
        // Anti-vacuity: the token really is loaded before the overlapping
        // request arrives, so a passing assertion below is the guard working
        // and not an empty session.
        assertEquals("attr_bond", client.getCompanionAttribution())
        // Stand in for a report already in flight the same way the sibling
        // overlap test does. Driving a first request through the bridge is not
        // usable here: `__captureProvider` returning null makes the bridge fail
        // the report synchronously and flip straight back to Paired, so the
        // second request would no longer be an overlapping one.
        Companion.__setState(CompanionState.ReportInProgress)
        CompanionCaptureBridge.__captureProvider = { _, _ -> null }

        client.listener.onMessage(
            fakeWs,
            """{"type":"report.request","correlation_id":"c2","attribution_token":"attr_c2"}""",
        )

        assertEquals(
            "a rejected request's token must not reach the session — a report carries the token minted for IT",
            "attr_bond",
            client.getCompanionAttribution(),
        )
        assertEquals(CompanionState.ReportInProgress, Companion.state.value)
        assertTrue(
            "expected a report.rejected(in_flight) text frame for the overlapping request",
            fakeWs.sentText.any {
                it.contains("\"type\":\"report.rejected\"") &&
                    it.contains("\"reason\":\"in_flight\"") &&
                    it.contains("\"correlation_id\":\"c2\"")
            },
        )
    }

    @Test
    fun onMessage_phoneDisconnected_transitionsToPhoneDisconnectedAndKeepsDeviceToken() {
        // Bond first so we have a non-null deviceToken to assert stability.
        client.listener.onMessage(
            fakeWs,
            """{"type":"pair.bonded","pair_id":"p","device_token":"d","device_token_expires_at":"2026-06-01T00:00:00.000Z"}""",
        )
        assertEquals(CompanionState.Paired, Companion.state.value)

        // Server emits this when the phone WS closes (browser tab close /
        // network drop). The TV must flip out of Paired so its UI reflects
        // reality; device_token + the underlying pair record stay intact so
        // a phone reconnect within the 5-min grace window will land a fresh
        // pair.bonded and flip back to Paired.
        val raw = """{"type":"phone.disconnected","pair_id":"p"}"""
        client.listener.onMessage(fakeWs, raw)

        assertEquals(CompanionState.PhoneDisconnected, Companion.state.value)
    }

    // ---------------- Task 11 review round 2 — preview session routing ----------------
    //
    // Round 1 shipped `previewSession`/`requestShot` wiring in `onMessage`
    // with no test exercising it at all — every defect the round-2 review
    // found (CRITICAL 1, part of CRITICAL 2) lived exactly in this ROUTING,
    // not in `CompanionPreviewSession` itself. These drive it with a
    // recording double instead of the real async capture loop — see
    // `RecordingPreviewSession`'s doc.

    @Test
    fun onMessage_previewStart_startsTheSessionWithTheMessagesCorrelationId() {
        client.listener.onMessage(fakeWs, """{"type":"preview.start","correlation_id":"c1"}""")
        assertEquals(listOf("c1"), previewSession.startCalls)
    }

    @Test
    fun onMessage_previewStop_stopsSilentlyAndDoesNotEchoAStopBack() {
        client.listener.onMessage(fakeWs, """{"type":"preview.stop","correlation_id":"c1","reason":"user"}""")

        assertEquals(1, previewSession.stopSilentlyCallCount)
        // `stopSilently()`, never `stop(reason)` — echoing a stop back at the
        // peer that just sent us one is nonsensical, and `stop(reason)`
        // would also try to send a frame over `fakeWs`.
        assertEquals(0, previewSession.stopCalls.size)
        assertTrue(fakeWs.sentText.none { it.contains("\"type\":\"preview.stop\"") })
    }

    @Test
    fun onMessage_shotRequest_passesTheMessagesOwnCorrelationIdNotSessionState() {
        // task-11 review round 2, CRITICAL 1 — round-1 shape called
        // `previewSession.handleShotRequest(msg.shotId, rect)` with NO
        // correlation id at all, relying on the session's own (frequently
        // stale or null) internal state. This asserts the ACTUAL fix: the
        // id on the incoming frame is what reaches the session, regardless
        // of whatever `preview.start`/`preview.stop` traffic did or didn't
        // precede it — reproducing the phone's real snapshot ordering
        // (`shot.request` immediately followed by `preview.stop`) without
        // needing the real session's async timing.
        client.listener.onMessage(fakeWs, """{"type":"preview.start","correlation_id":"c1"}""")
        client.listener.onMessage(fakeWs, """{"type":"preview.stop","correlation_id":"c1","reason":"user"}""")
        client.listener.onMessage(
            fakeWs,
            """{"type":"shot.request","correlation_id":"c1","shot_id":"s1"}""",
        )

        assertEquals(1, previewSession.requestShotCalls.size)
        val call = previewSession.requestShotCalls.single()
        assertEquals("c1", call.correlationId)
        assertEquals("s1", call.shotId)
        assertEquals(null, call.rect)
    }

    @Test
    fun onMessage_shotRequest_passesTheNormalizedRectWhenPresent() {
        client.listener.onMessage(
            fakeWs,
            """{"type":"shot.request","correlation_id":"c1","shot_id":"s1","rect":{"x":0.1,"y":0.2,"w":0.3,"h":0.4}}""",
        )

        val call = previewSession.requestShotCalls.single()
        assertEquals(NormalizedRect(0.1, 0.2, 0.3, 0.4), call.rect)
    }

    @Test
    fun onMessage_phoneDisconnected_alsoStopsThePreviewSilentlyAndClearsTheStash() {
        client.listener.onMessage(
            fakeWs,
            """{"type":"pair.bonded","pair_id":"p","device_token":"d","device_token_expires_at":"2026-06-01T00:00:00.000Z"}""",
        )
        client.listener.onMessage(fakeWs, """{"type":"phone.disconnected","pair_id":"p"}""")

        // Nobody left to send frames to — the third auto-stop trigger.
        assertEquals(1, previewSession.stopSilentlyCallCount)
        assertEquals(1, previewSession.clearStashCallCount)
    }

    @Test
    fun onMessage_pairExpired_alsoStopsThePreviewSilentlyAndClearsTheStash() {
        client.listener.onMessage(
            fakeWs,
            """{"type":"pair.bonded","pair_id":"p","device_token":"d","device_token_expires_at":"2026-06-01T00:00:00.000Z"}""",
        )
        client.listener.onMessage(fakeWs, """{"type":"pair.expired","pair_id":"p","reason":"inactivity"}""")

        // The pair this preview belonged to no longer exists — the fourth
        // auto-stop trigger.
        assertEquals(1, previewSession.stopSilentlyCallCount)
        assertEquals(1, previewSession.clearStashCallCount)
    }

    @Test
    fun onMessage_reportCancelled_clearsTheStash() {
        client.listener.onMessage(
            fakeWs,
            """{"type":"pair.bonded","pair_id":"p","device_token":"d","device_token_expires_at":"2026-06-01T00:00:00.000Z"}""",
        )
        client.listener.onMessage(fakeWs, """{"type":"report.cancelled","correlation_id":"c1"}""")

        // The report these captures were taken for is over. Before this, ONLY
        // pair-loss and backgrounding cleared the stash, so a cancelled report
        // left report-grade screenshots of the user's screen resident until
        // some LATER report happened to start under a new correlation id.
        // Correlation-SCOPED: an unconditional clear let a delayed
        // cancellation from an OLDER report delete the current report's
        // captures, after which a re-crop would silently capture the current
        // screen under the old shot id.
        assertEquals(listOf("c1"), previewSession.clearStashForIds)
    }

    @Test
    fun send_terminalReportFrame_clearsTheStash() {
        // The device is the sender of every terminal report frame, so the
        // outbound send is the one choke point that sees a report end however
        // it ended.
        client.send(ReportCompleted(correlationId = "c1", eventId = "e1"))
        assertEquals(1, previewSession.clearStashCallCount)

        client.send(ReportFailed(correlationId = "c1", reason = "nope"))
        assertEquals(2, previewSession.clearStashCallCount)

        // A non-terminal frame must NOT drop a live report's stash.
        client.send(PreviewStop(correlationId = "c1", reason = "user"))
        assertEquals(2, previewSession.clearStashCallCount)
    }

    @Test
    fun clientStop_tearsDownThePreviewSessionPermanently() {
        // task-11 review round 2, CRITICAL 2 — round-1 shape's `stop()`
        // cancelled the socket but never touched `previewSession` at all: a
        // capture loop already running would keep reading the user's screen
        // for up to 2 more minutes against a socket that no longer existed.
        // `teardown()`, not `stopSilently()` — this client is being torn
        // down for GOOD (the host builds a fresh `RelayWSClient` for its
        // next `start()`), so the session must not be left resumable.
        client.stop()

        assertEquals(1, previewSession.teardownCallCount)
    }

    @Test
    fun onStop_backgroundingAlsoStopsThePreviewSilentlyAndClearsTheStash_resumably() {
        // task-11 review round 2, CRITICAL 2 — the other half: process
        // backgrounding (`supersedeForBackground`, reached via `onStop`)
        // cancels the SOCKET but round-1 shape never touched the preview
        // session either — same leak, different trigger. Unlike `stop()`
        // above this must be `stopSilently()`, NOT `teardown()`: the SAME
        // client instance reconnects on foreground (see `onStart_after...`
        // tests above), so the session has to stay usable for a later
        // `preview.start`.
        client.onStop(FakeLifecycleOwner())

        assertEquals(1, previewSession.stopSilentlyCallCount)
        assertEquals(1, previewSession.clearStashCallCount)
        assertEquals(0, previewSession.teardownCallCount)
    }

    @Test
    fun onMessage_reportCancelled_returnsToPairedFromReportInProgress() {
        // Bond → report.request flips TV into ReportInProgress → phone
        // taps Discard → report.cancelled lands → TV must return to Paired.
        // Without this the TV's host UI sits on the "report in progress"
        // indicator forever even though the phone is back on bonded_idle.
        client.listener.onMessage(
            fakeWs,
            """{"type":"pair.bonded","pair_id":"p","device_token":"d","device_token_expires_at":"2026-06-01T00:00:00.000Z"}""",
        )
        // Provider returns a stub so report.request flips state synchronously.
        CompanionCaptureBridge.__captureProvider = { _, _ -> null }
        client.listener.onMessage(fakeWs, """{"type":"report.request","correlation_id":"corr_x"}""")
        // Re-enter ReportInProgress directly (the bridge's null-payload handler
        // may have synchronously flipped back to Paired — we want to verify the
        // cancel handler itself drives the transition). `__beginReport`, not
        // `__setState`: a report in flight has an identity, and only a frame
        // carrying the same correlation_id may end it (PR-fix 7). Standing the
        // state up without an owner would leave this cancel belonging to
        // nobody.
        Companion.__beginReport("corr_x")

        client.listener.onMessage(fakeWs, """{"type":"report.cancelled","correlation_id":"corr_x"}""")
        assertEquals(CompanionState.Paired, Companion.state.value)
    }

    // ---------------- a completion ends only ITS OWN report (PR-fix 7) -------
    //
    // The serial-report guard above rejects an overlapping request while one is
    // in flight. It does NOT cover this, because here the overlap is legal:
    // re-bonding sets the shared state back to `Paired`, so the new user's
    // request is accepted exactly as intended. The damage came from the OTHER
    // end — `launchSubmit` flipped the pair to `Paired` unconditionally when
    // the older upload finished, clearing a report that was still running. A
    // third request was then accepted over the second, re-freezing the replay
    // snapshot its composer was about to consume.

    @Test(timeout = 30_000)
    fun aStaleSubmitCompletionFromASupersededBond_doesNotEndTheLiveReport() {
        client.listener.onMessage(fakeWs, bondedFrame(attributionToken = "attr_a"))
        CompanionCaptureBridge.__captureProvider = { id, _ -> minimalAssembledPayload(id) }

        // The submit coroutine parks here so the whole re-bond happens strictly
        // inside user A's upload — the multi-second window a real multipart
        // POST occupies.
        val holdSubmit = java.util.concurrent.CountDownLatch(1)
        CompanionCaptureBridge.__submitProvider = { _, _, _, _, captureOwner, capturedAtSend ->
            suspend {
            holdSubmit.await(20, TimeUnit.SECONDS)
            CompanionCaptureBridge.SubmitResult.Ok("evt_a")

            }
        }

        // User A requests, and submits.
        client.listener.onMessage(fakeWs, """{"type":"report.request","correlation_id":"c1"}""")
        assertEquals(CompanionState.ReportInProgress, Companion.state.value)
        client.listener.onMessage(fakeWs, submitFrame("c1"))
        client.listener.onMessage(fakeWs, ByteString.of(1, 2, 3))

        // The pair is released and user B attaches: the relay force-closes only
        // the phone leg, so this same client gets a fresh `pair.bonded` and the
        // state legitimately returns to Paired. B's report is then accepted.
        client.listener.onMessage(fakeWs, bondedFrame(attributionToken = "attr_b"))
        assertEquals(CompanionState.Paired, Companion.state.value)
        client.listener.onMessage(fakeWs, """{"type":"report.request","correlation_id":"c2"}""")
        // Anti-vacuity: B's report really is the live one, so what follows
        // measures the guard rather than a client that ignored B.
        assertEquals(CompanionState.ReportInProgress, Companion.state.value)
        assertEquals("c2", Companion.__reportInProgressCorrelationIdForTesting())

        // NOW A's upload finishes.
        holdSubmit.countDown()
        awaitSentText("\"type\":\"report.completed\"")
        // The state write is the line after that send; give it room to land so
        // a green here is the guard and not a race the assertion won.
        Thread.sleep(300)

        assertEquals(
            "user A's completion must not clear user B's in-flight report",
            CompanionState.ReportInProgress,
            Companion.state.value,
        )
        assertEquals("c2", Companion.__reportInProgressCorrelationIdForTesting())

        // …and the guard is not a latch: B's own completion still ends it, so a
        // host is never stuck showing "report in progress".
        CompanionCaptureBridge.__submitProvider = { _, _, _, _, captureOwner, capturedAtSend ->
            suspend {
            CompanionCaptureBridge.SubmitResult.Ok("evt_b")

            }
        }
        client.listener.onMessage(fakeWs, submitFrame("c2"))
        client.listener.onMessage(fakeWs, ByteString.of(4, 5, 6))
        val deadline = System.currentTimeMillis() + 10_000
        while (Companion.state.value != CompanionState.Paired &&
            System.currentTimeMillis() < deadline
        ) {
            Thread.sleep(5)
        }
        assertEquals(CompanionState.Paired, Companion.state.value)
        assertNull(Companion.__reportInProgressCorrelationIdForTesting())
    }

    @Test
    fun aStaleCancelFromASupersededBond_doesNotEndTheLiveReport() {
        // Same shape on the phone-side Discard branch. That one also discards
        // the frozen replay snapshot, which by now belongs to the LIVE report —
        // so this assertion stands in for both halves, which the fix keeps
        // inside one ownership claim.
        client.listener.onMessage(fakeWs, bondedFrame())
        CompanionCaptureBridge.__captureProvider = { id, _ -> minimalAssembledPayload(id) }

        client.listener.onMessage(fakeWs, """{"type":"report.request","correlation_id":"c1"}""")
        client.listener.onMessage(fakeWs, bondedFrame())
        client.listener.onMessage(fakeWs, """{"type":"report.request","correlation_id":"c2"}""")
        assertEquals("c2", Companion.__reportInProgressCorrelationIdForTesting())

        client.listener.onMessage(fakeWs, """{"type":"report.cancelled","correlation_id":"c1"}""")
        assertEquals(
            "a cancel for a superseded report must not end the live one",
            CompanionState.ReportInProgress,
            Companion.state.value,
        )

        client.listener.onMessage(fakeWs, """{"type":"report.cancelled","correlation_id":"c2"}""")
        assertEquals(CompanionState.Paired, Companion.state.value)
    }

    /** Poll `fakeWs.sentText` until a frame containing [needle] shows up. */
    private fun awaitSentText(needle: String) {
        val deadline = System.currentTimeMillis() + 20_000
        while (System.currentTimeMillis() < deadline) {
            if (fakeWs.sentText.any { it.contains(needle) }) return
            Thread.sleep(5)
        }
        org.junit.Assert.fail("no frame containing $needle was sent within 20s")
    }

    @Test(timeout = 30_000)
    fun aCompletedSubmit_dropsThatReportsShotStash() {
        // The stash clear used to hang off `RelayWSClient.send()`, but
        // `CompanionCaptureBridge` writes its terminal `report.completed` /
        // `report.failed` frames straight onto the raw WebSocket — so a
        // perfectly normal successful submit left up to eight report-grade
        // screenshots of the user's screen resident until some later report,
        // disconnect or teardown. The hook now hangs off the report-end funnel
        // every one of those paths already goes through.
        client.listener.onMessage(fakeWs, bondedFrame())
        CompanionCaptureBridge.__captureProvider = { id, _ -> minimalAssembledPayload(id) }
        CompanionCaptureBridge.__submitProvider = { _, _, _, _, captureOwner, capturedAtSend ->
            suspend {
            CompanionCaptureBridge.SubmitResult.Ok("evt")

            }
        }

        client.listener.onMessage(fakeWs, """{"type":"report.request","correlation_id":"c1"}""")
        client.listener.onMessage(fakeWs, submitFrame("c1"))
        client.listener.onMessage(fakeWs, ByteString.of(1, 2, 3))
        awaitSentText("\"type\":\"report.completed\"")
        Thread.sleep(200)

        assertTrue(
            "a completed report must drop its own stash — got ${previewSession.clearStashForIds}",
            previewSession.clearStashForIds.contains("c1"),
        )
    }

    @Test(timeout = 30_000)
    fun stalledMultiShotSubmits_doNotAccumulateWithoutBound() {
        // The readiness gate retains the primary and any shots received so far
        // while an announced shot is outstanding. Before the gate, the primary
        // was consumed the moment it arrived. A bonded sender can therefore
        // open a submit, send a large primary, omit the announced shot, and
        // repeat — so the half-assembled submits are bounded.
        client.listener.onMessage(fakeWs, bondedFrame())
        CompanionCaptureBridge.__captureProvider = { id, _ -> minimalAssembledPayload(id) }
        CompanionCaptureBridge.__submitProvider = { _, _, _, _, captureOwner, capturedAtSend ->
            suspend {
            CompanionCaptureBridge.SubmitResult.Ok("evt")

            }
        }

        repeat(12) { i ->
            client.listener.onMessage(fakeWs, """{"type":"report.request","correlation_id":"c$i"}""")
            client.listener.onMessage(fakeWs, submitFrame("c$i", shotIds = listOf("s$i")))
            client.listener.onMessage(fakeWs, ByteString.of(*ByteArray(64) { 7 }))
            // …and never sends the announced shot.
        }

        assertTrue(
            "half-assembled submits must be bounded — got ${CompanionCaptureBridge.__pendingPairsCountForTesting()}",
            CompanionCaptureBridge.__pendingPairsCountForTesting() <= 6,
        )
    }

    @Test(timeout = 30_000)
    fun unsolicitedShotBinaries_areDroppedRatherThanBuffered() {
        // `shot.binary` is only legal behind a `report.submit` that announced
        // that shot. Buffering unannounced pairs let a bonded phone stream
        // unlimited marker/payload frames under ids of its own choosing into a
        // map cleared only at teardown — a straightforward way to exhaust the
        // device's memory.
        client.listener.onMessage(fakeWs, bondedFrame())
        CompanionCaptureBridge.__submitProvider = { _, _, _, _, captureOwner, capturedAtSend ->
            suspend {
            CompanionCaptureBridge.SubmitResult.Ok("evt")

            }
        }
        val before = CompanionCaptureBridge.__pendingPairsCountForTesting()

        repeat(20) { i ->
            client.listener.onMessage(
                fakeWs,
                """{"type":"shot.binary","correlation_id":"attacker$i","shot_id":"s$i"}""",
            )
            client.listener.onMessage(fakeWs, ByteString.of(1, 2, 3, 4))
        }

        assertEquals(
            "unsolicited shot binaries must not be retained",
            before,
            CompanionCaptureBridge.__pendingPairsCountForTesting(),
        )
    }

    @Test(timeout = 30_000)
    fun multiShotSubmit_deliversEveryAnnouncedShotToTheUploader() {
        // Before this, `shot.binary` was an unhandled discriminator and its
        // bytes were dropped: a multi-shot report uploaded ONLY the primary
        // screenshot and still reported success. The user's extra screenshots
        // were lost silently, and the admin payload card — which already
        // parses `screenshot-N` parts — had nothing to show.
        client.listener.onMessage(fakeWs, bondedFrame())
        CompanionCaptureBridge.__captureProvider = { id, _ -> minimalAssembledPayload(id) }
        val seenExtras = java.util.concurrent.atomic.AtomicReference<List<ByteArray>?>(null)
        CompanionCaptureBridge.__submitProvider = { _, _, extras, _, captureOwner, capturedAtSend ->
            suspend {
            seenExtras.set(extras)
            CompanionCaptureBridge.SubmitResult.Ok("evt")

            }
        }

        client.listener.onMessage(fakeWs, """{"type":"report.request","correlation_id":"c1"}""")
        client.listener.onMessage(fakeWs, submitFrame("c1", shotIds = listOf("s1", "s2")))
        client.listener.onMessage(fakeWs, ByteString.of(1, 2, 3)) // primary

        // The submit must NOT have fired yet: two announced shots are missing,
        // and firing on the primary alone is exactly how their bytes got lost.
        Thread.sleep(200)
        assertNull("submit must wait for every announced shot", seenExtras.get())

        client.listener.onMessage(fakeWs, """{"type":"shot.binary","correlation_id":"c1","shot_id":"s1"}""")
        client.listener.onMessage(fakeWs, ByteString.of(11, 11))
        client.listener.onMessage(fakeWs, """{"type":"shot.binary","correlation_id":"c1","shot_id":"s2"}""")
        client.listener.onMessage(fakeWs, ByteString.of(22, 22, 22))

        awaitSentText("\"type\":\"report.completed\"")
        val extras: List<ByteArray> = seenExtras.get() ?: emptyList()
        assertEquals("both announced shots must reach the uploader", 2, extras.size)
        // Ordered by the ANNOUNCED order, not arrival — the envelope's
        // `screenshot-N` suffixes have to line up with the phone's `shots[]`
        // array or annotations pair to the wrong image.
        assertEquals(2, extras[0].size)
        assertEquals(3, extras[1].size)
    }

    @Test
    fun concurrentPreparedReportsHaveTwoSlotBound() {
        val entered = java.util.concurrent.CountDownLatch(2)
        val release = java.util.concurrent.CountDownLatch(1)
        val completed = java.util.concurrent.CountDownLatch(2)
        val prepared = java.util.concurrent.atomic.AtomicInteger()
        CompanionCaptureBridge.__captureProvider = { id, _ -> minimalAssembledPayload(id) }
        CompanionCaptureBridge.__submitProvider = { _, _, _, _, _, _ ->
            prepared.incrementAndGet()
            suspend {
                entered.countDown()
                try { check(release.await(5, TimeUnit.SECONDS)); CompanionCaptureBridge.SubmitResult.Ok("done") }
                finally { completed.countDown() }
            }
        }
        try {
            repeat(3) { i ->
                client.listener.onMessage(fakeWs, bondedFrame(attributionToken = null))
                client.listener.onMessage(fakeWs, """{"type":"report.request","correlation_id":"bounded-$i"}""")
                client.listener.onMessage(fakeWs, submitFrame("bounded-$i"))
                client.listener.onMessage(fakeWs, ByteString.of(1))
            }
            assertTrue(entered.await(3, TimeUnit.SECONDS))
            assertEquals(2, prepared.get())
            assertTrue(fakeWs.sentText.any { it.contains("submit_capacity") })
        } finally { release.countDown(); assertTrue(completed.await(3, TimeUnit.SECONDS)) }
    }

    private fun submitFrame(correlationId: String, shotIds: List<String> = emptyList()): String {
        val shots = if (shotIds.isEmpty()) "" else {
            ""","shots":[""" + shotIds.joinToString(",") { """{"shot_id":"$it","annotations":[]}""" } + "]"
        }
        return """{"type":"report.submit","correlation_id":"$correlationId",""" +
            """"title":"t","description":{"text":"d","redactions":[]},"annotations":[],""" +
            """"includes":{"logs":false,"metadata":false,"network":false,""" +
            """"screenshot":true,"uiTree":false}$shots}"""
    }

    private fun unusedSubmitFrame(correlationId: String): String =
        """{"type":"report.submit","correlation_id":"$correlationId",""" +
            """"title":"t","description":{"text":"d","redactions":[]},"annotations":[],""" +
            """"includes":{"logs":false,"metadata":false,"network":false,""" +
            """"screenshot":true,"uiTree":false}}"""

    /** The smallest `report.assembled` the bridge will accept, so a request
     *  leaves the pair in `ReportInProgress` instead of failing straight back
     *  to `Paired` the way a null provider does. */
    private fun minimalAssembledPayload(correlationId: String) =
        CompanionCaptureBridge.AssembledPayload(
            assembled = com.traceitx.protocol.generated.ReportAssembled(
                correlationId = correlationId,
                counts = com.traceitx.protocol.generated.ReportAssembledCounts(
                    logs = 0L, network = 0L, uiTreeNodes = 0L,
                ),
                mime = "image/png",
                size = 1L,
                toggles = com.traceitx.protocol.generated.ReportAssembledToggles(
                    logs = true, metadata = true, network = true,
                    screenshot = true, uiTree = false,
                ),
                tree = null,
            ),
            pngBytes = byteArrayOf(1),
        )

    @Test
    fun onMessage_phoneDisconnectedThenPairBonded_returnsToPaired() {
        // Bond → phone.disconnected → reconnect bond. Covers the
        // grace-window reconnect path end-to-end on the client side.
        val bonded = """{"type":"pair.bonded","pair_id":"p","device_token":"d","device_token_expires_at":"2026-06-01T00:00:00.000Z"}"""
        client.listener.onMessage(fakeWs, bonded)
        assertEquals(CompanionState.Paired, Companion.state.value)

        client.listener.onMessage(fakeWs, """{"type":"phone.disconnected","pair_id":"p"}""")
        assertEquals(CompanionState.PhoneDisconnected, Companion.state.value)

        // Server-issued bond after phone reconnects with its device_token.
        client.listener.onMessage(fakeWs, bonded)
        assertEquals(CompanionState.Paired, Companion.state.value)
    }

    @Test
    fun onMessage_malformedFrame_isDroppedSilently() {
        val before = Companion.state.value
        client.listener.onMessage(fakeWs, "{not json")
        client.listener.onMessage(fakeWs, """{"type":"unknown.kind","x":1}""")
        // No crash; state untouched. (`unknown.kind` IS a decoder error
        // because the sealed class has no matching `@SerialName` branch.)
        assertEquals(before, Companion.state.value)
    }

    // ---------------- onClosing close-code mapping ----------------

    @Test
    fun onClosing_4002PairExpired_returnsToUnpairedClearsPairUrlAndRePairs() {
        // Establish a pairUrl + Paired first.
        client.listener.onMessage(
            fakeWs,
            """{"type":"pair.created","pair_id":"p","pair_token":"tok_xyz"}""",
        )
        client.listener.onMessage(
            fakeWs,
            """{"type":"pair.bonded","pair_id":"p","device_token":"d","device_token_expires_at":"2026-06-01T00:00:00.000Z"}""",
        )
        assertEquals(CompanionState.Paired, Companion.state.value)
        assertEquals("https://relay.example.test/r/tok_xyz", Companion.pairUrl.value)

        client.listener.onClosing(fakeWs, RelayWSClient.CLOSE_PAIR_EXPIRED, "pair_expired")
        assertEquals(CompanionState.Unpaired, Companion.state.value)
        // Socket close is the one place pairUrl is nulled.
        assertNull(Companion.pairUrl.value)
        // Terminal means "this PAIR is dead", not "this device is done". The
        // state above has already been reset to Unpaired with no pairUrl, so
        // without a reconnect a TV box would sit on a blank screen with no
        // path back (a browser SPA can be reloaded; a lobby TV cannot).
        assertEquals(listOf(1_000L), scheduled)
    }

    @Test
    fun onClosing_terminalCode_releasesTheSocketSoForegroundRecoveryAlsoWorks() {
        // If `ws` still held the dead socket, onStart's "already alive" guard
        // would read a corpse as a live connection and block the ONLY other
        // recovery route, leaving stopCompanion/startCompanion as the sole way
        // back from a blank screen.
        client.listener.onClosing(fakeWs, RelayWSClient.CLOSE_TOKEN_NOT_FOUND, "token_not_found")
        assertNull(
            "the dead socket must be released, not left installed",
            client.__currentSocketForTesting(),
        )

        val before = okHttp.sockets.size
        client.onStart(FakeLifecycleOwner())
        assertEquals(
            "foreground recovery must be able to open a fresh socket",
            before + 1,
            okHttp.sockets.size,
        )
    }

    @Test
    fun afterATerminalClose_theDeviceEndsUpWithALiveQrAgain() {
        // The invariant, stated end to end: a terminal close must not leave an
        // Android TV showing nothing forever.
        val http = FakeWebSocketOkHttpClient()
        val c = RelayWSClient(
            client = http,
            baseUrl = "https://relay.example.test",
            scheduler = { _, action -> action() },
        )
        c.onStart(FakeLifecycleOwner())
        c.listener.onMessage(
            http.sockets.last(),
            """{"type":"pair.created","pair_id":"p","pair_token":"tok_1"}""",
        )
        assertEquals("https://relay.example.test/r/tok_1", Companion.pairUrl.value)

        val socketsBefore = http.sockets.size
        c.listener.onClosing(
            http.sockets.last(),
            RelayWSClient.CLOSE_TOKEN_NOT_FOUND,
            "token_not_found",
        )
        // Mid-flight: QR gone, state Unpaired — this is the blank screen.
        assertNull(Companion.pairUrl.value)
        // The close must have driven a genuinely new connection (the scheduler
        // here runs the armed action inline). Asserting the socket COUNT, not
        // just that some socket exists, is what makes this fail if the client
        // merely keeps holding the dead one.
        assertEquals(
            "a terminal close must re-announce and dial a new socket",
            socketsBefore + 1,
            http.sockets.size,
        )

        // The relay answers the new socket with a fresh pair.
        c.listener.onMessage(
            http.sockets.last(),
            """{"type":"pair.created","pair_id":"p2","pair_token":"tok_2"}""",
        )
        assertEquals(
            "the device must recover to a live, scannable QR on its own",
            "https://relay.example.test/r/tok_2",
            Companion.pairUrl.value,
        )
        assertEquals(CompanionState.Unpaired, Companion.state.value)
    }

    @Test
    fun onClosing_4005ServerShutdown_schedulesReconnect() {
        client.listener.onClosing(fakeWs, RelayWSClient.CLOSE_SERVER_SHUTDOWN, "server_shutdown")
        assertEquals(listOf(1_000L), scheduled)
    }

    @Test
    fun onClosing_4008TvAnnounceBacklog_isRetryable() {
        // 4008 was missing from the constant table entirely. The relay sheds
        // announce load with it, so it MUST reconnect rather than sit dead.
        client.listener.onClosing(fakeWs, RelayWSClient.CLOSE_TV_ANNOUNCE_BACKLOG, "tv_announce_backlog")
        assertEquals(listOf(1_000L), scheduled)
    }

    @Test
    fun closeCodeConstants_matchTheServerCatalog() {
        // AUTHORITY: the relay threat model §close code catalog.
        // The names drifted across the whole 4001..4007 range; the numbers and
        // the terminal/retry split did not.
        assertEquals(4001, RelayWSClient.CLOSE_ALREADY_BONDED)
        assertEquals(4002, RelayWSClient.CLOSE_PAIR_EXPIRED)
        assertEquals(4003, RelayWSClient.CLOSE_GRACE_EXCEEDED)
        assertEquals(4004, RelayWSClient.CLOSE_TOKEN_NOT_FOUND)
        assertEquals(4005, RelayWSClient.CLOSE_SERVER_SHUTDOWN)
        assertEquals(4006, RelayWSClient.CLOSE_MALFORMED_FRAME)
        assertEquals(4007, RelayWSClient.CLOSE_OVERSIZE_BINARY_FRAME)
        assertEquals(4008, RelayWSClient.CLOSE_TV_ANNOUNCE_BACKLOG)
    }

    @Test
    fun onClosing_terminalCodes_clearCodeAndAttachedUserNameWithPairUrl() {
        // `code` and `attachedUserName` share pairUrl's lifecycle. A stale
        // display code sends the dashboard user chasing a row that is gone.
        Companion.__setCode("LMN-421")
        client.listener.onMessage(fakeWs, bondedFrame(companionUser = "Ada Lovelace"))
        assertEquals("Ada Lovelace", Companion.attachedUserName.value)

        client.listener.onClosing(fakeWs, RelayWSClient.CLOSE_TOKEN_NOT_FOUND, "token_not_found")

        assertNull(Companion.pairUrl.value)
        assertNull(Companion.code.value)
        assertNull(Companion.attachedUserName.value)
        assertNull(
            "the attribution token dies with the pair",
            client.getCompanionAttribution(),
        )
    }

    @Test
    fun onClosing_1006Abnormal_schedulesReconnect() {
        client.listener.onClosing(fakeWs, RelayWSClient.CLOSE_ABNORMAL, "abnormal")
        assertEquals(listOf(1_000L), scheduled)
    }

    @Test
    fun onFailure_schedulesReconnect() {
        client.listener.onFailure(fakeWs, RuntimeException("boom"), null)
        assertEquals(listOf(1_000L), scheduled)
    }

    // ---------------- ProcessLifecycleOwner observer ----------------

    @Test
    fun onStop_marksPhoneDisconnected() {
        client.listener.onMessage(
            fakeWs,
            """{"type":"pair.bonded","pair_id":"p","device_token":"d","device_token_expires_at":"2026-06-01T00:00:00.000Z"}""",
        )
        assertEquals(CompanionState.Paired, Companion.state.value)

        val owner = FakeLifecycleOwner()
        client.onStop(owner)
        assertEquals(CompanionState.PhoneDisconnected, Companion.state.value)
    }

    @Test
    fun onStart_afterStopReconnectsViaDeviceToken() {
        // Bond and disconnect.
        client.listener.onMessage(
            fakeWs,
            """{"type":"pair.bonded","pair_id":"p","device_token":"d","device_token_expires_at":"2026-06-01T00:00:00.000Z"}""",
        )
        val owner = FakeLifecycleOwner()
        client.onStop(owner)
        assertEquals(CompanionState.PhoneDisconnected, Companion.state.value)

        // onStart should attempt reconnect. Since the OkHttpClient is real
        // and the URL points to a non-existent host, we just verify the
        // method does not throw.
        try {
            client.onStart(owner)
        } catch (t: Throwable) {
            // OkHttp's newWebSocket schedules I/O — no synchronous throw.
            org.junit.Assert.fail("onStart must not throw synchronously: $t")
        }
    }

    // ---------------- companion attach (spec 2026-08-07) ----------------

    private fun bondedFrame(
        attributionToken: String? = null,
        companionUser: String? = null,
    ): String {
        val fields = buildList {
            add(""""type":"pair.bonded"""")
            add(""""pair_id":"p"""")
            add(""""device_token_expires_at":"2026-06-01T00:00:00.000Z"""")
            if (attributionToken != null) add(""""attribution_token":"$attributionToken"""")
            if (companionUser != null) add(""""companion_user":{"display_name":"$companionUser"}""")
        }
        return "{${fields.joinToString(",")}}"
    }

    @Test
    fun pairBonded_withCompanionFields_publishesAttachedUserNameAndStoresTheToken() {
        client.listener.onMessage(
            fakeWs,
            bondedFrame(attributionToken = "attr_tok_1", companionUser = "Ada Lovelace"),
        )

        assertEquals("Ada Lovelace", Companion.attachedUserName.value)
        assertEquals("attr_tok_1", client.getCompanionAttribution())
        assertEquals(CompanionState.Paired, Companion.state.value)
    }

    @Test
    fun pairBonded_onAnOrdinaryQrBond_resetsAttachedUserNameAndTokenToNull() {
        // The load-bearing case: a dashboard attach, then a release, then an
        // ordinary QR pairing on the SAME session. Nothing from the earlier
        // companion identity may survive into the QR bond.
        client.listener.onMessage(
            fakeWs,
            bondedFrame(attributionToken = "attr_tok_1", companionUser = "Ada Lovelace"),
        )
        assertEquals("attr_tok_1", client.getCompanionAttribution())

        // A plain QR bond carries neither optional field.
        client.listener.onMessage(fakeWs, bondedFrame())

        assertNull(
            "attachedUserName must reset, not linger from the earlier attach",
            Companion.attachedUserName.value,
        )
        assertNull(
            "the attribution token must reset — a QR report must not be credited to a dashboard user",
            client.getCompanionAttribution(),
        )
    }

    // External review, finding N2 — attach state must clear on detach/
    // reconnect, parity with the web ws-client's three attachedUserName-
    // clearing boundaries (pair.created, pair.expired, client teardown).

    @Test
    fun pairExpired_afterAnAttributedBond_clearsAttachedUserName() {
        client.listener.onMessage(
            fakeWs,
            bondedFrame(attributionToken = "attr_tok_1", companionUser = "Ada Lovelace"),
        )
        assertEquals("Ada Lovelace", Companion.attachedUserName.value)

        client.listener.onMessage(
            fakeWs,
            """{"type":"pair.expired","pair_id":"p","reason":"inactivity"}""",
        )

        assertNull(Companion.attachedUserName.value)
    }

    @Test
    fun pairCreated_afterAnAttributedBond_clearsAttachedUserName() {
        // Simulates a reconnect on the same socket: a fresh `pair.created` is
        // by construction unbonded, so any attach state a previous bond left
        // behind is stale and must not survive it.
        client.listener.onMessage(
            fakeWs,
            bondedFrame(attributionToken = "attr_tok_1", companionUser = "Ada Lovelace"),
        )
        assertEquals("Ada Lovelace", Companion.attachedUserName.value)

        client.listener.onMessage(
            fakeWs,
            """{"type":"pair.created","pair_id":"p2","pair_token":"tok_2"}""",
        )

        assertNull(Companion.attachedUserName.value)
    }

    @Test
    fun stop_afterAnAttributedBond_clearsAttachedUserName() {
        client.listener.onMessage(
            fakeWs,
            bondedFrame(attributionToken = "attr_tok_1", companionUser = "Ada Lovelace"),
        )
        assertEquals("Ada Lovelace", Companion.attachedUserName.value)

        client.stop()

        assertNull(Companion.attachedUserName.value)
    }

    @Test
    fun reportRequest_withAFreshToken_overwritesTheBondTimeToken() {
        client.listener.onMessage(fakeWs, bondedFrame(attributionToken = "attr_bond"))
        CompanionCaptureBridge.__captureProvider = { _, _ -> null }

        client.listener.onMessage(
            fakeWs,
            """{"type":"report.request","correlation_id":"c1","attribution_token":"attr_fresh"}""",
        )

        assertEquals("attr_fresh", client.getCompanionAttribution())
    }

    @Test
    fun reportRequest_withoutAToken_leavesTheExistingTokenIntact() {
        client.listener.onMessage(fakeWs, bondedFrame(attributionToken = "attr_bond"))
        CompanionCaptureBridge.__captureProvider = { _, _ -> null }

        client.listener.onMessage(fakeWs, """{"type":"report.request","correlation_id":"c1"}""")

        assertEquals(
            "an older relay sends no per-report token; the bond-time one must survive",
            "attr_bond",
            client.getCompanionAttribution(),
        )
    }

    @Test
    fun pairExpiredThenPairCreated_onOneSocket_leavesALiveUpdatedPairUrl() {
        // Release rotates the pair token: pair.expired(inactivity) followed by
        // a NEW pair.created on the same open socket. `pair.expired` with that
        // reason means "show your QR again", not "the pair is dead" — the host
        // must never be left with no QR.
        client.listener.onMessage(fakeWs, """{"type":"pair.created","pair_id":"p","pair_token":"tok_1"}""")
        client.listener.onMessage(fakeWs, bondedFrame(companionUser = "Ada Lovelace"))
        assertEquals(CompanionState.Paired, Companion.state.value)

        client.listener.onMessage(fakeWs, """{"type":"pair.expired","pair_id":"p","reason":"inactivity"}""")
        assertEquals(CompanionState.Unpaired, Companion.state.value)
        assertEquals(
            "the QR must stay on screen through the release",
            "https://relay.example.test/r/tok_1",
            Companion.pairUrl.value,
        )

        client.listener.onMessage(fakeWs, """{"type":"pair.created","pair_id":"p2","pair_token":"tok_2"}""")
        assertEquals(
            "the rotated pair token must replace the old QR",
            "https://relay.example.test/r/tok_2",
            Companion.pairUrl.value,
        )
        assertEquals(CompanionState.Unpaired, Companion.state.value)
    }

    // ---------------- stale-socket guards ----------------

    @Test
    fun framesFromASupersededSocket_areIgnored() {
        val stale = fakeWs
        client.onStop(FakeLifecycleOwner())   // cancels + drops the socket
        client.onStart(FakeLifecycleOwner())  // opens a fresh one
        assertTrue("expected a genuinely new socket", okHttp.sockets.last() !== stale)

        // The stale socket's OWN listener — the one OkHttp would call back for
        // it — not the current attempt's.
        stale.listener.onMessage(stale, """{"type":"pair.created","pair_id":"p","pair_token":"stale_tok"}""")

        assertNull(
            "a frame from a socket we already replaced must not touch state",
            Companion.pairUrl.value,
        )
    }

    @Test
    fun supersedingASocket_cancelsThePredecessorAndItsFailureArmsNothing() {
        // The overwrite-without-cancel shape: OkHttp keeps a socket we merely
        // stop referencing alive and connected — a second live /relay/tv and a
        // duplicate device row in the dashboard. And our own supersede-cancel
        // comes back through onFailure on the OLD socket, which must not read
        // as a drop or it tears down the socket that just replaced it.
        val http = FakeWebSocketOkHttpClient()
        val delays = mutableListOf<Long>()
        val c = RelayWSClient(
            client = http,
            baseUrl = "https://relay.example.test",
            scheduler = { delayMs, action -> delays.add(delayMs); action() },
        )
        c.onStart(FakeLifecycleOwner())
        val first = http.sockets.single()

        first.listener.onFailure(first, RuntimeException("drop"), null)
        val second = http.sockets.last()
        assertTrue("the reconnect must open a new socket", second !== first)
        assertTrue("the predecessor must be cancelled, not left connected", first.cancelled)

        delays.clear()
        // The supersede-cancel arrives on the socket we replaced, through that
        // socket's own listener — which is exactly what must stay silent.
        first.listener.onFailure(first, java.io.IOException("Canceled"), null)

        assertTrue("a superseded socket's failure must not arm a reconnect", delays.isEmpty())
        assertEquals("and must not open a third socket", 2, http.sockets.size)
    }

    @Test(timeout = 10_000)
    fun aFailureArrivingBeforeTheSocketReferenceIsStored_stillReconnects() {
        // THE defect this test exists for. `client.newWebSocket(…)` starts
        // connecting the moment it is called, so an immediate DNS / TLS /
        // connection-refused error is delivered — on OkHttp's dispatcher
        // thread — BEFORE it returns the reference `openSocket` stores. A
        // guard that answers "is this socket ours?" by comparing identity
        // against the stored reference reads the PREDECESSOR during that
        // window, calls a genuine failure stale, and returns without arming a
        // reconnect. The dead socket is then installed, `onStart`'s
        // "already alive" guard reads it as a live connection, and the device
        // never dials again.
        //
        // `FailBeforeReturnOkHttpClient` reproduces exactly that interleaving,
        // deterministically: the callback runs on a DIFFERENT thread and is
        // joined before `newWebSocket` returns. (It is also why nothing may
        // hold the client's lock across that call — this test deadlocks, and
        // trips its timeout, if that regresses.)
        val http = FailBeforeReturnOkHttpClient()
        val delays = mutableListOf<Long>()
        val c = RelayWSClient(
            client = http,
            baseUrl = "https://relay.example.test",
            // Inline, so the recovery this arms is observable in-test.
            scheduler = { delayMs, action -> delays.add(delayMs); action() },
        )

        c.onStart(FakeLifecycleOwner())

        // Anti-vacuity: the failure really did land inside `newWebSocket`.
        assertTrue(
            "precondition: the failure must be delivered before the socket is returned",
            http.failedBeforeReturn,
        )
        assertEquals("an immediate connect failure must arm a reconnect", listOf(1_000L), delays)
        assertEquals("and that reconnect must dial again", 2, http.sockets.size)
        assertEquals(
            "the dead socket must never be left installed as the live one",
            http.sockets[1],
            c.__currentSocketForTesting(),
        )
        assertTrue("the dead socket is cancelled, not leaked", http.sockets[0].cancelled)

        // The other half, on the same client: our own supersede-cancel comes
        // back as a failure on that dead socket, and must still stay silent.
        delays.clear()
        http.sockets[0].listener.onFailure(
            http.sockets[0], java.io.IOException("Canceled"), null,
        )
        assertTrue("a supersede-cancel must still not arm a reconnect", delays.isEmpty())
        assertEquals("nor open a third socket", 2, http.sockets.size)
    }

    @Test
    fun oneDropSignalledTwice_armsExactlyOneReconnectAndOpensOneSocket() {
        // A real drop signals TWICE within ~ms: onClosing then onFailure.
        // Before the generation-scoped dedup this produced two reconnects,
        // two announces, two single-use tickets and two dashboard rows for
        // one device.
        val http = FakeWebSocketOkHttpClient()
        val pending = mutableListOf<() -> Unit>()
        val delays = mutableListOf<Long>()
        val c = RelayWSClient(
            client = http,
            baseUrl = "https://relay.example.test",
            scheduler = { delayMs, action -> delays.add(delayMs); pending.add(action) },
        )
        c.onStart(FakeLifecycleOwner())
        val live = http.sockets.single()

        c.listener.onClosing(live, RelayWSClient.CLOSE_ABNORMAL, "abnormal")
        c.listener.onFailure(live, java.io.IOException("boom"), null)

        assertEquals("one drop must arm exactly one reconnect", 1, pending.size)
        assertEquals(listOf(1_000L), delays)

        pending.single().invoke()
        assertEquals("and that reconnect must open exactly one socket", 2, http.sockets.size)
    }

    @Test
    fun aStaleTimerFiringAfterANewerAttempt_doesNotReplaceTheHealthySocket() {
        val http = FakeWebSocketOkHttpClient()
        val pending = mutableListOf<() -> Unit>()
        val c = RelayWSClient(
            client = http,
            baseUrl = "https://relay.example.test",
            scheduler = { _, action -> pending.add(action) },
        )
        c.onStart(FakeLifecycleOwner())
        c.listener.onFailure(http.sockets.single(), java.io.IOException("drop"), null)
        assertEquals(1, pending.size)

        // A foreground bounce supersedes the armed timer with a newer attempt.
        c.onStop(FakeLifecycleOwner())
        c.onStart(FakeLifecycleOwner())
        assertEquals(2, http.sockets.size)

        pending.single().invoke()

        assertEquals(
            "a superseded timer must drop, not cancel a connection that is already healthy",
            2,
            http.sockets.size,
        )
    }

    @Test
    fun aReconnectTimerArmedBeforeBackgrounding_doesNotOpenASocketWhileBackgrounded() {
        // The second resurrection route, independent of the announce race: a
        // drop arms a timer, the process backgrounds inside the backoff, and
        // the timer fires on the scheduler regardless of lifecycle. `onStop`
        // cancelling the socket does nothing about it — only superseding the
        // generation (and clearing the armed marker) does.
        val http = FakeWebSocketOkHttpClient()
        val pending = mutableListOf<() -> Unit>()
        val c = RelayWSClient(
            client = http,
            baseUrl = "https://relay.example.test",
            scheduler = { _, action -> pending.add(action) },
        )
        c.onStart(FakeLifecycleOwner())
        c.listener.onFailure(http.sockets.single(), java.io.IOException("drop"), null)
        assertEquals("precondition: the drop armed a reconnect", 1, pending.size)

        c.onStop(FakeLifecycleOwner())
        pending.single().invoke()

        assertEquals(
            "a timer armed before backgrounding must not open a socket while backgrounded",
            1,
            http.sockets.size,
        )

        c.onStart(FakeLifecycleOwner())
        assertEquals(
            "and foregrounding still recovers, with exactly one socket",
            2,
            http.sockets.size,
        )
    }

    @Test
    fun onStart_doesNotOpenSecondWebSocketWhenOneAlreadyAlive() {
        // Repro for the duplicate-WS bug: ProcessLifecycleOwner.addObserver()
        // synthesizes onStart immediately when registered against an already-
        // STARTED owner. start() opens WS #1 in connectInitial(); the synth
        // onStart would open WS #2 unless guarded — each WS mints its own
        // pair_id, server then has two competing pairs and the QR/scan race
        // produces the "first scan expired" symptom. See TraceItX.companion
        // logcat trace from 2026-05-22 (clientId=221172518, two pair.created
        // from a single RelayWSClient.start).
        //
        // We can't call start() directly here (the header comment explains
        // why), so we exercise the same code path by simulating its effect:
        // call onStart twice in a row. The first call opens WS, the second
        // is the "addObserver synthesis" replay — must no-op.
        val counter = FakeWebSocketOkHttpClient()
        val c = RelayWSClient(
            client = counter,
            baseUrl = "https://relay.example.test",
            scheduler = { delayMs, _ -> scheduled.add(delayMs) },
        )
        val owner = FakeLifecycleOwner()

        c.onStart(owner)
        assertEquals("first onStart() must open exactly one WebSocket", 1, counter.sockets.size)

        c.onStart(owner)
        assertEquals(
            "second onStart() must NOT open another WebSocket (ws already alive)",
            1, counter.sockets.size,
        )
    }

    @Test
    fun onStart_afterOnStopReopensExactlyOneWebSocket() {
        // Sanity check: the guard must not break the legitimate
        // background→foreground reconnect path. After onStop cancels the WS
        // (sets the AtomicReference to null), onStart should open a fresh
        // one.
        val counter = FakeWebSocketOkHttpClient()
        val c = RelayWSClient(
            client = counter,
            baseUrl = "https://relay.example.test",
            scheduler = { delayMs, _ -> scheduled.add(delayMs) },
        )
        val owner = FakeLifecycleOwner()

        c.onStart(owner)           // counter -> 1, ws populated
        assertEquals(1, counter.sockets.size)

        c.onStop(owner)            // cancels and nulls the WS
        c.onStart(owner)           // genuine reconnect — counter -> 2
        assertEquals("expected one open per legitimate foregrounding", 2, counter.sockets.size)
    }

    // ---------------- Backoff cap ----------------

    @Test
    fun computeBackoff_capsAt10Seconds() {
        assertEquals(1_000L, client.computeBackoff(0))
        assertEquals(2_000L, client.computeBackoff(1))
        assertEquals(4_000L, client.computeBackoff(2))
        assertEquals(8_000L, client.computeBackoff(3))
        assertEquals(10_000L, client.computeBackoff(4))
        // Plateau at 10s past the table.
        assertEquals(10_000L, client.computeBackoff(5))
        assertEquals(10_000L, client.computeBackoff(50))
        assertEquals(10_000L, client.computeBackoff(Int.MAX_VALUE))
    }

    @Test
    fun scheduleReconnect_dedupesRepeatedSignalsWithinOneAttempt() {
        // Three signals, one live attempt, one armed timer. (Before the
        // dedup this recorded 1s/2s/4s — three reconnects for one drop.)
        client.scheduleReconnect()
        client.scheduleReconnect()
        client.scheduleReconnect()
        assertEquals(listOf(1_000L), scheduled)
    }

    @Test
    fun successiveDrops_advanceThroughTheBackoffTable() {
        val http = FakeWebSocketOkHttpClient()
        val delays = mutableListOf<Long>()
        val c = RelayWSClient(
            client = http,
            baseUrl = "https://relay.example.test",
            scheduler = { delayMs, action -> delays.add(delayMs); action() },
        )
        c.onStart(FakeLifecycleOwner())

        // Each drop is of the socket that is currently live, so each is a
        // genuinely new attempt rather than a deduped repeat signal.
        repeat(3) {
            c.listener.onFailure(c.__currentSocketForTesting()!!, RuntimeException("drop"), null)
        }

        assertEquals(listOf(1_000L, 2_000L, 4_000L), delays)
        assertEquals("one reconnect per drop", 4, http.sockets.size)
    }

    // ---------------- Fakes ----------------

    /**
     * Minimal `WebSocket` stand-in — records the frames sent by the listener.
     *
     * Carries the listener OkHttp was handed for it, because the client now
     * builds one listener per connect attempt (stamped with that attempt's
     * generation) rather than sharing a single object. Driving a superseded
     * socket through `client.listener` would prove nothing: that property is
     * the CURRENT attempt's listener by definition. Real OkHttp calls back the
     * listener the socket was created with, and so do the tests below.
     */
    private class FakeWebSocket(val listener: WebSocketListener) : WebSocket {
        // CopyOnWriteArrayList, not mutableListOf(). These are written by the
        // SDK's OWN threads (the submit coroutine, the reconnect scheduler)
        // through send(), and read from the test thread — `awaitSentText`
        // polls `sentText.any { … }` every 5ms for up to 20s while a report
        // upload is in flight. An ArrayList iterator throws
        // ConcurrentModificationException if an append lands mid-iteration,
        // which is exactly what
        // `aStaleSubmitCompletionFromASupersededBond_doesNotEndTheLiveReport`
        // hit on CI (RelayWSClientTest.kt:1148) — a data race in the test's own
        // fake, not in the client under test, and one that surfaces only when
        // the machine is loaded enough to interleave the two.
        //
        // Copy-on-write is the right shape here rather than a synchronized
        // wrapper: reads iterate an immutable snapshot so they can never throw
        // or need external locking, and writes are rare (a handful of frames
        // per test) so the copy cost is irrelevant.
        val sentText: MutableList<String> = java.util.concurrent.CopyOnWriteArrayList()
        val sentBinary: MutableList<ByteString> = java.util.concurrent.CopyOnWriteArrayList()
        var cancelled: Boolean = false
            private set

        override fun queueSize(): Long = 0
        override fun send(text: String): Boolean {
            sentText.add(text); return true
        }
        override fun send(bytes: ByteString): Boolean {
            sentBinary.add(bytes); return true
        }
        override fun close(code: Int, reason: String?): Boolean = true
        override fun cancel() { cancelled = true }
        override fun request(): okhttp3.Request = okhttp3.Request.Builder().url("https://x.test").build()
    }

    /**
     * `OkHttpClient` whose `newWebSocket` hands back a recorded
     * [FakeWebSocket] instead of dialling. Everything else about the connect
     * path — generation check, `ws` install, cancel-the-predecessor — runs
     * for real, which is what makes the listener guards observable.
     */
    private class FakeWebSocketOkHttpClient : OkHttpClient() {
        val sockets: MutableList<FakeWebSocket> = mutableListOf()
        val requestedUrls: MutableList<String> = mutableListOf()

        override fun newWebSocket(
            request: okhttp3.Request,
            listener: okhttp3.WebSocketListener,
        ): WebSocket {
            requestedUrls.add(request.url.toString())
            return FakeWebSocket(listener).also { sockets.add(it) }
        }
    }

    /**
     * `OkHttpClient` that fails the FIRST socket the way a real immediate
     * connect error does: from another thread, while `newWebSocket` has not
     * returned yet, so the client has had no chance to store the reference.
     * The join is what makes the interleaving deterministic instead of a race
     * this test would win most of the time and lose in CI.
     */
    private class FailBeforeReturnOkHttpClient : OkHttpClient() {
        val sockets: MutableList<FakeWebSocket> = mutableListOf()

        @Volatile
        var failedBeforeReturn: Boolean = false
            private set

        override fun newWebSocket(
            request: okhttp3.Request,
            listener: WebSocketListener,
        ): WebSocket {
            val socket = FakeWebSocket(listener)
            sockets.add(socket)
            if (sockets.size == 1) {
                val dispatcher = Thread {
                    listener.onFailure(
                        socket,
                        java.io.IOException("Failed to connect to relay.example.test"),
                        null,
                    )
                }
                dispatcher.start()
                dispatcher.join()
                failedBeforeReturn = true
            }
            return socket
        }
    }

    /** Minimal `LifecycleOwner` — only used as the argument to onStart/onStop. */
    private class FakeLifecycleOwner : LifecycleOwner {
        private val registry = LifecycleRegistry(this).apply {
            currentState = Lifecycle.State.STARTED
        }
        override val lifecycle: Lifecycle = registry
    }

    /**
     * Task 11 review round 2 — a recording double for
     * [CompanionPreviewSessionApi], injected via [RelayWSClient]'s
     * `previewSessionForTesting` seam. Lets the ROUTING (which incoming
     * frame calls which session method, with which arguments) be asserted
     * directly and synchronously, without driving the real session's async
     * capture loop through Robolectric's paused main Looper — that loop's
     * own behavior is already covered by `CompanionPreviewSessionTest`.
     */
    private class RecordingPreviewSession : CompanionPreviewSessionApi {
        data class ShotCall(val correlationId: String, val shotId: String, val rect: NormalizedRect?)

        var startCalls = mutableListOf<String>()
        var stopCalls = mutableListOf<PreviewStopReason>()
        var stopSilentlyCallCount = 0
        var clearStashCallCount = 0
        var requestShotCalls = mutableListOf<ShotCall>()
        var teardownCallCount = 0

        override var isRunning: Boolean = false

        override fun start(correlationId: String) {
            startCalls += correlationId
            isRunning = true
        }

        override fun stop(reason: PreviewStopReason) {
            stopCalls += reason
            isRunning = false
        }

        override fun stopSilently() {
            stopSilentlyCallCount++
            isRunning = false
        }

        var clearStashForIds = mutableListOf<String>()

        override fun clearStashFor(correlationId: String) {
            clearStashForIds += correlationId
        }

        override fun clearStash() {
            clearStashCallCount++
        }

        override fun requestShot(correlationId: String, shotId: String, rect: NormalizedRect?) {
            requestShotCalls += ShotCall(correlationId, shotId, rect)
        }

        override fun teardown() {
            teardownCallCount++
            isRunning = false
        }
    }
}
