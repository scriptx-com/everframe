// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Pure JVM unit tests — no Robolectric needed. LogRingBuffer touches no Android APIs.
 */
class LogRingBufferTest {

    private fun mk(i: Int) = LogRingBuffer.Entry(
        timestamp = i.toLong(),
        level = "INFO",
        tag = null,
        message = "msg-$i",
    )

    @Test
    fun `cap_250_drops_oldest_on_overflow`() {
        val buf = LogRingBuffer(capacity = 250)
        for (i in 0 until 251) buf.push(mk(i))

        val snap = buf.snapshot()
        assertEquals(250, snap.size)
        // Oldest dropped — first remaining entry is index 1, last is 250.
        assertEquals("msg-1", snap.first().message)
        assertEquals("msg-250", snap.last().message)
    }

    @Test
    fun `snapshot_returns_chronological_order`() {
        val buf = LogRingBuffer(capacity = 250)
        for (i in 0 until 100) buf.push(mk(i))
        val snap = buf.snapshot()
        assertEquals(100, snap.size)
        for (i in 0 until 100) {
            assertEquals("msg-$i", snap[i].message)
        }
    }

    @Test
    fun `clear_empties_buffer`() {
        val buf = LogRingBuffer(capacity = 250)
        for (i in 0 until 50) buf.push(mk(i))
        buf.clear()
        assertEquals(0, buf.size())
        assertTrue(buf.snapshot().isEmpty())
    }

    @Test
    fun `concurrent_8_threads_1000_ops_no_torn_writes`() {
        val buf = LogRingBuffer(capacity = 250)
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

        // After 8000 ops into a 250-cap buffer: exactly 250 entries, no exception.
        assertEquals(250, buf.snapshot().size)
    }

    @Test
    fun `shared_log_buffer_is_capped_at_100`() {
        // sharedLogBuffer is the SDK-wide singleton — guard against an accidental
        // capacity drift. Memory-bounded to the last 100 (matches web + iOS).
        sharedLogBuffer.clear()
        for (i in 0 until 300) sharedLogBuffer.push(mk(i))
        val snap = sharedLogBuffer.snapshot()
        assertEquals(100, snap.size)
        assertEquals("msg-200", snap.first().message)
        assertEquals("msg-299", snap.last().message)
        sharedLogBuffer.clear()
    }
}
