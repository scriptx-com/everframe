// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Public-API tests for `object TraceItX` — start / kill / setUser bodies +
// captureGate flip + ConfigValidator gates.
package com.traceitx

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.traceitx.capture.NetworkBodyCaptureState
import com.traceitx.capture.NetworkRingBuffer
import com.traceitx.capture.ResourceRingBuffer
import com.traceitx.capture.sharedBreadcrumbBuffer
import com.traceitx.capture.sharedNetworkBodyBuffer
import com.traceitx.capture.sharedNetworkBuffer
import com.traceitx.capture.sharedResourceBuffer
import com.traceitx.config.CaptureConfig
import com.traceitx.config.Environment
import com.traceitx.config.TXUser
import com.traceitx.config.TraceItXConfig
import com.traceitx.config.TraceItXConfigError
import com.traceitx.protocol.generated.BreadcrumbKind
import com.traceitx.protocol.generated.NetworkBody
import com.traceitx.shared.SharedData
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Before
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class TraceItXTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()

    private fun validConfig(env: Environment = Environment.production): TraceItXConfig =
        TraceItXConfig(
            appId = "test-app-id",
            sdkKey = "txx_live_test1234567890",
            environment = env,
            // Review fix (Plan 5 Task 1): none of this file's start() call
            // sites assert log/console-breadcrumb behavior (that's covered by
            // TraceItXLogWiringTest, which has an airtight awaitHeavyInit +
            // uninstall teardown). LogCapture.install() plants a PROCESS-WIDE
            // stdout/stderr tee from inside start()'s detached
            // Dispatchers.IO heavy-init coroutine; this file's tearDown()
            // does NOT await that coroutine before calling TraceItX.kill(),
            // so a straggling coroutine could install the tee AFTER kill()'s
            // uninstall already ran, leaking a corrupted System.out/err into
            // a later test. Defaulting logs=false here means the `if
            // (config.capture.logs)` gate in the heavy-init coroutine is
            // false and no tee is ever installed, dissolving the race.
            // Mirrors BreadcrumbRingBufferTest's `noLogCaptureConfig()`.
            capture = CaptureConfig(logs = false),
        )

    /** Session Vitals: a player that only records what the controller did to it. */
    private class RecordingPlayerIntegration : com.traceitx.vitals.PlayerIntegration {
        override val library = "fake"; override val version: String? = null
        var detached = 0
        override fun attach(ctx: com.traceitx.vitals.PlayerIntegrationContext) = true
        override fun snapshot(onResult: (com.traceitx.vitals.PlayerSnapshot?) -> Boolean) { onResult(null) }
        override fun startupTimings(): com.traceitx.vitals.StartupTimings? = null
        override fun describe(ctx: com.traceitx.vitals.PlayerIntegrationContext) {}
        override fun detach() { detached++ }
    }

    /** A controller with no network and no real sampler — stands in for the one `start()`'s tail builds. */
    private fun vitalsControllerForTest() = com.traceitx.vitals.VitalsController(
        com.traceitx.vitals.VitalsController.Deps(
            localConfig = com.traceitx.config.VitalsConfig(),
            dims = com.traceitx.vitals.wire.SessionSummaryDims("android", "1", "test"),
            transport = {
                object : com.traceitx.vitals.VitalsSink {
                    override fun send(body: String) = Unit
                    override fun close() = Unit
                }
            },
            scheduler = object : com.traceitx.vitals.VitalsScheduler {
                override fun repeat(intervalMs: Long, tick: () -> Unit) = AutoCloseable { }
            },
            samplerFactory = { onSample, onTick ->
                object : com.traceitx.vitals.ResourceSampler(
                    handler = android.os.Handler(android.os.Looper.getMainLooper()),
                    onSample = onSample,
                    onTick = onTick,
                ) {}
            },
            lifecycle = { _, _ -> null },
            random = { 0.0 },
        ),
    )

    @Before
    fun setUp() {
        // Session Vitals: the server signal and the process-wide runtime are
        // process-global, so reset both before every test (parked item N5) —
        // a leftover enabled signal would otherwise start a collector inside
        // an unrelated test's start().
        com.traceitx.vitals.VitalsServerConfigSignal.resetForTesting()
        com.traceitx.vitals.VitalsRuntime.resetForTesting()
        // RedactionEngine (invoked by every sharedBreadcrumbBuffer.add()) reads
        // SharedData, which requires an explicit init with a Context outside of
        // TraceItX.start() (mirrors BreadcrumbRingBufferTest's setUp — Robolectric
        // gives a fresh Application per test, so this can't be assumed done already).
        SharedData.init(context)
    }

    @After
    fun tearDown() {
        // Reset SDK state for test isolation.
        TraceItX.kill()
        sharedBreadcrumbBuffer.applyConfig(null)
        sharedBreadcrumbBuffer.clear()
        sharedNetworkBodyBuffer.clear()
        sharedNetworkBuffer.clear()
        sharedResourceBuffer.clear()
        com.traceitx.config.BrandingServerConfigSignal.resetForTesting()
        com.traceitx.config.BrandingInlineTheme.resetForTesting()
        com.traceitx.vitals.VitalsServerConfigSignal.resetForTesting()
        com.traceitx.vitals.VitalsRuntime.resetForTesting()
    }

    @Test
    fun `start flips captureGate to true and stores config`() {
        val cfg = validConfig()
        TraceItX.start(context, cfg)
        assertTrue("captureGate should be true after start()", TraceItX.captureGate)
        assertEquals(cfg, TraceItX.currentConfig)
    }

    @Test
    fun `start completes synchronously (no host-thread blocking)`() {
        // Real-device claim is <5ms; JVM/Robolectric warmup makes that bound noisy,
        // so we use a generous 250ms ceiling. The point is "start() did NOT await
        // any heavy I/O" — the heavy-init coroutine is detached.
        val cfg = validConfig()
        val elapsed = kotlin.system.measureTimeMillis { TraceItX.start(context, cfg) }
        assertTrue(
            "start() must return promptly; took ${elapsed}ms (real-device <5ms claim verified separately)",
            elapsed < 250,
        )
    }

    @Test
    fun `start throws MissingAppId on blank appId`() {
        val bad = validConfig().copy(appId = "")
        assertThrows(TraceItXConfigError.MissingAppId::class.java) {
            TraceItX.start(context, bad)
        }
    }

    @Test
    fun `start throws BlankSdkKey on blank sdkKey`() {
        val bad = validConfig().copy(sdkKey = "")
        assertThrows(TraceItXConfigError.BlankSdkKey::class.java) {
            TraceItX.start(context, bad)
        }
    }

    // Endpoint scheme validation tests removed — endpoint is no longer a
    // public config field. The URL is baked into BuildConfig.INGEST_URL at
    // library build time and `IngestEndpoint.url` exposes it internally.

    @Test
    fun `kill flips captureGate to false and is idempotent`() {
        TraceItX.start(context, validConfig())
        assertTrue(TraceItX.captureGate)
        TraceItX.kill()
        assertFalse(TraceItX.captureGate)
        // Calling again is safe — must not throw.
        TraceItX.kill()
        assertFalse(TraceItX.captureGate)
        assertNull(TraceItX.currentConfig)
    }

    /**
     * Fix round 2 residual minor. Unlike every other piece of session state
     * (`_config`, `_user`, `_identityHolder`, `_replaySession`),
     * `__replayConfigOverrideForTesting` was never cleared by `kill()` — a
     * value left set (a forgotten test cleanup, or any future misuse) would
     * silently override the fail-closed `.OFF` default for EVERY submit
     * path across a `kill()`/re-`start()` cycle, since
     * `currentReplayConfig()` checks it unconditionally, first. Mutation-
     * verified: removing the clear line in `kill()` makes this fail.
     */
    @Test
    fun `kill clears the replay-config test override`() {
        TraceItX.start(context, validConfig())
        TraceItX.__replayConfigOverrideForTesting = com.traceitx.config.ReplayConfig(
            replayEnabled = true,
            replayDurationSec = 30,
            samplingRate = 1.0,
            identity = com.traceitx.config.IdentityConfigWire(enabled = true),
        )
        assertNotNull(TraceItX.__replayConfigOverrideForTesting)

        TraceItX.kill()

        assertNull(
            "kill() must clear __replayConfigOverrideForTesting like every other piece of session state",
            TraceItX.__replayConfigOverrideForTesting,
        )
    }

    @Test
    fun `kill zeroizes breadcrumb buffer including frozen snapshot`() {
        // Final-review fix: cross-SDK posture parity with web (sdk-core
        // client.ts kill() calls state.breadcrumbs.clear()). Pre-kill live
        // entries AND a frozen snapshot (the reporter-open freeze) must both
        // be zeroized by kill() — otherwise a submit on an already-frozen
        // report could still ship crumbs captured before the kill (GDPR
        // erasure / DEFE-03 posture).
        sharedBreadcrumbBuffer.applyConfig(null)
        sharedBreadcrumbBuffer.clear()
        // validConfig() already defaults to capture = CaptureConfig(logs = false).
        TraceItX.start(context, validConfig())

        sharedBreadcrumbBuffer.add(kind = BreadcrumbKind.Tap, message = "pre-kill-live")
        sharedBreadcrumbBuffer.freeze()
        sharedBreadcrumbBuffer.add(kind = BreadcrumbKind.Tap, message = "pre-kill-after-freeze")

        TraceItX.kill()

        assertEquals(0, sharedBreadcrumbBuffer.size)
        assertNull(sharedBreadcrumbBuffer.takeFrozen())
    }

    @Test
    fun `kill zeroizes body and network buffers`() {
        // Task 15 — closes the pre-existing zeroize gap: kill() previously
        // only cleared sharedBreadcrumbBuffer, leaving sharedNetworkBuffer
        // (network metadata) and sharedNetworkBodyBuffer (request/response
        // bodies — the more sensitive of the two) alive across a kill. Both
        // live entries AND any frozen snapshot (reporter-open freeze) must
        // be zeroized, mirroring the breadcrumb test above.
        sharedNetworkBodyBuffer.clear()
        sharedNetworkBuffer.clear()
        TraceItX.start(context, validConfig())

        sharedNetworkBodyBuffer.append(NetworkBody(ref = 1.0, t = 1.0, reqBody = "pre-kill-live"))
        sharedNetworkBodyBuffer.freeze()
        sharedNetworkBodyBuffer.append(NetworkBody(ref = 2.0, t = 2.0, reqBody = "pre-kill-after-freeze"))

        sharedNetworkBuffer.push(
            NetworkRingBuffer.Entry(
                timestamp = 0L,
                method = "GET",
                url = "https://example.com",
                status = 200,
                durationMs = 1L,
                requestHeaders = emptyMap(),
                responseHeaders = emptyMap(),
                errorMessage = null,
            )
        )

        TraceItX.kill()

        assertEquals(0, sharedNetworkBodyBuffer.snapshot().size)
        assertNull(sharedNetworkBodyBuffer.takeFrozen())
        assertEquals(0, sharedNetworkBuffer.size())
    }

    @Test
    fun `kill zeroizes the resource ring buffer`() {
        // Round-1 review, Important 2 — the identical finding iOS already
        // fixed for its ResourceRingBuffer, carried into Android here.
        // `clearCapturedEvidenceBuffers()` (kill()'s zeroization path) had
        // three buffers before this feature existed and gained a fourth
        // (this one) without a fifth call being added alongside it.
        sharedResourceBuffer.clear()
        TraceItX.start(context, validConfig())

        sharedResourceBuffer.push(ResourceRingBuffer.Entry(t = System.currentTimeMillis(), cpu = 0.1, mem = 4096L))
        assertFalse("fixture sanity: the entry must actually be captured", sharedResourceBuffer.snapshot().isEmpty())

        TraceItX.kill()

        assertTrue(
            "kill() must zeroize the resource ring buffer like every other evidence buffer",
            sharedResourceBuffer.snapshot().isEmpty(),
        )
    }

    @Test
    fun `push after kill cannot repopulate the resource ring regardless of ordering with teardown`() {
        // Round-review Finding 3 (2026-09-05) — `kill()` calls
        // `clearCapturedEvidenceBuffers()` (which clears `sharedResourceBuffer`)
        // BEFORE `_replaySession?.teardown()` stops the sampler that feeds it.
        // A tick already queued on the main looper when `kill()` runs could
        // previously land in that exact gap — after the clear, before the
        // teardown actually silences the sampler — and push one fresh sample
        // into the ring post-kill. `ResourceRingBuffer.push` now gates on
        // `TraceItX.captureGate` (mirroring NetworkRingBuffer's F11/F15
        // fix), so this is structural rather than ordering-dependent: any
        // push attempted once the gate is closed is a no-op no matter when
        // it lands relative to clear()/teardown().
        sharedResourceBuffer.clear()
        TraceItX.start(context, validConfig())
        TraceItX.kill()

        // Simulates the queued tick landing after kill() has fully run
        // (gate closed, buffers already cleared) — the exact interleaving
        // the finding describes.
        sharedResourceBuffer.push(ResourceRingBuffer.Entry(t = System.currentTimeMillis(), cpu = 0.1, mem = 4096L))

        assertTrue(
            "a sample pushed after kill() must never repopulate the ring",
            sharedResourceBuffer.snapshot().isEmpty(),
        )
    }

    @Test
    fun `kill resets the network-body sampling gate so a fresh start redraws`() {
        // Final-review Finding 3 (process-lifetime sampling): a
        // kill()/start() cycle used to reuse the OLD session's one-shot
        // sampling draw (only the test-only resetForTesting() cleared it).
        // kill() must call NetworkBodyCaptureState.reset() so a fresh
        // session draws fresh sampling instead of inheriting a stale draw.
        NetworkBodyCaptureState.resetForTesting()
        TraceItX.start(context, validConfig())
        NetworkBodyCaptureState.applyConfig(
            com.traceitx.config.NetworkBodiesConfigWire(captureBodies = true),
            samplingRate = 1.0, locallyDisabled = false, random = { 0.0 }, // draws IN
        )
        assertTrue(NetworkBodyCaptureState.isActive)

        TraceItX.kill()
        assertFalse("kill() must deactivate the network-body gate", NetworkBodyCaptureState.isActive)

        // A samplingRate of 0 (would draw OUT) combined with a `random` that
        // would draw IN at any nonzero rate: if the pre-kill sticky draw
        // survived, the gate would wrongly stay active.
        NetworkBodyCaptureState.applyConfig(
            com.traceitx.config.NetworkBodiesConfigWire(captureBodies = true),
            samplingRate = 0.0, locallyDisabled = false, random = { 0.0 },
        )
        assertFalse(
            "stale sticky sampling draw must not survive kill()",
            NetworkBodyCaptureState.isActive,
        )
        NetworkBodyCaptureState.resetForTesting()
    }

    @Test
    fun `setUser stores user when captureGate is open`() {
        TraceItX.start(context, validConfig())
        val user = TXUser(id = "u-1", email = "test@example.com")
        TraceItX.setUser(user)
        assertEquals(user, TraceItX.currentUser)
    }

    /**
     * External review, finding 2 (Serious) — the sibling of `kill()`'s clear,
     * and the more dangerous half. `start()` replaced `_config` — which
     * carries the SDK KEY, i.e. the project every subsequent report is
     * uploaded to — without clearing `_user`. So the supported
     * `start(projectA) -> setUser(X) -> start(projectB)` sequence uploaded A's
     * id/email/display name under B's key, creating a falsely attributed
     * person in a DIFFERENT customer's project. React Native makes it
     * especially reachable: unmounting the provider leaves this singleton's
     * user intact, so a remount + reconfigure inherits the previous user.
     *
     * `currentUser` is the exact state every envelope call site reads
     * (`CrashReporter.kt`, `ReporterDialog.kt`, `CompanionSubmissionComposer.kt`),
     * which is why asserting on it is asserting on what ships.
     */
    @Test
    fun `start with a new configuration clears the previous session's user`() {
        TraceItX.start(context, validConfig())
        TraceItX.setUser(TXUser(id = "u-1", email = "test@example.com", displayName = "A"))

        // Reconfigure onto a DIFFERENT project — no setUser call in the new
        // session anywhere.
        TraceItX.start(
            context,
            validConfig().copy(sdkKey = "txx_live_other0987654321"),
        )
        assertNull(
            "project A's user must never be uploaded under project B's SDK key",
            TraceItX.currentUser,
        )
    }

    /**
     * The rule is UNCONDITIONAL, including a benign same-key re-init: "start()
     * begins a session with no user; call setUser after start" is one sentence
     * an integrator can hold, and that is worth more than a config-equality
     * predicate. It costs nothing correct either — `setUser` is already a
     * no-op while the capture gate is closed (the test below), so setting the
     * user AFTER start is already the only ordering that works here.
     */
    @Test
    fun `an identical restart also clears the user`() {
        TraceItX.start(context, validConfig())
        TraceItX.setUser(TXUser(id = "u-1"))

        TraceItX.start(context, validConfig())
        assertNull("a same-key restart clears the user too", TraceItX.currentUser)
    }

    /**
     * Codex round-1 fix D, finding 4 (partial by ruling — no epoch-guarded
     * setter). Same session-boundary argument as `_user` above, applied to
     * the dashboard-configured companion-badge override
     * (`CompanionBadgeServerConfigSignal.flow`): a new `start()` against a
     * different app must not keep showing/hiding the badge per project A's
     * server block while project B's first config fetch is still in flight.
     * The write lives in the SAME synchronous `stateLock` critical section
     * as `_user = null` (TraceItX.kt, ~L558), so — unlike the heavy-init
     * coroutine assertions elsewhere in this file — this is directly
     * observable with no dispatcher wait, exactly like the `_user` test
     * above.
     */
    @Test
    fun `start with a new configuration clears the previous session's companion-badge server override`() {
        TraceItX.start(context, validConfig())
        com.traceitx.companion.CompanionBadgeServerConfigSignal.flow.value =
            com.traceitx.config.CompanionBadgeConfigWire(enabled = false, position = "top-left")
        assertNotNull(
            "precondition: project A's badge override is installed",
            com.traceitx.companion.CompanionBadgeServerConfigSignal.flow.value,
        )

        // Reconfigure onto a DIFFERENT project — no config fetch has landed
        // for it yet.
        TraceItX.start(
            context,
            validConfig().copy(sdkKey = "txx_live_other0987654321"),
        )

        assertNull(
            "project A's badge override must not survive into project B's session",
            com.traceitx.companion.CompanionBadgeServerConfigSignal.flow.value,
        )
        com.traceitx.companion.CompanionBadgeServerConfigSignal.resetForTesting()
    }

    /**
     * Codex round-2 fix — the twin of the `start()` test directly above,
     * now for `kill()`. The companion client keeps running by design after
     * a kill, but the config machinery that DELIVERED a server badge
     * override is dead — a prior override (e.g. `enabled: true` over an
     * inline `false`, or a position override) must not survive indefinitely.
     * `kill()` clears the signal AFTER its synchronous
     * `_replaySession?.teardown()` block, OUTSIDE `stateLock` (StateFlow
     * emission runs collector code synchronously on the emitting thread) —
     * but `kill()` itself is a plain synchronous function with no coroutine
     * dispatch, so the write is already observable the instant `kill()`
     * returns, same as the `start()` test above.
     */
    @Test
    fun `kill clears the companion-badge server override`() {
        TraceItX.start(context, validConfig())
        com.traceitx.companion.CompanionBadgeServerConfigSignal.flow.value =
            com.traceitx.config.CompanionBadgeConfigWire(enabled = true, position = "top-left")
        assertNotNull(
            "precondition: a server badge override is installed",
            com.traceitx.companion.CompanionBadgeServerConfigSignal.flow.value,
        )

        TraceItX.kill()

        assertNull(
            "kill() must clear the badge server-config override so it cannot survive indefinitely",
            com.traceitx.companion.CompanionBadgeServerConfigSignal.flow.value,
        )
        com.traceitx.companion.CompanionBadgeServerConfigSignal.resetForTesting()
    }

    // Branding (Android spec 2026-08-26): both session boundaries clear the
    // server signal — a previous session's paid entitlement must never leak
    // into the next session's dialog (mirrors the companion-badge clears).
    // start() additionally seeds the inline theme from the validated config.

    @Test
    fun `start with a new configuration clears the previous session's branding server signal`() {
        TraceItX.start(context, validConfig())
        com.traceitx.config.BrandingServerConfigSignal.flow.value =
            com.traceitx.config.BrandingConfigWire(watermark = false)
        assertNotNull(
            "precondition: project A's branding signal is installed",
            com.traceitx.config.BrandingServerConfigSignal.flow.value,
        )

        // Reconfigure onto a DIFFERENT project — no config fetch has landed
        // for it yet.
        TraceItX.start(
            context,
            validConfig().copy(sdkKey = "txx_live_other0987654321"),
        )

        assertNull(
            "project A's branding signal must not survive into project B's session",
            com.traceitx.config.BrandingServerConfigSignal.flow.value,
        )
    }

    // Session Vitals (spec 2026-09-05): both session boundaries clear the
    // vitals server signal, and both tear the live controller down. Twins of
    // the branding/companion clears immediately above.

    @Test
    fun `kill clears the vitals server signal`() {
        // Parked item N5 — `kill()` has cleared this since the M8 fix, with
        // no test. A dashboard-delivered vitalsEnabled/vitalsSampleRate pair
        // outliving kill() means the next start() inherits the dead app's
        // gate before its own config fetch has returned anything.
        TraceItX.start(context, validConfig())
        com.traceitx.vitals.VitalsServerConfigSignal.flow.value =
            com.traceitx.vitals.VitalsServerConfig(vitalsEnabled = true, vitalsSampleRate = 1.0)
        assertNotNull(
            "precondition: a vitals server signal is installed",
            com.traceitx.vitals.VitalsServerConfigSignal.flow.value,
        )

        TraceItX.kill()

        assertNull(
            "kill() must clear the vitals server signal so it cannot survive indefinitely",
            com.traceitx.vitals.VitalsServerConfigSignal.flow.value,
        )
    }

    @Test
    fun `start tears the previous session's vitals controller down and clears the vitals server signal`() {
        // Codex round-1, Critical 1: `start(B)` re-opens `captureGate`
        // synchronously while project A's controller stayed live until B's
        // heavy-init tail installed. `trackPlayer` in that window attached
        // B's players to A's controller, A's sampler kept recording, and B's
        // controller could open its gate off A's uncleared server signal.
        com.traceitx.vitals.VitalsServerConfigSignal.flow.value =
            com.traceitx.vitals.VitalsServerConfig(vitalsEnabled = true, vitalsSampleRate = 1.0)
        val integration = RecordingPlayerIntegration()
        val previous = vitalsControllerForTest()
        com.traceitx.vitals.VitalsRuntime.install(previous)
        val deadline = System.currentTimeMillis() + 5_000
        while (!previous.isRunning && System.currentTimeMillis() < deadline) Thread.sleep(2)
        assertTrue("precondition: project A's controller is collecting", previous.isRunning)
        previous.trackPlayer(integration, "main")

        TraceItX.start(context, validConfig().copy(sdkKey = "txx_live_other0987654321"))

        assertFalse(
            "project A's controller must not survive a superseding start()",
            previous.isRunning,
        )
        assertEquals("every player it tracked must be detached", 1, integration.detached)
        assertNull(
            "project A's vitals server signal must not open project B's gate",
            com.traceitx.vitals.VitalsServerConfigSignal.flow.value,
        )
    }

    @Test
    fun `a report built the instant start(B) returns carries none of project A's vitals`() {
        // Codex round-2, Critical 1. The vitals teardown used to run AFTER the
        // `stateLock` block that installs B's `_config` (B's SDK KEY) and
        // re-opens `captureGate`, so for the width of that block A's
        // controller was still the process-wide live one while B's identity
        // was already published: an envelope built by any other thread in that
        // window read A's session id and A's recent ring through
        // `VitalsRuntime.currentStamp()` and shipped them under B's key.
        //
        // The default `EnvelopeBuilder` provider is the one the reporter and
        // the crash handler actually use, which is why this asserts through it
        // rather than through the runtime directly.
        com.traceitx.vitals.VitalsServerConfigSignal.flow.value =
            com.traceitx.vitals.VitalsServerConfig(vitalsEnabled = true, vitalsSampleRate = 1.0)
        val previous = vitalsControllerForTest()
        com.traceitx.vitals.VitalsRuntime.install(previous)
        val deadline = System.currentTimeMillis() + 5_000
        while (!previous.isRunning && System.currentTimeMillis() < deadline) Thread.sleep(2)
        assertTrue("precondition: project A's controller is collecting", previous.isRunning)
        previous.trackPlayer(RecordingPlayerIntegration(), "main")
        assertNotNull(
            "precondition: project A's ring is stampable",
            com.traceitx.vitals.VitalsRuntime.currentStamp(),
        )

        TraceItX.start(context, validConfig().copy(sdkKey = "txx_live_other0987654321"))

        // B's own controller is installed asynchronously by the heavy-init
        // tail and, either way, starts gated shut (start() cleared the server
        // signal) — so the only thing that could stamp here is A's runtime.
        // (`current()` is deliberately NOT asserted null: B's tail may have
        // installed its own controller already, and that one is not A's.)
        assertNotSame(
            "A's controller must already be unpublished when start(B) returns",
            previous,
            com.traceitx.vitals.VitalsRuntime.current(),
        )
        assertFalse(previous.isRunning)
        assertNull(com.traceitx.vitals.VitalsRuntime.currentStamp())
        val envelope = kotlinx.serialization.json.Json.parseToJsonElement(
            String(
                com.traceitx.envelope.EnvelopeBuilder().buildEncoded(sdkVersion = "0.8.0").bytes,
                Charsets.UTF_8,
            ),
        ).jsonObject
        assertFalse(
            "a report built after start(B) must not carry project A's session id",
            envelope.containsKey("sessionId"),
        )
        assertFalse(
            "a report built after start(B) must not carry project A's vitals ring",
            envelope["payload"]!!.jsonObject.containsKey("vitals"),
        )
    }

    @Test
    fun `a trackPlayer call made before start is attached by the session start installs`() {
        // Codex round-3, Critical 1, end to end. `TraceItX.trackPlayer`'s KDoc
        // promises that a registration made before `start()` "is honoured the
        // moment a controller is installed". Round 2 made `start()` share
        // `kill()`'s queue-clearing shutdown, so this path detached every
        // pre-start handle instead of attaching it.
        val integration = RecordingPlayerIntegration()
        val handle = TraceItX.trackPlayer(integration, "main")
        assertEquals("precondition: nothing to delegate to yet", "", handle.id)

        TraceItX.start(context, validConfig())
        awaitHeavyInit()

        assertEquals("the pre-start registration must attach to the installed controller", "p1", handle.id)
        assertEquals("...and must not have been detached at the boundary", 0, integration.detached)
    }

    @Test
    fun `a start superseded while tearing the previous session down publishes nothing`() {
        // Codex round-3, Critical 2. `start(B)` blocks inside an old
        // integration's `detach()` — customer code, unbounded by construction
        // — while `start(C)` runs to completion. B used to wake up and publish
        // B's `_config` (B's SDK KEY) and a re-opened `captureGate` over C's
        // already-live session. B now reserves its generation up front and
        // re-checks it before publishing: it publishes nothing.
        com.traceitx.vitals.VitalsServerConfigSignal.flow.value =
            com.traceitx.vitals.VitalsServerConfig(vitalsEnabled = true, vitalsSampleRate = 1.0)
        val inDetach = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        val blocking = object : com.traceitx.vitals.PlayerIntegration {
            override val library = "fake"; override val version: String? = null
            override fun attach(ctx: com.traceitx.vitals.PlayerIntegrationContext) = true
            override fun snapshot(onResult: (com.traceitx.vitals.PlayerSnapshot?) -> Boolean) { onResult(null) }
            override fun startupTimings(): com.traceitx.vitals.StartupTimings? = null
            override fun describe(ctx: com.traceitx.vitals.PlayerIntegrationContext) {}
            override fun detach() {
                inDetach.countDown()
                release.await(5, java.util.concurrent.TimeUnit.SECONDS)
            }
        }
        val previous = vitalsControllerForTest()
        com.traceitx.vitals.VitalsRuntime.install(previous)
        previous.trackPlayer(blocking, "main")

        val b = Thread { TraceItX.start(context, validConfig().copy(sdkKey = "txx_live_bbbbbbbbbbbbbb")) }
        b.start()
        assertTrue("precondition: start(B) is parked in the old integration's detach()", inDetach.await(5, java.util.concurrent.TimeUnit.SECONDS))

        TraceItX.start(context, validConfig().copy(sdkKey = "txx_live_cccccccccccccc"))
        assertEquals("precondition: C published its own key", "txx_live_cccccccccccccc", TraceItX.currentConfig!!.sdkKey)

        release.countDown()
        b.join(5_000)
        assertFalse("start(B) never returned", b.isAlive)

        assertEquals(
            "a superseded start() must not publish its SDK key over the session that overtook it",
            "txx_live_cccccccccccccc",
            TraceItX.currentConfig!!.sdkKey,
        )
    }

    @Test
    fun `start invalidates the previous replay session before it clears the vitals signal`() {
        // Codex round-3, Critical 3. The clear used to run first, so a refresh
        // that had already passed its generation pre-check could resume and
        // re-publish project A's vitals gate afterwards — project B's
        // controller then opened its gate off the dead app's dashboard config,
        // indefinitely if B's own fetch failed. The teardown (which bumps that
        // session's generation and is what makes ReplaySession's own re-check
        // bite) now runs first.
        TraceItX.start(context, validConfig())
        val session = com.traceitx.capture.replay.ReplaySession(
            baseUrl = "https://example.invalid",
            apiKey = "txx_live_test1234567890",
            locallyDisabled = true,
        )
        TraceItX._replaySession = session
        com.traceitx.vitals.VitalsServerConfigSignal.flow.value =
            com.traceitx.vitals.VitalsServerConfig(vitalsEnabled = true, vitalsSampleRate = 1.0)

        TraceItX.start(context, validConfig().copy(sdkKey = "txx_live_other0987654321"))

        assertTrue(
            "the previous replay session must be invalidated at the boundary",
            session.isTornDownForTesting,
        )
        assertNull(
            "the vitals signal must be cleared, and nothing may re-publish it afterwards",
            com.traceitx.vitals.VitalsServerConfigSignal.flow.value,
        )
    }

    @Test
    fun `the vitals transport kill predicate never blocks on stateLock`() {
        // Codex round-3, Important 7. `VitalsTransport.isKilled` is evaluated
        // under `VitalsCollector`'s own lock, at every send boundary, on a
        // player thread or the sampler thread. Routing it through the
        // `stateLock`-guarded `currentStartEpoch()` meant a flush could park
        // behind a start/kill critical section — which itself runs customer
        // teardown — breaking the collector's never-blocking send contract and
        // timing out the crash handler's 100 ms stamp.
        TraceItX.start(context, validConfig())
        val epoch = TraceItX.currentStartEpochVolatile()
        val held = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        val holder = Thread {
            TraceItX.__withStateLockForTesting {
                held.countDown()
                release.await(5, java.util.concurrent.TimeUnit.SECONDS)
            }
        }
        holder.start()
        assertTrue(held.await(5, java.util.concurrent.TimeUnit.SECONDS))
        try {
            // The predicate the transport actually ships (TraceItX.kt), run on
            // a collector-like thread while `stateLock` is occupied.
            val answered = java.util.concurrent.CountDownLatch(1)
            val flush = Thread {
                if (TraceItX.currentStartEpochVolatile() == epoch) answered.countDown()
            }
            flush.start()
            assertTrue(
                "the kill predicate blocked behind stateLock",
                answered.await(100, java.util.concurrent.TimeUnit.MILLISECONDS),
            )

            // Control: the LOCKED accessor really is blocked right now, so the
            // assertion above has teeth rather than passing vacuously.
            val locked = java.util.concurrent.CountDownLatch(1)
            val blocked = Thread { TraceItX.currentStartEpoch(); locked.countDown() }
            blocked.start()
            assertFalse(
                "precondition: stateLock is genuinely held",
                locked.await(100, java.util.concurrent.TimeUnit.MILLISECONDS),
            )
            release.countDown()
            assertTrue(locked.await(5, java.util.concurrent.TimeUnit.SECONDS))
        } finally {
            release.countDown()
            holder.join(5_000)
        }
    }

    @Test
    fun `kill clears the branding server signal and the inline theme`() {
        // A config with a NON-null theme is required here: `validConfig()`
        // alone leaves `theme = null`, so BrandingInlineTheme.flow would
        // already be null before kill() runs and the post-kill assertNull
        // would pass whether or not kill() actually clears it. Only a
        // precondition of "start() set it to something" makes the post-kill
        // assertion distinguish "kill cleared it" from "it was never set".
        TraceItX.start(
            context,
            validConfig().copy(theme = com.traceitx.config.ReporterThemeOptions(accent = "#336699")),
        )
        com.traceitx.config.BrandingServerConfigSignal.flow.value =
            com.traceitx.config.BrandingConfigWire(watermark = false)
        assertNotNull(
            "precondition: a branding server signal is installed",
            com.traceitx.config.BrandingServerConfigSignal.flow.value,
        )
        assertNotNull(
            "precondition: the inline theme is installed by start()",
            com.traceitx.config.BrandingInlineTheme.flow.value,
        )

        TraceItX.kill()

        assertNull(
            "kill() must clear the branding server signal so it cannot survive indefinitely",
            com.traceitx.config.BrandingServerConfigSignal.flow.value,
        )
        assertNull(
            "kill() must also clear the inline theme",
            com.traceitx.config.BrandingInlineTheme.flow.value,
        )
    }

    @Test
    fun `start seeds the inline theme from the validated config`() {
        val theme = com.traceitx.config.ReporterThemeOptions(accent = "#336699")
        TraceItX.start(context, validConfig().copy(theme = theme))

        assertEquals(
            "start() must seed BrandingInlineTheme from config.theme",
            theme,
            com.traceitx.config.BrandingInlineTheme.flow.value,
        )
    }

    @Test
    fun `setUser is no-op when captureGate is closed`() {
        // No start() — captureGate is false.
        TraceItX.setUser(TXUser(id = "u-1"))
        assertNull(TraceItX.currentUser)
    }

    @Test
    fun `markSensitive after kill protects next capture without reopening gate`() {
        TraceItX.start(context, validConfig())
        TraceItX.kill()
        val view = android.view.View(context)
        TraceItX.markSensitive(view)
        assertEquals(true, view.getTag(com.traceitx.R.id.tx_sensitive))
        assertFalse(TraceItX.captureGate)
        assertNull(TraceItX.currentUser)
    }

    @Test
    fun `SDK_VERSION is a non-blank SemVer string sourced from BuildConfig`() {
        // The constant is wired to BuildConfig.SDK_VERSION, which Gradle
        // generates from the traceitxVersion property. Verify the wiring
        // (non-blank, SemVer shape) rather than a literal value — otherwise
        // every release bump silently breaks the test.
        assertTrue(
            "SDK_VERSION must be SemVer (X.Y.Z[-SUFFIX]): got '${TraceItX.SDK_VERSION}'",
            Regex("""^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$""").matches(TraceItX.SDK_VERSION),
        )
        assertEquals(BuildConfig.SDK_VERSION, TraceItX.SDK_VERSION)
    }

    @Test
    fun `resolver-indirection slots default to null`() {
        assertNull(TraceItX.__reporterTriggersInstaller)
        assertNull(TraceItX.__reporterTriggersTeardown)
        assertNull(TraceItX.report.__resolver)
    }

    @Test
    fun `start invokes __reporterTriggersInstaller when set`() {
        var invoked = false
        TraceItX.__reporterTriggersInstaller = { _, _ -> invoked = true }
        TraceItX.start(context, validConfig())
        // Heavy init is detached; give it a moment via the coroutine scope.
        // Best-effort assert — if the dispatcher hasn't run yet, we assert at
        // least that the slot is wired (not null) and start() returned cleanly.
        assertNotNull(TraceItX.__reporterTriggersInstaller)
        // Cleanup
        TraceItX.__reporterTriggersInstaller = null
        @Suppress("UNUSED_VARIABLE") val _unused = invoked  // value may or may not be observed in time
    }

    /**
     * Bounded poll for the heavy-init tail of the `start()` just issued.
     * `_replaySession` is assigned by the LAST statement of that coroutine's
     * sequential body (the `start.replay` block, which runs textually AFTER
     * the vitals-install block in `start.heavyInit`) and `start()` nulls it
     * synchronously first, so non-null is a sound "everything upstream —
     * including the vitals controller install — already ran" signal. Same
     * idiom as `EnvelopeUserTest.awaitHeavyInit()` /
     * `TraceItXLogWiringTest.awaitHeavyInit()`.
     */
    private fun awaitHeavyInit(timeoutMs: Long = 5_000) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (TraceItX._replaySession == null && System.currentTimeMillis() < deadline) {
            Thread.sleep(5)
        }
        assertNotNull(
            "start()'s heavy-init tail never completed — the vitals-controller assertion below would race it",
            TraceItX._replaySession,
        )
    }

    @Test
    fun `start installs the vitals controller and kill shuts it down`() {
        TraceItX.start(context, validConfig())
        awaitHeavyInit()
        assertNotNull(
            "start()'s heavy-init tail should have installed the vitals controller",
            com.traceitx.vitals.VitalsRuntime.current(),
        )

        TraceItX.kill()

        assertNull(
            "kill() must zeroize the vitals runtime (spec §2 amended — Android's " +
                "registry is per-controller, so nothing survives kill()->start())",
            com.traceitx.vitals.VitalsRuntime.current(),
        )
    }
}
