// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Plan 05-05 Task 1 — RetryPolicy unit tests (pure JVM, no Robolectric).
package dev.everframe.transport

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLHandshakeException

class RetryPolicyTest {

    @Test
    fun `MAX_ATTEMPTS is 5 and DELAY_SECONDS matches PIPE-02`() {
        assertEquals(5, RetryPolicy.MAX_ATTEMPTS)
        assertEquals(listOf(0L, 60L, 300L, 1800L, 7200L), RetryPolicy.DELAY_SECONDS)
    }

    @Test
    fun `classify 400 is Terminal`() {
        val c = RetryPolicy.classify(400, emptyMap(), null)
        assertTrue("expected Terminal got $c", c is RetryPolicy.Classification.Terminal)
    }

    @Test
    fun `classify 408 is Retryable`() {
        val c = RetryPolicy.classify(408, emptyMap(), null)
        assertTrue("expected Retryable got $c", c is RetryPolicy.Classification.Retryable)
    }

    @Test
    fun `classify 429 with Retry-After returns RetryAfter in ms`() {
        val c = RetryPolicy.classify(429, mapOf("Retry-After" to "60"), null)
        assertTrue("expected RetryAfter got $c", c is RetryPolicy.Classification.RetryAfter)
        assertEquals(60_000L, (c as RetryPolicy.Classification.RetryAfter).delayMs)
    }

    @Test
    fun `classify 429 without Retry-After is Retryable`() {
        val c = RetryPolicy.classify(429, emptyMap(), null)
        assertTrue("expected Retryable got $c", c is RetryPolicy.Classification.Retryable)
    }

    @Test
    fun `classify 502 is Retryable`() {
        val c = RetryPolicy.classify(502, emptyMap(), null)
        assertTrue("expected Retryable got $c", c is RetryPolicy.Classification.Retryable)
    }

    @Test
    fun `classify 200 is Terminal (caller handles 2xx separately)`() {
        // 2xx is not a retry decision — submitter handles it before classify() is called.
        // Per RetryPolicy contract: any non-retryable result (including success) is Terminal.
        val c = RetryPolicy.classify(200, emptyMap(), null)
        assertTrue(c is RetryPolicy.Classification.Terminal)
    }

    @Test
    fun `classify SocketTimeoutException is Retryable`() {
        val c = RetryPolicy.classify(null, emptyMap(), SocketTimeoutException("timeout"))
        assertTrue(c is RetryPolicy.Classification.Retryable)
    }

    @Test
    fun `classify UnknownHostException is Retryable`() {
        val c = RetryPolicy.classify(null, emptyMap(), UnknownHostException("nope"))
        assertTrue(c is RetryPolicy.Classification.Retryable)
    }

    @Test
    fun `classify ConnectException is Retryable`() {
        val c = RetryPolicy.classify(null, emptyMap(), ConnectException("refused"))
        assertTrue(c is RetryPolicy.Classification.Retryable)
    }

    @Test
    fun `classify SSLHandshakeException is Retryable`() {
        val c = RetryPolicy.classify(null, emptyMap(), SSLHandshakeException("tls"))
        assertTrue(c is RetryPolicy.Classification.Retryable)
    }

    @Test
    fun `classify generic IOException is Retryable`() {
        val c = RetryPolicy.classify(null, emptyMap(), IOException("io"))
        assertTrue(c is RetryPolicy.Classification.Retryable)
    }

    @Test
    fun `classify IllegalStateException is Terminal`() {
        val c = RetryPolicy.classify(null, emptyMap(), IllegalStateException("nope"))
        assertTrue(c is RetryPolicy.Classification.Terminal)
    }

    @Test
    fun `delay schedule`() {
        assertEquals(0L, RetryPolicy.delay(1))
        assertEquals(60_000L, RetryPolicy.delay(2))
        assertEquals(300_000L, RetryPolicy.delay(3))
        assertEquals(1_800_000L, RetryPolicy.delay(4))
        assertEquals(7_200_000L, RetryPolicy.delay(5))
    }

    @Test
    fun `delay throws for attempt 0`() {
        assertThrows(EverframeTransportError.RetryPolicyError::class.java) {
            RetryPolicy.delay(0)
        }
    }

    @Test
    fun `delay throws for attempt 6`() {
        assertThrows(EverframeTransportError.RetryPolicyError::class.java) {
            RetryPolicy.delay(6)
        }
    }

    @Test
    fun `Retry-After header lookup is case-insensitive`() {
        val c1 = RetryPolicy.classify(429, mapOf("retry-after" to "30"), null)
        assertEquals(30_000L, (c1 as RetryPolicy.Classification.RetryAfter).delayMs)
        val c2 = RetryPolicy.classify(429, mapOf("RETRY-AFTER" to "45"), null)
        assertEquals(45_000L, (c2 as RetryPolicy.Classification.RetryAfter).delayMs)
    }
}
