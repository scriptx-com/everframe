// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import dev.everframe.Everframe
import dev.everframe.config.NetworkBodiesConfigWire
import dev.everframe.protocol.generated.BodySkipped
import dev.everframe.shared.SharedData
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class NetworkBodyFinalizerTest {

    @Before
    fun setUp() {
        SharedData.init(RuntimeEnvironment.getApplication())
    }

    @Test
    fun completeSmallBodyIsNotTruncatedAndCountsExactly() {
        val raw = "{\"a\":1}".toByteArray()
        val out = NetworkBodyFinalizer.decodeAndRedact(raw, cap = 8192, complete = true, declaredLength = -1L)
        assertEquals("{\"a\":1}", out.body)
        assertNull(out.truncated)
        assertEquals(raw.size.toDouble(), out.bytes)
        assertNull(out.skipped)
    }

    // Rule 1: a complete read is ground truth and OUTRANKS a declared length.
    @Test
    fun completeReadOutranksDeclaredLength() {
        val raw = "abcd".toByteArray()
        val out = NetworkBodyFinalizer.decodeAndRedact(raw, cap = 8192, complete = true, declaredLength = 999L)
        assertEquals(4.0, out.bytes)
    }

    // Rule 2: incomplete read falls back to the declaration.
    @Test
    fun incompleteReadUsesDeclaredLength() {
        val raw = "abcd".toByteArray()
        val out = NetworkBodyFinalizer.decodeAndRedact(raw, cap = 8192, complete = false, declaredLength = 999L)
        assertEquals(999.0, out.bytes)
        assertEquals(true, out.truncated)
    }

    // Rule 3: unknown stays unknown — never invented.
    @Test
    fun incompleteReadWithNoDeclarationOmitsBytes() {
        val out = NetworkBodyFinalizer.decodeAndRedact("abcd".toByteArray(), cap = 8192, complete = false, declaredLength = -1L)
        assertNull(out.bytes)
        assertEquals(true, out.truncated)
    }

    @Test
    fun completeBodyLongerThanCapIsTruncatedToCap() {
        val raw = "x".repeat(100).toByteArray()
        val out = NetworkBodyFinalizer.decodeAndRedact(raw, cap = 10, complete = true, declaredLength = -1L)
        assertEquals(10, out.body!!.toByteArray().size)
        assertEquals(true, out.truncated)
        assertEquals(100.0, out.bytes)
    }

    // The whole point of the widened window: a secret straddling the cap must
    // still be masked, and masking happens BEFORE the cut. `cap` must land
    // strictly INSIDE the JWT's byte span in `raw` — otherwise the JWT is
    // simply excluded by the cut rather than straddled, and the test would
    // pass identically against a broken truncate-before-redact
    // implementation. The precondition is asserted, not just hoped for, so
    // it can't silently stop straddling if the literals above are edited.
    @Test
    fun secretStraddlingTheCapIsRedactedBeforeTruncation() {
        val jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        val prefix = "{\"pad\":\"" + "p".repeat(40) + "\",\"token\":\""
        val raw = (prefix + jwt + "\"}").toByteArray()

        val prefixLen = prefix.toByteArray().size
        val jwtLen = jwt.toByteArray().size
        val cap = 100
        assertTrue(
            "test precondition: cap must fall strictly inside the JWT's byte span " +
                "($prefixLen, ${prefixLen + jwtLen}) or this test doesn't exercise straddling",
            cap > prefixLen && cap < prefixLen + jwtLen,
        )

        val out = NetworkBodyFinalizer.decodeAndRedact(raw, cap = cap, complete = true, declaredLength = -1L)
        assertTrue("raw JWT must never survive", !out.body!!.contains("dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"))

        // The check above alone is not sufficient: the JWT pattern
        // (`[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`) has no
        // trailing anchor, so its third segment — which starts at byte
        // ${prefixLen + 49} and only finishes at byte ${prefixLen + jwtLen}
        // — never has ANY of its bytes inside a 100-byte window regardless
        // of cut order, making the check above pass trivially either way.
        // A fragment that starts right after the prefix (well inside the
        // cap window) proves the point instead: cutting the window to `cap`
        // before redacting would sever the JWT after its first dot, so the
        // pattern's two-dot requirement never matches and this leading
        // fragment survives raw in the output; redacting the whole window
        // first (the required order) replaces the entire three-segment
        // match, this fragment included, before any cut happens.
        val leadingFragment = jwt.substring(0, 10)
        assertTrue(
            "raw JWT fragment must never survive even when it starts inside the cap window",
            !out.body!!.contains(leadingFragment),
        )
    }

    // Redaction can EXPAND a match past cap: an 11-byte SSN becomes the
    // 14-byte token "[REDACTED:SSN]". Truncation must be judged on the SAME
    // (post-redaction) bytes it cuts — not on the pre-redaction size — or an
    // expansion like this silently ships a body over cap while reporting
    // truncated = null, falsely claiming completeness.
    @Test
    fun redactionExpansionPastCapIsTruncated() {
        val raw = "123-45-6789".toByteArray() // 11 bytes pre-redaction
        val out = NetworkBodyFinalizer.decodeAndRedact(raw, cap = 12, complete = true, declaredLength = -1L)
        assertTrue("redacted body must never exceed cap", out.body!!.toByteArray().size <= 12)
        assertEquals(true, out.truncated)
    }

    @Test
    fun nonUtf8BytesReportError() {
        val raw = byteArrayOf(0xFF.toByte(), 0xFE.toByte(), 0xFF.toByte(), 0xFE.toByte())
        val out = NetworkBodyFinalizer.decodeAndRedact(raw, cap = 8192, complete = true, declaredLength = -1L)
        assertEquals(BodySkipped.Error, out.skipped)
        assertNull(out.body)
        assertEquals(4.0, out.bytes)
    }

    // DEVIATION FROM THE BRIEF (found during TDD, not an override): the
    // brief's literal test code hardcodes `generation: Int = 0` and never
    // activates NetworkBodyCaptureState before calling submit()/appendSkip().
    // But NetworkBodyCaptureState.active defaults to false (see its file
    // header — fail-closed until a config says otherwise), so
    // append's guard — `NetworkBodyCaptureState.isActiveForGeneration(generation)`
    // — rejects EVERY entry by default, regardless of which generation is
    // passed. Run as literally written, `submitBuildsAndAppendsAnEntry` and
    // friends fail with "expected 1 but was 0": nothing lands, not because
    // the guard discriminates, but because it always says no. This is
    // exactly the failure mode the brief's own Step 4 footnote warns about
    // for the stale-generation test ("if it passes for the wrong reason").
    // Fix: activate the gate the same way NetworkBodyRingBufferTest's F34
    // tests do (NetworkBodyCaptureState.applyConfig with captureBodies =
    // true), and default `ctx()`'s generation to the CURRENT live
    // generation via snapshotActive() instead of a hardcoded 0, mirroring
    // how EverframeInterceptor actually captures the token at decision time.
    private fun activateGate() {
        NetworkBodyCaptureState.applyConfig(
            NetworkBodiesConfigWire(captureBodies = true, bodyByteCap = null, bodyContentTypes = null, bodyTotalBudget = null),
            samplingRate = 1.0, locallyDisabled = false, random = { 0.0 },
        )
    }

    private fun ctx(reqId: Int = 1, cap: Int = 8192, generation: Int = NetworkBodyCaptureState.snapshotActive().generation) =
        NetworkBodyFinalizer.Ctx(
            reqId = reqId,
            t = 1_700_000_000_000L,
            cap = cap,
            generation = generation,
            resHeaders = mapOf("content-type" to "application/json"),
        )

    @Test
    fun submitBuildsAndAppendsAnEntry() {
        Everframe.captureGate = true
        activateGate()
        NetworkBodyFinalizer.__directForTesting = true
        sharedNetworkBodyBuffer.clear()

        NetworkBodyFinalizer.submit("{\"a\":1}".toByteArray(), complete = true, failed = false, declaredLength = -1L, ctx = ctx(reqId = 7))

        val entries = sharedNetworkBodyBuffer.snapshot()
        assertEquals(1, entries.size)
        // JUnit4's 2-arg assertEquals(double, double) is a deprecated
        // always-fail stub (forces a delta form for float comparisons) —
        // `ref`/`t` are non-null Double here, so the 2-arg overload is what
        // Kotlin resolves to; use the 3-arg delta form instead.
        assertEquals(7.0, entries[0].ref, 0.0)
        assertEquals(1_700_000_000_000.0, entries[0].t, 0.0)
        assertEquals("{\"a\":1}", entries[0].resBody)
        assertEquals(mapOf("content-type" to "application/json"), entries[0].resHeaders)
        // Response direction only — the request half stays null everywhere.
        assertNull(entries[0].reqBody)
        assertNull(entries[0].reqHeaders)
    }

    // Spec §8: an abandoned body and a dead transport must NOT look the same.
    @Test
    fun zeroBytesOnAnAbandonedBodyAppendsNothing() {
        Everframe.captureGate = true
        // Final whole-branch review: this call was MISSING. Without it
        // NetworkBodyCaptureState is fail-closed inactive, so the append guard
        // rejects unconditionally and the empty-buffer assertion below would
        // hold no matter what finalizeNow did with the zero bytes — the test
        // named a behaviour it never exercised.
        activateGate()
        NetworkBodyFinalizer.__directForTesting = true
        sharedNetworkBodyBuffer.clear()

        NetworkBodyFinalizer.submit(ByteArray(0), complete = false, failed = false, declaredLength = -1L, ctx = ctx())

        assertEquals(0, sharedNetworkBodyBuffer.snapshot().size)
    }

    // OVERRIDE 1 (task-4 human override, supersedes the brief's literal
    // `raw.isEmpty() && !complete` guard): a chunked response with an empty
    // body has contentLength() == -1, so Task 2's decide() does not screen
    // it out — it reaches finalization with zero bytes AND complete = true.
    // The rule is "no entry for zero bytes, regardless of complete, unless
    // failed" — so this complete-but-empty case must ALSO append nothing.
    @Test
    fun zeroBytesButCompleteAppendsNothing() {
        Everframe.captureGate = true
        // Same missing-activateGate() defect as the sibling test above.
        activateGate()
        NetworkBodyFinalizer.__directForTesting = true
        sharedNetworkBodyBuffer.clear()

        NetworkBodyFinalizer.submit(ByteArray(0), complete = true, failed = false, declaredLength = -1L, ctx = ctx())

        assertEquals(0, sharedNetworkBodyBuffer.snapshot().size)
    }

    @Test
    fun zeroBytesAfterATransportFailureReportsError() {
        Everframe.captureGate = true
        activateGate()
        NetworkBodyFinalizer.__directForTesting = true
        sharedNetworkBodyBuffer.clear()

        NetworkBodyFinalizer.submit(ByteArray(0), complete = false, failed = true, declaredLength = -1L, ctx = ctx())

        val entries = sharedNetworkBodyBuffer.snapshot()
        assertEquals(1, entries.size)
        assertEquals(BodySkipped.Error, entries[0].resBodySkipped)
    }

    // Spec §9/§13: saturation must drop, never block or grow without bound.
    //
    // OVERRIDE 2 (task-4 human override, supersedes the brief's near-vacuous
    // `snapshot().size <= 500` assertion): the real contract under test is
    // "saturation discards rather than throwing" — assert that explicitly.
    // We then drain the executor deterministically (no wall-clock sleep):
    // __submitForTesting is the same discard-on-saturation queue under test,
    // so a single marker submission is not guaranteed delivery either — we
    // retry immediate (non-sleeping) submissions of a latch-countdown marker
    // until one actually lands and runs. The latch is the synchronization
    // signal; the attempt cap is only a hang safety net, not a timing
    // assertion.
    @Test
    fun executorSaturationDropsWithoutThrowing() {
        Everframe.captureGate = true
        activateGate()
        NetworkBodyFinalizer.__directForTesting = false // exercise the real executor
        sharedNetworkBodyBuffer.clear()

        // Far more than queueDepth (32); the discard policy must absorb the
        // excess silently rather than throwing RejectedExecutionException.
        var rejected: Throwable? = null
        try {
            repeat(500) {
                NetworkBodyFinalizer.submit("{\"a\":1}".toByteArray(), complete = true, failed = false, declaredLength = -1L, ctx = ctx())
            }
        } catch (t: Throwable) {
            rejected = t
        }
        assertNull("saturation must discard, never throw", rejected)

        val latch = CountDownLatch(1)
        var attempts = 0
        while (latch.count > 0 && attempts < 20_000) {
            NetworkBodyFinalizer.__submitForTesting { latch.countDown() }
            attempts++
        }
        assertTrue(
            "marker must eventually land and run under the discard policy " +
                "(single worker keeps draining the queue between retries)",
            latch.await(10, TimeUnit.SECONDS),
        )

        // Proves work actually ran (not that everything was silently
        // dropped) — the buffer's own 256 KiB budget bounds whatever landed.
        assertTrue(sharedNetworkBodyBuffer.snapshot().isNotEmpty())
    }

    @Test
    fun appendSkipProducesAReasonOnlyEntry() {
        Everframe.captureGate = true
        activateGate()
        NetworkBodyFinalizer.__directForTesting = true
        sharedNetworkBodyBuffer.clear()

        NetworkBodyFinalizer.appendSkip(BodySkipped.ContentType, ctx(reqId = 3))

        val entries = sharedNetworkBodyBuffer.snapshot()
        assertEquals(1, entries.size)
        assertEquals(3.0, entries[0].ref, 0.0)
        assertEquals(BodySkipped.ContentType, entries[0].resBodySkipped)
        assertNull(entries[0].resBody)
    }

    @Test
    fun aStaleGenerationIsRejectedAtTheAppendBoundary() {
        Everframe.captureGate = true
        NetworkBodyFinalizer.__directForTesting = true
        sharedNetworkBodyBuffer.clear()
        NetworkBodyCaptureState.resetForTesting() // bumps generation; ours is now stale

        NetworkBodyFinalizer.submit("{\"a\":1}".toByteArray(), complete = true, failed = false, declaredLength = -1L, ctx = ctx(generation = -1))

        assertEquals(0, sharedNetworkBodyBuffer.snapshot().size)
    }

    @After
    fun tearDownFinalizer() {
        NetworkBodyFinalizer.__directForTesting = false
        sharedNetworkBodyBuffer.clear()
        Everframe.captureGate = false
        NetworkBodyCaptureState.resetForTesting()
    }
}
