// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// JVM unit tests for TraceItXInterceptor. We use OkHttp's MockWebServer for a
// real HTTP round-trip, which exercises the actual Interceptor.Chain plumbing
// (the spec-compliant fakes that mockk-based tests would never quite cover).
//
// We DO NOT mock OkHttp — the chain protocol is too narrow to mock safely and
// MockWebServer is fast (sub-millisecond loopback). Robolectric is not needed:
// SharedData.init has a `from-classpath-fallback` Plan 02 path that loads the
// JSON from a test-classpath resource when no Android Context is available.
package com.traceitx.okhttp

import com.traceitx.TraceItX
import com.traceitx.capture.NetworkRingBuffer
import com.traceitx.capture.sharedNetworkBodyBuffer
import com.traceitx.capture.sharedNetworkBuffer
import com.traceitx.shared.SharedData
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.BufferedSink
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.io.IOException
import java.net.SocketException
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
class TraceItXInterceptorTest {

    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        // SharedData needs initialization so RedactionEngine.filterHeaders /
        // RedactionEngine.redact have allowlists + patterns. Robolectric supplies
        // a real Context with merged assets (preBuild copyProtocolData task).
        SharedData.init(RuntimeEnvironment.getApplication())

        // Open the kill-switch gate so the interceptor records.
        TraceItX.captureGate = true

        sharedNetworkBuffer.clear()
        sharedNetworkBodyBuffer.clear()
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        sharedNetworkBuffer.clear()
        sharedNetworkBodyBuffer.clear()
        TraceItX.captureGate = false
        server.shutdown()
    }

    private fun client(): OkHttpClient =
        OkHttpClient.Builder().addTraceItXInterceptor().build()

    @Test
    fun `captures_method_url_status_duration_for_successful_call`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("response-bytes-go-here"))
        val resp = client().newCall(Request.Builder().url(server.url("/api/v1/widgets")).build()).execute()
        // Drain so the interceptor's chain.proceed completes and writes the entry.
        resp.close()

        val snap = sharedNetworkBuffer.snapshot()
        assertEquals(1, snap.size)
        val e = snap.first()
        assertEquals("GET", e.method)
        // URL is post-redaction; the path here has no sensitive tokens, so it survives intact.
        assertTrue("expected URL contains /api/v1/widgets, got ${e.url}", e.url.contains("/api/v1/widgets"))
        assertEquals(200, e.status)
        assertNull(e.errorMessage)
        assertTrue("durationMs should be ≥ 0, got ${e.durationMs}", e.durationMs >= 0L)
    }

    @Test
    fun `redacts_sensitive_headers_drops_unknown_keeps_allowlisted`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("ok"))
        val req = Request.Builder()
            .url(server.url("/secure"))
            .addHeader("Authorization", "Bearer secret-token-do-not-leak")
            .addHeader("Content-Type", "application/json")
            .addHeader("X-Custom-Foo", "should-be-dropped")
            .build()
        client().newCall(req).execute().close()

        val e = sharedNetworkBuffer.snapshot().single()

        // Sensitive header value is replaced with [REDACTED] but the key is preserved.
        // OkHttp normalizes header names — accept either case.
        val authVal = e.requestHeaders.entries.firstOrNull { it.key.equals("Authorization", true) }?.value
        assertEquals("[REDACTED]", authVal)

        // Allowlisted header passes through verbatim.
        val ctVal = e.requestHeaders.entries.firstOrNull { it.key.equals("Content-Type", true) }?.value
        assertEquals("application/json", ctVal)

        // Unknown header is dropped entirely (default-deny).
        assertFalse(
            "X-Custom-Foo must be dropped — default-deny",
            e.requestHeaders.keys.any { it.equals("X-Custom-Foo", true) },
        )
    }

    @Test
    fun `addTraceItXInterceptor_is_chainable_and_returns_same_builder`() {
        val builder = OkHttpClient.Builder()
        val returned = builder.addTraceItXInterceptor()
        assertSame("addTraceItXInterceptor must return the same builder for chaining", builder, returned)
        val client = builder.build()
        val ours = client.interceptors.count { it is TraceItXInterceptor }
        assertEquals(1, ours)
    }

    @Test
    fun `kill_switch_pass_through_records_nothing`() {
        TraceItX.captureGate = false
        server.enqueue(MockResponse().setResponseCode(200))
        client().newCall(Request.Builder().url(server.url("/x")).build()).execute().close()
        assertTrue(
            "captureGate=false must produce zero entries (DEFE-03)",
            sharedNetworkBuffer.snapshot().isEmpty(),
        )
    }

    @Test
    fun `transport_failure_records_entry_with_error_and_rethrows`() {
        // Shut the server down BEFORE the call, then point a request at a
        // closed port — guaranteed transport failure.
        val url = server.url("/dead")
        server.shutdown()

        var caught: IOException? = null
        try {
            client().newCall(Request.Builder().url(url).build()).execute().close()
            fail("expected IOException")
        } catch (e: IOException) {
            caught = e
        }
        assertNotNull(caught)

        val e = sharedNetworkBuffer.snapshot().single()
        assertEquals("GET", e.method)
        assertNull("status must be null for transport failure", e.status)
        assertNotNull("errorMessage must be set", e.errorMessage)

        // Restart for the @After teardown.
        server = MockWebServer().also { it.start() }
    }

    @Test
    fun `entry_data_class_carries_no_body_field`() {
        // Belt-and-suspenders to the source-grep gate: structurally inspect the
        // Entry's Kotlin data-class component fields. If a future refactor
        // adds `requestBody` or `responseBody`, this test fails. This
        // invariant is unchanged by the network-body-capture work: the
        // metadata Entry stays payload-free by construction — a captured
        // payload (response direction, via `capture/NetworkBodyTee.kt`; see
        // that file and `NetworkBodyCaptureState.kt`'s header) lives only in
        // `NetworkBodyRingBuffer`, never on this Entry. This test's `setUp`
        // never activates the body-capture gate, so that buffer stays empty
        // here regardless — this Entry's own shape is the structural
        // guarantee being tested.
        val e = NetworkRingBuffer.Entry(
            timestamp = 0L, method = "GET", url = "x", status = 200, durationMs = 0L,
            requestHeaders = emptyMap(), responseHeaders = emptyMap(), errorMessage = null,
        )
        // toString of a Kotlin data class enumerates ALL declared properties.
        val s = e.toString()
        assertFalse("Entry must not carry requestBody field", s.contains("requestBody"))
        assertFalse("Entry must not carry responseBody field", s.contains("responseBody"))
        assertFalse("Entry must not contain a 'body' field at all", Regex("\\bbody=").containsMatchIn(s))
    }

    /**
     * Coexistence regression: when other interceptors (representing
     * Sentry/Bugsnag/Datadog/Firebase Performance plugins) are also attached,
     * the chain still completes and we record exactly one entry. The third-
     * party plugins themselves are not present in this test classpath; we use
     * a passthrough Interceptor as a stand-in for "any other plugin chained
     * above or below us."
     */
    @Test
    fun `coexists_with_other_interceptors_in_same_chain`() {
        val passthroughCount = java.util.concurrent.atomic.AtomicInteger(0)
        val passthrough = okhttp3.Interceptor { chain ->
            passthroughCount.incrementAndGet()
            chain.proceed(chain.request())
        }
        val client = OkHttpClient.Builder()
            .addInterceptor(passthrough)
            .addTraceItXInterceptor()
            .addInterceptor(passthrough)
            .build()
        server.enqueue(MockResponse().setResponseCode(200))
        client.newCall(Request.Builder().url(server.url("/y")).build()).execute().close()
        assertEquals(2, passthroughCount.get())
        assertEquals(1, sharedNetworkBuffer.snapshot().size)
    }

    // ==================== Request-body capture removal regression guard (2026-08-02) ====================

    /**
     * Android still ships NO request-direction body capture — see this
     * file's header and `NetworkBodyCaptureState.kt`'s. (The response
     * direction, removed in the same 2026-08-02 scope reduction, was
     * reinstated 2026-08-12 via a bounded tee on the app's own read,
     * `capture/NetworkBodyTee.kt` — but this test's `setUp` never activates
     * the body-capture gate, so `sharedNetworkBodyBuffer` stays empty here
     * either way.) The request half was removed because reading a request
     * body via `RequestBody.writeTo` a SECOND time (the interceptor
     * previously did this, post-`chain.proceed()`, to capture a copy) is not
     * guaranteed prompt just because the FIRST write already completed —
     * `isOneShot()` defaults to `false`, so nothing stops an arbitrary,
     * stateful, or deliberately slow custom `RequestBody` from repeating
     * slow I/O (or blocking outright) on that second call, and a byte
     * ceiling bounds memory, not wall-clock time.
     *
     * This is the regression guard for that whole class of bug: a
     * `RequestBody` that counts its own `writeTo` invocations and fails the
     * test outright the moment it is asked to write a second time, driven
     * through a REAL interceptor call over MockWebServer (not a direct
     * `makeEntry`-style unit call — there is no such unit left to call). If
     * a future change ever reintroduces any form of synchronous request-body
     * capture, this is the test that catches it: either `writeTo` gets
     * invoked twice (immediate failure) or `sharedNetworkBodyBuffer` stops
     * being empty (second assertion below).
     */
    @Test
    fun `no body capture - RequestBody writeTo is never invoked a second time and the body buffer stays empty`() {
        val writeToCount = AtomicInteger(0)
        val json = """{"a":1}"""
        val body = object : RequestBody() {
            override fun contentType() = "application/json".toMediaType()
            override fun contentLength() = json.toByteArray(Charsets.UTF_8).size.toLong()
            override fun writeTo(sink: BufferedSink) {
                val callNumber = writeToCount.incrementAndGet()
                if (callNumber > 1) {
                    fail(
                        "RequestBody.writeTo was invoked a $callNumber-th time — Android must never " +
                            "read a request body a second time (that is the exact synchronous-capture " +
                            "defect class this guard exists to catch)",
                    )
                }
                sink.writeUtf8(json)
            }
        }

        server.enqueue(MockResponse().setResponseCode(200))
        client().newCall(Request.Builder().url(server.url("/x")).post(body).build()).execute().close()

        assertEquals("writeTo must be called exactly once (the normal app-visible transmission)", 1, writeToCount.get())
        assertTrue(
            "no request-body capture and the body-capture gate is inactive in this test — " +
                "sharedNetworkBodyBuffer must stay empty",
            sharedNetworkBodyBuffer.snapshot().isEmpty(),
        )
    }
}
