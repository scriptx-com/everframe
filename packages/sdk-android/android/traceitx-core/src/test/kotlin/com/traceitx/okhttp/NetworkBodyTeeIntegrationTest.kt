// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// End-to-end body capture through a real OkHttp chain (MockWebServer). We do
// not mock OkHttp — the chain protocol is too narrow to mock safely.
package com.traceitx.okhttp

import com.traceitx.TraceItX
import com.traceitx.capture.NetworkBodyCaptureState
import com.traceitx.capture.NetworkBodyFinalizer
import com.traceitx.capture.sharedBreadcrumbBuffer
import com.traceitx.capture.sharedNetworkBodyBuffer
import com.traceitx.capture.sharedNetworkBuffer
import com.traceitx.config.NetworkBodiesConfigWire
import com.traceitx.protocol.generated.BodySkipped
import com.traceitx.protocol.generated.BreadcrumbKind
import com.traceitx.shared.SharedData
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class NetworkBodyTeeIntegrationTest {

    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient

    @Before
    fun setUp() {
        SharedData.init(RuntimeEnvironment.getApplication())
        TraceItX.captureGate = true
        NetworkBodyFinalizer.__directForTesting = true
        sharedNetworkBuffer.clear()
        sharedNetworkBodyBuffer.clear()
        // The interceptor dual-writes every call into the breadcrumb ring
        // (NetworkBreadcrumbAdapter.dualWrite). Reset it to the boot defaults
        // (enabled, all 7 kinds) and empty it, so a sibling test class that
        // left a disabled/kind-filtered config behind cannot make the
        // ref↔reqId join test below silently observe zero crumbs.
        sharedBreadcrumbBuffer.applyConfig(null)
        sharedBreadcrumbBuffer.clear()
        NetworkBodyCaptureState.resetForTesting()
        // Open the gate: server ON, not locally disabled, sampling always in.
        NetworkBodyCaptureState.applyConfig(
            wire = NetworkBodiesConfigWire(captureBodies = true),
            samplingRate = 1.0,
            locallyDisabled = false,
            random = { 0.0 },
        )
        server = MockWebServer()
        server.start()
        client = OkHttpClient.Builder().addTraceItXInterceptor().build()
    }

    @After
    fun tearDown() {
        NetworkBodyFinalizer.__directForTesting = false
        sharedNetworkBuffer.clear()
        sharedNetworkBodyBuffer.clear()
        sharedBreadcrumbBuffer.clear()
        NetworkBodyCaptureState.resetForTesting()
        TraceItX.captureGate = false
        server.shutdown()
    }

    private fun get(): String {
        val req = Request.Builder().url(server.url("/x")).build()
        return client.newCall(req).execute().use { it.body!!.string() }
    }

    @Test
    fun jsonResponseBodyIsCaptured() {
        server.enqueue(MockResponse().setBody("{\"ok\":true}").setHeader("Content-Type", "application/json"))
        assertEquals("{\"ok\":true}", get())

        val bodies = sharedNetworkBodyBuffer.snapshot()
        assertEquals(1, bodies.size)
        assertEquals("{\"ok\":true}", bodies[0].resBody)
    }

    // RENAMED (final whole-branch review, finding C2). This test used to be
    // called `bodyRefMatchesTheMetadataEntrysTimestampClock` and carried the
    // comment "Spec §6: the body's ref MUST match the crumb's reqId" — a claim
    // of coverage it never provided: its single assertion compares the body's
    // `t` against the metadata entry's `timestamp` and never looks at `ref` or
    // at a crumb at all. The ref↔reqId join is now asserted for real, one test
    // down; this one keeps the (genuinely useful) shared-clock property under
    // a name that says what it checks.
    //
    // Spec §6: both channels stamp from the SAME clock — the metadata entry's
    // own timestamp — so oldest-first eviction sorts by response order.
    @Test
    fun bodyTimestampComesFromTheMetadataEntrysClock() {
        server.enqueue(MockResponse().setBody("{\"ok\":true}").setHeader("Content-Type", "application/json"))
        get()

        val meta = sharedNetworkBuffer.snapshot()
        val bodies = sharedNetworkBodyBuffer.snapshot()
        assertEquals(1, meta.size)
        assertEquals(1, bodies.size)
        // Exact Long->Double conversion, no floating math in between — 0.0
        // delta is correct, not a tolerance fudge. JUnit 4's two-arg
        // assertEquals(double, double) is deprecated and unconditionally
        // fails ("Use assertEquals(expected, actual, delta)") regardless of
        // whether the values match, so a delta is required here.
        assertEquals(meta[0].timestamp.toDouble(), bodies[0].t, 0.0)
    }

    /**
     * Spec §6 + §13 item 9 — THE JOIN, asserted through the real interceptor.
     *
     * `EnvelopeBuilder` (envelope/EnvelopeBuilder.kt, `shippedNetworkReqIds`)
     * filters `payload.networkBodies` down to the bodies whose `ref` matches a
     * SHIPPED network crumb's `data.reqId`. A `ref` that does not match is not
     * a cosmetic id difference — the body is dropped at the encode boundary
     * with no diagnostic anywhere, i.e. 100% silent body loss.
     *
     * Nothing else in the suite pins this. Verified by mutation: changing
     * `TraceItXInterceptor`'s Capture branch to mint a SECOND reqId
     * (`bodyCtx(NetworkBodyCaptureState.mintReqId(), ...)` instead of
     * `bodyCtx(reqId!!, ...)`) — which double-mints and therefore guarantees
     * every captured body is discarded at encode time — leaves every other
     * test in this repo green and fails only this one.
     */
    @Test
    fun bodyRefMatchesTheNetworkCrumbsReqId() {
        server.enqueue(MockResponse().setBody("{\"ok\":true}").setHeader("Content-Type", "application/json"))
        get()

        val bodies = sharedNetworkBodyBuffer.snapshot()
        assertEquals(1, bodies.size)

        val crumbs = sharedBreadcrumbBuffer.snapshotForCrash()
            .filter { it.kind == BreadcrumbKind.Network }
        assertEquals(1, crumbs.size)

        // Read the crumb's reqId exactly the way EnvelopeBuilder.reqIdOf does,
        // so this test joins on the same value the encoder will.
        val reqId = (crumbs[0].data?.get("reqId") as? JsonPrimitive)?.content?.toDoubleOrNull()
        assertNotNull(
            "the network crumb must carry a reqId at all — without one the body " +
                "has nothing to join against and EnvelopeBuilder drops it",
            reqId,
        )
        assertEquals(
            "NetworkBody.ref must equal the network crumb's data.reqId — " +
                "EnvelopeBuilder ships only bodies whose ref matches a shipped crumb",
            reqId!!,
            bodies[0].ref,
            0.0,
        )
    }

    @Test
    fun nonAllowlistedContentTypeYieldsAContentTypeSkip() {
        server.enqueue(MockResponse().setBody("binary").setHeader("Content-Type", "image/png"))
        get()

        val bodies = sharedNetworkBodyBuffer.snapshot()
        assertEquals(1, bodies.size)
        assertEquals(BodySkipped.ContentType, bodies[0].resBodySkipped)
        assertNull(bodies[0].resBody)
    }

    @Test
    fun emptyBodyProducesNoEntryAtAll() {
        server.enqueue(MockResponse().setResponseCode(204))
        get()
        assertEquals(0, sharedNetworkBodyBuffer.snapshot().size)
    }

    @Test
    fun gateOffCapturesMetadataButNoBodies() {
        NetworkBodyCaptureState.resetForTesting() // gate closed
        server.enqueue(MockResponse().setBody("{\"ok\":true}").setHeader("Content-Type", "application/json"))
        get()

        assertEquals(1, sharedNetworkBuffer.snapshot().size)
        assertEquals(0, sharedNetworkBodyBuffer.snapshot().size)
    }

    @Test
    fun responseBodyIsUnchangedForTheApp() {
        val payload = "{\"a\":\"" + "z".repeat(50_000) + "\"}"
        server.enqueue(MockResponse().setBody(payload).setHeader("Content-Type", "application/json"))
        assertEquals(payload, get())
    }
}
