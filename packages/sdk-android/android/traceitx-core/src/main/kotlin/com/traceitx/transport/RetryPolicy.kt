// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// LOCKED retry schedule (PIPE-02): 5 attempts at 0s, 1m, 5m, 30m, 2h.
//
// Server-side schedule is longer (Phase 02.1, ~3 days); client-side caps at 2h
// because the user is waiting on submission feedback. Foreground-only (D-04 lock)
// — drainOutbox runs at TraceItX.start() in a coroutine; no WorkManager/JobScheduler.
//
// Mirrors `packages/sdk-ios/Sources/TraceItX/Transport/RetryPolicy.swift` with
// the Android idiom for transport errors: OkHttp wraps connection problems in
// IOException subclasses (SocketTimeoutException, UnknownHostException,
// ConnectException, SSLHandshakeException) — equivalent to iOS URLError codes.
package com.traceitx.transport

import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLHandshakeException

internal object RetryPolicy {

    const val MAX_ATTEMPTS: Int = 5

    /**
     * Wait-before-this-attempt schedule. `DELAY_SECONDS[i]` is the delay observed
     * before attempt `i+1`. attempt 1 = 0s (immediate first try).
     */
    val DELAY_SECONDS: List<Long> = listOf(0L, 60L, 300L, 1800L, 7200L)

    sealed class Classification {
        /** Generic retryable: caller uses `delay(forAttempt)` to compute back-off. */
        object Retryable : Classification()

        /** Server-supplied delay (ms) via `Retry-After` header. */
        data class RetryAfter(val delayMs: Long) : Classification()

        /** Non-retryable — caller should throw. */
        object Terminal : Classification()
    }

    /**
     * Classify an HTTP status + headers + transport error into a retry decision.
     *
     * Order of precedence:
     *   1. IOException subclasses → Retryable (network problem).
     *   2. Other Throwable → Terminal (programmer error or non-retryable).
     *   3. statusCode 408 → Retryable (request timeout).
     *   4. statusCode 429 → RetryAfter (parsed from header) or Retryable fallback.
     *   5. 5xx → Retryable.
     *   6. 4xx (other than 408/429) → Terminal.
     *   7. else → Terminal.
     */
    fun classify(
        statusCode: Int?,
        headers: Map<String, String>,
        error: Throwable?,
    ): Classification {
        if (error != null) {
            return when (error) {
                is SocketTimeoutException,
                is UnknownHostException,
                is ConnectException,
                is SSLHandshakeException,
                is IOException -> Classification.Retryable
                else -> Classification.Terminal
            }
        }
        if (statusCode == null) return Classification.Terminal
        if (statusCode == 408) return Classification.Retryable
        if (statusCode == 429) {
            val retryAfter = parseRetryAfter(headers)
            return if (retryAfter != null) Classification.RetryAfter(retryAfter * 1000L)
                   else Classification.Retryable
        }
        if (statusCode in 500..599) return Classification.Retryable
        if (statusCode in 400..499) return Classification.Terminal
        return Classification.Terminal
    }

    /**
     * Delay (in milliseconds) the caller should wait before performing `attempt`.
     * `attempt` is 1-based. Throws `TraceItXTransportError.RetryPolicyError` outside
     * `[1, MAX_ATTEMPTS]` so the retry loop can dead-letter cleanly.
     */
    fun delay(forAttempt: Int): Long {
        if (forAttempt < 1 || forAttempt > MAX_ATTEMPTS) {
            throw TraceItXTransportError.RetryPolicyError(
                "attempt $forAttempt out of [1..$MAX_ATTEMPTS]"
            )
        }
        return DELAY_SECONDS[forAttempt - 1] * 1000L
    }

    // RFC 7231 §7.1.3 — "Retry-After" header. Supports the delta-seconds form
    // ("60"); HTTP-date form falls back to null (caller substitutes a default).
    // Header lookup is case-insensitive.
    private fun parseRetryAfter(headers: Map<String, String>): Long? {
        val candidates = listOf("Retry-After", "retry-after", "RETRY-AFTER")
        for (key in candidates) {
            val raw = headers[key] ?: continue
            val n = raw.trim().toLongOrNull()
            if (n != null) return n
        }
        // Fallback: case-insensitive scan in case caller normalized differently.
        for ((k, v) in headers) {
            if (k.equals("Retry-After", ignoreCase = true)) {
                return v.trim().toLongOrNull()
            }
        }
        return null
    }
}
