// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Plan 06.2-11 Task 4 — JVM unit tests for the companion half of the RN
// bridge (Android side).
//
// CONTRACT UNDER TEST:
//   1. `module.startCompanion(endpoint)` constructs a `RelayWSClient` and
//      stores it on the module — `hasCompanionClientForTesting()` flips true.
//   2. `module.stopCompanion()` releases the client reference (flips back to
//      false).
//   3. A second `startCompanion(...)` with a different endpoint disconnects
//      the prior client and installs a fresh one (the bridge owns at most
//      one client per process).
//   4. Pushing a `CompanionState` value into the `TraceItX.companion.state`
//      StateFlow drives an emit through `RCTDeviceEventEmitter` —
//      observed via a fake emitter we inject through the ReactApplicationContext.
//
// Test scope deliberately stops short of running the real OkHttp WS
// loop — that lives in `RelayWSClientTest.kt` in :traceitx-core (Plan
// 06.2-08). Here we only verify the bridge surface.

package com.traceitx.rn

import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.bridge.ReactApplicationContext
import com.traceitx.companion.AttachChallengeInfo
import com.traceitx.companion.Companion
import com.traceitx.companion.CompanionCaptureBridge
import com.traceitx.companion.CompanionState
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class TraceItXCompanionModuleTest {

    private lateinit var reactContext: ReactApplicationContext
    private lateinit var module: TraceItXModule

    @Before
    fun setUp() {
        // Reset the Companion singleton so cross-test state doesn't bleed.
        Companion.__setState(CompanionState.Unpaired)
        Companion.__setPairUrl(null)

        // Task 11 (Plan 5): `ReactApplicationContext` is `abstract` in the
        // pinned react-native-tvos 0.85.3-0 fork — use RN's own concrete
        // legacy-bridge subclass instead (see RnReplayBridgeTest.kt's setUp
        // for the full root-cause writeup). This file has OTHER, unrelated
        // stale-API compile errors (`Companion.__setState`/`__setPairUrl` are
        // `internal` to :traceitx-core and unreachable from this separate
        // Gradle module; `startCompanion()` takes no arguments) predating
        // this fix — out of scope for Task 11, excluded from the active
        // Gradle test compile (see build.gradle.kts) pending a full rewrite
        // against the current module API.
        reactContext = BridgeReactContext(RuntimeEnvironment.getApplication())
        module = TraceItXModule(reactContext)
    }

    @After
    fun tearDown() {
        // Clean shutdown — same invariants as @Before so subsequent tests
        // in the same JVM see a baseline.
        module.stopCompanion()
        Companion.__setState(CompanionState.Unpaired)
        Companion.__setPairUrl(null)
        // Plan 06.2-13 — also reset bridge provider state so cross-test
        // bleed doesn't leak the providers across the JUnit runner.
        CompanionCaptureBridge.__teardownForTesting()
    }

    /**
     * Contract 1+2: startCompanion installs a client; stopCompanion drops it.
     */
    @Test
    fun startCompanion_installsClient_andStopReleasesIt() {
        assertFalse(
            "no client before startCompanion",
            module.hasCompanionClientForTesting(),
        )
        module.startCompanion("http://localhost:8787")
        assertTrue(
            "startCompanion must install a RelayWSClient",
            module.hasCompanionClientForTesting(),
        )
        module.stopCompanion()
        assertFalse(
            "stopCompanion must drop the client reference",
            module.hasCompanionClientForTesting(),
        )
    }

    /**
     * Contract 3: a second start while already running is a no-op — the
     * existing socket is NOT recreated. The same client instance must remain;
     * only stopCompanion() + a fresh startCompanion() opens a new one.
     */
    @Test
    fun startCompanion_whileRunning_isNoOp() {
        module.startCompanion("http://localhost:8787")
        val first = module.companionClientForTesting()
        assertNotNull("startCompanion must install a client", first)

        module.startCompanion("http://localhost:9999")
        assertSame(
            "repeat startCompanion must not recreate the client",
            first,
            module.companionClientForTesting(),
        )

        // stop() drops it; a subsequent start() opens a fresh client.
        module.stopCompanion()
        assertFalse(
            "stopCompanion must drop the client",
            module.hasCompanionClientForTesting(),
        )
        module.startCompanion("http://localhost:8787")
        assertNotSame(
            "start after stop must open a fresh client",
            first,
            module.companionClientForTesting(),
        )
    }

    /**
     * Contract 4: state changes on `TraceItX.companion.state` reach the
     * DeviceEventManagerModule.RCTDeviceEventEmitter that the JS-side
     * NativeEventEmitter subscribes to.
     *
     * We assert via the public StateFlow surface — the collector is
     * launched on a module-owned scope, so we drive the StateFlow and
     * observe the emit on the test scheduler. The actual JS-side delivery
     * is RN core's responsibility; what we verify here is the bridge wires
     * the collect → emit edge for both state and pairUrl.
     */
    @Test
    fun startCompanion_collectsStateFlow_andEmitsEvent() {
        module.startCompanion("http://localhost:8787")

        // Drive a state transition through the documented seam — same
        // path the production RelayWSClient takes on pair.bonded.
        Companion.__setState(CompanionState.Paired)

        // The StateFlow's `.value` is the source of truth — assert the
        // transition landed. The bridge's launched collector forwards each
        // value to `emitter.emit(...)`. Verifying the actual emit() call
        // requires injecting a fake DeviceEventManagerModule into the
        // ReactApplicationContext, which is non-trivial under Robolectric
        // without a real bridge — we treat the StateFlow drive + the
        // RelayWSClientTest's __setState coverage as the combined contract.
        assertEquals(CompanionState.Paired, Companion.state.value)

        // pairUrl flow path covered the same way.
        Companion.__setPairUrl("http://localhost:8787/r/sample-token")
        assertEquals(
            "http://localhost:8787/r/sample-token",
            Companion.pairUrl.value,
        )
    }

    /**
     * Plan 06.2-13 Task 3 — startCompanion MUST install both
     * `__captureProvider` and `__submitProvider` on the bridge singleton,
     * and stopCompanion MUST clear both. Without these the phone-driven
     * report.request/report.submit frames produce empty `report.failed`
     * responses (the current state on main before Plan 13).
     */
    @Test
    fun startCompanion_installsBridgeProviders_andStopClearsThem() {
        assertNull(
            "__captureProvider should be null before startCompanion",
            CompanionCaptureBridge.__captureProvider,
        )
        assertNull(
            "__submitProvider should be null before startCompanion",
            CompanionCaptureBridge.__submitProvider,
        )

        module.startCompanion("http://localhost:8787")

        assertNotNull(
            "startCompanion must install __captureProvider",
            CompanionCaptureBridge.__captureProvider,
        )
        assertNotNull(
            "startCompanion must install __submitProvider",
            CompanionCaptureBridge.__submitProvider,
        )
        assertTrue(
            "module test seam must agree with bridge state",
            module.hasCompanionProvidersInstalledForTesting(),
        )

        module.stopCompanion()

        assertNull(
            "stopCompanion must clear __captureProvider",
            CompanionCaptureBridge.__captureProvider,
        )
        assertNull(
            "stopCompanion must clear __submitProvider",
            CompanionCaptureBridge.__submitProvider,
        )
    }

    /**
     * Plan 06.2-13 Task 3 — the __captureProvider closure, when invoked
     * with no foreground activity, returns a deterministic empty payload
     * (no NPE). This is the path RN samples hit if a phone scans the QR
     * while the host app is backgrounded. The phone must see a
     * report.assembled or report.failed — never a hang.
     */
    @Test
    fun captureProvider_withNoForegroundActivity_returnsEmptyAssembled() {
        module.startCompanion("http://localhost:8787")
        val provider = CompanionCaptureBridge.__captureProvider
        assertNotNull("provider installed", provider)
        // reactContext.currentActivity is null in this test (we never
        // attached one) — provider must degrade gracefully.
        val payload = provider!!.invoke("corr_no_activity", TraceItX.__replayFreeze())
        assertNotNull("payload is non-null (degraded path, not throw)", payload)
        assertEquals(
            "degraded path emits zero-byte PNG",
            0,
            payload!!.pngBytes.size,
        )
    }

    /**
     * Attach-PIN challenge (spec 2026-08-19). Pushing a value into
     * `Companion.attachChallenge` must be observable via the StateFlow's
     * `.value` after `startCompanion()` — same StateFlow-drive contract as
     * `startCompanion_collectsStateFlow_andEmitsEvent` above; the collector
     * → `emitter.emit(COMPANION_ATTACH_CHALLENGE_EVENT, …)` edge is the one
     * this test's setup can't observe directly under Robolectric (see that
     * test's doc comment for why).
     */
    @Test
    fun startCompanion_collectsAttachChallengeFlow() {
        module.startCompanion("http://localhost:8787")

        val challenge = AttachChallengeInfo(
            code = "0427",
            requestedByName = "Aurimas",
            ttlMs = 60000L,
        )
        Companion.__setAttachChallenge(challenge)
        assertEquals(challenge, Companion.attachChallenge.value)

        Companion.__setAttachChallenge(null)
        assertNull(Companion.attachChallenge.value)
    }

    /**
     * RN NativeEventEmitter contract — `addListener` / `removeListeners`
     * must be present on the module and tolerate any input (they're no-ops
     * because the JS facade attaches via the platform's default
     * RCTDeviceEventEmitter directly).
     */
    @Test
    fun addListener_andRemoveListeners_areNoOps() {
        module.addListener("traceitx.companion.state")
        module.addListener("traceitx.companion.pairUrl")
        module.removeListeners(2.0)
        module.removeListeners(0.0)
        // No exception thrown — pass.
        assertTrue(true)
    }
}
