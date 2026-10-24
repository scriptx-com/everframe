// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Device link hello and attempt check against MockWebServer. Tokens and nonces
// are compared, never printed.

package dev.everframe.devicelink

import androidx.test.core.app.ApplicationProvider
import dev.everframe.testing.takeRequestOrFail
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
class DeviceLinkClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: DeviceLinkClient
    private val nonce = LinkNonce.generate()
    private val uuid = "6c1e2f6a-1b7e-4b43-9a55-0e0c2b8f3e10"
    private val token = "evf_dev_" + "Q7wX".repeat(8)
    private val device = HelloDevice(
        model = "Pixel 9",
        osVersion = "15",
        appVersion = "1.0.0",
        sdk = "android/1.6.0",
        formFactor = "phone",
    )

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        val http = OkHttpClient.Builder()
            .connectTimeout(2, TimeUnit.SECONDS)
            .readTimeout(1, TimeUnit.SECONDS)
            .retryOnConnectionFailure(false)
            .build()
        client = DeviceLinkClient(server.url("/api/ingest/").toString(), "sdk-key-1", http)
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun json(body: String) = MockResponse().setResponseCode(200).setBody(body)

    @Test
    fun helloPostsTheContractBody() = runBlocking {
        server.enqueue(json("""{"status":"none"}"""))
        client.hello(nonce, device)
        val req = server.takeRequestOrFail()
        assertEquals("POST", req.method)
        assertEquals("/api/device-link/hello", req.path)
        assertEquals("Bearer sdk-key-1", req.getHeader("Authorization"))
        assertNull(req.getHeader("X-Everframe-Capture-Token"))
        assertTrue(req.getHeader("Content-Type")!!.startsWith("application/json"))
        val body = Json.parseToJsonElement(req.body.readUtf8()).jsonObject
        assertTrue(body["attemptNonce"]!!.jsonPrimitive.content == nonce)
        val d = body["device"]!!.jsonObject
        assertEquals("Pixel 9", d["model"]!!.jsonPrimitive.content)
        assertEquals("Android", d["os"]!!.jsonPrimitive.content)
        assertEquals("15", d["osVersion"]!!.jsonPrimitive.content)
        assertEquals("1.0.0", d["appVersion"]!!.jsonPrimitive.content)
        assertTrue(d["sdk"]!!.jsonPrimitive.content.startsWith("android/"))
        assertTrue(d["formFactor"]!!.jsonPrimitive.content in setOf("phone", "tablet", "tv"))
    }

    @Test
    fun collectedDeviceMatchesTheContract() {
        val d = HelloDevice.collect(ApplicationProvider.getApplicationContext(), debugBuild = null)
        assertEquals("Android", d.os)
        assertTrue(d.sdk.startsWith("android/"))
        assertTrue(d.formFactor in setOf("phone", "tablet", "tv"))
        assertTrue(d.model.isNotEmpty())
    }

    @Test
    fun helloResponses() = runBlocking {
        server.enqueue(json("""{"status":"none"}"""))
        assertEquals(HelloResult.None, client.hello(nonce, device))
        server.enqueue(json("""{"status":"pending","attemptId":"$uuid","number":47}"""))
        assertEquals(HelloResult.Pending(uuid, 47), client.hello(nonce, device))
        server.enqueue(json("""{"status":"pending","attemptId":"$uuid","number":0,"future":true}"""))
        assertEquals(HelloResult.Pending(uuid, 0), client.hello(nonce, device))
        server.enqueue(MockResponse().setResponseCode(429))
        assertEquals(HelloResult.Stop, client.hello(nonce, device))
        server.enqueue(MockResponse().setResponseCode(500))
        assertEquals(HelloResult.Stop, client.hello(nonce, device))
        server.enqueue(json("""{"status":"pending"}"""))
        assertEquals(HelloResult.Stop, client.hello(nonce, device))
        server.enqueue(json("""{"status":"pending","attemptId":"$uuid","number":100}"""))
        assertEquals(HelloResult.Stop, client.hello(nonce, device))
        server.enqueue(json("""{"status":"pending","attemptId":"$uuid","number":-1}"""))
        assertEquals(HelloResult.Stop, client.hello(nonce, device))
        server.enqueue(json("""{"status":"pending","attemptId":"$uuid","number":4.5}"""))
        assertEquals(HelloResult.Stop, client.hello(nonce, device))
        server.enqueue(json("""{"status":"pending","attemptId":"${"a".repeat(65)}","number":4}"""))
        assertEquals(HelloResult.Stop, client.hello(nonce, device))
        server.enqueue(json("not json"))
        assertEquals(HelloResult.Stop, client.hello(nonce, device))
        server.enqueue(json("""{"status":"later"}"""))
        assertEquals(HelloResult.Stop, client.hello(nonce, device))
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
        assertEquals(HelloResult.Stop, client.hello(nonce, device))
    }

    @Test
    fun checkPostsTheNonceToTheAttemptPath() = runBlocking {
        server.enqueue(json("""{"status":"pending"}"""))
        client.check(uuid, nonce)
        val req = server.takeRequestOrFail()
        assertEquals("POST", req.method)
        assertEquals("/api/device-link/attempts/$uuid/check", req.path)
        assertEquals("Bearer sdk-key-1", req.getHeader("Authorization"))
        val body = Json.parseToJsonElement(req.body.readUtf8()).jsonObject
        assertEquals(setOf("attemptNonce"), body.keys)
        assertTrue(body["attemptNonce"]!!.jsonPrimitive.content == nonce)
    }

    @Test
    fun checkResponses() = runBlocking {
        server.enqueue(json("""{"status":"pending"}"""))
        assertEquals(CheckResult.Pending, client.check(uuid, nonce))
        server.enqueue(json("""{"status":"expired"}"""))
        assertEquals(CheckResult.Expired, client.check(uuid, nonce))

        server.enqueue(json("""{"status":"linked","token":"$token","owner":{"kind":"user","name":"Aurimas"}}"""))
        val user = client.check(uuid, nonce)
        assertTrue(user is CheckResult.Linked)
        assertTrue((user as CheckResult.Linked).token == token)
        assertEquals(DeviceLinkOwner.User("Aurimas"), user.owner)

        server.enqueue(json("""{"status":"linked","token":"$token","owner":{"kind":"team"}}"""))
        val team = client.check(uuid, nonce)
        assertEquals(DeviceLinkOwner.Team, (team as CheckResult.Linked).owner)

        server.enqueue(json("""{"status":"linked","token":"evf_dev_short","owner":{"kind":"team"}}"""))
        assertEquals(CheckResult.Expired, client.check(uuid, nonce))
        server.enqueue(json("""{"status":"linked","token":"$token","owner":{"kind":"robot"}}"""))
        assertEquals(CheckResult.Expired, client.check(uuid, nonce))
        server.enqueue(json("""{"status":"linked","token":"$token"}"""))
        assertEquals(CheckResult.Expired, client.check(uuid, nonce))
        server.enqueue(MockResponse().setResponseCode(429))
        assertEquals(CheckResult.Stop, client.check(uuid, nonce))
        server.enqueue(MockResponse().setResponseCode(503))
        assertEquals(CheckResult.Retry, client.check(uuid, nonce))
        server.enqueue(MockResponse().setResponseCode(404))
        assertEquals(CheckResult.Expired, client.check(uuid, nonce))
        server.enqueue(json("garbage"))
        assertEquals(CheckResult.Retry, client.check(uuid, nonce))
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
        assertEquals(CheckResult.Retry, client.check(uuid, nonce))
    }

    @Test
    fun attemptIdIsEncodedAsOnePathSegment() = runBlocking {
        server.enqueue(json("""{"status":"pending"}"""))
        client.check("a/b?c", nonce)
        assertEquals("/api/device-link/attempts/a%2Fb%3Fc/check", server.takeRequestOrFail().path)
    }

    @Test
    fun baseUrlWithoutIngestSuffix() = runBlocking {
        val bare = DeviceLinkClient(server.url("/").toString(), "k", PlainTestClient.forTest())
        server.enqueue(json("""{"status":"none"}"""))
        bare.hello(nonce, device)
        assertEquals("/api/device-link/hello", server.takeRequestOrFail().path)
    }

    @Test
    fun linkedResultToStringRedactsTheToken() {
        val linked = CheckResult.Linked(token, DeviceLinkOwner.User("Aurimas"))
        assertFalse(linked.toString().contains(token))
        assertTrue(linked.toString().contains("<redacted>"))
    }

    @Test
    fun aRedirectNeverCarriesTheNonceElsewhere() = runBlocking {
        val other = MockWebServer().apply { start() }
        try {
            // A 307 would re-send the POST body, nonce included, to the new origin.
            server.enqueue(MockResponse().setResponseCode(307).setHeader("Location", other.url("/api/device-link/hello").toString()))
            other.enqueue(json("{\"status\":\"none\"}"))
            assertEquals(HelloResult.Stop, client.hello(nonce, device))
            server.enqueue(MockResponse().setResponseCode(307).setHeader("Location", other.url("/x").toString()))
            other.enqueue(json("{\"status\":\"pending\"}"))
            assertEquals(CheckResult.Expired, client.check(uuid, nonce))
            assertEquals("a redirect target received the link request", 0, other.requestCount)
        } finally {
            other.shutdown()
        }
    }

    @Test
    fun aStalledBodyIsAbandonedAtTheDeadlineToo() = runBlocking {
        // The headers arrive at once; the body never comes within the deadline.
        server.enqueue(json("{\"status\":\"pending\"}").setBodyDelay(5, TimeUnit.SECONDS))
        val slow = DeviceLinkClient(
            server.url("/api/ingest/").toString(), "sdk-key-1",
            OkHttpClient.Builder().readTimeout(30, TimeUnit.SECONDS).build(),
        )
        val started = System.nanoTime()
        val result = kotlinx.coroutines.withTimeoutOrNull(300) { slow.check(uuid, nonce) }
        val elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)
        assertNull(result)
        assertTrue("the check ran ${elapsedMs}ms past its 300ms deadline", elapsedMs < 2_000)
    }

    @Test
    fun aCancelledCheckAbandonsTheCallAtOnce() = runBlocking {
        server.enqueue(json("{\"status\":\"pending\"}").setHeadersDelay(5, TimeUnit.SECONDS))
        val slow = DeviceLinkClient(
            server.url("/api/ingest/").toString(), "sdk-key-1",
            OkHttpClient.Builder().readTimeout(30, TimeUnit.SECONDS).build(),
        )
        val started = System.nanoTime()
        val result = kotlinx.coroutines.withTimeoutOrNull(200) { slow.check(uuid, nonce) }
        val elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)
        assertNull(result)
        assertTrue("the check ran ${elapsedMs}ms past its 200ms deadline", elapsedMs < 2_000)
    }
}

private object PlainTestClient {
    fun forTest(): OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(2, TimeUnit.SECONDS)
        .readTimeout(1, TimeUnit.SECONDS)
        .build()
}
