// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// End-to-end tests for the announce-before-connect leg (spec 2026-08-07),
// driven against a real `MockWebServer` that serves BOTH the announce POST and
// the relay WebSocket upgrade. Nothing here stubs `openSocket`: every
// assertion is about the URL a real OkHttp WebSocket actually dialled and the
// requests the server actually received, so the guards inside `beginConnect` /
// `openSocket` are genuinely executed.
//
// MockWebServer binds loopback, so these stay deterministic and offline.
//
// *** THESE TESTS DO NOT RUN IN CI. *** `.github/workflows/android.yml`'s "JVM
// unit tests" step is `./gradlew testReleaseUnitTest testDebugUnitTest` with no
// `--continue`, and `testReleaseUnitTest` has been failing since 2026-05-11
// (measured 2026-08-10: 419 tests, 163 failed — R8 renames the internals those
// tests name by string). Gradle aborts before `testDebugUnitTest` is scheduled,
// so no unit test in this module is gated by CI today. Run it locally:
//
//     cd packages/sdk-android/android && ./gradlew :everframe-core:testDebugUnitTest
//
// If you repair the workflow (add `--continue`, or fix the release variant),
// delete this note — it describes a broken job, not these tests.
//
// Unlike `CompanionAnnounceTest`, this file DOES compile and run in the release
// variant: it never class-loads an obfuscated type by name.

package dev.everframe.companion

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
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
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class RelayWSClientAnnounceTest {

    private lateinit var server: MockWebServer
    private lateinit var relay: RelayDispatcher
    private var client: RelayWSClient? = null
    private lateinit var baseUrl: String

    @Before
    fun setUp() {
        resetCompanion()
        relay = RelayDispatcher()
        server = MockWebServer()
        server.dispatcher = relay
        server.start()
        baseUrl = server.url("/").toString()
    }

    @After
    fun tearDown() {
        client?.stop()
        client = null
        server.shutdown()
        resetCompanion()
        CompanionCaptureBridge.__captureProvider = null
        CompanionCaptureBridge.__submitProvider = null
        // :core ← :reporter-ui seam, process-global — don't leak across tests.
        dev.everframe.Everframe.__attachPinUiInstalled = false
    }

    /** `Companion` is a process-global Kotlin `object` — reset every flow. */
    private fun resetCompanion() {
        Companion.__setState(CompanionState.Unpaired)
        Companion.__setPairUrl(null)
        Companion.__setCode(null)
        Companion.__setAttachedUserName(null)
        Companion.__setAttachChallenge(null)
        Companion.__setResolvedName(null)
    }

    private fun newClient(
        sdkKey: String? = "sdk_key_abc",
        deviceLabel: String? = null,
        deviceProvider: (suspend () -> AnnounceDevice?)? = null,
        scheduler: (Long, () -> Unit) -> Unit = { _, _ -> },
        /**
         * Stands in for `ProcessLifecycleOwner.get().lifecycle.currentState`,
         * which `start()` reads to catch "already backgrounded when the host
         * started us". The default here is what a real Robolectric process
         * reports — measured: `INITIALIZED`, because nothing attaches the
         * process observer in a JVM unit test — so the default path through
         * these tests behaves exactly as the production default does on this
         * host. `RelayWSClientTest` leaves the parameter off entirely and so
         * still exercises the real `ProcessLifecycleOwner` read.
         */
        processLifecycleState: () -> Lifecycle.State = { Lifecycle.State.INITIALIZED },
        attachPinUi: AttachPinUi = AttachPinUi.BUILTIN,
    ): RelayWSClient = RelayWSClient(
        client = OkHttpClient(),
        baseUrl = baseUrl,
        scheduler = scheduler,
        sdkKey = sdkKey,
        deviceLabel = deviceLabel,
        deviceProvider = deviceProvider,
        processLifecycleState = processLifecycleState,
        attachPinUi = attachPinUi,
    ).also { client = it }

    private fun nextSocketPath(): String? = relay.socketPaths.poll(5, TimeUnit.SECONDS)

    private fun <T> awaitValue(what: String, read: () -> T?): T {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (System.nanoTime() < deadline) {
            read()?.let { return it }
            Thread.sleep(10)
        }
        throw AssertionError("timed out waiting for $what")
    }

    // ---------------- happy path ----------------

    @Test
    fun start_announcesThenOpensTheTicketedSocketAndPublishesTheCode() {
        relay.announceResponses.add(announce200("tkt_first", "LMN-421"))

        newClient(deviceLabel = "Lobby TV").start()

        assertEquals("/relay/tv/tkt_first", nextSocketPath())
        assertEquals(1, relay.announceCount.get())
        assertEquals("Bearer sdk_key_abc", relay.announceAuth.single())
        assertEquals("""{"label":"Lobby TV"}""", relay.announceBodies.single())
        assertEquals("LMN-421", awaitValue("Companion.code") { Companion.code.value })
    }

    // ---------------- supportsAttachPin capability (spec 2026-08-19) ----------------

    @Test
    fun attachPinUiCustom_advertisesSupportsAttachPinRegardlessOfTheBuiltinUiSeam() {
        dev.everframe.Everframe.__attachPinUiInstalled = false
        relay.announceResponses.add(announce200("tkt_custom", "AAA-111"))

        newClient(deviceLabel = "Lobby TV", attachPinUi = AttachPinUi.CUSTOM).start()

        assertEquals("/relay/tv/tkt_custom", nextSocketPath())
        assertEquals(
            """{"label":"Lobby TV","supportsAttachPin":true}""",
            relay.announceBodies.single(),
        )
    }

    @Test
    fun attachPinUiOff_neverAdvertisesSupportsAttachPinEvenWithTheBuiltinUiInstalled() {
        dev.everframe.Everframe.__attachPinUiInstalled = true
        try {
            relay.announceResponses.add(announce200("tkt_off", "AAA-111"))

            newClient(attachPinUi = AttachPinUi.OFF).start()

            assertEquals("/relay/tv/tkt_off", nextSocketPath())
            assertEquals("{}", relay.announceBodies.single())
        } finally {
            dev.everframe.Everframe.__attachPinUiInstalled = false
        }
    }

    @Test
    fun attachPinUiBuiltin_advertisesSupportsAttachPinOnlyWhenTheBuiltinUiSeamIsInstalled() {
        dev.everframe.Everframe.__attachPinUiInstalled = false
        relay.announceResponses.add(announce200("tkt_builtin_off", "AAA-111"))

        newClient(attachPinUi = AttachPinUi.BUILTIN).start()

        assertEquals("/relay/tv/tkt_builtin_off", nextSocketPath())
        assertEquals(
            "BUILTIN without the reporter-ui seam installed must not claim the capability",
            "{}",
            relay.announceBodies.single(),
        )
    }

    @Test
    fun attachPinUiBuiltin_withTheUiSeamInstalled_advertisesSupportsAttachPin() {
        dev.everframe.Everframe.__attachPinUiInstalled = true
        try {
            relay.announceResponses.add(announce200("tkt_builtin_on", "AAA-111"))

            newClient(attachPinUi = AttachPinUi.BUILTIN).start()

            assertEquals("/relay/tv/tkt_builtin_on", nextSocketPath())
            assertEquals("""{"supportsAttachPin":true}""", relay.announceBodies.single())
        } finally {
            dev.everframe.Everframe.__attachPinUiInstalled = false
        }
    }

    // ---------------- announce failure must never cost reporting ----------------

    @Test
    fun announceFailure_fallsBackToTheTicketlessSocketAndStillPairs() {
        // A revoked SDK key. The device must lose its dashboard listing and
        // nothing else: the QR still works and reports still land.
        relay.announceResponses.add(
            MockResponse().setResponseCode(401).setBody("""{"error":"invalid_sdk_key"}"""),
        )

        newClient().start()

        assertEquals(
            "a failed announce must open the plain socket, with no trailing ticket segment",
            "/relay/tv",
            nextSocketPath(),
        )
        assertNull("no display code when the announce failed", Companion.code.value)

        val serverSocket = relay.serverSockets.poll(5, TimeUnit.SECONDS)
        assertNotNull(serverSocket)
        serverSocket!!.send("""{"type":"pair.created","pair_id":"p1","pair_token":"tok_1"}""")

        assertEquals(
            "${baseUrl.trimEnd('/')}/r/tok_1",
            awaitValue("pairUrl") { Companion.pairUrl.value },
        )
        assertEquals(CompanionState.Unpaired, Companion.state.value)
    }

    @Test
    fun announce404_onAnOlderServer_fallsBackToTheTicketlessSocket() {
        relay.announceResponses.add(MockResponse().setResponseCode(404))
        newClient().start()
        assertEquals("/relay/tv", nextSocketPath())
    }

    @Test
    fun announceWithABlankTicket_fallsBackToTicketlessRatherThanDialingRelayTvSlash() {
        // A 200 whose ticket is empty must NOT compose `/relay/tv/` — the relay
        // rejects that as 4004 (terminal), which costs the device a full
        // re-pair cycle instead of the clean fallback the contract promises.
        relay.announceResponses.add(
            MockResponse().setResponseCode(200)
                .setHeader("Content-Type", "application/json")
                .setBody("""{"ticket":"","code":""}"""),
        )

        newClient().start()

        assertEquals("/relay/tv", nextSocketPath())
        assertNull(Companion.code.value)
    }

    // ---------------- opt-in: no key, no HTTP ----------------

    @Test
    fun withoutAnSdkKey_noAnnounceRequestIsEverMade() {
        newClient(sdkKey = null).start()

        assertEquals("/relay/tv", nextSocketPath())
        assertEquals(
            "companion discovery is opt-in — an unconfigured host must make no HTTP call at all",
            0,
            relay.announceCount.get(),
        )
        assertNull(Companion.code.value)
    }

    // ---------------- one ticket per attempt ----------------

    @Test
    fun everyReconnectAttemptAnnouncesAgainWithAFreshTicket() {
        // Tickets are single-use with a 60s TTL. Caching one means every
        // reconnect after the first closes 4004 forever and the device
        // silently disappears from the dashboard.
        relay.announceResponses.add(announce200("tkt_first", "AAA-111"))
        relay.announceResponses.add(announce200("tkt_second", "BBB-222"))
        val pending = LinkedBlockingQueue<() -> Unit>()

        newClient(scheduler = { _, action -> pending.put(action) }).start()

        assertEquals("/relay/tv/tkt_first", nextSocketPath())
        val serverSocket = relay.serverSockets.poll(5, TimeUnit.SECONDS)!!

        // Drop the connection from the server side.
        serverSocket.close(1001, "going away")

        val reconnect = pending.poll(5, TimeUnit.SECONDS)
        assertNotNull("the drop must arm a reconnect", reconnect)
        reconnect!!.invoke()

        assertEquals(
            "the reconnect must announce again and carry a DIFFERENT ticket",
            "/relay/tv/tkt_second",
            nextSocketPath(),
        )
        assertEquals(2, relay.announceCount.get())
        assertEquals("BBB-222", awaitValue("refreshed code") { Companion.code.value })
    }

    @Test
    fun oneDropSignalledTwice_producesExactlyOneAnnounceAndOneSocket() {
        // The trap: a real drop signals through onClosing AND onFailure ~ms
        // apart. Once each reconnect announces, an undeduped second signal
        // spends a second single-use ticket and opens a second socket — two
        // rows for one device in the dashboard, the exact surface this whole
        // feature exists to produce.
        //
        // Three announce responses are queued so a surplus announce WOULD be
        // served (and therefore WOULD be observable) if the dedup regressed.
        relay.announceResponses.add(announce200("tkt_1", "AAA-111"))
        relay.announceResponses.add(announce200("tkt_2", "BBB-222"))
        relay.announceResponses.add(announce200("tkt_3", "CCC-333"))
        val pending = LinkedBlockingQueue<() -> Unit>()

        val c = newClient(scheduler = { _, action -> pending.put(action) })
        c.start()

        assertEquals("/relay/tv/tkt_1", nextSocketPath())
        val live = awaitValue("the installed socket") { c.__currentSocketForTesting() }
        assertEquals(1, relay.announceCount.get())

        c.listener.onClosing(live, RelayWSClient.CLOSE_ABNORMAL, "abnormal")
        c.listener.onFailure(live, java.io.IOException("boom"), null)

        assertEquals("one drop must arm exactly one reconnect", 1, pending.size)
        pending.take().invoke()

        assertEquals("/relay/tv/tkt_2", nextSocketPath())
        assertEquals(
            "exactly one announce per connect attempt",
            2,
            relay.announceCount.get(),
        )
        // Nothing else may show up on the wire afterwards.
        assertNull("no third socket", relay.socketPaths.poll(500, TimeUnit.MILLISECONDS))
        assertEquals(2, relay.announceCount.get())
    }

    @Test
    fun stop_supersedesAnInFlightAnnounceSoNoSocketIsOpenedAfterwards() {
        // The announce hop is up to 5s wide; a host that stops the client
        // inside that window must not have a socket resurrected under it.
        relay.announceResponses.add(announce200("tkt_late", "ZZZ-999").setBodyDelay(1, TimeUnit.SECONDS))

        val c = newClient()
        c.start()
        c.stop()

        assertNull(
            "a superseded announce must not open a socket",
            relay.socketPaths.poll(3, TimeUnit.SECONDS),
        )
        assertNull("nor publish its already-dead display code", Companion.code.value)
    }

    // ---------------- backgrounding must supersede the in-flight attempt ----------------

    @Test
    fun backgroundingDuringAnAnnounce_opensNoSocket_andForegroundingAnnouncesAfresh() {
        // THE defect. The announce is an awaited HTTP call in front of EVERY
        // socket open, so at the moment the process backgrounds there is
        // usually no socket for `onStop` to cancel — only an attempt in
        // flight. Unless backgrounding supersedes that attempt, its
        // continuation passes `isAttemptCurrent` and dials: the device stays
        // listed in the dashboard and keeps accepting capture requests with no
        // UI behind it.
        relay.announceResponses.add(
            announce200("tkt_bg", "ZZZ-999").setBodyDelay(1, TimeUnit.SECONDS),
        )
        relay.announceResponses.add(announce200("tkt_fg", "AAA-111"))
        val owner = FakeLifecycleOwner()

        val c = newClient()
        c.start()
        // Anti-vacuity: the announce really IS in flight before we background.
        awaitValue("the in-flight announce") { relay.announceCount.get().takeIf { it >= 1 } }
        assertNull("precondition: no socket yet", relay.socketPaths.poll())

        c.onStop(owner)

        assertNull(
            "a superseded announce must not open a socket while backgrounded",
            relay.socketPaths.poll(3, TimeUnit.SECONDS),
        )
        assertNull("nor publish its already-dead display code", Companion.code.value)
        assertEquals(
            "and nothing may announce again while backgrounded",
            1,
            relay.announceCount.get(),
        )

        // The complementary half: recovery must announce AGAIN — the ticket it
        // superseded is single-use with a 60s TTL — and exactly once. Zero
        // leaves the device permanently invisible; two lists it twice.
        c.onStart(owner)

        assertEquals("/relay/tv/tkt_fg", nextSocketPath())
        assertEquals(2, relay.announceCount.get())
        assertEquals("AAA-111", awaitValue("the refreshed code") { Companion.code.value })
        assertNull(
            "exactly one socket for one foregrounding",
            relay.socketPaths.poll(500, TimeUnit.MILLISECONDS),
        )
    }

    @Test
    fun repeatedBackgroundingDuringSuccessiveAnnounces_stillRecoversExactlyOnce() {
        // Background → foreground → background, each bounce landing inside a
        // DIFFERENT announce. Every superseded attempt must drop, and the last
        // foregrounding must still end with one live socket off an announce of
        // its own.
        relay.announceResponses.add(
            announce200("tkt_1", "AAA-111").setBodyDelay(1, TimeUnit.SECONDS),
        )
        relay.announceResponses.add(
            announce200("tkt_2", "BBB-222").setBodyDelay(1, TimeUnit.SECONDS),
        )
        relay.announceResponses.add(announce200("tkt_3", "CCC-333"))
        val owner = FakeLifecycleOwner()

        val c = newClient()
        c.start()
        awaitValue("announce #1") { relay.announceCount.get().takeIf { it >= 1 } }

        c.onStop(owner)
        // Foregrounding here also proves `onStop` released `connectInFlight`:
        // the superseded attempt's `finishAttempt` no-ops on its stale
        // generation, so a flag left set would wedge this guard forever and
        // the device would never come back at all.
        c.onStart(owner)
        awaitValue("announce #2") { relay.announceCount.get().takeIf { it >= 2 } }
        c.onStop(owner)

        assertNull(
            "no socket may open while backgrounded, however many attempts were superseded",
            relay.socketPaths.poll(3, TimeUnit.SECONDS),
        )
        assertEquals(2, relay.announceCount.get())

        c.onStart(owner)

        assertEquals("/relay/tv/tkt_3", nextSocketPath())
        assertEquals(3, relay.announceCount.get())
        assertNull(
            "and exactly one socket",
            relay.socketPaths.poll(500, TimeUnit.MILLISECONDS),
        )
    }

    @Test
    fun startWhileBackgrounded_makesNoAnnounceUntilTheAppReturns() {
        // A host `start()` is the one route into `beginConnect` that the
        // generation bump cannot stop — it claims a NEW generation, so nothing
        // about it is stale. `beginConnect` refuses outright while
        // backgrounded, and refusing must not wedge the client: `onStart`
        // clears the flag before it tests anything.
        relay.announceResponses.add(announce200("tkt_fg", "AAA-111"))
        val owner = FakeLifecycleOwner()
        val c = newClient()

        c.onStop(owner)
        c.start()

        assertNull(
            "no socket may open while backgrounded",
            relay.socketPaths.poll(1, TimeUnit.SECONDS),
        )
        assertEquals("not even the HTTP call", 0, relay.announceCount.get())

        c.onStart(owner)

        assertEquals("/relay/tv/tkt_fg", nextSocketPath())
        assertEquals(1, relay.announceCount.get())
    }

    @Test
    fun aDeviceTokenReconnectOpensNoSocketWhileBackgrounded() {
        // `connectWithDeviceToken` is the ONE path that installs a socket
        // without going through `beginConnect`, so `beginConnect`'s
        // `isBackgrounded` guard does not cover it. The generation check in
        // the reconnect timer is not a substitute: it releases the lock before
        // calling here, so backgrounding in that window leaves this path a
        // freshly claimed, perfectly current generation to dial on.
        //
        // That interleaving cannot be staged deterministically from outside
        // (there is no seam between the timer's unlock and this call), so the
        // test drives the entry point directly — which is also why the
        // POSITIVE half below is not optional: without it a green negative
        // would only prove the branch is dead, and it IS dead on this leg (the
        // relay never sends `device_token` to a TV). The pair together prove a
        // live path that refuses only because of the guard.
        relay.announceResponses.add(announce200("tkt_1", "AAA-111"))
        val owner = FakeLifecycleOwner()
        val c = newClient()

        c.start()
        assertEquals("/relay/tv/tkt_1", nextSocketPath())

        val serverSocket = relay.serverSockets.poll(5, TimeUnit.SECONDS)!!
        serverSocket.send(
            """{"type":"pair.bonded","pair_id":"p1",""" +
                """"device_token":"dev_tok_1","attribution_token":"attr_1"}""",
        )
        // The frame really landed. `attribution_token` rides the same frame
        // and is the only part of it this class exposes.
        assertEquals("attr_1", awaitValue("the bonded frame") { c.getCompanionAttribution() })

        // Positive half — foregrounded, this path does open a socket.
        c.connectWithDeviceToken()
        assertEquals("/relay/phone/reconnect/dev_tok_1", nextSocketPath())

        // Negative half — backgrounded, the same call must open nothing.
        c.onStop(owner)
        c.connectWithDeviceToken()

        assertNull(
            "a device-token reconnect must not open a socket while backgrounded",
            relay.socketPaths.poll(1, TimeUnit.SECONDS),
        )
    }

    // ---------------- already backgrounded when the host called start() ----------------

    @Test
    fun startWhileTheProcessIsAlreadyBackgrounded_opensNoSocketUntilTheAppReturns() {
        // `isBackgrounded` flips on a TRANSITION only, and a host that starts
        // us from the background never produces one: `stopCompanion()` drops
        // the client and `startCompanion()` builds a FRESH RelayWSClient whose
        // flag initialises to false. Without the state read in `start()` this
        // session would announce, dial, and stay dialled until the next full
        // background/foreground cycle.
        //
        // Note what is NOT claimed: the announce POST still goes out. The read
        // has to happen on the main thread, so it lands after `beginConnect()`
        // has already launched the announce; what it stops is the socket. The
        // cost is one burned single-use ticket (60s TTL) and no dashboard
        // visibility — the relay lists a device when it opens the socket, not
        // when it announces.
        relay.announceResponses.add(announce200("tkt_bg", "ZZZ-999"))
        relay.announceResponses.add(announce200("tkt_fg", "AAA-111"))
        val owner = FakeLifecycleOwner()
        val c = newClient(processLifecycleState = { Lifecycle.State.CREATED })

        c.start()

        // Wait for the superseded announce to be consumed so the ticket queue
        // stays deterministic for the recovery half below.
        awaitValue("the superseded announce") { relay.announceCount.get().takeIf { it >= 1 } }
        assertNull(
            "no socket may open when start() runs in a backgrounded process",
            relay.socketPaths.poll(1, TimeUnit.SECONDS),
        )
        assertNull("nor may the superseded attempt publish its code", Companion.code.value)

        // Not wedged: the first real foregrounding announces afresh and opens
        // exactly one socket.
        c.onStart(owner)

        assertEquals("/relay/tv/tkt_fg", nextSocketPath())
        assertEquals(2, relay.announceCount.get())
        assertNull(
            "and exactly one socket",
            relay.socketPaths.poll(500, TimeUnit.MILLISECONDS),
        )
    }

    @Test
    fun startWhileTheProcessIsForegrounded_connectsExactlyAsBefore() {
        // The other side of the same branch: a STARTED owner must change
        // nothing at all, or the state read would have disabled companion for
        // every ordinary host.
        relay.announceResponses.add(announce200("tkt_1", "AAA-111"))
        val c = newClient(processLifecycleState = { Lifecycle.State.STARTED })

        c.start()

        assertEquals("/relay/tv/tkt_1", nextSocketPath())
        assertEquals("AAA-111", awaitValue("Companion.code") { Companion.code.value })
    }

    @Test
    fun ticketWithUrlUnsafeCharacters_isPercentEncodedIntoOnePathSegment() {
        relay.announceResponses.add(announce200("a/b?c d", "AAA-111"))

        newClient().start()

        assertEquals(
            "a ticket must never be able to restructure the socket URL",
            "/relay/tv/a%2Fb%3Fc%20d",
            nextSocketPath(),
        )
    }

    // ---------------- attribution reaches the submit path ----------------

    @Test
    fun theLiveClientCapturesTheBondsAttributionTokenAndDropsItOnStop() {
        relay.announceResponses.add(announce200("tkt_first", "LMN-421"))
        val c = newClient()
        c.start()

        val serverSocket = relay.serverSockets.poll(5, TimeUnit.SECONDS)!!
        serverSocket.send(
            """{"type":"pair.bonded","pair_id":"p1",""" +
                """"attribution_token":"attr_tok_1",""" +
                """"companion_user":{"display_name":"Ada Lovelace"}}""",
        )

        assertEquals(
            "attr_tok_1",
            awaitValue("attribution token") { c.getCompanionAttribution() },
        )
        assertEquals("Ada Lovelace", Companion.attachedUserName.value)

        c.stop()
        assertNull(
            "a stopped session must not leave its token readable",
            c.getCompanionAttribution(),
        )
    }

    // ---------------- device identity (naming spec 2026-08-24) ----------------

    @Test
    fun deviceProvider_resolvedDevice_reachesTheAnnounceRequestBody() {
        relay.announceResponses.add(announce200("tkt_1", "AAA-111"))
        val device = AnnounceDevice(
            id = "069517e3-5bd7-4012-b70c-f7a35e011fc9",
            model = "Pixel 8",
            osName = "Android",
            osVersion = "14",
            emulator = false,
        )

        newClient(deviceProvider = { device }).start()

        assertEquals("/relay/tv/tkt_1", nextSocketPath())
        val body = Json.parseToJsonElement(relay.announceBodies.single()) as JsonObject
        val deviceObj = body["device"] as JsonObject
        assertEquals("069517e3-5bd7-4012-b70c-f7a35e011fc9", deviceObj["id"]!!.jsonPrimitive.content)
        assertEquals("Pixel 8", deviceObj["model"]!!.jsonPrimitive.content)
    }

    @Test
    fun deviceProvider_thatThrows_omitsTheDeviceBlockRatherThanFailingTheAnnounce() {
        relay.announceResponses.add(announce200("tkt_1", "AAA-111"))

        newClient(deviceProvider = { throw IllegalStateException("boom") }).start()

        assertEquals(
            "device resolution failing must not cost the device its announce",
            "/relay/tv/tkt_1",
            nextSocketPath(),
        )
        assertEquals("AAA-111", awaitValue("Companion.code") { Companion.code.value })
        assertEquals("{}", relay.announceBodies.single())
    }

    @Test
    fun deviceProvider_resolvingNull_omitsTheDeviceBlock() {
        relay.announceResponses.add(announce200("tkt_1", "AAA-111"))

        newClient(deviceProvider = { null }).start()

        assertEquals("/relay/tv/tkt_1", nextSocketPath())
        assertEquals("{}", relay.announceBodies.single())
    }

    @Test
    fun noDeviceProvider_sendsNoDeviceBlock_byteIdenticalToBeforeTheFeature() {
        relay.announceResponses.add(announce200("tkt_first", "LMN-421"))

        newClient(deviceLabel = "Lobby TV").start()

        assertEquals("/relay/tv/tkt_first", nextSocketPath())
        assertEquals("""{"label":"Lobby TV"}""", relay.announceBodies.single())
    }

    // ---------------- resolvedName (naming spec 2026-08-24) ----------------

    @Test
    fun announceSuccess_withResolvedName_publishesItToCompanionResolvedName() {
        relay.announceResponses.add(
            MockResponse().setResponseCode(200)
                .setHeader("Content-Type", "application/json")
                .setBody("""{"ticket":"tkt_1","code":"AAA-111","resolvedName":"Lobby TV"}"""),
        )

        newClient().start()

        assertEquals("/relay/tv/tkt_1", nextSocketPath())
        assertEquals("Lobby TV", awaitValue("resolvedName") { Companion.resolvedName.value })
    }

    @Test
    fun announceFailure_leavesResolvedNameNull() {
        relay.announceResponses.add(
            MockResponse().setResponseCode(401).setBody("""{"error":"invalid_sdk_key"}"""),
        )

        newClient().start()

        assertEquals("/relay/tv", nextSocketPath())
        assertNull(Companion.resolvedName.value)
    }

    @Test
    fun companionNameFrame_updatesResolvedNameWhileConnected() {
        relay.announceResponses.add(announce200("tkt_1", "AAA-111"))
        newClient().start()
        assertEquals("/relay/tv/tkt_1", nextSocketPath())
        val serverSocket = relay.serverSockets.poll(5, TimeUnit.SECONDS)!!

        serverSocket.send("""{"type":"companion.name","name":"Green Room"}""")

        assertEquals("Green Room", awaitValue("resolvedName") { Companion.resolvedName.value })
    }

    @Test
    fun companionNameFrame_outOfRangeLength_isIgnored() {
        relay.announceResponses.add(
            MockResponse().setResponseCode(200)
                .setHeader("Content-Type", "application/json")
                .setBody("""{"ticket":"tkt_1","code":"AAA-111","resolvedName":"Lobby TV"}"""),
        )
        newClient().start()
        assertEquals("/relay/tv/tkt_1", nextSocketPath())
        assertEquals("Lobby TV", awaitValue("resolvedName") { Companion.resolvedName.value })
        val serverSocket = relay.serverSockets.poll(5, TimeUnit.SECONDS)!!
        val tooLong = "x".repeat(81)

        serverSocket.send("""{"type":"companion.name","name":"$tooLong"}""")

        // Nothing to await for a no-op; give the WS reader a beat, then assert
        // the prior value is untouched.
        Thread.sleep(200)
        assertEquals("Lobby TV", Companion.resolvedName.value)
    }

    @Test
    fun terminalClose_clearsResolvedNameAlongsideCode() {
        relay.announceResponses.add(announce200("tkt_1", "AAA-111"))
        val c = newClient()
        c.start()
        assertEquals("/relay/tv/tkt_1", nextSocketPath())
        val serverSocket = relay.serverSockets.poll(5, TimeUnit.SECONDS)!!
        serverSocket.send("""{"type":"companion.name","name":"Lobby TV"}""")
        assertEquals("Lobby TV", awaitValue("resolvedName") { Companion.resolvedName.value })

        // Terminal close code (4002 = pair_expired) drives the listener
        // directly — mirrors the terminal-close-branch shape exercised
        // elsewhere in this suite (RelayWSClientAttachChallengeTest).
        c.listener.onClosing(
            c.__currentSocketForTesting()!!,
            RelayWSClient.CLOSE_PAIR_EXPIRED,
            "expired",
        )

        awaitValue("code cleared") { true.takeIf { Companion.code.value == null } }
        assertNull("resolvedName must clear alongside code", Companion.resolvedName.value)
    }

    // ---------------- fixtures ----------------

    private fun announce200(ticket: String, code: String): MockResponse =
        MockResponse().setResponseCode(200)
            .setHeader("Content-Type", "application/json")
            .setBody("""{"ticket":"$ticket","code":"$code","expiresInMs":60000}""")

    /**
     * Serves `POST /api/companion/announce` from a queue and answers every
     * other path with a WebSocket upgrade, recording what it saw.
     */
    /** Stands in for `ProcessLifecycleOwner` so the lifecycle overrides can be
     *  driven directly — the same shape `RelayWSClientTest` uses. */
    private class FakeLifecycleOwner : LifecycleOwner {
        private val registry = LifecycleRegistry(this).apply {
            currentState = Lifecycle.State.STARTED
        }
        override val lifecycle: Lifecycle = registry
    }

    private class RelayDispatcher : Dispatcher() {
        val announceResponses = LinkedBlockingQueue<MockResponse>()
        val announceCount = AtomicInteger(0)
        val announceBodies = CopyOnWriteArrayList<String>()
        val announceAuth = CopyOnWriteArrayList<String>()
        val socketPaths = LinkedBlockingQueue<String>()
        val serverSockets = LinkedBlockingQueue<WebSocket>()

        private val serverListener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                serverSockets.put(webSocket)
            }
        }

        override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.path.orEmpty()
            if (path.startsWith("/api/companion/announce")) {
                announceCount.incrementAndGet()
                announceBodies.add(request.body.readUtf8())
                announceAuth.add(request.getHeader("Authorization").orEmpty())
                return announceResponses.poll()
                    ?: MockResponse().setResponseCode(503)
            }
            socketPaths.put(path)
            return MockResponse().withWebSocketUpgrade(serverListener)
        }
    }
}
