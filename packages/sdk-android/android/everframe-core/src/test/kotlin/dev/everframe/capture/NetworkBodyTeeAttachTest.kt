// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import dev.everframe.Everframe
import dev.everframe.config.NetworkBodiesConfigWire
import dev.everframe.protocol.generated.BodySkipped
import dev.everframe.shared.SharedData
import java.io.IOException
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.asResponseBody
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import okio.Source
import okio.Timeout
import okio.buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class NetworkBodyTeeAttachTest {

    // DEVIATION FROM THE BRIEF (same defect Task 4 hit, same fix): the brief's
    // setUp flips `Everframe.captureGate` and `__directForTesting` but never
    // ACTIVATES NetworkBodyCaptureState, whose `active` bit is fail-closed
    // false by default. Every append is guarded by
    // `NetworkBodyCaptureState.isActiveForGeneration(ctx.generation)`, so with
    // the gate inert the guard rejects EVERYTHING regardless of generation and
    // the happy-path tests below fail with "expected 1 but was 0" — for a
    // reason that has nothing to do with the tee. Fix (mirrors
    // NetworkBodyFinalizerTest): turn the state on via applyConfig, and take
    // ctx's generation from the LIVE snapshotActive() rather than hardcoding
    // 0, which is also how EverframeInterceptor will capture the token at
    // decision time.
    private fun activateGate() {
        NetworkBodyCaptureState.applyConfig(
            NetworkBodiesConfigWire(
                captureBodies = true,
                bodyByteCap = null,
                bodyContentTypes = null,
                bodyTotalBudget = null,
            ),
            samplingRate = 1.0,
            locallyDisabled = false,
            random = { 0.0 },
        )
    }

    @Before
    fun setUp() {
        SharedData.init(RuntimeEnvironment.getApplication())
        Everframe.captureGate = true
        activateGate()
        NetworkBodyFinalizer.__directForTesting = true
        sharedNetworkBodyBuffer.clear()
    }

    @After
    fun tearDown() {
        NetworkBodyFinalizer.__directForTesting = false
        sharedNetworkBodyBuffer.clear()
        Everframe.captureGate = false
        NetworkBodyCaptureState.resetForTesting()
    }

    private fun ctx(cap: Int = 8192) = NetworkBodyFinalizer.Ctx(
        reqId = 1,
        t = 1L,
        cap = cap,
        generation = NetworkBodyCaptureState.snapshotActive().generation,
        resHeaders = emptyMap(),
    )

    private fun responseOf(body: okhttp3.ResponseBody) = Response.Builder()
        .request(Request.Builder().url("https://example.test/x").build())
        .protocol(Protocol.HTTP_1_1).code(200).message("OK")
        .body(body)
        .build()

    private fun response(text: String) =
        responseOf(text.toResponseBody("application/json".toMediaType()))

    /**
     * A [Source] that hands out at most [chunk] bytes per read, so the tee's
     * `read` is driven many times with a NON-EMPTY sink — which is precisely
     * what makes the copy offset (`sink.size - n`) load-bearing. A single
     * whole-body read would pass even with the offset hardcoded to 0.
     */
    private class ChunkedSource(
        data: ByteArray,
        private val chunk: Long,
        /** Throw after this many bytes have been handed out; -1 = never. */
        private val failAfter: Long = -1L,
    ) : Source {
        private val remaining = Buffer().write(data)
        private var emitted = 0L

        /** Task 7 review Finding 1 — how many times `read` was actually
         *  invoked. Lets a test assert "zero I/O happened", not just "capture
         *  didn't finalize" (see `attachPerformsNoIOOfItsOwn`). */
        var reads = 0
            private set

        override fun read(sink: Buffer, byteCount: Long): Long {
            reads++
            if (failAfter >= 0L && emitted >= failAfter) throw IOException("transport died")
            if (remaining.exhausted()) return -1L
            val n = remaining.read(sink, minOf(byteCount, chunk))
            if (n > 0L) emitted += n
            return n
        }

        override fun timeout(): Timeout = Timeout.NONE
        override fun close() = Unit
    }

    private fun chunkedResponse(text: String, chunk: Long, failAfter: Long = -1L): Response {
        val bytes = text.toByteArray()
        return responseOf(
            ChunkedSource(bytes, chunk, failAfter).buffer()
                .asResponseBody("application/json".toMediaType(), bytes.size.toLong()),
        )
    }

    @Test
    fun appReceivesIdenticalBytes() {
        val text = "{\"a\":\"" + "z".repeat(5000) + "\"}"
        val wrapped = NetworkBodyTee.attach(response(text), ctx())
        assertEquals(text, wrapped.body!!.string())
    }

    // Task 7 review Finding 1 — THE CARDINAL PROPERTY, PROVEN DIRECTLY.
    // Every non-interference assertion elsewhere in this suite (here and in
    // NetworkBodyTeeNonInterferenceTest) only observes whether capture
    // FINALIZED — i.e. whether `sharedNetworkBodyBuffer` gained an entry. A
    // pre-read hidden inside `attach()` itself (e.g. an eager
    // `body.source().request(...)` before the tee is even constructed) is
    // invisible to every one of those assertions: it bypasses the tee
    // entirely, so nothing finalizes and the buffer stays empty regardless of
    // how much I/O just happened synchronously on the caller's thread. That
    // is precisely the `Response.peekBody` defect this whole file exists to
    // rule out, and none of the other tests can see it happen.
    //
    // This test observes I/O directly instead: `attach()` must not call
    // `read()` on the delegate source AT ALL — construction only. Verified by
    // mutation: injecting `body.source().request(1_000_000L)` as the first
    // line of `NetworkBodyTee.attach` makes this fail (reads goes from 0 to
    // 1); reverting restores the pass. No socket, no timing, no latch — a
    // plain read counter on the delegate.
    @Test
    fun attachPerformsNoIOOfItsOwn() {
        val delegate = ChunkedSource("{\"a\":1}".toByteArray(), chunk = 7)
        val body = delegate.buffer().asResponseBody("application/json".toMediaType(), 7L)

        NetworkBodyTee.attach(responseOf(body), ctx())

        assertEquals("attach() must not read a single byte from the delegate", 0, delegate.reads)
    }

    @Test
    fun readingToEofProducesACompleteEntry() {
        val wrapped = NetworkBodyTee.attach(response("{\"a\":1}"), ctx())
        wrapped.body!!.string()

        val entries = sharedNetworkBodyBuffer.snapshot()
        assertEquals(1, entries.size)
        assertEquals("{\"a\":1}", entries[0].resBody)
        assertEquals(7.0, entries[0].resBodyBytes)
        assertNull("a fully-read in-window body is not truncated", entries[0].resBodyTruncated)
    }

    @Test
    fun closingWithoutReadingAppendsNothing() {
        val wrapped = NetworkBodyTee.attach(response("{\"a\":1}"), ctx())
        wrapped.body!!.close()
        assertEquals(0, sharedNetworkBodyBuffer.snapshot().size)
    }

    // GAP FOUND BY TASK 7's MUTATION TESTING, closed after review (not in the
    // original Task 5 or Task 7 briefs). An earlier integration-level test —
    // read 32 of ~100,000 bytes over a REAL MockWebServer socket, then
    // close() — was deleted after mutation testing showed it cannot fail for
    // ANY single-point mutation of `TeeSource`'s three finalize triggers
    // (`close()`, EOF, window-fill), individually or in combination.
    //
    // CORRECTED MECHANISM (an earlier version of this comment got this
    // wrong): the cause is NOT OkHttp connection-reuse machinery draining the
    // socket on close(). It is the same mechanism documented on
    // NetworkBodyTeeNonInterferenceTest's surviving non-interference test:
    // Okio's `RealBufferedSource.request(n)` always pulls the delegate via a
    // read sized to a full 8192-byte segment, regardless of how few bytes the
    // caller asked for (see `Buffer.request`). Over a live socket where the
    // whole payload is already sitting in the receive buffer, that ONE call
    // can — and did — hand the tee enough bytes to overshoot even a small
    // window (that deleted test's config: cap=64 + 4096 overlap = 4160 bytes)
    // during what looked like a 32-byte app read. So `finalizeOnce` fired
    // from WINDOW-FILL, mid-read, well before `close()` was ever reached —
    // independent of whether `close()` or the EOF branch were mutated away.
    // The three triggers were fully redundant with each other for that
    // specific test, so it could never isolate any one of them.
    //
    // This unit test is the reliable replacement, and it isolates `close()`
    // by construction rather than by coincidence: the source is in-memory (no
    // socket at all), the ~5000-byte body is well under `ctx()`'s DEFAULT
    // window (8192 cap + 4096 overlap = 12288), so window-fill cannot fire,
    // and only 4 bytes are ever pulled through `request()` — satisfied by the
    // delegate's single read, so the buffered wrapper never calls `read()`
    // again and EOF is never reached either. Only `close()` can finalize here.
    // Deleting `finalizeOnce(...)` from `close()` makes this fail with 0
    // entries instead of 1 — verified by mutation.
    //
    // CHUNKED, NOT `response(text)` (final whole-branch review, finding I3):
    // a plain `toResponseBody` Buffer holds all ~5010 bytes in ONE okio
    // segment, so the delegate's single read hands the tee the ENTIRE declared
    // body during that 4-byte `request()`. With the I3 fix — captured bytes
    // >= `contentLength()` means we hold the whole body, whichever trigger
    // finalizes — that is (correctly) no longer truncated, and the assertion
    // below would fail for a reason that has nothing to do with `close()`.
    // A 64-byte chunked delegate keeps the capture a genuine PREFIX (64 of
    // ~5010) so the truncation assertion still says what it means, while every
    // property that makes this test isolate `close()` is unchanged.
    @Test
    fun closingAfterAPartialReadFinalizesViaTheCloseOverride() {
        val text = "{\"a\":\"" + "z".repeat(5000) + "\"}"
        val wrapped = NetworkBodyTee.attach(chunkedResponse(text, chunk = 64), ctx())
        wrapped.body!!.source().readByteString(4)
        wrapped.body!!.close()

        val entries = sharedNetworkBodyBuffer.snapshot()
        assertEquals(1, entries.size)
        assertEquals(true, entries[0].resBodyTruncated)
    }

    // DEVIATION FROM THE BRIEF (defect in the brief's test, not the impl): the
    // brief asserts `contentType().toString() == "application/json"`. That is
    // false for a reason that has nothing to do with the tee —
    // `String.toResponseBody(mediaType)` REWRITES a charset-less media type to
    // "application/json; charset=utf-8" so it can pick an encoding for the
    // string it is about to encode. Run as written the test fails with
    // `expected:<application/json[]> but was:<application/json[; charset=utf-8]>`
    // while the tee is behaving perfectly. Asserting against the ORIGINAL
    // body's own values is both correct and a strictly stronger statement of
    // the actual contract — these fields DELEGATE, whatever they happen to be.
    @Test
    fun contentTypeAndLengthStillDelegate() {
        val original = response("{\"a\":1}")
        val declaredType = original.body!!.contentType()
        val declaredLength = original.body!!.contentLength()
        val wrapped = NetworkBodyTee.attach(original, ctx())
        assertEquals(declaredType, wrapped.body!!.contentType())
        assertEquals(declaredLength, wrapped.body!!.contentLength())
        // Pin the media TYPE itself so this can't degrade into a tautology if
        // the delegation is ever replaced by an unconditional null.
        assertEquals("application/json", wrapped.body!!.contentType()!!.let { "${it.type}/${it.subtype}" })
    }

    @Test
    fun killMidStreamZeroizesAndAppendsNothing() {
        val text = "{\"a\":\"" + "z".repeat(20_000) + "\"}"
        val wrapped = NetworkBodyTee.attach(response(text), ctx())
        val source = wrapped.body!!.source()
        source.readByteString(64)     // pull a little
        Everframe.captureGate = false  // kill lands mid-stream
        source.readByteArray()        // drain the rest; app is unaffected

        assertEquals(0, sharedNetworkBodyBuffer.snapshot().size)
    }

    // GAP FOUND BY MUTATION TESTING, not in the brief. The test above passes
    // even with `captured.clear()` deleted from the kill branch — verified by
    // mutation — because NetworkBodyRingBuffer.append ITSELF early-returns on
    // `!Everframe.captureGate` (honorsKillGate), so the entry is suppressed at
    // the sink no matter what the tee is still holding. That asserts
    // suppression, not zeroization, and zeroization is the actual DEFE-03
    // requirement: the bytes must be GONE from our memory, not merely unsent.
    //
    // Re-opening the gate before EOF is what separates the two. If the tee
    // only stopped appending, the pre-kill bytes would still be sitting in
    // `captured` and would be submitted (and now accepted) at EOF. Nothing
    // may land: the kill zeroized the buffer and permanently stopped copying,
    // so the finalization at EOF has nothing to hand over. Deleting either
    // `captured.clear()` or `copying = false` makes this fail.
    @Test
    fun killMidStreamZeroizesEvenIfTheGateReopensBeforeEof() {
        // 64-byte chunks so every app read maps 1:1 onto a delegate read —
        // with a whole-body source okio's 8 KiB segment fill would satisfy the
        // second read out of its own buffer and the tee would never observe
        // the kill at all.
        val text = "{\"a\":\"" + "z".repeat(3000) + "\"}"
        val wrapped = NetworkBodyTee.attach(chunkedResponse(text, chunk = 64), ctx())
        val source = wrapped.body!!.source()
        source.readByteString(64)     // pull a little; the tee has copied bytes
        Everframe.captureGate = false  // kill lands mid-stream
        source.readByteString(64)     // this read observes the kill and zeroizes
        Everframe.captureGate = true   // gate re-opens; an append would now succeed
        source.readByteArray()        // drain to EOF -> finalization runs

        assertEquals(0, sharedNetworkBodyBuffer.snapshot().size)
    }

    @Test
    fun bodyLargerThanTheWindowIsTruncatedAndStillFullyReadable() {
        val text = "{\"a\":\"" + "z".repeat(60_000) + "\"}"
        val wrapped = NetworkBodyTee.attach(response(text), ctx(cap = 64))
        assertEquals(text, wrapped.body!!.string()) // app still gets everything

        val entries = sharedNetworkBodyBuffer.snapshot()
        assertEquals(1, entries.size)
        assertEquals(true, entries[0].resBodyTruncated)
        assertTrue(entries[0].resBody!!.toByteArray().size <= 64)
    }

    // The offset arithmetic guard. The delegate hands out 7 bytes at a time
    // and the app pulls the whole body in one `readByteArray()`, so okio's
    // `writeAll` loop calls the tee's `read` ~45 times with a sink that is
    // ALREADY 7, 14, 21 … bytes long. Copying from the wrong offset (e.g. a
    // hardcoded 0, or `sink.size` instead of `sink.size - n`) still yields a
    // capture of the right LENGTH — only comparing the bytes catches it.
    @Test
    fun multiChunkReadsCaptureEveryByteInOrder() {
        val payload = (0 until 301).map { ('a' + (it % 26)) }.joinToString("")
        val text = "{\"a\":\"$payload\"}"
        val wrapped = NetworkBodyTee.attach(chunkedResponse(text, chunk = 7), ctx())

        assertEquals(text, wrapped.body!!.source().readByteArray().toString(Charsets.UTF_8))

        val entries = sharedNetworkBodyBuffer.snapshot()
        assertEquals(1, entries.size)
        assertEquals(text, entries[0].resBody)
        assertEquals(text.toByteArray().size.toDouble(), entries[0].resBodyBytes)
    }

    // `hitWindow` and `complete` are SEPARATE signals: reaching EOF after the
    // window already filled means the stream ended, but the captured bytes are
    // NOT the whole body. If EOF wrongly reported complete = true, the byte
    // count would be the window size (4160) instead of the declared full size.
    @Test
    fun eofAfterTheWindowFilledIsNotReportedAsComplete() {
        val payload = (0 until 5000).map { ('a' + (it % 26)) }.joinToString("")
        val text = "{\"a\":\"$payload\"}"
        val wrapped = NetworkBodyTee.attach(chunkedResponse(text, chunk = 512), ctx(cap = 64))

        assertEquals(text, wrapped.body!!.source().readByteArray().toString(Charsets.UTF_8))

        val entries = sharedNetworkBodyBuffer.snapshot()
        assertEquals(1, entries.size)
        assertEquals(true, entries[0].resBodyTruncated)
        // Declared length, NOT the 64 + 4096 window we actually copied.
        assertEquals(text.toByteArray().size.toDouble(), entries[0].resBodyBytes)
    }

    // Finalization fires exactly once across window-fill, EOF and close.
    @Test
    fun finalizationIsIdempotentAcrossEofAndClose() {
        val wrapped = NetworkBodyTee.attach(response("{\"a\":1}"), ctx())
        val source = wrapped.body!!.source()
        source.readByteArray()
        source.close()
        wrapped.body!!.close()

        assertEquals(1, sharedNetworkBodyBuffer.snapshot().size)
    }

    @Test
    fun windowFillFollowedByCloseAppendsExactlyOneEntry() {
        val text = "{\"a\":\"" + "z".repeat(60_000) + "\"}"
        val wrapped = NetworkBodyTee.attach(response(text), ctx(cap = 64))
        val source = wrapped.body!!.source()
        source.readByteArray()
        source.close()

        assertEquals(1, sharedNetworkBodyBuffer.snapshot().size)
    }

    // A dead transport is worth reporting; the app's own IOException must
    // reach the app untouched.
    @Test
    fun transportFailureBeforeAnyBytesRecordsAnErrorEntry() {
        val wrapped = NetworkBodyTee.attach(
            chunkedResponse("{\"a\":1}", chunk = 7, failAfter = 0L),
            ctx(),
        )

        var thrown: IOException? = null
        try {
            wrapped.body!!.source().readByteArray()
        } catch (e: IOException) {
            thrown = e
        }
        assertNotNull("the delegate's IOException must propagate to the app", thrown)

        val entries = sharedNetworkBodyBuffer.snapshot()
        assertEquals(1, entries.size)
        assertEquals(BodySkipped.Error, entries[0].resBodySkipped)
        assertNull(entries[0].resBody)
    }

    // FINAL WHOLE-BRANCH REVIEW, FINDING I3 — the truncation mislabel.
    //
    // A streaming parser (Moshi/Retrofit, and any reader that knows its own
    // framing) reads exactly `contentLength()` bytes and then closes. It never
    // reads past the closing brace, so the tee never sees the `-1` EOF read —
    // and before this fix the entry finalized with `complete = false` and was
    // reported `resBodyTruncated = true` even though the captured text IS the
    // whole body. Confirmed empirically on the same 7-byte payload: this
    // read shape gave `truncated = true` while `string()` (which does hit EOF)
    // gave `truncated = null`, for byte-identical captures.
    //
    // The fix makes the DECLARED length the tiebreaker: holding at least
    // `contentLength()` bytes means we hold the whole body, whichever trigger
    // finalized. Reverting it makes this fail with
    // `expected null, but was:<true>` on `resBodyTruncated`.
    @Test
    fun readingExactlyContentLengthThenClosingIsNotReportedTruncated() {
        val text = "{\"a\":1}" // 7 bytes; response(text) declares Content-Length 7
        val wrapped = NetworkBodyTee.attach(response(text), ctx())
        assertEquals(7L, wrapped.body!!.contentLength())

        val source = wrapped.body!!.source()
        // Exactly the declared length, then close. No read ever returns -1.
        assertEquals(text, source.readUtf8(7L))
        wrapped.body!!.close()

        val entries = sharedNetworkBodyBuffer.snapshot()
        assertEquals(1, entries.size)
        assertEquals(text, entries[0].resBody)
        assertEquals(7.0, entries[0].resBodyBytes)
        assertNull(
            "the captured text IS the whole declared body — reading to the declared " +
                "length without an EOF read must not be reported as truncated",
            entries[0].resBodyTruncated,
        )
    }

    // FINAL WHOLE-BRANCH REVIEW, FINDINGS I4 + I5 — one shared one-line fix.
    //
    // I4: the `catch (t: Throwable)` around the copy used to set only
    // `copying = false` and leave `hitWindow` false, so the later EOF branch
    // evaluated `complete = !hitWindow` to TRUE — a body truncated by a
    // mid-copy failure shipped as COMPLETE, with a `resBodyBytes` that is
    // simply wrong presented as ground truth.
    //
    // I5: `!hitWindow` at that EOF branch was DEAD — window-fill finalizes
    // immediately, so EOF could never observe `hitWindow == true`, and
    // mutating the expression to a bare `complete = true` left the suite
    // green. Setting `hitWindow = true` in the catch fixes I4 and makes the
    // expression live in the same stroke, which is why one test covers both:
    // reverting EITHER (`hitWindow = true` removed, or `!hitWindow` mutated to
    // `true`) makes this fail with `expected:<true> but was:<null>`.
    //
    // The throw comes through `attach`'s test-only `copyFault` seam. That seam
    // exists because there is no external way to make the copy throw: it can
    // only fail if the delegate reports more bytes than it wrote, and
    // `ResponseBody.source()` must return an `okio.BufferedSource`, which okio
    // declares SEALED ("Extending sealed classes or interfaces from a
    // different module is prohibited") — while a plain `Source` wrapped in
    // `.buffer()` has its count normalized by `RealBufferedSource` before the
    // tee sees it (the first draft of this test did exactly that and failed
    // with `expected:<true> but was:<null>` because no throw ever happened).
    @Test
    fun aFailureInsideTheCopyIsReportedTruncatedNotComplete() {
        val payload = (0 until 300).map { ('a' + (it % 26)) }.joinToString("")
        val text = "{\"a\":\"$payload\"}"
        val declared = text.toByteArray().size

        var copies = 0
        val wrapped = NetworkBodyTee.attach(
            chunkedResponse(text, chunk = 64),
            ctx(),
        ) {
            copies++
            // Let the first 64-byte chunk land, then blow up mid-stream.
            if (copies == 2) throw IllegalStateException("copy blew up")
        }

        // Capture failure must never become app failure: every byte still
        // reaches the caller, and no exception escapes.
        assertEquals(text, wrapped.body!!.source().readByteArray().toString(Charsets.UTF_8))
        assertTrue("the fault must actually have fired", copies >= 2)

        val entries = sharedNetworkBodyBuffer.snapshot()
        assertEquals(1, entries.size)
        assertEquals(
            "a body truncated by a mid-copy failure holds a PREFIX — it must never " +
                "be reported as the complete body",
            true,
            entries[0].resBodyTruncated,
        )
        // The declaration, not the 64 bytes we managed to keep.
        assertEquals(declared.toDouble(), entries[0].resBodyBytes)
        assertEquals("only the pre-failure prefix survives", text.take(64), entries[0].resBody)
    }

    // A transport that dies PART-WAY still yields whatever arrived, marked
    // truncated — the body is real, it is just not the whole story.
    @Test
    fun transportFailureMidStreamKeepsTheBytesThatArrived() {
        val payload = (0 until 300).map { ('a' + (it % 26)) }.joinToString("")
        val text = "{\"a\":\"$payload\"}"
        val wrapped = NetworkBodyTee.attach(
            chunkedResponse(text, chunk = 7, failAfter = 70L),
            ctx(),
        )

        try {
            wrapped.body!!.source().readByteArray()
        } catch (e: IOException) {
            // expected
        }

        val entries = sharedNetworkBodyBuffer.snapshot()
        assertEquals(1, entries.size)
        assertEquals(text.take(70), entries[0].resBody)
        assertEquals(true, entries[0].resBodyTruncated)
    }
}
