// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Round-5 review Finding F23 (2026-08-02-pr25-review-round-5): `start(A) ->
// start(B)` is not a safe app/session boundary by itself. `start()`
// synchronously overwrites `_config`/re-opens `captureGate`/changes the
// submit key, but A's `NetworkBodyCaptureState` (including its STICKY
// sampling draw), A's buffered request/response bytes, and A's
// refresh-owning `ReplaySession` all stayed live — the body ring buffer was
// never cleared at ALL, and the old `ReplaySession` kept running until the
// async `start.replay` block eventually got around to tearing it down.
// Consequences: (1) requests captured during that window kept capturing
// under A's server authorization; (2) a report opened under B could upload
// A's buffered bodies (and their correlated crumbs) to B's app/key.
//
// Fixed by moving `NetworkBodyCaptureState.reset()` (deactivate + clear the
// sticky sample draw — previously only called from `kill()`),
// `sharedNetworkBodyBuffer.clear()`, and `_replaySession?.teardown()` into
// `start()`'s SAME synchronous `stateLock` critical section that installs
// `_config`/`captureGate` for the new session. Unlike iOS, `_replaySession`
// here is plain `stateLock`-guarded state (not actor-isolated), so this
// really is atomic with the config swap — every assertion below is checked
// with ZERO waiting, immediately after `start()` returns.
//
// SCOPE UPDATE (2026-08-13, follow-ups register item 10): F23 deliberately
// stopped at the BODY buffer and left the breadcrumb chain and the network
// METADATA ring alone, reasoning from consistency (every other crumb kind
// survived a restart) rather than from tenancy. Those two rings outliving
// `start(B)` meant the next ordinary report in B shipped project A's crumbs
// and A's URLs/statuses/timings to a different customer's project, so
// `start()` now clears them too. Guarded by `EnvelopeUserTest`, not here —
// this file stays scoped to F23's body-capture state.
package dev.everframe

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.everframe.capture.NetworkBodyCaptureState
import dev.everframe.capture.replay.ReplaySession
import dev.everframe.capture.sharedBreadcrumbBuffer
import dev.everframe.capture.sharedNetworkBodyBuffer
import dev.everframe.capture.sharedNetworkBuffer
import dev.everframe.config.CaptureConfig
import dev.everframe.config.ConfigFetcher
import dev.everframe.config.NetworkBodiesConfigWire
import dev.everframe.config.ReplayConfigProvider
import dev.everframe.config.EverframeConfig
import dev.everframe.protocol.generated.NetworkBody
import dev.everframe.shared.SharedData
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class EverframeNetworkBodySessionBoundaryTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private val configUrl = "https://everframe.dev/api/config"

    private fun validConfig(sdkKey: String): EverframeConfig = EverframeConfig(
        appId = "test-app-id",
        sdkKey = sdkKey,
        // Mirrors StartEpochGuardTest.validConfig()'s rationale: keep the
        // detached heavy-init coroutine's OTHER side effects (log tee
        // install) out of this suite entirely.
        capture = CaptureConfig(logs = false),
    )

    private fun bodyEntry(ref: Int) = NetworkBody(
        ref = ref.toDouble(),
        reqBody = "A's secret request body",
        reqBodyBytes = 24.0,
        reqBodySkipped = null,
        reqBodyTruncated = null,
        reqHeaders = null,
        resBody = "A's secret response body",
        resBodyBytes = 25.0,
        resBodySkipped = null,
        resBodyTruncated = null,
        resHeaders = null,
        t = 0.0,
    )

    private fun response(code: Int, body: String): Response {
        val req = Request.Builder().url(configUrl).build()
        return Response.Builder()
            .request(req)
            .protocol(Protocol.HTTP_1_1)
            .code(code)
            .message(if (code == 200) "OK" else "ERR")
            .body(body.toResponseBody("application/json".toMediaType()))
            .build()
    }

    @Before
    fun setUp() {
        SharedData.init(context)
        NetworkBodyCaptureState.resetForTesting()
    }

    @After
    fun tearDown() {
        Everframe.kill()
        sharedBreadcrumbBuffer.applyConfig(null)
        sharedBreadcrumbBuffer.clear()
        sharedNetworkBodyBuffer.clear()
        sharedNetworkBuffer.clear()
        NetworkBodyCaptureState.resetForTesting()
    }

    @Test
    fun `start(B) synchronously tears down session A and resets network-body capture state`() {
        Everframe.start(context, validConfig("txx_live_appA1234567890"))

        // Install a real ReplaySession (injectable provider — no real
        // network) as session A's refresh owner, exactly as start()'s own
        // heavy-init tail would have installed one.
        val fetcherA = ConfigFetcher { response(200, """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0}""") }
        val providerA = ReplayConfigProvider(configUrl = configUrl, apiKey = "a", fetcher = fetcherA)
        val sessionA = ReplaySession(apiKey = "a", locallyDisabled = false, provider = providerA)
        Everframe._replaySession = sessionA
        assertFalse("test setup: session A must not already be torn down", sessionA.isTornDownForTesting)

        // Simulate A's session having been authorized ON by the server and
        // having sampled itself in — this sticky draw is exactly what this
        // fix must clear.
        NetworkBodyCaptureState.applyConfig(
            NetworkBodiesConfigWire(captureBodies = true),
            samplingRate = 1.0,
            locallyDisabled = false,
            random = { 0.0 },
        )
        assertTrue("test setup: A's gate must be active before start(B)", NetworkBodyCaptureState.isActive)

        // Simulate a body having actually been captured under A's
        // authorization — this is what a report opened under B must never
        // be able to upload.
        sharedNetworkBodyBuffer.append(bodyEntry(ref = 1))
        assertTrue(
            "test setup: A's body must be buffered before start(B)",
            sharedNetworkBodyBuffer.snapshot().isNotEmpty(),
        )

        Everframe.start(context, validConfig("txx_live_appB0987654321"))

        // SYNCHRONOUS assertions — ZERO waiting, immediately after start(B)
        // returns. `_replaySession`/`NetworkBodyCaptureState`/
        // `sharedNetworkBodyBuffer` are all plain stateLock/ReentrantLock-
        // guarded state, not coroutine/actor-isolated, so this really does
        // exercise the synchronous part of start().
        assertTrue("start(B) must tear down A's ReplaySession synchronously", sessionA.isTornDownForTesting)
        assertFalse("start(B) must deactivate A's still-armed body gate synchronously", NetworkBodyCaptureState.isActive)
        assertTrue(
            "start(B) must zeroize A's buffered bodies synchronously",
            sharedNetworkBodyBuffer.snapshot().isEmpty(),
        )

        // Prove the STICKY sampling draw itself was cleared (not just
        // `active`): re-apply an ON config with samplingRate 0 and a
        // random() that always draws "sampled out". If reset() had NOT
        // cleared the sticky draw, applyConfig would treat the OLD draw
        // (true, from A) as already-decided and never re-roll — isActive
        // would come back true. Only a genuinely-cleared draw re-rolls and
        // lands here as false.
        NetworkBodyCaptureState.applyConfig(
            NetworkBodiesConfigWire(captureBodies = true),
            samplingRate = 0.0,
            locallyDisabled = false,
            random = { 0.999 },
        )
        assertFalse(
            "start(B) must clear A's sticky sampling draw, not just deactivate the gate",
            NetworkBodyCaptureState.isActive,
        )
    }
}
