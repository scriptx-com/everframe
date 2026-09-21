// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Port of packages/sdk-web/src/vitals/transport.ts minus the beacon path
// (Android has none — the lifecycle onStop flush stands in for it). One retry
// after 5s on network error / 5xx / 429 (Retry-After honoured, capped 60s);
// never on any other 4xx; every failure swallowed; kill gate read fresh at
// every send boundary including the retry.
package com.traceitx.vitals

import com.traceitx.envelope.InternalLogger
import com.traceitx.envelope.txGuardVoid
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Where a [VitalsCollector]'s encoded payloads go. One sink per COLLECTOR
 * (Codex round-2, Important 14): the controller builds one when it starts
 * collecting and [close]s it when that collector stops, so a rapid
 * start/kill cycle cannot accumulate transports holding payloads, delayed
 * retry runnables and in-flight calls that only go quiet when their epoch
 * check eventually fires.
 */
interface VitalsSink : AutoCloseable {
    fun send(body: String)
    /** Cancel every scheduled retry and every in-flight call. Idempotent. */
    override fun close()
}

class VitalsTransport(
    private val client: OkHttpClient,
    private val endpoint: String,
    private val apiKey: String,
    private val isKilled: () -> Boolean,
    /**
     * Codex round-2, Important 14 — takes a `Runnable` rather than a lambda so
     * [cancelRetry] can name the same object back to `Handler.removeCallbacks`.
     */
    private val scheduleRetry: (delayMs: Long, Runnable) -> Unit,
    private val cancelRetry: (Runnable) -> Unit = {},
    private val retryDelayMs: Long = 5_000,
    private val maxRetryAfterMs: Long = 60_000,
) : VitalsSink {
    private val json = "application/json; charset=utf-8".toMediaType()

    /**
     * Identity tag on every call this transport makes, so [close] can cancel
     * exactly its own — the OkHttp client is per-start and shared with nothing
     * today, but `dispatcher.cancelAll()` would become wrong the moment that
     * client is reused (which is the follow-up this change deliberately does
     * not take).
     */
    private val callTag = Any()
    private val closed = AtomicBoolean(false)
    /** Retry runnables handed to [scheduleRetry] and not yet run. */
    private val scheduled = LinkedHashSet<Runnable>()

    override fun send(body: String) = txGuardVoid("VitalsTransport.send") { attempt(body, isRetry = false) }

    /**
     * Codex round-2, Important 14. The epoch/gate predicate only makes a
     * scheduled retry a NO-OP when it eventually fires — up to a minute later,
     * with its payload, its transport and its client all still reachable, and
     * any in-flight call still running. `close()` releases them now.
     */
    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        val pending = synchronized(scheduled) { scheduled.toList().also { scheduled.clear() } }
        for (r in pending) runCatching { cancelRetry(r) }
        runCatching {
            val d = client.dispatcher
            for (call in d.queuedCalls() + d.runningCalls()) {
                if (call.request().tag() === callTag) call.cancel()
            }
        }
    }

    private fun attempt(body: String, isRetry: Boolean) {
        if (closed.get() || isKilled()) return
        val req = Request.Builder()
            .url(endpoint)
            .post(body.toRequestBody(json))
            .header("Authorization", "Bearer $apiKey")
            .header("Accept", "application/json")
            .tag(callTag)
            .build()
        client.newCall(req).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (!isRetry) retryLater(body, retryDelayMs)
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    val code = it.code
                    if (isRetry || code in 200..299) return
                    when {
                        code == 429 -> retryLater(body, retryAfterMs(it.header("Retry-After")))
                        code >= 500 -> retryLater(body, retryDelayMs)
                        else -> Unit // permanent rejection — dropped, vitals are lossy
                    }
                }
            }
        })
    }

    private fun retryAfterMs(header: String?): Long {
        // Negative or unparseable (including a digit string too large for a
        // Long, which `toLongOrNull()` reports as null rather than
        // overflowing) both fall back to the fixed delay -- matching the web
        // reference's `seconds >= 0` guard. Clamping `secs` itself (rather
        // than the product) before multiplying by 1000 avoids overflow ever
        // reaching `coerceIn`, which previously clamped a negative product
        // down to 0 -- an immediate retry instead of a fallback.
        val secs = header?.trim()?.toLongOrNull()?.takeIf { it >= 0 } ?: return retryDelayMs
        return secs.coerceAtMost(maxRetryAfterMs / 1000) * 1000
    }

    private fun retryLater(body: String, delayMs: Long) {
        if (closed.get()) return
        lateinit var r: Runnable
        r = Runnable {
            synchronized(scheduled) { scheduled.remove(r) }
            txGuardVoid("VitalsTransport.retry") { attempt(body, isRetry = true) }
        }
        synchronized(scheduled) { scheduled.add(r) }
        try {
            scheduleRetry(delayMs, r)
        } catch (t: Throwable) {
            synchronized(scheduled) { scheduled.remove(r) }
            InternalLogger.recordSafeWrapFailure("VitalsTransport.scheduleRetry", t)
        }
        // A close() that raced the schedule above cancels nothing (the entry
        // was not in the set yet), so re-check and cancel here.
        if (closed.get()) {
            synchronized(scheduled) { scheduled.remove(r) }
            runCatching { cancelRetry(r) }
        }
    }
}
