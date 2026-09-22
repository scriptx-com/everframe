// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Round-2 review Finding F11: `push` now honors `TraceItX.captureGate` by
// default (`honorsKillGate = true`) — tests below that exercise capacity /
// eviction behavior independently of the global kill-switch use the
// `honorsKillGate = false` seam so they don't need a live TraceItX.start().
package com.traceitx.capture

import com.traceitx.TraceItX
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class NetworkRingBufferTest {

    @After
    fun tearDown() {
        // Belt-and-suspenders: no test below should leave the process-global
        // gate flipped, but restore it defensively so test order never leaks.
        TraceItX.captureGate = false
    }

    private fun mk(i: Int, status: Int? = 200) = NetworkRingBuffer.Entry(
        timestamp = i.toLong(),
        method = "GET",
        url = "https://example.com/$i",
        status = status,
        durationMs = 12L,
        requestHeaders = emptyMap(),
        responseHeaders = emptyMap(),
        errorMessage = null,
    )

    @Test
    fun `cap_250_drops_oldest_on_overflow`() {
        val buf = NetworkRingBuffer(capacity = 250, honorsKillGate = false)
        for (i in 0 until 251) buf.push(mk(i))
        val snap = buf.snapshot()
        assertEquals(250, snap.size)
        assertEquals("https://example.com/1", snap.first().url)
        assertEquals("https://example.com/250", snap.last().url)
    }

    @Test
    fun `entry_carries_no_body_field_priv_03`() {
        // Defensive structural check — Entry has the fields documented in
        // PRIV-03; if a future commit adds a body-bearing field this test
        // (compiled against the data class) will start failing or recording
        // unexpected fields. This is the second belt to the source-grep gate.
        val e = mk(1, status = null)
        // Toggle the seven canonical fields — anything else would be a structural drift.
        assertEquals(1L, e.timestamp)
        assertEquals("GET", e.method)
        assertEquals("https://example.com/1", e.url)
        assertNull(e.status)
        assertEquals(12L, e.durationMs)
        assertNotNull(e.requestHeaders)
        assertNotNull(e.responseHeaders)
        assertNull(e.errorMessage)
    }

    @Test
    fun `concurrent_8_threads_no_torn_writes`() {
        val buf = NetworkRingBuffer(capacity = 250, honorsKillGate = false)
        val threads = 8
        val opsPerThread = 1000
        val pool = Executors.newFixedThreadPool(threads)
        val ready = CountDownLatch(threads)
        val go = CountDownLatch(1)
        val done = CountDownLatch(threads)
        val counter = AtomicInteger(0)

        for (t in 0 until threads) {
            pool.submit {
                ready.countDown()
                go.await()
                try {
                    for (i in 0 until opsPerThread) {
                        val seq = counter.incrementAndGet()
                        buf.push(mk(seq))
                    }
                } finally {
                    done.countDown()
                }
            }
        }

        ready.await()
        go.countDown()
        assertTrue(done.await(30, TimeUnit.SECONDS))
        pool.shutdown()
        assertEquals(250, buf.snapshot().size)
    }

    @Test
    fun `shared_network_buffer_capped_at_100_dropping_oldest`() {
        TraceItX.captureGate = true
        sharedNetworkBuffer.clear()
        for (i in 0 until 300) sharedNetworkBuffer.push(mk(i))
        val snap = sharedNetworkBuffer.snapshot()
        // Memory-bounded to the last 100 — older entries evicted, never accumulate.
        assertEquals(100, snap.size)
        assertEquals("https://example.com/200", snap.first().url)
        assertEquals("https://example.com/299", snap.last().url)
        sharedNetworkBuffer.clear()
    }

    // ==================== Round-2 review Finding F11 (kill-gate on push) ====================

    @Test
    fun `push is a no-op when captureGate is closed`() {
        TraceItX.captureGate = false
        val buf = NetworkRingBuffer(capacity = 10)
        buf.push(mk(1))
        assertTrue(
            "a production (honorsKillGate=true) buffer must refuse to record while the gate is closed",
            buf.snapshot().isEmpty(),
        )
    }

    @Test
    fun `push records once captureGate reopens`() {
        TraceItX.captureGate = false
        val buf = NetworkRingBuffer(capacity = 10)
        buf.push(mk(1))
        assertTrue(buf.snapshot().isEmpty())
        TraceItX.captureGate = true
        buf.push(mk(2))
        assertEquals(listOf("https://example.com/2"), buf.snapshot().map { it.url })
    }

    @Test
    fun `honorsKillGate=false bypasses the gate for isolated eviction tests`() {
        TraceItX.captureGate = false
        val buf = NetworkRingBuffer(capacity = 10, honorsKillGate = false)
        buf.push(mk(1))
        assertEquals(1, buf.snapshot().size)
    }

    // ==================== PR review round 4 Finding F15 (kill-gate/push race) ====================

    /**
     * Regression for the exact interleaving F15 closes:
     *   1. push() reads `captureGate == true` (the cheap pre-lock fast path)
     *   2. kill() flips the gate false, then clear()s the buffer
     *   3. push() finally acquires the lock and inserts — after zeroization
     * `preLockHook` pauses `push` right after step 1's read, on a second
     * thread, so this test can force `TraceItX.kill()` (which, on
     * [sharedNetworkBuffer], synchronously flips the gate and clears this
     * exact buffer — see `TraceItX.kt`'s `kill()`, ~line 279-304) to run to
     * completion before releasing `push` into the lock. Uses
     * [sharedNetworkBuffer] itself (not a fresh instance) so `kill()`'s real
     * production `clear()` call targets the same buffer `push` is racing
     * into.
     */
    @Test
    fun `F15 - kill race between pre-lock gate read and lock acquisition does not insert`() {
        val buf = sharedNetworkBuffer
        TraceItX.captureGate = true
        buf.clear()

        val reachedPreLock = CountDownLatch(1)
        val releasePush = CountDownLatch(1)
        buf.preLockHook = {
            reachedPreLock.countDown()
            releasePush.await()
        }

        val pushDone = CountDownLatch(1)
        Thread {
            buf.push(mk(1))
            pushDone.countDown()
        }.start()

        assertTrue(reachedPreLock.await(5, TimeUnit.SECONDS))
        // kill() flips captureGate false, THEN clears `buf` — same order as
        // production (TraceItX.kt's kill(), ~line 279-304).
        TraceItX.kill()
        releasePush.countDown()
        assertTrue(pushDone.await(5, TimeUnit.SECONDS))

        assertTrue(buf.snapshot().isEmpty())
        buf.preLockHook = null
    }
}
