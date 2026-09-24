// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.vitals

import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

class VitalsTransportTest {
    private lateinit var server: MockWebServer

    // `scheduleRetry` runs on OkHttp's async dispatcher thread, not the test
    // thread. `server.takeRequest()` only proves the request was fully read
    // by the server -- the response still has to travel back over the socket
    // and through OkHttp's Callback before `retries` is populated, so
    // asserting on `retries` immediately after `take()` races that callback
    // (observed: consistently 0 elements, not an occasional flake, in this
    // environment). `awaitRetries` below is the deterministic replacement:
    // poll with a bounded timeout instead of asserting mid-flight.
    private val retries = CopyOnWriteArrayList<Pair<Long, Runnable>>()
    private val cancelled = CopyOnWriteArrayList<Runnable>()
    private var killed = false

    @Before fun setUp() { server = MockWebServer(); server.start() }
    @After fun tearDown() { server.shutdown() }

    private fun transport() = VitalsTransport(
        client = OkHttpClient.Builder().connectTimeout(2, TimeUnit.SECONDS).readTimeout(2, TimeUnit.SECONDS).build(),
        endpoint = server.url("/api/ingest/vitals").toString(),
        apiKey = "key-1",
        isKilled = { killed },
        scheduleRetry = { delay, r -> retries.add(delay to r) },
        cancelRetry = { r -> cancelled.add(r) },
    )

    private fun take() = server.takeRequest(2, TimeUnit.SECONDS)

    /**
     * Blocks until `retries` has at least [atLeast] entries, or [timeoutMs]
     * elapses -- whichever comes first. Never fails by itself: it is purely a
     * synchronization point, the callers' own assertions decide pass/fail.
     */
    private fun awaitRetries(atLeast: Int, timeoutMs: Long = 2_000) {
        val deadline = System.nanoTime() + timeoutMs * 1_000_000
        while (retries.size < atLeast && System.nanoTime() < deadline) Thread.sleep(10)
    }

    @Test
    fun `posts JSON with bearer auth`() {
        server.enqueue(MockResponse().setResponseCode(204))
        transport().send("""{"payload":{}}""")
        val req = take()!!
        assertEquals("POST", req.method)
        assertEquals("Bearer key-1", req.getHeader("Authorization"))
        assertEquals("application/json; charset=utf-8", req.getHeader("Content-Type"))
        assertEquals("""{"payload":{}}""", req.body.readUtf8())
        awaitRetries(1, timeoutMs = 300)
        assertEquals(0, retries.size)
    }

    @Test
    fun `retries once after 5s on 5xx, then gives up`() {
        server.enqueue(MockResponse().setResponseCode(500)); server.enqueue(MockResponse().setResponseCode(500))
        transport().send("{}")
        take()
        awaitRetries(1)
        assertEquals(1, retries.size); assertEquals(5_000L, retries[0].first)
        retries[0].second.run()
        take()
        awaitRetries(2, timeoutMs = 300)
        assertEquals(1, retries.size)
    }

    @Test
    fun `429 honours Retry-After capped at 60s`() {
        // No follow-up response is enqueued here: the retry callback is never
        // invoked in this test (only its delay is asserted), so a spare
        // response would sit unconsumed in MockWebServer's FIFO queue and get
        // served to the unrelated `send()` below instead of the 429/600 this
        // test enqueues for it.
        server.enqueue(MockResponse().setResponseCode(429).setHeader("Retry-After", "7"))
        transport().send("{}"); take()
        awaitRetries(1)
        assertEquals(7_000L, retries[0].first)
        retries.clear()

        server.enqueue(MockResponse().setResponseCode(429).setHeader("Retry-After", "600"))
        transport().send("{}"); take()
        awaitRetries(1)
        assertEquals(60_000L, retries[0].first)
        retries.clear()

        // A negative Retry-After is nonsensical -- must fall back to the
        // fixed delay, not clamp to 0 (an immediate retry).
        server.enqueue(MockResponse().setResponseCode(429).setHeader("Retry-After", "-5"))
        transport().send("{}"); take()
        awaitRetries(1)
        assertEquals(5_000L, retries[0].first)
        retries.clear()

        // A digit string too large for a Long overflows `toLongOrNull()` to
        // null, which also falls back to the fixed delay.
        server.enqueue(MockResponse().setResponseCode(429).setHeader("Retry-After", "99999999999999999999"))
        transport().send("{}"); take()
        awaitRetries(1)
        assertEquals(5_000L, retries[0].first)
    }

    @Test
    fun `no retry on other 4xx`() {
        server.enqueue(MockResponse().setResponseCode(400))
        transport().send("{}"); take()
        awaitRetries(1, timeoutMs = 300)
        assertEquals(0, retries.size)
    }

    @Test
    fun `retries on network error`() {
        // No `take()` here: DISCONNECT_AT_START drops the connection before
        // the server ever finishes reading a request, so `takeRequest()`
        // would just block for its full timeout on every run for no
        // assertion-relevant reason.
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
        transport().send("{}")
        awaitRetries(1)
        assertEquals(1, retries.size)
    }

    @Test
    fun `killed client sends nothing, including the retry`() {
        server.enqueue(MockResponse().setResponseCode(500)); server.enqueue(MockResponse().setResponseCode(204))
        val t = transport()
        t.send("{}"); take()
        awaitRetries(1)
        killed = true
        retries[0].second.run()
        assertNull(server.takeRequest(500, TimeUnit.MILLISECONDS))
        t.send("{}")
        assertNull(server.takeRequest(500, TimeUnit.MILLISECONDS))
    }

    @Test
    fun `close cancels the scheduled retry and silences every later send`() {
        // Codex round-2, Important 14. There was no close path at all: the
        // epoch/gate predicate only made a scheduled retry a NO-OP when it
        // eventually fired — up to a minute later, with its payload, its
        // transport and its OkHttp client all still reachable.
        server.enqueue(MockResponse().setResponseCode(500))
        val t = transport()
        t.send("{}"); take()
        awaitRetries(1)
        assertEquals(1, retries.size)

        t.close()

        assertEquals("the pending retry must be cancelled, not merely no-op'd", 1, cancelled.size)
        assertSame(retries[0].second, cancelled[0])
        // Even if the cancelled runnable is somehow still dispatched, it sends nothing.
        retries[0].second.run()
        assertNull(server.takeRequest(500, TimeUnit.MILLISECONDS))
        t.send("{}")
        assertNull("a closed transport accepts nothing", server.takeRequest(500, TimeUnit.MILLISECONDS))
    }

    @Test
    fun `close is idempotent and a retry scheduled after it is cancelled immediately`() {
        val t = transport()
        t.close()
        t.close()
        assertEquals(0, cancelled.size)
        server.enqueue(MockResponse().setResponseCode(500))
        t.send("{}")
        assertNull(server.takeRequest(500, TimeUnit.MILLISECONDS))
        assertEquals(0, retries.size)
    }

    @Test
    fun `a transport bound to a superseded start epoch is silenced even while the capture gate is open`() {
        // Codex round-1, Critical 1. `Everframe.start()` builds this predicate
        // as `{ !captureGate || currentStartEpoch() != epoch }` precisely
        // because `captureGate` is REUSABLE: a superseding start() re-opens
        // it, so a retry scheduled by the previous session's transport found
        // an open gate and shipped project A's payload under project A's key
        // after the boundary. The epoch never comes back.
        var gateOpen = true
        var currentEpoch = 7
        val boundEpoch = 7
        val t = VitalsTransport(
            client = OkHttpClient.Builder().connectTimeout(2, TimeUnit.SECONDS).readTimeout(2, TimeUnit.SECONDS).build(),
            endpoint = server.url("/api/ingest/vitals").toString(),
            apiKey = "key-1",
            isKilled = { !gateOpen || currentEpoch != boundEpoch },
            scheduleRetry = { delay, r -> retries.add(delay to r) },
            cancelRetry = { r -> cancelled.add(r) },
        )
        server.enqueue(MockResponse().setResponseCode(500))
        t.send("{}")
        assertEquals("precondition: this session's own send goes out", "POST", take()!!.method)
        awaitRetries(1)

        // A superseding start(): the gate is re-opened, the epoch moves on.
        currentEpoch = 8
        gateOpen = true
        retries[0].second.run()
        assertNull("a post-boundary retry must not ship the old session's payload", server.takeRequest(500, TimeUnit.MILLISECONDS))
        t.send("{}")
        assertNull(server.takeRequest(500, TimeUnit.MILLISECONDS))
    }
}
