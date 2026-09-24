// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Contract tests for `CompanionAnnounce` (spec 2026-08-07).
//
// The invariant every one of these defends: announce failing must NEVER cost
// the device its bug reporting. Each failure mode below has to come back as
// `null` — the caller's cue to open the plain, ticketless `/relay/tv` — rather
// than as a thrown exception, a retry, or a hang.
//
// MockWebServer binds loopback and every response is enqueued by the test, so
// these are deterministic and touch no external host.
//
// *** THESE TESTS DO NOT RUN IN CI. *** `.github/workflows/android.yml`'s "JVM
// unit tests" step is `./gradlew testReleaseUnitTest testDebugUnitTest` with no
// `--continue`, and `testReleaseUnitTest` has been failing since 2026-05-11
// (measured 2026-08-10: 419 tests, 163 failed — R8 renames the internals those
// tests name by string). Gradle therefore aborts the build before
// `testDebugUnitTest` is ever scheduled, so nothing in this file — or in any
// other `test/` file in this module — is gated by CI today. Run it locally:
//
//     cd packages/sdk-android/android && ./gradlew :everframe-core:testDebugUnitTest
//
// If you repair the workflow (add `--continue`, or fix the release variant),
// delete this note — it is a statement about a broken job, not a permanent
// property of these tests.
//
// This class is ALSO excluded from the release variant's test source set; see
// the R8 note directly above the class declaration below.

package dev.everframe.companion

import dev.everframe.testing.takeRequestOrFail
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
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

/**
 * DEBUG VARIANT ONLY — this file is excluded from `compileReleaseUnitTestKotlin`
 * in `everframe-core/build.gradle.kts`. Do not "fix" that exclusion by adding a
 * `-keep` rule.
 *
 * WHY: the release variant runs `isMinifyEnabled = true`, and
 * `proguard-rules.pro` deliberately keeps only the public API surface —
 * `CompanionAnnounce` and `AnnounceResult` are `internal` helpers, so R8 renames
 * them, and a test that class-loads `dev.everframe.companion.CompanionAnnounce`
 * by name dies with `NoClassDefFoundError` before a single assertion runs. The
 * alternative — a `-keep` rule — would ship an obfuscation hole for a type that
 * has no business being in the public AAR surface, which is the opposite of what
 * `proguard-rules.pro:8-14` asks for.
 *
 * Nothing is lost: `RelayWSClientAnnounceTest` drives the same announce leg
 * end-to-end through the real socket path and DOES run in both variants.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class CompanionAnnounceTest {

    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun announcer(
        sdkKey: String = "sdk_key_abc",
        timeoutSeconds: Long = 5,
        baseUrl: String = server.url("/").toString(),
    ) = CompanionAnnounce(
        client = OkHttpClient(),
        baseUrl = baseUrl,
        sdkKey = sdkKey,
        timeoutSeconds = timeoutSeconds,
    )

    private fun json(code: Int, body: String) =
        MockResponse().setResponseCode(code)
            .setHeader("Content-Type", "application/json")
            .setBody(body)

    // ---------------- success ----------------

    @Test
    fun announce_success_returnsTicketAndCode_andIssuesAnAuthenticatedPost() {
        server.enqueue(json(200, """{"ticket":"tkt_abc","code":"LMN-421","expiresInMs":60000}"""))

        val result = runBlocking { announcer().announce(label = "Lobby TV") }

        assertNotNull("a 200 with ticket+code must produce a result", result)
        assertEquals("tkt_abc", result!!.ticket)
        assertEquals("LMN-421", result.code)

        val recorded = server.takeRequestOrFail()
        assertEquals("POST", recorded.method)
        assertEquals("/api/companion/announce", recorded.path)
        assertEquals("Bearer sdk_key_abc", recorded.getHeader("Authorization"))
        assertTrue(
            "body must be sent as JSON, was ${recorded.getHeader("Content-Type")}",
            recorded.getHeader("Content-Type").orEmpty().startsWith("application/json"),
        )
        assertEquals("""{"label":"Lobby TV"}""", recorded.body.readUtf8())
    }

    @Test
    fun announce_withoutLabel_sendsAnEmptyJsonObject() {
        server.enqueue(json(200, """{"ticket":"t","code":"c"}"""))

        val result = runBlocking { announcer().announce(label = null) }

        assertNotNull(result)
        assertEquals("{}", server.takeRequestOrFail().body.readUtf8())
    }

    @Test
    fun announce_labelContainingQuotesAndBackslashes_staysParseableJson() {
        // The string-interpolation trap: `{"label":"$label"}` would emit
        // `{"label":"Sam's \"TV\" C:\path"}` — malformed, 400 at the server,
        // and this device silently loses its dashboard listing.
        val hostile = """Sam's "TV" C:\path"""
        server.enqueue(json(200, """{"ticket":"t","code":"c"}"""))

        runBlocking { announcer().announce(label = hostile) }

        val raw = server.takeRequestOrFail().body.readUtf8()
        // Parse it back the way the server would, and check the round trip.
        val parsed = Json.parseToJsonElement(raw) as JsonObject
        assertEquals(hostile, parsed["label"]!!.jsonPrimitive.content)
    }

    // ---------------- every failure is null ----------------

    @Test
    fun announce_401InvalidSdkKey_returnsNull() {
        server.enqueue(json(401, """{"error":"invalid_sdk_key"}"""))
        assertNull(runBlocking { announcer().announce(label = null) })
    }

    @Test
    fun announce_404OnAnOlderServerWithoutTheRoute_returnsNull() {
        server.enqueue(MockResponse().setResponseCode(404))
        assertNull(runBlocking { announcer().announce(label = null) })
    }

    @Test
    fun announce_500_returnsNull() {
        server.enqueue(MockResponse().setResponseCode(500).setBody("boom"))
        assertNull(runBlocking { announcer().announce(label = null) })
    }

    @Test
    fun announce_serverUnreachable_returnsNull() {
        // Bind, capture the port, then shut down so nothing is listening.
        val deadUrl = server.url("/").toString()
        server.shutdown()
        val result = runBlocking { announcer(baseUrl = deadUrl).announce(label = null) }
        assertNull("an offline device must fall back, not throw", result)
        // Re-start so tearDown's shutdown stays valid.
        server = MockWebServer().also { it.start() }
    }

    @Test
    fun announce_nonJsonBody_returnsNull() {
        server.enqueue(json(200, "<html>gateway</html>"))
        assertNull(runBlocking { announcer().announce(label = null) })
    }

    @Test
    fun announce_bodyMissingCode_returnsNull() {
        server.enqueue(json(200, """{"ticket":"tkt_abc"}"""))
        assertNull(runBlocking { announcer().announce(label = null) })
    }

    @Test
    fun announce_bodyMissingTicket_returnsNull() {
        server.enqueue(json(200, """{"code":"LMN-421"}"""))
        assertNull(runBlocking { announcer().announce(label = null) })
    }

    @Test
    fun announce_nonStringTicket_returnsNull() {
        server.enqueue(json(200, """{"ticket":12345,"code":"LMN-421"}"""))
        assertNull(runBlocking { announcer().announce(label = null) })
    }

    @Test
    fun announce_blankTicket_returnsNull() {
        // Present-but-empty is not a usable answer: a blank ticket composes the
        // socket URL `/relay/tv/`, which the relay rejects as 4004 — a terminal
        // close, i.e. the device lands on a re-pair cycle instead of taking the
        // clean ticketless fallback this contract promises.
        server.enqueue(json(200, """{"ticket":"","code":"LMN-421"}"""))
        assertNull(runBlocking { announcer().announce(label = null) })
    }

    @Test
    fun announce_blankCode_returnsNull() {
        // A blank code would be rendered beside the QR as nothing at all, so
        // the dashboard user has no way to identify this row.
        server.enqueue(json(200, """{"ticket":"tkt_abc","code":"   "}"""))
        assertNull(runBlocking { announcer().announce(label = null) })
    }

    @Test
    fun announce_unknownExtraFields_areTolerated() {
        // The announce response is ours to widen; unknown keys must not fail
        // closed the way relay-message frames deliberately do.
        server.enqueue(json(200, """{"ticket":"t","code":"c","futureField":{"a":1}}"""))
        val result = runBlocking { announcer().announce(label = null) }
        assertEquals("t", result?.ticket)
    }

    // ---------------- the timeout is real ----------------

    @Test
    fun announce_hungServer_isBoundedByTheConfiguredTimeout() {
        // NO_RESPONSE accepts the connection and then says nothing — the exact
        // shape of a captive portal or a wedged relay. Without a call timeout
        // OkHttp waits on its default read timeout (10s) or forever, and
        // companion start stalls with no QR on screen at all.
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))

        val started = System.nanoTime()
        val result = runBlocking {
            // withTimeout turns "the implementation never applied a timeout"
            // into a red test instead of a hung build.
            try {
                withTimeout(6_000) { announcer(timeoutSeconds = 1).announce(label = null) }
            } catch (e: TimeoutCancellationException) {
                throw AssertionError("announce did not honour its 1s call timeout", e)
            }
        }
        val elapsed = (System.nanoTime() - started) / 1_000_000

        assertNull("a hung announce must fall back, not hang", result)
        assertTrue("expected the 1s timeout to fire, took ${elapsed}ms", elapsed < 5_000)
    }

    // ---------------- body encoder ----------------

    @Test
    fun encodeBody_isEmptyObjectWithoutLabel() {
        assertEquals("{}", CompanionAnnounce.encodeBody(null))
    }

    @Test
    fun encodeBody_escapesRatherThanInterpolates() {
        assertEquals("""{"label":"a\"b\\c"}""", CompanionAnnounce.encodeBody("""a"b\c"""))
    }

    // ---------------- supportsAttachPin (spec 2026-08-19) ----------------

    @Test
    fun encodeBody_supportsAttachPinTrue_withoutLabel_omitsLabelKeepsFlag() {
        assertEquals(
            """{"supportsAttachPin":true}""",
            CompanionAnnounce.encodeBody(null, supportsAttachPin = true),
        )
    }

    @Test
    fun encodeBody_supportsAttachPinFalse_omitsTheFlag_soOldServerBodiesStayByteIdentical() {
        assertEquals(
            """{"label":"Lobby TV"}""",
            CompanionAnnounce.encodeBody("Lobby TV", supportsAttachPin = false),
        )
    }

    @Test
    fun encodeBody_labelAndSupportsAttachPinTrue_carriesBoth() {
        assertEquals(
            """{"label":"Lobby TV","supportsAttachPin":true}""",
            CompanionAnnounce.encodeBody("Lobby TV", supportsAttachPin = true),
        )
    }

    // ---------------- device block (naming spec 2026-08-24) ----------------

    @Test
    fun encodeBody_withoutDevice_isByteIdenticalToBeforeTheFeature() {
        // The without-device case must be byte-identical to today — an old
        // server, and every pre-existing assertion in this suite, must see
        // exactly the same body.
        assertEquals(
            """{"label":"Lobby TV"}""",
            CompanionAnnounce.encodeBody("Lobby TV", supportsAttachPin = false, device = null),
        )
    }

    @Test
    fun encodeBody_withFullDevice_emitsAllFields() {
        val device = AnnounceDevice(
            id = "069517e3-5bd7-4012-b70c-f7a35e011fc9",
            platform = "android",
            model = "Pixel 8",
            osName = "Android",
            osVersion = "14",
            emulator = false,
        )
        assertEquals(
            """{"label":"Lobby TV","device":{"id":"069517e3-5bd7-4012-b70c-f7a35e011fc9",""" +
                """"platform":"android","model":"Pixel 8","osName":"Android","osVersion":"14",""" +
                """"emulator":false}}""",
            CompanionAnnounce.encodeBody("Lobby TV", device = device),
        )
    }

    @Test
    fun encodeBody_withDevice_omitsNullFactFields() {
        val device = AnnounceDevice(
            id = "069517e3-5bd7-4012-b70c-f7a35e011fc9",
            platform = "android",
            model = null,
            osName = null,
            osVersion = null,
            emulator = true,
        )
        assertEquals(
            """{"device":{"id":"069517e3-5bd7-4012-b70c-f7a35e011fc9","platform":"android",""" +
                """"emulator":true}}""",
            CompanionAnnounce.encodeBody(null, device = device),
        )
    }

    @Test
    fun encodeBody_deviceEmulatorFalse_isStillSentExplicitly() {
        // `emulator` is non-optional on AnnounceDevice (mirrors iOS's `let
        // emulator: Bool`) — always sent, true OR false, never omitted the
        // way the nullable fact fields are.
        val device = AnnounceDevice(
            id = "069517e3-5bd7-4012-b70c-f7a35e011fc9",
            model = null,
            osName = null,
            osVersion = null,
            emulator = false,
        )
        val encoded = CompanionAnnounce.encodeBody(null, device = device)
        assertTrue("emulator:false must be present, not omitted", encoded.contains(""""emulator":false"""))
    }

    // ---------------- resolvedName decoding ----------------

    @Test
    fun announce_success_withResolvedName_decodesIt() {
        server.enqueue(json(200, """{"ticket":"tkt_abc","code":"LMN-421","resolvedName":"Lobby TV"}"""))
        val result = runBlocking { announcer().announce(label = "Lobby TV") }
        assertEquals("Lobby TV", result?.resolvedName)
    }

    @Test
    fun announce_success_withoutResolvedName_isNull() {
        // Older server: the field is simply absent.
        server.enqueue(json(200, """{"ticket":"tkt_abc","code":"LMN-421"}"""))
        val result = runBlocking { announcer().announce(label = null) }
        assertNotNull(result)
        assertNull(result!!.resolvedName)
    }

    @Test
    fun announce_success_withBlankResolvedName_isNull() {
        server.enqueue(json(200, """{"ticket":"tkt_abc","code":"LMN-421","resolvedName":"   "}"""))
        val result = runBlocking { announcer().announce(label = null) }
        assertNotNull(result)
        assertNull(result!!.resolvedName)
    }

    @Test
    fun announce_success_withDevice_sendsItInTheBody() {
        server.enqueue(json(200, """{"ticket":"t","code":"c"}"""))
        val device = AnnounceDevice(
            id = "069517e3-5bd7-4012-b70c-f7a35e011fc9",
            model = "Pixel 8",
            osName = "Android",
            osVersion = "14",
            emulator = false,
        )

        runBlocking { announcer().announce(label = null, device = device) }

        val raw = server.takeRequestOrFail().body.readUtf8()
        val parsed = Json.parseToJsonElement(raw) as JsonObject
        val deviceObj = parsed["device"] as JsonObject
        assertEquals("069517e3-5bd7-4012-b70c-f7a35e011fc9", deviceObj["id"]!!.jsonPrimitive.content)
        assertEquals("android", deviceObj["platform"]!!.jsonPrimitive.content)
    }
}
