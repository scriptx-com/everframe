// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// NetworkBodyRingBuffer behavior: byte-budget eviction (not count-capped),
// freeze/discardAndResume/takeFrozen/clear lifecycle. ReentrantLock
// discipline + freeze shape mirrored from BreadcrumbRingBuffer.kt:267-282.
// Transliterated from packages/sdk-ios/Tests/EverframeTests/NetworkBodyRingBufferTests.swift
// (Task 7).
//
// Round-2 review Finding F11: `append` now honors `Everframe.captureGate` by
// default (`honorsKillGate = true`) — tests below that exercise budget /
// eviction behavior independently of the global kill-switch use the
// `honorsKillGate = false` seam so they don't need a live Everframe.start().
package dev.everframe.capture

import dev.everframe.Everframe
import dev.everframe.config.NetworkBodiesConfigWire
import dev.everframe.protocol.generated.NetworkBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class NetworkBodyRingBufferTest {

    @After
    fun tearDown() {
        // Belt-and-suspenders: no test below should leave the process-global
        // gate flipped, but restore it defensively so test order never leaks.
        Everframe.captureGate = false
    }

    private fun entry(
        ref: Int,
        t: Double,
        reqBody: String? = null,
        resBody: String? = null,
    ) = NetworkBody(
        ref = ref.toDouble(),
        reqBody = reqBody,
        reqBodyBytes = reqBody?.let { it.toByteArray(Charsets.UTF_8).size.toDouble() },
        reqBodySkipped = null,
        reqBodyTruncated = null,
        reqHeaders = null,
        resBody = resBody,
        resBodyBytes = resBody?.let { it.toByteArray(Charsets.UTF_8).size.toDouble() },
        resBodySkipped = null,
        resBodyTruncated = null,
        resHeaders = null,
        t = t,
    )

    @Test
    fun `evicts oldest when total budget exceeded`() {
        val buf = NetworkBodyRingBuffer(honorsKillGate = false)
        buf.setTotalBudget(1000)
        buf.append(entry(ref = 1, t = 1.0, resBody = "a".repeat(600)))
        buf.append(entry(ref = 2, t = 2.0, resBody = "b".repeat(600)))
        val refs = buf.snapshot().map { it.ref }
        assertEquals(listOf(2.0), refs) // oldest (by t) shed
    }

    @Test
    fun `byte accounting sums req and res bodies`() {
        // Budget accounts for the fixed per-entry overhead (Finding 2, see
        // `zero-body entries with headers are still evicted once budget exceeded`
        // below): each entry here costs 300 body bytes + 256 overhead = 556,
        // so 700 keeps one entry resident but not two.
        val buf = NetworkBodyRingBuffer(honorsKillGate = false)
        buf.setTotalBudget(700)
        buf.append(
            entry(
                ref = 1, t = 1.0,
                reqBody = "a".repeat(150),
                resBody = "b".repeat(150),
            )
        )
        // 556 bytes so far, under budget — still present.
        assertEquals(listOf(1.0), buf.snapshot().map { it.ref })
        buf.append(
            entry(
                ref = 2, t = 2.0,
                reqBody = "c".repeat(150),
                resBody = "d".repeat(150),
            )
        )
        // 556 + 556 = 1112 > 700 budget — oldest (ref 1) evicted.
        assertEquals(listOf(2.0), buf.snapshot().map { it.ref })
    }

    @Test
    fun `freeze is idempotent and takeFrozen drains`() {
        val buf = NetworkBodyRingBuffer(honorsKillGate = false)
        buf.append(entry(ref = 1, t = 1.0, resBody = "x"))
        buf.freeze()
        buf.append(entry(ref = 2, t = 2.0, resBody = "y")) // post-freeze appends don't join frozen set
        buf.freeze() // idempotent — still the first snapshot
        assertEquals(listOf(1.0), buf.takeFrozen()?.map { it.ref })
        assertNull(buf.takeFrozen())
    }

    @Test
    fun `discardAndResume drops frozen`() {
        val buf = NetworkBodyRingBuffer(honorsKillGate = false)
        buf.append(entry(ref = 1, t = 1.0, resBody = "a"))
        buf.freeze()
        buf.discardAndResume()
        assertNull(buf.takeFrozen())
        // Live capture continues untouched.
        assertEquals(listOf(1.0), buf.snapshot().map { it.ref })
    }

    @Test
    fun `clear zeroizes live and frozen`() {
        val buf = NetworkBodyRingBuffer(honorsKillGate = false)
        buf.append(entry(ref = 1, t = 1.0, resBody = "a"))
        buf.freeze()
        buf.clear()
        assertTrue(buf.snapshot().isEmpty())
        assertNull(buf.takeFrozen())
    }

    @Test
    fun `default budget is 262144`() {
        assertTrue(NetworkBodyRingBuffer().snapshot().isEmpty())
        // Appending a single entry comfortably under the default budget
        // (leaving headroom for the fixed per-entry overhead, Finding 2)
        // survives.
        val buf = NetworkBodyRingBuffer(honorsKillGate = false)
        buf.append(entry(ref = 1, t = 1.0, resBody = "a".repeat(262_144 - 1000)))
        assertEquals(listOf(1.0), buf.snapshot().map { it.ref })
    }

    @Test
    fun `sharedNetworkBodyBuffer is a process-wide singleton`() {
        Everframe.captureGate = true
        sharedNetworkBodyBuffer.clear()
        sharedNetworkBodyBuffer.append(entry(ref = 1, t = 1.0, resBody = "z"))
        assertEquals(listOf(1.0), sharedNetworkBodyBuffer.snapshot().map { it.ref })
        sharedNetworkBodyBuffer.clear()
    }

    // ==================== Round-2 review Finding F11 (kill-gate on append) ====================

    @Test
    fun `append is a no-op when captureGate is closed`() {
        Everframe.captureGate = false
        val buf = NetworkBodyRingBuffer()
        buf.append(entry(ref = 1, t = 1.0, resBody = "z"))
        assertTrue(
            "a production (honorsKillGate=true) buffer must refuse to record while the gate is closed",
            buf.snapshot().isEmpty(),
        )
    }

    @Test
    fun `append records once captureGate reopens`() {
        Everframe.captureGate = false
        val buf = NetworkBodyRingBuffer()
        buf.append(entry(ref = 1, t = 1.0, resBody = "z"))
        assertTrue(buf.snapshot().isEmpty())
        Everframe.captureGate = true
        buf.append(entry(ref = 2, t = 2.0, resBody = "z"))
        assertEquals(listOf(2.0), buf.snapshot().map { it.ref })
    }

    @Test
    fun `honorsKillGate=false bypasses the gate for isolated budget tests`() {
        Everframe.captureGate = false
        val buf = NetworkBodyRingBuffer(honorsKillGate = false)
        buf.append(entry(ref = 1, t = 1.0, resBody = "z"))
        assertEquals(1, buf.snapshot().size)
    }

    // ==================== Final-review Finding 2 (unbounded zero-cost entries) ====================

    /**
     * Regression: entries with no reqBody/resBody (204s, content-type skips)
     * used to cost 0 under the old `cost()` (reqBody+resBody UTF-8 bytes
     * only), so they were never evicted while their headers/skip metadata
     * grew the buffer unbounded. `cost()` must now also count header
     * key+value UTF-8 bytes plus a fixed per-entry overhead, so a budget is
     * still enforced even for entirely body-less entries — proven here by
     * pushing enough zero-body, header-bearing entries to exceed a small
     * budget and asserting the buffer's entry COUNT stays bounded (rather
     * than growing without limit).
     */
    @Test
    fun `zero-body entries with headers are still evicted once budget exceeded`() {
        val buf = NetworkBodyRingBuffer(honorsKillGate = false)
        buf.setTotalBudget(2000) // small budget relative to per-entry header overhead
        val headers = mapOf(
            "content-type" to "application/json",
            "x-trace-id" to "0123456789abcdef0123456789abcdef",
        )
        for (i in 0 until 500) {
            buf.append(
                NetworkBody(
                    ref = i.toDouble(), reqBody = null, reqBodyBytes = null, reqBodySkipped = null,
                    reqBodyTruncated = null, reqHeaders = headers,
                    resBody = null, resBodyBytes = null, resBodySkipped = null,
                    resBodyTruncated = null, resHeaders = headers, t = i.toDouble(),
                )
            )
        }
        // 500 zero-body entries must NOT all still be resident — each one
        // has non-zero cost from its headers + fixed overhead, so eviction
        // must have kicked in well before entry 500.
        assertTrue(buf.snapshot().size < 500)
        assertTrue(buf.snapshot().isNotEmpty())
    }

    // ==================== PR review round 4 Finding F15 (kill-gate/append race) ====================

    /**
     * Regression for the exact interleaving F15 closes:
     *   1. append() reads `captureGate == true` (the cheap pre-lock fast path)
     *   2. kill() flips the gate false, then clear()s the buffer
     *   3. append() finally acquires the lock and inserts — after zeroization
     * `preLockHook` pauses `append` right after step 1's read, on a second
     * thread, so this test can force `Everframe.kill()` (which, on
     * [sharedNetworkBodyBuffer], synchronously flips the gate and clears
     * this exact buffer — see `Everframe.kt`'s `kill()`, ~line 279-304) to run
     * to completion before releasing `append` into the lock. Uses
     * [sharedNetworkBodyBuffer] itself (not a fresh instance) so `kill()`'s
     * real production `clear()` call targets the same buffer `append` is
     * racing into.
     */
    @Test
    fun `F15 - kill race between pre-lock gate read and lock acquisition does not insert`() {
        val buf = sharedNetworkBodyBuffer
        Everframe.captureGate = true
        buf.clear()

        val reachedPreLock = CountDownLatch(1)
        val releaseAppend = CountDownLatch(1)
        buf.preLockHook = {
            reachedPreLock.countDown()
            releaseAppend.await()
        }

        val appendDone = CountDownLatch(1)
        Thread {
            buf.append(entry(ref = 1, t = 1.0, resBody = "raced"))
            appendDone.countDown()
        }.start()

        assertTrue(reachedPreLock.await(5, TimeUnit.SECONDS))
        // kill() flips captureGate false, THEN clears `buf` — same order as
        // production (Everframe.kt's kill(), ~line 279-304).
        Everframe.kill()
        releaseAppend.countDown()
        assertTrue(appendDone.await(5, TimeUnit.SECONDS))

        assertTrue(buf.snapshot().isEmpty())
        buf.preLockHook = null
    }

    // ==================== Round-7 review Finding F34 (remote captureBodies:false
    // must be authoritative at the append boundary, not just before makeEntry) ====================

    /**
     * Reviewer's probe, reproduced directly: decide/capture with the gate ON
     * (so [dev.everframe.okhttp.NetworkBodyCapture.makeEntry] would proceed to
     * build the entry), then apply a remote `captureBodies: false` config —
     * BEFORE the already-built entry is appended. Pre-fix, `append(entry)`
     * had no way to know the decision was stale; post-fix, the `guard`
     * closure (mirroring the production call site in
     * [dev.everframe.okhttp.EverframeInterceptor]) re-validates the captured
     * generation atomically with the insert and must refuse it.
     */
    @Test
    fun `F34 - remote config disabling bodies before append drops the already-built entry`() {
        NetworkBodyCaptureState.resetForTesting()
        val buf = NetworkBodyRingBuffer(honorsKillGate = false)

        // Decision point: gate ON, exactly as EverframeInterceptor reads it
        // before calling NetworkBodyCapture.makeEntry.
        NetworkBodyCaptureState.applyConfig(
            NetworkBodiesConfigWire(captureBodies = true, bodyByteCap = null, bodyContentTypes = null, bodyTotalBudget = null),
            samplingRate = 1.0, locallyDisabled = false, random = { 0.0 },
        )
        val decision = NetworkBodyCaptureState.snapshotActive()
        assertTrue("test setup: gate must be ON at the decision point", decision.active)

        // The entry was already built (redaction, bounded reads — real work
        // that takes time) while the gate was ON.
        val sensitiveEntry = entry(ref = 1, t = 1.0, resBody = "sensitive-should-not-ship")

        // A remote config refresh disables body capture BEFORE the append —
        // the exact race F34 closes.
        NetworkBodyCaptureState.applyConfig(
            NetworkBodiesConfigWire(captureBodies = false, bodyByteCap = null, bodyContentTypes = null, bodyTotalBudget = null),
            samplingRate = 1.0, locallyDisabled = false, random = { 0.0 },
        )
        assertFalse("test setup: remote refresh must have deactivated the gate", NetworkBodyCaptureState.isActive)

        buf.append(sensitiveEntry) { NetworkBodyCaptureState.isActiveForGeneration(decision.generation) }

        assertTrue(
            "a remote captureBodies:false must be authoritative even though the entry was already built while the gate was ON",
            buf.snapshot().isEmpty(),
        )
        NetworkBodyCaptureState.resetForTesting()
    }

    /** Companion happy-path: the token must NOT over-block a normal capture
     * where nothing changed between decision and append. */
    @Test
    fun `F34 - matching generation and active gate still appends normally`() {
        NetworkBodyCaptureState.resetForTesting()
        val buf = NetworkBodyRingBuffer(honorsKillGate = false)
        NetworkBodyCaptureState.applyConfig(
            NetworkBodiesConfigWire(captureBodies = true, bodyByteCap = null, bodyContentTypes = null, bodyTotalBudget = null),
            samplingRate = 1.0, locallyDisabled = false, random = { 0.0 },
        )
        val decision = NetworkBodyCaptureState.snapshotActive()

        buf.append(entry(ref = 1, t = 1.0, resBody = "ok")) {
            NetworkBodyCaptureState.isActiveForGeneration(decision.generation)
        }

        assertEquals(
            "a still-valid token must not be over-blocked",
            listOf(1.0), buf.snapshot().map { it.ref },
        )
        NetworkBodyCaptureState.resetForTesting()
    }

    /** `guard` defaults to `null` (skips validation entirely) — every
     * pre-existing call site above this section relies on that default
     * remaining backward compatible. */
    @Test
    fun `F34 - no guard closure behaves exactly as before`() {
        val buf = NetworkBodyRingBuffer(honorsKillGate = false)
        buf.append(entry(ref = 1, t = 1.0, resBody = "z"))
        assertEquals(listOf(1.0), buf.snapshot().map { it.ref })
    }
}
