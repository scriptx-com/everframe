// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Regression suite for the defect class that removed the previous Android
// body-capture implementation: capture must never delay, block, or alter the
// app's own read. Assertions are LATCH-based — never wall-clock — because a
// timing assertion measures the CI machine, not the code (see 18c7d40e).
//
// This suite runs through a REAL OkHttp chain (addEverframeInterceptor() +
// MockWebServer) — the integration path. Task 5's NetworkBodyTeeAttachTest
// already covers the equivalent scenarios one layer down, by calling
// NetworkBodyTee.attach() directly against a hand-built okhttp3.Response.
// See per-test notes below for which brief cases were judged redundant with
// that unit-level coverage (none were dropped outright — this file's value
// is proving the SAME properties survive the full interceptor + real socket
// path, not just the tee in isolation).
package dev.everframe.okhttp

import dev.everframe.Everframe
import dev.everframe.capture.NetworkBodyCaptureState
import dev.everframe.capture.NetworkBodyFinalizer
import dev.everframe.capture.sharedBreadcrumbBuffer
import dev.everframe.capture.sharedNetworkBodyBuffer
import dev.everframe.capture.sharedNetworkBuffer
import dev.everframe.config.NetworkBodiesConfigWire
import dev.everframe.shared.SharedData
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.ResponseBody.Companion.asResponseBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okio.Buffer
import okio.ForwardingSource
import okio.Source
import okio.buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.io.IOException
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

@RunWith(RobolectricTestRunner::class)
class NetworkBodyTeeNonInterferenceTest {

    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient

    @Before
    fun setUp() {
        SharedData.init(RuntimeEnvironment.getApplication())
        Everframe.captureGate = true
        NetworkBodyFinalizer.__directForTesting = true
        sharedNetworkBuffer.clear()
        sharedNetworkBodyBuffer.clear()
        // Task 7 review — the interceptor dual-writes every call into the
        // breadcrumb ring buffer (NetworkBreadcrumbAdapter.dualWrite); left
        // uncleared, entries leak across tests within this class.
        sharedBreadcrumbBuffer.clear()
        NetworkBodyCaptureState.resetForTesting()
        NetworkBodyCaptureState.applyConfig(
            wire = NetworkBodiesConfigWire(captureBodies = true, bodyByteCap = 64),
            samplingRate = 1.0,
            locallyDisabled = false,
            random = { 0.0 },
        )
        server = MockWebServer()
        server.start()
        client = OkHttpClient.Builder().addEverframeInterceptor().build()
    }

    @After
    fun tearDown() {
        NetworkBodyFinalizer.__directForTesting = false
        sharedNetworkBuffer.clear()
        sharedNetworkBodyBuffer.clear()
        sharedBreadcrumbBuffer.clear()
        NetworkBodyCaptureState.resetForTesting()
        Everframe.captureGate = false
        server.shutdown()
    }

    private fun call() = client.newCall(Request.Builder().url(server.url("/x")).build())

    /**
     * A [Source] that counts every `read()` the layer above it performs. Used
     * to observe I/O DIRECTLY rather than inferring it from whether capture
     * finalized.
     */
    private class CountingSource(delegate: Source) : ForwardingSource(delegate) {
        val reads = AtomicInteger(0)

        override fun read(sink: Buffer, byteCount: Long): Long {
            reads.incrementAndGet()
            return super.read(sink, byteCount)
        }
    }

    /**
     * THE INTERCEPTOR-LAYER NO-I/O GUARD (final whole-branch review, finding
     * C1). `NetworkBodyTeeAttachTest.attachPerformsNoIOOfItsOwn` proves
     * `attach()` alone reads nothing — but `attach()` is only the last line of
     * the capture path. Injecting `resp.peekBody(1_000_000L)` into
     * `EverframeInterceptor` immediately BEFORE the `NetworkBodyTee.attach`
     * call — a full-body blocking read on the app's own call thread, which is
     * the literal defect that got the previous Android implementation deleted
     * — left the entire 586-test suite green.
     *
     * No buffer-size assertion can ever catch that: a pre-read that bypasses
     * the tee finalizes nothing, so `sharedNetworkBodyBuffer` is empty at the
     * exact moment it is empty for correct code too. The only thing that
     * separates the two is counting the delegate's reads.
     *
     * Construction: the counting source is wrapped into the response by an
     * interceptor added AFTER ours, which therefore sits BELOW ours in the
     * chain and hands its response UP to `intercept()`. So the counter is
     * already in place before `intercept()` sees the response, and there is no
     * way for `intercept()` to touch a body byte without being counted. The
     * assertion runs the instant `execute()` returns, before the app has read
     * anything.
     *
     * The `> 0` check afterwards is not decoration: without it this test would
     * still pass if the counting source were never on the read path at all.
     *
     * MUTATION-VERIFIED — see the fix-wave report for the exact failure text.
     */
    @Test
    fun interceptItselfReadsNoBodyBytes() {
        val payload = "{\"a\":\"" + "z".repeat(2_000) + "\"}"
        server.enqueue(MockResponse().setBody(payload).setHeader("Content-Type", "application/json"))

        val counter = AtomicReference<CountingSource?>(null)
        val instrumented = OkHttpClient.Builder()
            // OUTER — the unit under test.
            .addEverframeInterceptor()
            // INNER — runs below ours, so its response (counting source and
            // all) is what our intercept() receives.
            .addInterceptor(
                Interceptor { chain ->
                    val resp = chain.proceed(chain.request())
                    val original = resp.body!!
                    val counting = CountingSource(original.source())
                    counter.set(counting)
                    resp.newBuilder()
                        .body(
                            counting.buffer()
                                .asResponseBody(original.contentType(), original.contentLength()),
                        )
                        .build()
                },
            )
            .build()

        val response = instrumented.newCall(Request.Builder().url(server.url("/x")).build()).execute()
        val counting = counter.get()
        assertNotNull("the counting source must have been installed below the interceptor", counting)

        assertEquals(
            "intercept() must not read a single byte of the response body on the app's " +
                "call thread — that is the Response.peekBody defect this design replaces",
            0,
            counting!!.reads.get(),
        )

        // The counter is genuinely on the read path (otherwise the assertion
        // above would be vacuous), and the app still gets every byte.
        assertEquals(payload, response.body!!.string())
        assertTrue(
            "the counting source must actually be the tee's delegate",
            counting.reads.get() > 0,
        )
        response.close()
    }

    /**
     * The core non-interference proof. A response far larger than the capture
     * window: execute() must return and the FIRST read must deliver bytes
     * while capture has necessarily not finalized, because finalization
     * cannot happen before the app pulls the bytes that trigger it.
     *
     * STRENGTHENED beyond the brief's literal text (which asserted only the
     * post-execute() state and never checked anything again): with
     * `__directForTesting = true`, submission is synchronous on the calling
     * thread, so if `intercept()` ever regressed into reading the body itself
     * before returning to the caller — exactly the `Response.peekBody` defect
     * this design replaces — the buffer would already hold an entry the
     * instant execute() returns. A single post-execute() assertion proves
     * that.
     *
     * NOTE — an assertion was attempted here and DELETED after it proved to
     * be a bug in this test, not in production: asserting the buffer was
     * STILL empty after the 16-byte `readByteString(16)` call failed with
     * "expected 0 but was 1". That is not the interference defect —
     * Okio's `RealBufferedSource.request()` always pulls a delegate read of
     * up to a full 8192-byte segment to satisfy ANY request, regardless of
     * how few bytes the caller asked for (see `Buffer.request`). On a local
     * loopback MockWebServer the whole 200 KB body is already sitting in the
     * socket's receive buffer, so that single delegate `read()` call can — and
     * did — return enough bytes to fill the 4160-byte window in one shot. The
     * tee copies from `sink` only after the delegate produced it — it did not
     * take a second, independent read the app didn't ask for — so this is
     * correct buffered-source behaviour, not the peekBody-style defect. The
     * app-facing size assertion right after (`first.size == 16`) is what
     * actually matters: the app got exactly what it asked for regardless of
     * how much the tee saw underneath.
     */
    @Test
    fun executeReturnsAndFirstReadDeliversBeforeCaptureFinalizes() {
        val payload = "{\"a\":\"" + "z".repeat(200_000) + "\"}"
        server.enqueue(MockResponse().setBody(payload).setHeader("Content-Type", "application/json"))

        val response = call().execute()
        // execute() returned: nothing pre-read the body.
        assertEquals(0, sharedNetworkBodyBuffer.snapshot().size)

        val source = response.body!!.source()
        val first = source.readByteString(16)
        assertEquals(16, first.size)

        val rest = source.readByteArray() // drain; the tee must not have starved the stream
        assertTrue(rest.isNotEmpty())
        response.close()

        // Closes the loop: once the app has pulled past the window, exactly
        // one (truncated) entry exists — capture did happen, just strictly
        // after the app's own pull, never ahead of it.
        val entries = sharedNetworkBodyBuffer.snapshot()
        assertEquals(1, entries.size)
        assertEquals(true, entries[0].resBodyTruncated)
    }

    /**
     * Once the window fills mid-stream, an entry exists BEFORE the app has
     * finished reading — proving finalization is driven by the window, not
     * by full completion — and the underlying stream keeps delivering bytes
     * afterward: capture stopping does not mean delegation stops.
     */
    @Test
    fun streamedResponseIsCapturedOnceTheWindowFillsAndKeepsFlowing() {
        val payload = "d".repeat(100_000)
        server.enqueue(MockResponse().setBody(payload).setHeader("Content-Type", "text/event-stream"))

        val response = call().execute()
        val source = response.body!!.source()
        // Pull past the 64-byte cap + 4096 overlap so the window fills.
        source.readByteString(8_192)
        assertEquals("window filled ⇒ entry exists", 1, sharedNetworkBodyBuffer.snapshot().size)
        assertEquals(true, sharedNetworkBodyBuffer.snapshot()[0].resBodyTruncated)

        // The stream is still usable afterwards — capture stopped, delegation didn't.
        val rest = source.readByteArray()
        assertTrue(rest.isNotEmpty())
        response.close()
    }

    // DELETED (Task 7 review Finding 2): `earlyCloseYieldsAPartialTruncatedEntry`
    // — read 32 of ~100,000 bytes over the real socket, then close(), expect
    // one truncated entry — used to live here. Mutation testing proved it
    // cannot fail for any single-point (or paired) mutation of TeeSource's
    // three finalize triggers: over a real socket with the whole payload
    // already buffered, Okio's `RealBufferedSource.request(32)` pulls the
    // delegate via a full 8192-byte segment read regardless of the 32-byte
    // ask, overshooting the 4160-byte window (cap=64 + 4096 overlap) on that
    // SAME call — so window-fill alone was always enough to produce the
    // entry the assertions checked for, no matter which of close()/EOF/
    // window-fill was mutated away. It also cost ~85% of this file's runtime
    // (1.4-2.0s of fixed OkHttp socket-teardown cost, independent of payload
    // size) for zero unique regression coverage. The property it was meant
    // to guard — closing early after a partial read still finalizes a
    // truncated entry — is correctly and more cheaply guarded by
    // `NetworkBodyTeeAttachTest.closingAfterAPartialReadFinalizesViaTheCloseOverride`,
    // which isolates `close()` by construction (an in-memory source with no
    // socket, a window the ~5000-byte body can't fill, and a 4-byte read that
    // can't reach EOF on its own) rather than by coincidence.

    /**
     * A dead transport's IOException must reach the caller unchanged THROUGH
     * the full interceptor + tee chain, over a REAL socket (MockWebServer's
     * DISCONNECT_DURING_RESPONSE_BODY) rather than a hand-rolled `Source` that
     * throws on cue.
     *
     * CORRECTION (found via mutation, see task-7-report.md): this does not
     * exercise `EverframeInterceptor`'s own catch/rethrow — `chain.proceed()`
     * has already returned successfully by the time the body is read, so the
     * interceptor's try/catch is out of the picture. The exception is thrown
     * from `wrapped.body!!.string()`, inside `TeeSource.read()`'s own
     * catch-and-rethrow (NetworkBodyTee.kt), which NetworkBodyTeeAttachTest
     * already exercises with a hand-built failing `Source`
     * (`transportFailureBeforeAnyBytesRecordsAnErrorEntry`,
     * `transportFailureMidStreamKeepsTheBytesThatArrived`). This test's
     * distinct value is narrower than originally stated: it confirms that
     * property survives a REAL OkHttp exchange codec + a REAL MockWebServer
     * mid-body disconnect, not a synthetic one.
     */
    @Test
    fun transportFailureMidBodyPropagatesUnchanged() {
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "application/json")
                .setBody("{\"a\":\"" + "z".repeat(50_000) + "\"}")
                .setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY),
        )

        var threw = false
        try {
            call().execute().use { it.body!!.string() }
        } catch (e: IOException) {
            threw = true // the app's failure semantics are unchanged
        }
        assertTrue("IOException must reach the caller", threw)
    }

    /**
     * The interceptor captures `snap.generation` at decision time
     * (EverframeInterceptor.kt, `bodyCtx`) — not a value a test hands it
     * directly, unlike NetworkBodyFinalizerTest's
     * `aStaleGenerationIsRejectedAtTheAppendBoundary`, which constructs a
     * stale `ctx` by hand. This test proves the real capture-then-compare
     * path.
     *
     * CORRECTED (Task 7 review): the original version of this test flipped
     * `captureBodies` OFF and left it off, then asserted the body was
     * dropped. That does catch a real regression (forcing the append guard
     * closure to `{ true }` makes it fail), but it does NOT exercise the
     * GENERATION comparison specifically — `NetworkBodyCaptureState.active`
     * is false by the time finalization runs, so `isActiveForGeneration`
     * rejects on the `active` half of `active && generation == expected`
     * alone. Deleting the `generation == expected` half while leaving
     * `active` intact left the original test green — it was silently only
     * pinning "gate-off wins", already covered elsewhere, under a name that
     * claimed to pin the generation token.
     *
     * This version cycles the gate OFF then back ON before the app finishes
     * reading: `active` is true again by finalize time (so the `active` half
     * of the guard cannot be what rejects it), but each transition bumps
     * `NetworkBodyCaptureState`'s generation (`generation is stable across
     * no-op applyConfig calls` / `generation bumps on transition to
     * active|inactive` in NetworkBodyCaptureStateTest), so the token the
     * interceptor captured at decision time is now stale. Only the
     * generation comparison can explain the drop here.
     */
    @Test
    fun aStaleGenerationFromAnOffOnCycleDropsTheBody() {
        server.enqueue(MockResponse().setBody("{\"ok\":true}").setHeader("Content-Type", "application/json"))

        val response = call().execute()
        // OFF then back ON before finalize: `active` ends up true again, but
        // the generation captured at decision time is now stale.
        NetworkBodyCaptureState.applyConfig(
            wire = NetworkBodiesConfigWire(captureBodies = false),
            samplingRate = 1.0,
            locallyDisabled = false,
            random = { 0.0 },
        )
        NetworkBodyCaptureState.applyConfig(
            wire = NetworkBodiesConfigWire(captureBodies = true, bodyByteCap = 64),
            samplingRate = 1.0,
            locallyDisabled = false,
            random = { 0.0 },
        )
        response.body!!.string()

        assertEquals(0, sharedNetworkBodyBuffer.snapshot().size)
    }
}
