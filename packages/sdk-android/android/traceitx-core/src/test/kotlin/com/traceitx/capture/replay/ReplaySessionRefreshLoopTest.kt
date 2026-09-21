// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Final-review Finding 1 (native body-capture kill-switch latency,
// 2026-08-01-network-body-capture-native): `enableIfConfigured()` used to be
// the ONLY caller of the refresh seam (provider.refresh() -> read current ->
// sharedBreadcrumbBuffer.applyConfig -> NetworkBodyCaptureState.applyConfig +
// setTotalBudget -> startBufferingIfEligible), invoked once at start(). The
// remote kill-switch (spec §3) needs that seam re-invoked periodically
// (~300s, matching the config TTL) so a server-side flip actually reaches a
// long-lived session instead of only the next process launch.
//
// These specs drive the extracted `ReplaySession.refreshConfigNow()` seam
// directly — via an injectable-fetcher/injectable-clock `ReplayConfigProvider`
// — rather than the periodic loop itself, mirroring
// ReplayConfigProviderTest.kt's fake-ConfigFetcher pattern. No real network,
// no 300s delay.
package com.traceitx.capture.replay

import com.traceitx.TraceItX
import com.traceitx.capture.NetworkBodyCaptureState
import com.traceitx.config.CaptureConfig
import com.traceitx.config.ConfigFetcher
import com.traceitx.config.ReplayConfigProvider
import com.traceitx.config.TraceItXConfig
import com.traceitx.identity.IdentityTokenSource
import java.util.Base64
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ReplaySessionRefreshLoopTest {

    private val url = "https://traceitx.com/api/config"

    @Before
    fun setUp() {
        // `refreshConfigNow()` ends with `withContext(Dispatchers.Main) {
        // startBufferingIfEligible() }`. Under Robolectric's default PAUSED
        // LooperMode a posted Handler runnable never runs on its own (see
        // CompanionSubmissionComposerTest's header comment for the same
        // issue); UnconfinedTestDispatcher bypasses the real main Looper
        // entirely and runs the hop inline, so `runTest { session
        // .refreshConfigNow() }` completes without a separate drain thread.
        Dispatchers.setMain(UnconfinedTestDispatcher())
        NetworkBodyCaptureState.resetForTesting()
        // Round-5 review Finding F22: `refreshConfigNow()`'s network-body
        // gate now fails closed on a null `TraceItX.currentConfig` (spec §3
        // — nil client config means the `capture.network`/`networkBodies`
        // preconditions can't be confirmed). This suite drives `ReplaySession`
        // directly (not via `TraceItX.start()`), so `currentConfig` would
        // otherwise stay null throughout — populate it via the test-only
        // seam with BOTH client preconditions opted in, matching what a real
        // `start()`'d host with body capture enabled looks like. Individual
        // tests below only assert on the SERVER block / sampling behavior,
        // so this fixed client config keeps that the only variable.
        TraceItX.__setConfigForTesting(
            TraceItXConfig(appId = "app", sdkKey = "k", capture = CaptureConfig(network = true, networkBodies = true)),
        )
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        NetworkBodyCaptureState.resetForTesting()
        TraceItX.__setConfigForTesting(null)
        // Round 17 additions below install a Provider on the process-wide
        // `TraceItX._identityHolder` singleton and drive
        // `__replayConfigOverrideForTesting` — both must not leak into
        // other tests in this file or other suites sharing the singleton.
        TraceItX.setIdentityToken(null)
        TraceItX.__replayConfigOverrideForTesting = null
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

    private fun session(clock: () -> Long, fetcher: ConfigFetcher): ReplaySession {
        val provider = ReplayConfigProvider(configUrl = url, apiKey = "k", fetcher = fetcher, now = clock)
        return ReplaySession(apiKey = "k", locallyDisabled = false, provider = provider)
    }

    @Test
    fun `periodic re-read deactivates the gate after the server flips captureBodies off`() = runTest {
        var callCount = 0
        val fetcher = ConfigFetcher {
            callCount += 1
            if (callCount == 1) {
                response(
                    200,
                    """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
                    "networkBodies":{"captureBodies":true}}""",
                )
            } else {
                response(
                    200,
                    """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
                    "networkBodies":{"captureBodies":false}}""",
                )
            }
        }
        var clockValue = 0L
        val session = session(clock = { clockValue }, fetcher = fetcher)

        // Initial read (what enableIfConfigured() does at start()): server ON,
        // samplingRate 1.0 -> always sampled in -> gate active.
        session.refreshConfigNow()
        assertTrue(NetworkBodyCaptureState.isActive)

        // Simulate the periodic loop's next tick (past the provider's TTL) by
        // invoking the SAME seam again directly -- no delay, no real network.
        clockValue = 400_000L
        session.refreshConfigNow()

        // The kill-switch reaches the gate without a process restart.
        assertFalse(NetworkBodyCaptureState.isActive)
        assertEquals(2, callCount)
    }

    // ==================== Final-review Finding 5 (failed refresh must fail the body gate closed) ====================

    /**
     * The provider fails closed by keeping its last-good cache on a failed
     * fetch, so `refreshConfigNow()` re-reading `provider.current` after a
     * failed forced fetch used to see the SAME stale ON block as before and
     * kept re-arming the gate active forever — an unreachable/malformed
     * config could never turn capture back off once it had been on.
     * `refreshConfigNow()` must instead notice the fetch itself failed (via
     * `refresh(force =)`'s Boolean return) and explicitly deactivate the
     * gate, THEN reactivate once a later fetch actually succeeds with an ON
     * block again.
     */
    @Test
    fun `refreshConfigNow fails gate closed on failed fetch then reactivates on next success`() = runTest {
        val onBody = """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "networkBodies":{"captureBodies":true}}"""
        // Same provider/session throughout, so its last-good cache genuinely
        // persists an ON block across the failed middle call -- exactly the
        // scenario the bug depended on (a stale cached ON block getting
        // blindly re-applied by a caller that only ever reads `.current`).
        var callCount = 0
        val fetcher = ConfigFetcher {
            callCount += 1
            when (callCount) {
                1 -> response(200, onBody)
                2 -> throw java.io.IOException("boom")
                else -> response(200, onBody)
            }
        }
        var clockValue = 0L
        val session = session(clock = { clockValue }, fetcher = fetcher)

        // Call 1: successful ON read arms the gate active (samplingRate 1.0
        // -> always sampled in).
        session.refreshConfigNow()
        assertTrue(NetworkBodyCaptureState.isActive)

        // Call 2: fetch fails -- provider's cache silently keeps the ON
        // block from call 1, but refreshConfigNow must notice THIS fetch
        // failed and deactivate the gate rather than re-arming off the
        // stale cache.
        clockValue = 400_000L
        session.refreshConfigNow()
        assertFalse("a failed refresh must fail the gate closed", NetworkBodyCaptureState.isActive)

        // Call 3: fetch succeeds again with an ON block -- reactivates. The
        // sticky sampling draw (already true from call 1) is honored, not
        // re-drawn.
        clockValue = 800_000L
        session.refreshConfigNow()
        assertTrue(NetworkBodyCaptureState.isActive)
        assertEquals(3, callCount)
    }

    @Test
    fun `sticky sampling draw is not re-drawn on periodic re-read`() = runTest {
        var callCount = 0
        val fetcher = ConfigFetcher {
            callCount += 1
            if (callCount == 1) {
                // samplingRate 0 -> sampled OUT on the first read, sticky.
                response(
                    200,
                    """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":0.0,
                    "networkBodies":{"captureBodies":true}}""",
                )
            } else {
                // Second read raises samplingRate to 1 -- must NOT re-draw
                // (NetworkBodyCaptureState's one-shot sampling draw, spec §3).
                response(
                    200,
                    """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
                    "networkBodies":{"captureBodies":true}}""",
                )
            }
        }
        var clockValue = 0L
        val session = session(clock = { clockValue }, fetcher = fetcher)

        session.refreshConfigNow()
        assertFalse(NetworkBodyCaptureState.isActive)

        clockValue = 400_000L
        session.refreshConfigNow()
        assertFalse(NetworkBodyCaptureState.isActive)
    }

    // ==================== Round-6 review Finding F28 ====================
    //
    // End-to-end (provider fetch -> refreshConfigNow -> gate): a server
    // config with `networkBodies.captureBodies: true` but breadcrumbs
    // off/network-excluding must leave the CAPTURE gate inactive, not just
    // filter at encode time — nothing should ever enter the body buffer in
    // the first place.

    @Test
    fun `server on but breadcrumbs disabled end-to-end stays inactive`() = runTest {
        val fetcher = ConfigFetcher {
            response(
                200,
                """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
                "breadcrumbs":{"enabled":false,"kinds":["network"],"maxCount":100,"byteBudget":16384,"consoleEntryCap":1024},
                "networkBodies":{"captureBodies":true}}""",
            )
        }
        val session = session(clock = { 0L }, fetcher = fetcher)

        session.refreshConfigNow()
        assertFalse(
            "breadcrumbs disabled must keep the capture gate off despite server bodies ON",
            NetworkBodyCaptureState.isActive,
        )
    }

    @Test
    fun `server on but breadcrumb kinds omit network end-to-end stays inactive`() = runTest {
        val fetcher = ConfigFetcher {
            response(
                200,
                """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
                "breadcrumbs":{"enabled":true,"kinds":["console","tap"],"maxCount":100,"byteBudget":16384,"consoleEntryCap":1024},
                "networkBodies":{"captureBodies":true}}""",
            )
        }
        val session = session(clock = { 0L }, fetcher = fetcher)

        session.refreshConfigNow()
        assertFalse(
            "breadcrumb kinds omitting 'network' must keep the capture gate off despite server bodies ON",
            NetworkBodyCaptureState.isActive,
        )
    }

    @Test
    fun `server on breadcrumbs enabled with network end-to-end becomes active`() = runTest {
        val fetcher = ConfigFetcher {
            response(
                200,
                """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
                "breadcrumbs":{"enabled":true,"kinds":["console","network"],"maxCount":100,"byteBudget":16384,"consoleEntryCap":1024},
                "networkBodies":{"captureBodies":true}}""",
            )
        }
        val session = session(clock = { 0L }, fetcher = fetcher)

        session.refreshConfigNow()
        assertTrue(
            "the happy path must not be over-gated by the F28 fix",
            NetworkBodyCaptureState.isActive,
        )
    }

    @Test
    fun `absent breadcrumbs block end-to-end stays active`() = runTest {
        // Matches sharedBreadcrumbBuffer.applyConfig(null)'s own default
        // (enabled + all kinds including network) — an app that never
        // configured breadcrumbs must not have bodies silently disabled.
        val fetcher = ConfigFetcher {
            response(
                200,
                """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
                "networkBodies":{"captureBodies":true}}""",
            )
        }
        val session = session(clock = { 0L }, fetcher = fetcher)

        session.refreshConfigNow()
        assertTrue(
            "an absent breadcrumbs block must not disable bodies",
            NetworkBodyCaptureState.isActive,
        )
    }

    // -------------------------------------------------------------------
    // Independent review, round 17, New — a host installing a Provider
    // immediately after start() (the documented, recommended integration)
    // finds identity disabled: config has not been fetched yet, so the
    // install-time warm correctly no-ops per round 6's enabled-gate.
    // Nothing then retried the warm once THIS config fetch enables
    // identity — the cache stayed cold until some LATER reporter-open warm
    // happened to fire, so every capture in between (including a crash)
    // shipped anonymous for the exact integration this SDK recommends. Fix:
    // `refreshConfigNow()` now detects a genuine DISABLED -> ENABLED
    // transition right where `configBox` is updated and reuses the
    // EXISTING `TraceItX.__warmIdentityToken()` entry point.
    // -------------------------------------------------------------------

    private fun jwt(sub: String, expMs: Long): String {
        val payload = buildJsonObject {
            put("sub", sub)
            put("exp", expMs / 1000)
        }
        val header = """{"alg":"HS256","typ":"JWT"}"""
        fun b64(s: String) = Base64.getUrlEncoder().withoutPadding().encodeToString(s.toByteArray(Charsets.UTF_8))
        return "${b64(header)}.${b64(payload.toString())}.not-a-real-signature"
    }

    private fun pollUntil(timeoutMs: Long = 5_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!condition() && System.currentTimeMillis() < deadline) {
            Thread.sleep(20)
        }
    }

    /**
     * THE test: install a Provider while identity is disabled (matches the
     * documented "install right after start()" recommendation), apply a
     * config that enables identity, and assert the provider is invoked and
     * the subject cached — WITHOUT any reporter ever opening. `TraceItX
     * .__replayConfigOverrideForTesting` stands in for this test's
     * standalone `session` being the one `TraceItX.currentReplayConfig()`
     * actually reads — `__warmIdentityToken()`'s OWN internal gate re-reads
     * that live accessor, independent of this test's local `session`
     * instance, so it must agree with what `session.refreshConfigNow()`
     * just applied for the warm to actually reach the provider.
     *
     * Mutation-verified, both halves independently:
     *  - Removing the transition detection entirely (so the warm never
     *    fires) makes this fail at the "invoked exactly once" assertion —
     *    `invoked` never reaches 1, reproducing the exact residual the
     *    finding described.
     *  - Loosening the gate to fire the warm on EVERY config apply (not
     *    just a genuine transition) makes this fail at the "must not
     *    re-invoke" assertion instead — `invoked` reaches 2. This is why
     *    the provider's token above is deliberately short-lived (inside
     *    `IDENTITY_REFRESH_MARGIN_MS`): a comfortably long-lived token
     *    would pass step 3 either way, because the holder's own cache
     *    would stay fresh regardless of which gate (if any) called warm.
     */
    @Test
    fun `a config apply that enables identity retries the warm and caches the subject`() = runBlocking {
      // Unlike every other test in this file, this one triggers a REAL
      // `TraceItX.__warmIdentityToken()` -> `sdkScope.launch { }` child job —
      // the process-wide `sdkScope` (`internal val sdkScope` on the `TraceItX`
      // object) is shared by every test in this JVM fork, and this file's
      // shared `@After tearDown()` above only clears the identity SOURCE
      // (`setIdentityToken(null)`), which stops a stale result from being
      // CACHED (via `IdentityTokenHolder`'s generation check) but does not
      // cancel an already-launched job. `TraceItX.kill()` — the same call
      // `IdentityProviderWarmTest.kt` makes in its own `@After` for this
      // exact reason — reaches `sdkScope.coroutineContext[Job]
      // ?.cancelChildren()` and resets every other piece of global
      // `TraceItX` state besides; safe to call unconditionally here since
      // `start()` was never called by this test. (Investigated a suspected
      // interaction with `TraceItXLogWiringTest` when running the two full
      // suites back to back; that turned out to be a PRE-EXISTING flake —
      // reproduces on the unmodified tree too, unrelated to this change —
      // not something this call fixes. Kept anyway as the same defensive
      // hygiene the sibling suite already practices.)
      try {
        val invoked = AtomicInteger(0)
        TraceItX.setIdentityToken(
            IdentityTokenSource.Provider {
                invoked.incrementAndGet()
                // Deliberately INSIDE IDENTITY_REFRESH_MARGIN_MS (30s), not a
                // comfortably-long-lived token: `IdentityTokenHolder.get()`
                // re-asks the provider whenever the cached token's remaining
                // life is <= the margin, regardless of what gated the CALL
                // to warm. A long-lived token would make step 3 below pass
                // even with the transition-detection gate removed entirely
                // (mutation-tested — see the doc comment), because the
                // holder's own cache would still be comfortably fresh and
                // never re-ask the provider either way. A short-lived token
                // makes step 3 actually exercise `refreshConfigNow()`'s own
                // gate: if it fired the warm on every apply instead of only
                // on the transition, the holder would find its cache inside
                // the margin and re-ask this provider, and `invoked` would
                // reach 2.
                jwt(sub = "alice", expMs = System.currentTimeMillis() + 10_000)
            },
        )

        var callCount = 0
        val fetcher = ConfigFetcher {
            callCount += 1
            if (callCount == 1) {
                // First fetch: identity disabled (matches "config hasn't
                // resolved yet" immediately after start()).
                response(200, """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,"nativeVideo":{"framesPerSecond":5}}""")
            } else {
                // Every fetch from here on: identity enabled, unchanged.
                response(
                    200,
                    """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
                    "identity":{"enabled":true}}""",
                )
            }
        }
        var clockValue = 0L
        val session = session(clock = { clockValue }, fetcher = fetcher)

        // 1. Install-time warm equivalent: identity starts disabled, so the
        //    warm setIdentityToken() already fired must have no-op'd.
        session.refreshConfigNow()
        assertEquals("fixture sanity: the provider must not be invoked while identity is disabled", 0, invoked.get())

        // 2. THE fix under test: config now enables identity. The real
        //    TraceItX.currentReplayConfig() (what __warmIdentityToken()'s
        //    own gate re-reads) must agree, so arm the same enabled config
        //    there via the test override before advancing the clock past
        //    the provider's TTL and re-fetching.
        TraceItX.__replayConfigOverrideForTesting = com.traceitx.config.ReplayConfig(
            replayEnabled = false, replayDurationSec = 30, samplingRate = 1.0,
            identity = com.traceitx.config.IdentityConfigWire(enabled = true),
        )
        clockValue = 400
        session.refreshConfigNow()

        pollUntil { invoked.get() >= 1 }
        assertEquals(
            "the disabled -> enabled transition must retry the warm and invoke the provider exactly once",
            1,
            invoked.get(),
        )
        pollUntil { TraceItX._identityHolder.cachedSubject(System.currentTimeMillis()) != null }
        assertEquals(
            "the subject must be cached without any reporter ever opening",
            "alice",
            TraceItX._identityHolder.cachedSubject(System.currentTimeMillis()),
        )

        // 3. A periodic refresh that LEAVES identity enabled (the ordinary
        //    ~300s tick) must NOT re-invoke the provider.
        clockValue = 800
        session.refreshConfigNow()
        Thread.sleep(300)  // fair chance for an (unwanted) re-invocation to land
        assertEquals(
            "a config refresh that leaves identity enabled must not re-invoke the provider",
            1,
            invoked.get(),
        )
      } finally {
        TraceItX.kill()
      }
    }

    // -------------------------------------------------------------------
    // Round 17 (codex round 16), Serious x2 — `setIdentityToken(null)` used
    // to force-discard the replay lifecycle via the now-REMOVED
    // `ReplaySession.forceDiscardForIdentityChange()` (`lifecycle
    // .forceDiscard()` immediately followed by an attempt to resume
    // buffering), called from inside `stateLock.withLock { }` regardless of
    // which thread `setIdentityToken` happened to run on. Two consequences,
    // both traced to that one call: (1) signing out while a reporter had
    // the lifecycle FROZEN flipped it back to buffering and restarted the
    // Choreographer tick WHILE reporter chrome was on screen — capturing
    // reporter UI into the next report, and leaving the open reporter's own
    // pending submit/cancel to no-op against a lifecycle that was no longer
    // frozen; (2) the same call, reached from an ordinary background auth
    // callback (the completely ordinary case), drove the main-thread-
    // confined `ReplaySession` off the main thread — the guard swallowed
    // the `Choreographer.getInstance()` exception AFTER tick and lifecycle
    // state were already mutated, leaving replay stuck "buffering" with a
    // dead tick until the SDK session restarted. Ruling: sign-out stops
    // touching the replay lifecycle entirely — it keeps only the
    // evidence-buffer zeroization (lock-guarded, thread-agnostic).
    // -------------------------------------------------------------------

    /**
     * Regression pin: freeze the lifecycle (simulating an open reporter),
     * sign out, and assert the lifecycle is STILL frozen — sign-out must
     * never flip it back to buffering. `ReplaySession.__lifecycleStateForTesting()`
     * is a new, minimal test-only accessor (`lifecycle` itself is
     * `private`) added purely so this can be observed directly rather than
     * inferred from a real captured frame, which neither this suite nor any
     * other in this tree has ever needed to drive.
     *
     * Mutation-verified: reinstating a call to (a re-added)
     * `_replaySession?.forceDiscardForIdentityChange()` inside
     * `TraceItX.discardCapturedEvidenceForIdentityChange()` makes this fail
     * — the lifecycle flips to BUFFERING instead of staying FROZEN.
     */
    @Test
    fun `sign out does not touch a frozen replay lifecycle`() = runTest {
        val fetcher = ConfigFetcher {
            response(200, """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,"nativeVideo":{"framesPerSecond":5}}""")
        }
        TraceItX.captureGate = true
        val session = session(clock = { 0L }, fetcher = fetcher)
        session.refreshConfigNow()
        assertEquals(
            "context-free fixture has no recorder to admit; freezing still owns ancillary reporting",
            com.traceitx.capture.video.NativeVideoRecorder.State.DISABLED,
            session.__lifecycleStateForTesting(),
        )

        TraceItX._replaySession = session
        try {
            val capture = TraceItX.__replayFreeze()
            assertEquals(
                "fixture sanity: freezing a buffering session must move it to FROZEN",
                com.traceitx.capture.video.NativeVideoRecorder.State.FROZEN,
                session.__lifecycleStateForTesting(),
            )

            TraceItX.setIdentityToken(null)

            assertEquals(
                "sign-out must not touch a frozen replay lifecycle",
                com.traceitx.capture.video.NativeVideoRecorder.State.FROZEN,
                session.__lifecycleStateForTesting(),
            )
            capture.cancel()
        } finally {
            session.teardown()
            TraceItX.captureGate = false
            TraceItX._replaySession = null
        }
    }
}
