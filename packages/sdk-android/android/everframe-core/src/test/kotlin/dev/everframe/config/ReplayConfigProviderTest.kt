// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// CONFIG-02 fail-closed matrix for ReplayConfigProvider. A fake ConfigFetcher
// returns canned okhttp3.Responses driving every path: valid 200 flips ON;
// non-200 / malformed / missing-field / out-of-range keep OFF (out-of-range is
// REJECTED, not clamped); a network throw keeps last-good; TTL is a no-op window.
// Robolectric provides the Android runtime; `now` is injected for determinism.
package dev.everframe.config

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.IOException

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ReplayConfigProviderTest {

    private val url = "https://everframe.dev/api/config"

    /**
     * Suspend-friendly wait for a [CountDownLatch] fired from a background
     * (real `Dispatchers.IO`) thread. Deliberately NOT a blocking
     * `latch.await(timeout, unit)` here — under `runTest`'s test dispatcher,
     * a `launch { ... }` child coroutine is only DISPATCHED (i.e. actually
     * starts running its body) when the driving test coroutine suspends;
     * blocking the driving thread synchronously would starve the scheduler
     * and deadlock rather than exercise the race. `delay()` genuinely
     * suspends (yielding to the scheduler, which lets the launched
     * coroutines reach their real `withContext(Dispatchers.IO)` hop and run
     * concurrently on a real thread) while still polling real wall-clock
     * state (`CountDownLatch.getCount()`) between yields.
     */
    private suspend fun awaitLatch(latch: CountDownLatch, timeoutMs: Long = 5_000) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (latch.count > 0) {
            assertTrue("timed out waiting for latch", System.currentTimeMillis() < deadline)
            delay(1)
        }
    }

    private fun response(code: Int, body: String): Response {
        val req = Request.Builder().url(url).build()
        return Response.Builder()
            .request(req)
            .protocol(Protocol.HTTP_1_1)
            .code(code)
            .message(if (code == 200) "OK" else "ERR")
            .body(body.toResponseBody("application/json".toMediaType()))
            .build()
    }

    private fun provider(
        clock: () -> Long = { 0L },
        fetcher: ConfigFetcher,
    ) = ReplayConfigProvider(configUrl = url, apiKey = "k", fetcher = fetcher, now = clock)

    @Test
    fun `starts at OFF default`() {
        val p = provider(fetcher = { error("not called") })
        assertEquals(ReplayConfig.OFF, p.current)
        assertFalse(p.current.replayEnabled)
    }

    @Test
    fun `valid 200 flips replay ON`() = runTest {
        val p = provider(
            fetcher = {
                response(200, """{"replayEnabled":true,"replayDurationSec":45,"samplingRate":0.5}""")
            },
        )
        p.refresh()
        assertTrue(p.current.replayEnabled)
        assertEquals(45, p.current.replayDurationSec)
        assertEquals(0.5, p.current.samplingRate, 0.0001)
    }

    @Test
    fun `shake-to-report is negotiated and decoded leniently`() = runTest {
        var body = """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,"shakeToReport":{"enabled":true,"future":"ignored"}}"""
        val p = provider(fetcher = { request ->
            assertTrue(request.header("X-TX-SDK-Features")!!.split(',').map(String::trim).contains("shaketoreport"))
            response(200, body)
        })

        assertTrue(p.refresh(force = true))
        assertEquals(true, p.current.shakeToReport?.enabled)

        body = """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,"shakeToReport":{"enabled":"yes"}}"""
        assertTrue(p.refresh(force = true))
        assertNull(p.current.shakeToReport)
    }

    private fun nativeVideoBody(json: String) =
        """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,"nativeVideo":$json}"""

    @Test
    fun `valid nativeVideo frame rates decode`() = runTest {
        for (framesPerSecond in listOf(5, 10)) {
            val p = provider(
                fetcher = {
                    response(200, nativeVideoBody("""{"framesPerSecond":$framesPerSecond}"""))
                },
            )

            assertTrue(p.refresh(force = true))
            assertEquals(framesPerSecond, p.current.nativeVideo?.framesPerSecond)
        }
    }

    @Test
    fun `missing or null nativeVideo remains compatible`() = runTest {
        val bodies = listOf(
            """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0}""",
            nativeVideoBody("null"),
        )
        for (body in bodies) {
            val p = provider(fetcher = { response(200, body) })

            assertTrue(p.refresh(force = true))
            assertNull(p.current.nativeVideo)
        }
    }

    @Test
    fun `malformed nativeVideo retains last-good configuration`() = runTest {
        val malformedBlocks = listOf(
            "{}",
            "{\"framesPerSecond\":6}",
            "{\"framesPerSecond\":\"5\"}",
            "{\"framesPerSecond\":5.5}",
            "{\"framesPerSecond\":null}",
            "{\"framesPerSecond\":5,\"extra\":true}",
            "true",
            "[]",
        )
        for (malformedBlock in malformedBlocks) {
            var body = nativeVideoBody("""{"framesPerSecond":5}""")
            val p = provider(fetcher = { response(200, body) })
            assertTrue(p.refresh(force = true))
            val lastGood = p.current

            body = nativeVideoBody(malformedBlock)
            assertFalse("accepted malformed nativeVideo block: $malformedBlock", p.refresh(force = true))
            assertEquals(lastGood, p.current)
        }
    }

    @Test
    fun `initial malformed nativeVideo stays OFF`() = runTest {
        val malformedBlocks = listOf(
            "{}",
            "{\"framesPerSecond\":6}",
            "{\"framesPerSecond\":\"5\"}",
            "{\"framesPerSecond\":5.5}",
            "{\"framesPerSecond\":null}",
            "{\"framesPerSecond\":5,\"extra\":true}",
            "true",
            "[]",
        )
        for (malformedBlock in malformedBlocks) {
            val p = provider(fetcher = { response(200, nativeVideoBody(malformedBlock)) })

            assertFalse("accepted initial malformed nativeVideo block: $malformedBlock", p.refresh(force = true))
            assertEquals(ReplayConfig.OFF, p.current)
        }
    }

    @Test
    fun `non-200 keeps OFF`() = runTest {
        val p = provider(
            fetcher = {
                response(500, """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0}""")
            },
        )
        p.refresh()
        assertFalse(p.current.replayEnabled)
    }

    @Test
    fun `malformed JSON keeps OFF`() = runTest {
        val p = provider(fetcher = { response(200, "{not json") })
        p.refresh()
        assertFalse(p.current.replayEnabled)
    }

    @Test
    fun `missing field keeps OFF`() = runTest {
        val p = provider(
            fetcher = { response(200, """{"replayEnabled":true,"samplingRate":1.0}""") },
        )
        p.refresh()
        assertFalse(p.current.replayEnabled)
    }

    @Test
    fun `out-of-range samplingRate is rejected not clamped`() = runTest {
        val p = provider(
            fetcher = {
                response(200, """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.5}""")
            },
        )
        p.refresh()
        // Fail closed — NOT clamped to 1.0. Stays OFF.
        assertFalse(p.current.replayEnabled)
        assertEquals(ReplayConfig.OFF, p.current)
    }

    @Test
    fun `network throw keeps last-good ON`() = runTest {
        var throwNow = false
        val p = provider(
            clock = { 1_000_000L }, // far past TTL so the 2nd refresh refetches
            fetcher = {
                if (throwNow) throw IOException("boom")
                response(200, """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0}""")
            },
        )
        // The clock is fixed; force two distinct fetches by making the 2nd throw.
        // First call seeds a valid-ON config.
        ReplayConfigProvider(
            configUrl = url,
            apiKey = "k",
            fetcher = { response(200, """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0}""") },
            now = { 0L },
        ).let {
            it.refresh()
            assertTrue(it.current.replayEnabled)
        }

        // Now: a provider that first succeeds (clock 0), then throws past the TTL window.
        var calls = 0
        val clockSeq = longArrayOf(0L, 0L, 400_000L, 400_000L)
        val p2 = ReplayConfigProvider(
            configUrl = url,
            apiKey = "k",
            fetcher = {
                calls += 1
                if (calls == 1) {
                    response(200, """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0}""")
                } else {
                    throw IOException("boom")
                }
            },
            now = object : () -> Long {
                var i = 0
                override fun invoke(): Long = clockSeq[minOf(i++, clockSeq.size - 1)]
            },
        )
        p2.refresh() // success → ON
        assertTrue(p2.current.replayEnabled)
        p2.refresh() // throws → keeps last-good ON
        assertTrue(p2.current.replayEnabled)
    }

    @Test
    fun `config body with a breadcrumbs block decodes and surfaces it`() = runTest {
        val p = provider(
            fetcher = {
                response(
                    200,
                    """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                    "breadcrumbs":{"enabled":true,"kinds":["navigation","error"],"maxCount":50,
                    "byteBudget":8192,"consoleEntryCap":512}}""",
                )
            },
        )
        p.refresh()
        assertEquals(50, p.current.breadcrumbs?.maxCount)
        assertEquals(listOf("navigation", "error"), p.current.breadcrumbs?.kinds)
    }

    @Test
    fun `unknown field INSIDE the breadcrumbs block does not fail-close`() = runTest {
        val p = provider(
            fetcher = {
                response(
                    200,
                    """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                    "breadcrumbs":{"enabled":true,"kinds":["tap"],"maxCount":50,
                    "byteBudget":8192,"consoleEntryCap":512,"futureField":"ignored"}}""",
                )
            },
        )
        p.refresh()
        assertTrue(p.current.replayEnabled)
        assertEquals(50, p.current.breadcrumbs?.maxCount)
    }

    @Test
    fun `missing REQUIRED field inside the breadcrumbs block still fail-closes`() = runTest {
        // No maxCount — the surrogate's leniency must NOT weaken required-field
        // validation. Decode still throws → whole config fails closed.
        val p = provider(
            fetcher = {
                response(
                    200,
                    """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                    "breadcrumbs":{"enabled":true,"kinds":["tap"],
                    "byteBudget":8192,"consoleEntryCap":512}}""",
                )
            },
        )
        p.refresh()
        assertFalse(p.current.replayEnabled)
        assertEquals(ReplayConfig.OFF, p.current)
    }

    @Test
    fun `unknown TOP-LEVEL field still fails closed`() = runTest {
        val p = provider(
            fetcher = {
                response(
                    200,
                    """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                    "unknownTopLevelField":"nope"}""",
                )
            },
        )
        p.refresh()
        assertFalse(p.current.replayEnabled)
        assertEquals(ReplayConfig.OFF, p.current)
    }

    // A replies-enabled app's server response used to fail-close this WHOLE
    // provider (unknown top-level `replies` key vs. `ignoreUnknownKeys = false`),
    // silently taking replay + breadcrumb config down with it. The block is now
    // modelled; top-level strictness is deliberately unchanged (see the
    // `unknown TOP-LEVEL field still fails closed` test above, which must keep
    // passing).
    @Test
    fun `config body with a replies block decodes and does not fail-close`() = runTest {
        val p = provider(
            fetcher = {
                response(
                    200,
                    """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                    "replies":{"enabled":true}}""",
                )
            },
        )
        p.refresh()
        assertTrue(p.current.replayEnabled)
        assertEquals(true, p.current.replies?.enabled)
    }

    @Test
    fun `unknown field INSIDE the replies block does not fail-close`() = runTest {
        val p = provider(
            fetcher = {
                response(
                    200,
                    """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                    "replies":{"enabled":true,"futureField":"ignored"}}""",
                )
            },
        )
        p.refresh()
        assertTrue(p.current.replayEnabled)
        assertEquals(true, p.current.replies?.enabled)
    }

    @Test
    fun `missing REQUIRED field inside the replies block still fail-closes`() = runTest {
        val p = provider(
            fetcher = {
                response(
                    200,
                    """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                    "replies":{}}""",
                )
            },
        )
        p.refresh()
        assertFalse(p.current.replayEnabled)
        assertEquals(ReplayConfig.OFF, p.current)
    }

    @Test
    fun `legacy 3-field body still decodes with null breadcrumbs`() = runTest {
        val p = provider(
            fetcher = {
                response(200, """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0}""")
            },
        )
        p.refresh()
        assertNull(p.current.breadcrumbs)
        assertNull(p.current.replies)
    }

    @Test
    fun `decodes networkBodies block`() = runTest {
        val p = provider(
            fetcher = {
                response(
                    200,
                    """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                    "networkBodies":{"captureBodies":true,"bodyByteCap":4096,
                    "bodyContentTypes":["application/json"],"bodyTotalBudget":131072}}""",
                )
            },
        )
        p.refresh()
        assertEquals(true, p.current.networkBodies?.captureBodies)
        assertEquals(4096, p.current.networkBodies?.bodyByteCap)
    }

    @Test
    fun `top-level strictness intact - unknown top-level key still fails closed`() = runTest {
        val p = provider(
            fetcher = {
                response(
                    200,
                    """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,"someFutureBlock":{}}""",
                )
            },
        )
        p.refresh()
        assertEquals(ReplayConfig.OFF, p.current)
    }

    @Test
    fun `nested unknown key inside networkBodies is tolerated`() = runTest {
        val p = provider(
            fetcher = {
                response(
                    200,
                    """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                    "networkBodies":{"captureBodies":true,"futureField":1}}""",
                )
            },
        )
        p.refresh()
        assertEquals(true, p.current.networkBodies?.captureBodies)
    }

    @Test
    fun `refresh declares every capability this build can decode`() = runTest {
        var seen: Request? = null
        val p = provider(
            fetcher = { req ->
                seen = req
                response(200, """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0}""")
            },
        )
        p.refresh()
        // Exact-string, deliberately: the server emits a block ONLY to callers
        // that declare it, so this header is the whole reason any of these
        // blocks arrive. Adding a capability here is a real contract change and
        // should have to be made on purpose.
        assertEquals("networkbodies, identity, companionbadge, branding, vitals, resources, shaketoreport, nativevideo", seen?.header("X-TX-SDK-Features"))
    }

    @Test
    fun `TTL window makes second refresh a no-op`() = runTest {
        var calls = 0
        val p = ReplayConfigProvider(
            configUrl = url,
            apiKey = "k",
            fetcher = {
                calls += 1
                response(200, """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0}""")
            },
            now = { 100L }, // both refreshes inside the 300_000ms window
        )
        p.refresh()
        p.refresh()
        assertEquals(1, calls)
    }

    // ==================== Final-review Finding 4 (polling at TTL doubles latency) /
    //                       Finding 5 (failed refresh must fail closed) ====================

    /**
     * `refresh(force = true)` bypasses the TTL gate entirely — two
     * back-to-back forced calls, even with no clock advance, both actually
     * fetch. This is what lets `ReplaySession`'s periodic loop re-read on
     * every wake instead of racing its own TTL and effectively halving its
     * own polling rate (the loop sleeps exactly one TTL, so an unforced
     * `refresh()` at each wake was always just-under-TTL and a no-op).
     */
    @Test
    fun `force bypasses TTL so two back-to-back forced calls both fetch`() = runTest {
        var calls = 0
        val p = ReplayConfigProvider(
            configUrl = url,
            apiKey = "k",
            fetcher = {
                calls += 1
                response(200, """{"replayEnabled":true,"replayDurationSec":15,"samplingRate":0.5}""")
            },
            now = { 0L }, // fixed clock -- an unforced refresh() would no-op on the 2nd call
        )
        p.refresh(force = true)
        assertEquals(1, calls)
        p.refresh(force = true)
        assertEquals(2, calls)
    }

    /**
     * `refresh(force =)` reports whether THIS attempt succeeded, distinct
     * from the cache's last-good value: a forced fetch that fails (network
     * error, non-200, decode failure, out-of-range samplingRate) returns
     * `false` even though the cache silently keeps its last-good contents.
     * This is the signal `ReplaySession.refreshConfigNow()` uses to fail the
     * network-body gate closed rather than trusting a config it could not
     * actually confirm is still current (Finding 5).
     */
    @Test
    fun `force refresh returns false on failure and true on success`() = runTest {
        var calls = 0
        val p = ReplayConfigProvider(
            configUrl = url,
            apiKey = "k",
            fetcher = {
                calls += 1
                if (calls == 1) throw IOException("boom")
                response(200, """{"replayEnabled":true,"replayDurationSec":15,"samplingRate":0.5}""")
            },
            now = { 0L },
        )
        val first = p.refresh(force = true)
        assertFalse(first)
        val second = p.refresh(force = true)
        assertTrue(second)
    }

    @Test
    fun `non-forced refresh returns true on TTL skip`() = runTest {
        var calls = 0
        val p = ReplayConfigProvider(
            configUrl = url,
            apiKey = "k",
            fetcher = {
                calls += 1
                response(200, """{"replayEnabled":true,"replayDurationSec":15,"samplingRate":0.5}""")
            },
            now = { 0L },
        )
        val first = p.refresh()
        assertTrue(first)
        // Within TTL -- no fetch, but the cache is fresh, so this still
        // reports success (per Finding 5's contract: "TTL-skip with fresh
        // cache on the non-forced path" counts as true).
        val second = p.refresh()
        assertTrue(second)
        assertEquals(1, calls)
    }

    @Test
    fun `retired tree image capability is never advertised`() = runTest {
        // The server emits this block ONLY to callers that declare it. Without
        // the token, retired configuration cannot break the strict decoder.
        assertFalse(ReplayConfigProvider.SDK_FEATURES_HEADER_VALUE.contains("replayimages"))
    }

    // ==================== Round-2 review Finding F10 (networkBodies wire ceilings) ====================
    //
    // Mirrors the iOS twin's boundary matrix (commit 826e5f76,
    // ReplayConfigProviderTests.swift): bodyByteCap 1...65536, bodyTotalBudget
    // 1...1_048_576, bodyContentTypes 1...16 entries of 1...64 chars each. Out
    // of range ⇒ NetworkBodiesConfigWireSerializer throws ⇒ propagates through
    // the top-level decode ⇒ whole config fails closed (Android's documented
    // choice — see the class doc comment above NetworkBodiesConfigWire).

    private fun networkBodiesBody(networkBodiesJson: String) =
        """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
        "networkBodies":$networkBodiesJson}"""

    @Test
    fun `bodyByteCap at the 65536 ceiling decodes fine`() = runTest {
        val p = provider(
            fetcher = {
                response(200, networkBodiesBody("""{"captureBodies":true,"bodyByteCap":65536}"""))
            },
        )
        p.refresh()
        assertTrue(p.current.replayEnabled)
        assertEquals(65536, p.current.networkBodies?.bodyByteCap)
    }

    @Test
    fun `bodyByteCap one past the ceiling fails the whole config closed`() = runTest {
        val p = provider(
            fetcher = {
                response(200, networkBodiesBody("""{"captureBodies":true,"bodyByteCap":65537}"""))
            },
        )
        p.refresh()
        assertEquals(ReplayConfig.OFF, p.current)
    }

    @Test
    fun `bodyByteCap zero fails the whole config closed`() = runTest {
        val p = provider(
            fetcher = { response(200, networkBodiesBody("""{"captureBodies":true,"bodyByteCap":0}""")) },
        )
        p.refresh()
        assertEquals(ReplayConfig.OFF, p.current)
    }

    @Test
    fun `bodyByteCap negative fails the whole config closed`() = runTest {
        val p = provider(
            fetcher = { response(200, networkBodiesBody("""{"captureBodies":true,"bodyByteCap":-1}""")) },
        )
        p.refresh()
        assertEquals(ReplayConfig.OFF, p.current)
    }

    @Test
    fun `bodyByteCap Int MAX_VALUE fails the whole config closed instead of overflowing downstream`() = runTest {
        val p = provider(
            fetcher = {
                response(
                    200,
                    networkBodiesBody("""{"captureBodies":true,"bodyByteCap":${Int.MAX_VALUE}}"""),
                )
            },
        )
        p.refresh()
        assertEquals(ReplayConfig.OFF, p.current)
    }

    @Test
    fun `bodyTotalBudget at the 1_048_576 ceiling decodes fine`() = runTest {
        val p = provider(
            fetcher = {
                response(200, networkBodiesBody("""{"captureBodies":true,"bodyTotalBudget":1048576}"""))
            },
        )
        p.refresh()
        assertTrue(p.current.replayEnabled)
        assertEquals(1_048_576, p.current.networkBodies?.bodyTotalBudget)
    }

    @Test
    fun `bodyTotalBudget one past the ceiling fails the whole config closed`() = runTest {
        val p = provider(
            fetcher = {
                response(200, networkBodiesBody("""{"captureBodies":true,"bodyTotalBudget":1048577}"""))
            },
        )
        p.refresh()
        assertEquals(ReplayConfig.OFF, p.current)
    }

    @Test
    fun `bodyContentTypes with 16 entries decodes fine`() = runTest {
        val types = (1..16).joinToString(",") { "\"type$it/x\"" }
        val p = provider(
            fetcher = {
                response(200, networkBodiesBody("""{"captureBodies":true,"bodyContentTypes":[$types]}"""))
            },
        )
        p.refresh()
        assertTrue(p.current.replayEnabled)
        assertEquals(16, p.current.networkBodies?.bodyContentTypes?.size)
    }

    @Test
    fun `bodyContentTypes with 17 entries fails the whole config closed`() = runTest {
        val types = (1..17).joinToString(",") { "\"type$it/x\"" }
        val p = provider(
            fetcher = {
                response(200, networkBodiesBody("""{"captureBodies":true,"bodyContentTypes":[$types]}"""))
            },
        )
        p.refresh()
        assertEquals(ReplayConfig.OFF, p.current)
    }

    @Test
    fun `empty bodyContentTypes fails the whole config closed`() = runTest {
        val p = provider(
            fetcher = {
                response(200, networkBodiesBody("""{"captureBodies":true,"bodyContentTypes":[]}"""))
            },
        )
        p.refresh()
        assertEquals(ReplayConfig.OFF, p.current)
    }

    @Test
    fun `bodyContentTypes entry over 64 chars fails the whole config closed`() = runTest {
        val tooLong = "a".repeat(65)
        val p = provider(
            fetcher = {
                response(200, networkBodiesBody("""{"captureBodies":true,"bodyContentTypes":["$tooLong"]}"""))
            },
        )
        p.refresh()
        assertEquals(ReplayConfig.OFF, p.current)
    }

    @Test
    fun `bodyContentTypes entry at exactly 64 chars decodes fine`() = runTest {
        val exact = "a".repeat(64)
        val p = provider(
            fetcher = {
                response(200, networkBodiesBody("""{"captureBodies":true,"bodyContentTypes":["$exact"]}"""))
            },
        )
        p.refresh()
        assertTrue(p.current.replayEnabled)
        assertEquals(listOf(exact), p.current.networkBodies?.bodyContentTypes)
    }

    @Test
    fun `invalid networkBodies block does not affect top-level replay fields when config was already OFF`() =
        runTest {
            val p = provider(
                fetcher = {
                    response(200, networkBodiesBody("""{"captureBodies":true,"bodyByteCap":0}"""))
                },
            )
            // Whole config fails closed — top-level fields stay at the untouched OFF default,
            // never a partially-applied replayEnabled=true with a dropped networkBodies block.
            p.refresh()
            assertEquals(ReplayConfig.OFF, p.current)
            assertFalse(p.current.replayEnabled)
            assertNull(p.current.networkBodies)
        }

    @Test
    fun `non-200 refresh returns false`() = runTest {
        val p = provider(
            fetcher = {
                response(500, """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0}""")
            },
        )
        assertFalse(p.refresh(force = true))
    }

    @Test
    fun `out-of-range samplingRate refresh returns false`() = runTest {
        val p = provider(
            fetcher = {
                response(200, """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.5}""")
            },
        )
        assertFalse(p.refresh(force = true))
    }

    // ==================== F32 (round-7 review, P1): overlapping refreshes
    //                       commit in START order, not completion order ====================
    //
    // `withContext(Dispatchers.IO)` runs each `refresh()` invocation on the
    // real IO thread pool, NOT serialized against other concurrent `refresh`
    // calls — two overlapping calls (e.g. the periodic loop's next tick
    // firing before the previous tick's fetch timed out) can both be
    // mid-network-call at once, and used to let whichever completed LAST
    // simply overwrite `current`. This is the reviewer's exact probe:
    // request A (ON) starts first, request B (OFF) starts second, B
    // resolves first, A resolves last — `current` must end up B's OFF, and
    // A's own `refresh()` call must return `false` (not a fresh success).

    @Test
    fun `an older-started refresh must not overwrite a newer one that started after it, even resolving last`() =
        runTest {
            val callIndex = AtomicInteger(0)
            val startedA = CountDownLatch(1)
            val releaseA = CountDownLatch(1)
            val startedB = CountDownLatch(1)
            val releaseB = CountDownLatch(1)

            val fetcher = ConfigFetcher { _ ->
                if (callIndex.incrementAndGet() == 1) {
                    startedA.countDown()
                    assertTrue("releaseA never fired", releaseA.await(5, TimeUnit.SECONDS))
                    response(
                        200,
                        """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                        "networkBodies":{"captureBodies":true}}""",
                    )
                } else {
                    startedB.countDown()
                    assertTrue("releaseB never fired", releaseB.await(5, TimeUnit.SECONDS))
                    response(
                        200,
                        """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
                        "networkBodies":{"captureBodies":false}}""",
                    )
                }
            }
            val p = provider(fetcher = fetcher)

            // Start request A (ON) first.
            val jobA = launch { p.refresh(force = true) }
            awaitLatch(startedA)

            // Start request B (OFF) after A has already started (but before A resolves).
            val jobB = launch { p.refresh(force = true) }
            awaitLatch(startedB)

            // Resolve B (the NEWER request) first.
            releaseB.countDown()
            jobB.join()

            // THEN resolve A (the OLDER request) — it must NOT win despite resolving last.
            releaseA.countDown()
            jobA.join()

            assertFalse(
                "B's newer OFF result must win even though A resolved last",
                p.current.replayEnabled,
            )
            assertEquals(false, p.current.networkBodies?.captureBodies)
        }

    @Test
    fun `overlapping refreshes resolving in start order still commit the newer one`() = runTest {
        val callIndex = AtomicInteger(0)
        val startedA = CountDownLatch(1)
        val releaseA = CountDownLatch(1)
        val startedB = CountDownLatch(1)
        val releaseB = CountDownLatch(1)

        val fetcher = ConfigFetcher { _ ->
            if (callIndex.incrementAndGet() == 1) {
                startedA.countDown()
                assertTrue(releaseA.await(5, TimeUnit.SECONDS))
                response(
                    200,
                    """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                    "networkBodies":{"captureBodies":true}}""",
                )
            } else {
                startedB.countDown()
                assertTrue(releaseB.await(5, TimeUnit.SECONDS))
                response(
                    200,
                    """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
                    "networkBodies":{"captureBodies":false}}""",
                )
            }
        }
        val p = provider(fetcher = fetcher)

        val jobA = launch { p.refresh(force = true) }
        awaitLatch(startedA)
        val jobB = launch { p.refresh(force = true) }
        awaitLatch(startedB)

        // Resolve A first this time — completion order == start order.
        releaseA.countDown()
        jobA.join()

        releaseB.countDown()
        jobB.join()

        assertFalse(p.current.replayEnabled)
        assertEquals(false, p.current.networkBodies?.captureBodies)
    }

    // ==================== F43 (round-9 review, P1): sequence ISSUANCE must
    //                       be atomic w.r.t. compare+commit, not just the
    //                       compare+commit atomic with itself ====================
    //
    // F38 (above) put the compare and the commit under a lock together, but
    // left sequence ISSUANCE outside that lock (deliberately -- see that
    // fix's own doc comment). A NEWER call's issuance could still land in
    // the gap between an OLDER call's lock-protected compare succeeding and
    // that same call's assignment actually executing: the older call would
    // blindly commit and report success anyway, re-arming capture from
    // stale config while the newer read was underway or had already
    // failed.
    //
    // Fixed by restructuring the whole issue -> fetch -> compare -> commit
    // lifecycle so issuance and commit are both just CAS attempts against
    // the SAME `AtomicReference<RefreshState>` -- see that field's doc
    // comment in ReplayConfigProvider.kt for the invariant this makes
    // locally checkable. The old lock-based seams (`__holdLockForTesting`,
    // `__hasQueuedThreadsForTesting`) are gone with the lock they polled;
    // `__beforeCommitHookForTesting` replaces them, firing once per
    // `refresh()` call right after decode/validation but BEFORE the
    // compare+commit CAS loop -- exactly the point the reviewer's schedule
    // needs to park a request at.
    //
    // Schedule: park request A immediately after it has fully decoded and
    // validated its response, let request B issue its own (newer) sequence
    // number AND commit its OFF config to completion -- entirely unblocked,
    // since A holds no lock while parked -- THEN release A. A's compare+
    // commit loop reads `state` fresh the instant it finally runs, sees
    // B's newer sequence already committed, and must bail without
    // overwriting it or reporting success.
    @Test
    fun `a request parked after validation must not commit once a newer one has issued and committed`() = runTest {
        val onBody = """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
            "networkBodies":{"captureBodies":true}}"""
        val offBody = """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "networkBodies":{"captureBodies":false}}"""
        val callIndex = AtomicInteger(0)
        val fetcher = ConfigFetcher { _ ->
            if (callIndex.incrementAndGet() == 1) response(200, onBody) else response(200, offBody)
        }
        val p = provider(fetcher = fetcher)

        val aReachedCommitPoint = CountDownLatch(1)
        val releaseA = CountDownLatch(1)
        p.__beforeCommitHookForTesting = {
            aReachedCommitPoint.countDown()
            assertTrue("releaseA never fired", releaseA.await(5, TimeUnit.SECONDS))
        }

        // Request A (ON): fetch/decode/validate run to completion unblocked
        // (nothing holds up the network call itself or the decode), then it
        // parks right before its compare+commit attempt -- it has evaluated
        // nothing about its own sequence's validity yet.
        val jobA = async { p.refresh(force = true) }
        awaitLatch(aReachedCommitPoint)

        // Clear the hook so request B (below) doesn't also park on the same
        // latch -- B must be free to issue AND commit fully while A waits.
        p.__beforeCommitHookForTesting = {}

        // Request B (OFF): issues its own (newer) sequence and commits to
        // completion -- entirely unblocked, since A holds nothing while
        // parked. Called directly (not launched) so it runs to completion
        // before we release A.
        val bSucceeded = p.refresh(force = true)
        assertTrue("B's own refresh should succeed", bSucceeded)
        assertFalse("B must have already committed OFF before A is released", p.current.replayEnabled)

        // NOW release A -- its compare+commit loop reads `state` fresh and
        // must find B's newer sequence already committed.
        releaseA.countDown()
        val aSucceeded = jobA.await()

        assertFalse(
            "A parked before its own compare+commit must report failure/supersession, not a fresh success",
            aSucceeded,
        )
        assertFalse(
            "B's newer OFF result must still be in the cache -- A must not have overwritten it",
            p.current.replayEnabled,
        )
        assertEquals(false, p.current.networkBodies?.captureBodies)
    }

    // ==================== companion badge dashboard config (2026-08-25) ====================
    //
    // Server-driven companion name-badge override, sent ONLY when this SDK
    // declares `companionbadge` in X-TX-SDK-Features. `position` is decoded
    // verbatim as a STRING here (the wire shape); resolution to a
    // CompanionBadgePosition, including the fallback for an unrecognised
    // value, happens at the badge (parseCompanionBadgePositionOrNull) — this
    // decoder's only job is scoped leniency on unknown nested fields, same
    // posture as identity above.

    @Test
    fun `decodes companionBadge block`() = runTest {
        val p = provider(
            fetcher = {
                response(
                    200,
                    """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                    "companionBadge":{"enabled":false,"position":"top-left"}}""",
                )
            },
        )
        p.refresh()
        assertEquals(CompanionBadgeConfigWire(false, "top-left"), p.current.companionBadge)
    }

    @Test
    fun `companionBadge tolerates unknown nested fields`() = runTest {
        val p = provider(
            fetcher = {
                response(
                    200,
                    """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                    "companionBadge":{"enabled":true,"position":"top-left","future":1}}""",
                )
            },
        )
        p.refresh()
        assertEquals(true, p.current.companionBadge?.enabled)
        assertEquals("top-left", p.current.companionBadge?.position)
    }

    @Test
    fun `absent companionBadge decodes to null`() = runTest {
        val p = provider(
            fetcher = {
                response(200, """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0}""")
            },
        )
        p.refresh()
        assertNull(p.current.companionBadge)
    }

    @Test
    fun `features header advertises companionbadge`() {
        assertTrue(
            ReplayConfigProvider.SDK_FEATURES_HEADER_VALUE.contains("companionbadge"),
        )
    }

    // ------------------------------------------------------------------
    // branding block (watermark + theme, Android spec 2026-08-26).
    // Element-wise lenient decode: a malformed BLOCK degrades to defaults,
    // a malformed FIELD degrades alone — `watermark: false` (the entitlement
    // signal) must never be lost to a bad color. Unknown TOP-LEVEL keys keep
    // failing the whole parse (locked posture, tested above).
    // ------------------------------------------------------------------

    @Test
    fun `decodes branding block with theme`() = runTest {
        val p = provider(
            fetcher = {
                response(
                    200,
                    """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
                    "branding":{"watermark":false,"theme":{"accent":"#336699","background":"#101215"}}}""",
                )
            },
        )
        p.refresh()
        assertEquals(
            BrandingConfigWire(watermark = false, theme = BrandingThemeWire(accent = "#336699", background = "#101215")),
            p.current.branding,
        )
    }

    @Test
    fun `absent branding decodes to null`() = runTest {
        val p = provider(
            fetcher = {
                response(200, """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0}""")
            },
        )
        p.refresh()
        assertNull(p.current.branding)
    }

    @Test
    fun `branding with free-plan watermark only`() = runTest {
        val p = provider(
            fetcher = {
                response(
                    200,
                    """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
                    "branding":{"watermark":true}}""",
                )
            },
        )
        p.refresh()
        assertEquals(BrandingConfigWire(watermark = true, theme = null), p.current.branding)
    }

    @Test
    fun `one bad hex degrades that field alone - watermark and siblings survive`() = runTest {
        val p = provider(
            fetcher = {
                response(
                    200,
                    """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
                    "branding":{"watermark":false,"theme":{"accent":"red","background":"#101215"}}}""",
                )
            },
        )
        p.refresh()
        val b = p.current.branding
        assertEquals(false, b?.watermark)
        assertNull(b?.theme?.accent)
        assertEquals("#101215", b?.theme?.background)
    }

    @Test
    fun `malformed branding types degrade element-wise, never fail the parse`() = runTest {
        val p = provider(
            fetcher = {
                response(
                    200,
                    """{"replayEnabled":true,"replayDurationSec":15,"samplingRate":0.5,
                    "branding":{"watermark":"yes","theme":"dark"}}""",
                )
            },
        )
        p.refresh()
        // Unrelated config survives; branding degrades to an empty block.
        assertEquals(true, p.current.replayEnabled)
        assertEquals(BrandingConfigWire(watermark = null, theme = null), p.current.branding)
    }

    @Test
    fun `string-typed watermark is rejected, not coerced to a boolean`() = runTest {
        // kotlinx's JsonPrimitive#booleanOrNull parses the STRING "false" as
        // Boolean false, which would grant entitlement (skip the watermark)
        // from a string the server's z.boolean() schema would reject outright.
        // That is fail-OPEN against the spec's "everything malformed ⇒
        // watermarked" contract, so the decoder must ignore a string here
        // exactly like any other wrong-typed field — theme still decodes.
        val p = provider(
            fetcher = {
                response(
                    200,
                    """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
                    "branding":{"watermark":"false","theme":{"accent":"#336699"}}}""",
                )
            },
        )
        p.refresh()
        assertNull(p.current.branding?.watermark)
        assertEquals("#336699", p.current.branding?.theme?.accent)
    }

    @Test
    fun `branding tolerates unknown nested fields`() = runTest {
        val p = provider(
            fetcher = {
                response(
                    200,
                    """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
                    "branding":{"watermark":false,"future":1,"theme":{"accent":"#336699","futureRole":"#000000"}}}""",
                )
            },
        )
        p.refresh()
        assertEquals(false, p.current.branding?.watermark)
        assertEquals("#336699", p.current.branding?.theme?.accent)
    }

    // ==================== Report Resource Window (spec 2026-09-05) — gap class 1 ====================
    //
    // Server-driven `resources: { enabled, windowSec }` block, sent ONLY when
    // this SDK declares `resources` in X-TX-SDK-Features. Without declaring
    // the token the server never emits the block at all, permanently and
    // silently disabling the feature — this is the negotiation gap Task 12/13
    // built the ring/sampler/envelope stamping without closing.

    @Test
    fun `decodes resources block`() = runTest {
        val p = provider(
            fetcher = {
                response(
                    200,
                    """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                    "resources":{"enabled":true,"windowSec":120}}""",
                )
            },
        )
        p.refresh()
        assertEquals(true, p.current.resources?.enabled)
        assertEquals(120, p.current.resources?.windowSec)
    }

    @Test
    fun `absent resources decodes to null`() = runTest {
        val p = provider(
            fetcher = {
                response(200, """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0}""")
            },
        )
        p.refresh()
        assertNull(p.current.resources)
    }

    @Test
    fun `resources tolerates unknown nested fields`() = runTest {
        val p = provider(
            fetcher = {
                response(
                    200,
                    """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                    "resources":{"enabled":true,"windowSec":60,"future":1}}""",
                )
            },
        )
        p.refresh()
        assertEquals(true, p.current.resources?.enabled)
        assertEquals(60, p.current.resources?.windowSec)
    }

    @Test
    fun `resources windowSec field-level leniency - a non-positive value degrades to null without losing enabled`() = runTest {
        val p = provider(
            fetcher = {
                response(
                    200,
                    """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                    "resources":{"enabled":true,"windowSec":0}}""",
                )
            },
        )
        p.refresh()
        assertEquals(true, p.current.resources?.enabled)
        assertNull(p.current.resources?.windowSec)
    }

    @Test
    fun `resources omitted windowSec decodes to null`() = runTest {
        val p = provider(
            fetcher = {
                response(
                    200,
                    """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                    "resources":{"enabled":false}}""",
                )
            },
        )
        p.refresh()
        assertEquals(false, p.current.resources?.enabled)
        assertNull(p.current.resources?.windowSec)
    }

    @Test
    fun `a STRUCTURALLY malformed resources block degrades to feature off, it does NOT fail the whole config`() = runTest {
        // Missing the REQUIRED `enabled` field — a naive nested decode would
        // throw out of the serializer and take breadcrumbs/replay/everything
        // else in this same response down with it.
        val p = provider(
            fetcher = {
                response(
                    200,
                    """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                    "resources":{"windowSec":60}}""",
                )
            },
        )
        p.refresh()
        assertTrue("the rest of the config must still commit", p.current.replayEnabled)
        assertNull(p.current.resources)
    }

    @Test
    fun `a wrong-typed enabled in resources degrades the block, not the whole config`() = runTest {
        val p = provider(
            fetcher = {
                response(
                    200,
                    """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                    "resources":{"enabled":"yes"}}""",
                )
            },
        )
        p.refresh()
        assertTrue("the rest of the config must still commit", p.current.replayEnabled)
        assertNull(p.current.resources)
    }

    @Test
    fun `features header advertises resources`() {
        assertTrue(
            ReplayConfigProvider.SDK_FEATURES_HEADER_VALUE.contains("resources"),
        )
    }
}
