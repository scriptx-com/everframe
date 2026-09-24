// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The JOIN in the companion attribution chain (spec 2026-08-07), and the
// invariant PR-fix 1 added to it.
//
// The two ends of that chain are covered elsewhere:
//   • relay socket -> RelayWSClient.getCompanionAttribution()
//     — RelayWSClientAnnounceTest / RelayWSClientTest
//   • ReportSubmitter -> MultipartUploader -> X-TX-Companion-Attribution
//     — transport/CompanionAttributionHeaderTest (literal token)
//
// Neither touches the wiring that connects them. These tests drive real
// `pair.bonded` / `report.request` / `report.submit` frames into a started
// `RelayWSClient`, let the real `CompanionCaptureBridge` pair them, run a real
// `CompanionSubmissionComposer.submit(...)` through the real
// `ReportSubmitter`/`MultipartUploader`, and assert on the header the ingest
// server actually received.
//
// THE INVARIANT (PR-fix 1). The token on a report's ingest POST must be the
// one that belonged to THAT report's `report.request` — never whatever the
// live session holds when the HTTP request finally gets built. A submit runs
// for seconds and deliberately outlives `stopCompanion()`; in that window the
// pair can be released and a different dashboard user can attach (a fresh
// `pair.bonded` down the same TV socket) or the host can swap relay clients
// entirely. Reading late credited the old report to the new user AND — because
// ingest consumes attribution tokens single-use — burned the token the new
// user's own next report needed. `aSubmitInFlight*` below reproduce both
// routes to that swap.

package dev.everframe.companion

import android.graphics.Bitmap
import dev.everframe.Everframe
import dev.everframe.config.Environment
import dev.everframe.config.ReportResult
import dev.everframe.config.EverframeConfig
import dev.everframe.protocol.generated.ReportAssembled
import dev.everframe.protocol.generated.ReportAssembledCounts
import dev.everframe.protocol.generated.ReportAssembledToggles
import dev.everframe.protocol.generated.ReportSubmit
import dev.everframe.transport.MultipartUploader
import dev.everframe.transport.ReportSubmitter
import okhttp3.OkHttpClient
import okhttp3.WebSocket
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.ByteString
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class CompanionAttributionFlowTest {

    private lateinit var ingest: MockWebServer
    private val startedClients = mutableListOf<RelayWSClient>()
    private lateinit var activity: android.app.Activity

    @Before
    fun setUp() {
        resetCompanion()
        CompanionCaptureBridge.__teardownForTesting()
        ingest = MockWebServer()
        ingest.start()

        activity = Robolectric.buildActivity(android.app.Activity::class.java).create().get()
        Everframe.start(
            activity.applicationContext,
            EverframeConfig(
                appId = "test-app-id",
                sdkKey = "txx_live_test1234567890",
                environment = Environment.production,
            ),
        )
        // Point the composer's submit at the local ingest server. The real
        // ReportSubmitter and MultipartUploader still run.
        CompanionSubmissionComposer.__submitterFactoryForTesting = { cfg, outbox ->
            ReportSubmitter(
                config = cfg,
                outbox = outbox,
                uploader = MultipartUploader(
                    OkHttpClient.Builder()
                        .connectTimeout(5, TimeUnit.SECONDS)
                        .readTimeout(5, TimeUnit.SECONDS)
                        .writeTimeout(5, TimeUnit.SECONDS)
                        .build(),
                ),
                endpointOverride = ingest.url("/api/ingest").toString(),
            )
        }
    }

    @After
    fun tearDown() {
        CompanionSubmissionComposer.__submitterFactoryForTesting = null
        CompanionCaptureBridge.__teardownForTesting()
        startedClients.forEach { it.stop() }
        startedClients.clear()
        ingest.shutdown()
        resetCompanion()
        Everframe.kill()
    }

    private fun resetCompanion() {
        Companion.__setState(CompanionState.Unpaired)
        Companion.__setPairUrl(null)
        Companion.__setCode(null)
        Companion.__setAttachedUserName(null)
    }

    // ---------------- the join ----------------

    @Test
    fun theTokenMintedForThisReportReachesIngest() {
        val client = startRelaySessionBondedWith(attributionToken = "attr_tok_bond")
        assertEquals(
            "precondition: the relay session must be holding the token",
            "attr_tok_bond",
            client.getCompanionAttribution(),
        )

        val recorded = runOneReport(client, correlationId = "c-join")

        assertEquals(
            "the report must carry its own session's token onto the ingest POST",
            "attr_tok_bond",
            recorded.getHeader("X-TX-Companion-Attribution"),
        )
    }

    @Test
    fun anOrdinaryQrBondSubmitsWithNoAttributionHeader() {
        // Same code path, no companion attach — no frame carries an
        // attribution_token, so nothing may be claimed on the POST.
        val client = startRelaySessionBondedWith(attributionToken = null)
        assertNull(client.getCompanionAttribution())

        val recorded = runOneReport(client, correlationId = "c-qr")

        assertNull(
            "a QR-paired report must not be credited to any dashboard user",
            recorded.getHeader("X-TX-Companion-Attribution"),
        )
    }

    @Test
    fun aFreshTokenFromReportRequestIsWhatReachesIngest() {
        // The relay re-mints per report; the newest token must win all the way
        // to the wire, not just inside the client.
        val client = startRelaySessionBondedWith(attributionToken = "attr_bond")

        val recorded = runOneReport(
            client,
            correlationId = "c-fresh",
            requestAttributionToken = "attr_fresh",
        )

        assertEquals("attr_fresh", recorded.getHeader("X-TX-Companion-Attribution"))
    }

    // ---------------- PR-fix 1: the report owns its token ----------------

    /**
     * ROUTE 1 — the same pair re-bonds to a different dashboard user while
     * user A's report is still composing. The relay does exactly this: a
     * release bumps `bondGeneration` and the next attach sends a fresh
     * `pair.bonded`, carrying the NEW user's token, down the SAME TV socket
     * (the relay service `attachPhone`). The TV socket is not
     * closed by a release, so one `RelayWSClient` instance serves both users.
     */
    @Test
    fun aSubmitInFlightWhenThePairRebondsToAnotherUserKeepsTheFirstUsersToken() {
        val client = startRelaySessionBondedWith(attributionToken = "attr_user_a_bond")

        val recorded = runOneReport(
            client,
            correlationId = "c-rebond",
            requestAttributionToken = "attr_user_a_report",
            // Runs on the bridge's submit coroutine, after this report's
            // inputs are assembled and before the ingest POST is built —
            // i.e. exactly the window a real multi-second upload sits in.
            duringComposition = {
                client.listener.onMessage(
                    socketOf(client),
                    """{"type":"pair.bonded","pair_id":"p1","attribution_token":"attr_user_b"}""",
                )
            },
        )

        // Anti-vacuity: the swap really happened — the live session was
        // holding user B's token by the time the POST went out.
        assertEquals(
            "the session must actually have re-bonded to user B mid-submit",
            "attr_user_b",
            client.getCompanionAttribution(),
        )
        assertEquals(
            "user A's report must keep user A's token — crediting it to user B " +
                "also consumes B's single-use token, so B's own next report " +
                "would land unattributed",
            "attr_user_a_report",
            recorded.getHeader("X-TX-Companion-Attribution"),
        )
    }

    /**
     * ROUTE 2 — the host tears the companion session down and starts a new one
     * for a different user while A's report is still composing.
     * `EverframeModule.stopCompanion()` deliberately does NOT cancel in-flight
     * submit coroutines, so the old composition runs on against a brand new
     * relay client.
     */
    @Test
    fun aSubmitInFlightWhenTheHostRestartsCompanionForAnotherUserKeepsTheFirstUsersToken() {
        val clientA = startRelaySessionBondedWith(attributionToken = "attr_user_a_bond")
        val clientBRef = AtomicReference<RelayWSClient?>(null)

        val recorded = runOneReport(
            clientA,
            correlationId = "c-swap",
            requestAttributionToken = "attr_user_a_report",
            duringComposition = {
                // The full `EverframeModule.stopCompanion()` teardown, including
                // the attribution-slot release it performs. An in-flight submit
                // must already own its token by now — if the fix leaned on the
                // slot still being readable at compose time, this call alone
                // would strip the header.
                clientA.stop()
                CompanionCaptureBridge.__clearPendingAttribution()
                clientBRef.set(startRelaySessionBondedWith(attributionToken = "attr_user_b"))
            },
        )

        val clientB = clientBRef.get()
        assertNotNull("the replacement session must have started", clientB)
        assertEquals(
            "the replacement session must actually be holding user B's token",
            "attr_user_b",
            clientB!!.getCompanionAttribution(),
        )
        assertEquals(
            "user A's report must keep user A's token across a client swap",
            "attr_user_a_report",
            recorded.getHeader("X-TX-Companion-Attribution"),
        )
    }

    /**
     * The QR direction of the same invariant: a report requested over an
     * ordinary QR bond has NO token, and must not acquire one because a
     * dashboard user attached while it was composing.
     */
    @Test
    fun anOrdinaryQrReportStaysUnattributedWhenSomeoneAttachesMidSubmit() {
        val client = startRelaySessionBondedWith(attributionToken = null)

        val recorded = runOneReport(
            client,
            correlationId = "c-qr-swap",
            duringComposition = {
                client.listener.onMessage(
                    socketOf(client),
                    """{"type":"pair.bonded","pair_id":"p1","attribution_token":"attr_late_attach"}""",
                )
            },
        )

        assertEquals(
            "anti-vacuity: someone really did attach mid-submit",
            "attr_late_attach",
            client.getCompanionAttribution(),
        )
        assertNull(
            "a QR-paired report must never pick up a token minted for someone else",
            recorded.getHeader("X-TX-Companion-Attribution"),
        )
    }

    // ---------------- fixtures ----------------

    /**
     * Starts a real [RelayWSClient] against a fake socket factory, then feeds
     * it a `pair.bonded` frame through the real listener on the socket the
     * client installed. Deliberately assertion-free: it is also called from
     * the bridge's submit coroutine, where a failed JUnit assertion would be
     * swallowed rather than failing the test.
     */
    private fun startRelaySessionBondedWith(attributionToken: String?): RelayWSClient {
        val client = RelayWSClient(
            client = FakeWebSocketOkHttpClient(),
            baseUrl = "https://relay.example.test",
            scheduler = { _, _ -> },
        )
        startedClients.add(client)
        client.start()
        val socket = socketOf(client)
        val attribution =
            if (attributionToken != null) ""","attribution_token":"$attributionToken"""" else ""
        client.listener.onMessage(
            socket,
            """{"type":"pair.bonded","pair_id":"p1"$attribution}""",
        )
        return client
    }

    private fun socketOf(client: RelayWSClient): WebSocket =
        client.__currentSocketForTesting()
            ?: error("RelayWSClient has no installed socket")

    /**
     * Drives ONE full phone-initiated report through the real machinery:
     * `report.request` → `CompanionCaptureBridge` → `report.submit` + the
     * D-05 binary frame → the bridge's submit coroutine → the real
     * `CompanionSubmissionComposer` → the local ingest server. Returns the
     * request the ingest server received.
     *
     * [duringComposition] runs inside the submit provider — after this
     * report's `Inputs` are assembled, before the composer builds the HTTP
     * request. That is the window a real multi-second multipart upload
     * occupies, and the window the PR-fix 1 tests use to swap users.
     *
     * The submit provider installed here stands in for
     * `EverframeModule.installCompanionBridgeProviders()`'s (that module is a
     * separate Gradle project with no runnable test host — see
     * `packages/sdk-react-native/__tests__/companion-bridge-wiring.spec.ts`).
     * Everything either side of it is production code.
     *
     * `submit()` marshals the replay read onto `Dispatchers.Main`, and under
     * Robolectric's PAUSED LooperMode a posted runnable never runs on its own —
     * so the submit runs on the bridge's own IO scope while this thread drains
     * the main looper (same shape as `CompanionSubmissionComposerTest`).
     */
    private fun runOneReport(
        client: RelayWSClient,
        correlationId: String,
        requestAttributionToken: String? = null,
        duringComposition: () -> Unit = {},
    ): RecordedRequest {
        ingest.enqueue(MockResponse().setResponseCode(200).setBody("{}"))

        CompanionCaptureBridge.__captureProvider = { id, _ -> minimalPayload(id) }

        val resultRef = AtomicReference<ReportResult?>(null)
        val providerFailure = AtomicReference<Throwable?>(null)
        CompanionCaptureBridge.__submitProvider = { submit: ReportSubmit,
                                                    _: ByteArray,
                                                    _: List<ByteArray>,
                                                    companionAttribution: String?, captureOwner, capturedAtSend ->
            suspend {
            try {
                val inputs = CompanionSubmissionComposer.Inputs(
            capture = captureOwner,
                    activity = activity,
                    captureBitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888),
                    title = submit.title,
                    description = submit.description.text,
                    includeLogs = submit.includes.logs,
                    includeNetwork = submit.includes.network,
                    includeMetadata = submit.includes.metadata,
                    hostExtra = null,
                    companionAttribution = companionAttribution,
                    capturedSession = capturedAtSend,
                )
                duringComposition()
                val result = CompanionSubmissionComposer.submit(inputs)
                resultRef.set(result)
                CompanionCaptureBridge.SubmitResult.Ok("evt")
            } catch (t: Throwable) {
                providerFailure.set(t)
                resultRef.set(ReportResult.Cancelled("test_provider_threw"))
                CompanionCaptureBridge.SubmitResult.Err("test_provider_threw")
            }

            }
        }

        val socket = socketOf(client)
        val requestAttribution =
            if (requestAttributionToken != null) {
                ""","attribution_token":"$requestAttributionToken""""
            } else {
                ""
            }
        client.listener.onMessage(
            socket,
            """{"type":"report.request","correlation_id":"$correlationId"$requestAttribution}""",
        )
        client.listener.onMessage(
            socket,
            """{"type":"report.submit","correlation_id":"$correlationId",""" +
                """"title":"Attribution flow","description":{"text":"d","redactions":[]},""" +
                """"annotations":[],""" +
                """"includes":{"logs":false,"metadata":false,"network":false,""" +
                """"screenshot":true,"uiTree":false}}""",
        )
        // D-05: the baked annotated PNG follows the submit text frame. Content
        // is irrelevant here — the submit provider composes from its own
        // bitmap, exactly as the RN module does when decoding fails.
        client.listener.onMessage(socket, ByteString.of(1, 2, 3))

        val deadline = System.currentTimeMillis() + 20_000
        while (resultRef.get() == null && System.currentTimeMillis() < deadline) {
            shadowOf(android.os.Looper.getMainLooper()).idle()
            Thread.sleep(5)
        }
        providerFailure.get()?.let { throw AssertionError("submit provider threw", it) }
        val result = resultRef.get() ?: error("submit() did not complete within 20s")
        assertTrue(
            "expected Submitted (the local ingest server answers 200), got $result",
            result is ReportResult.Submitted,
        )

        return ingest.takeRequest(5, TimeUnit.SECONDS)
            ?: error("ingest server received no request")
    }

    private fun minimalPayload(correlationId: String) =
        CompanionCaptureBridge.AssembledPayload(
            assembled = ReportAssembled(
                correlationId = correlationId,
                counts = ReportAssembledCounts(logs = 0L, network = 0L, uiTreeNodes = 0L),
                mime = "image/png",
                size = 1L,
                toggles = ReportAssembledToggles(
                    logs = true, metadata = true, network = true,
                    screenshot = true, uiTree = false,
                ),
                tree = null,
            ),
            pngBytes = byteArrayOf(1),
        )

    /** Hands `openSocket` a recorded fake instead of dialling; the client's
     *  own install / cancel / generation logic still runs. */
    private class FakeWebSocketOkHttpClient : OkHttpClient() {
        val sockets: MutableList<WebSocket> = mutableListOf()

        override fun newWebSocket(
            request: okhttp3.Request,
            listener: okhttp3.WebSocketListener,
        ): WebSocket = FakeWebSocket().also { sockets.add(it) }
    }

    private class FakeWebSocket : WebSocket {
        override fun queueSize(): Long = 0
        override fun send(text: String): Boolean = true
        override fun send(bytes: ByteString): Boolean = true
        override fun close(code: Int, reason: String?): Boolean = true
        override fun cancel() = Unit
        override fun request(): okhttp3.Request =
            okhttp3.Request.Builder().url("https://x.test").build()
    }
}
