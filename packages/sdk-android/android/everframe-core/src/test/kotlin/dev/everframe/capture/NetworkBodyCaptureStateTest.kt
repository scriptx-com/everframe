// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// NetworkBodyCaptureState: server-authoritative body-capture gate with a
// one-shot sampling draw (CONFIG-04 parity — the draw happens AT MOST ONCE
// per process, on the first `applyConfig` where the server block says ON;
// later refreshes never re-draw, so a sampled-out session cannot flip in
// mid-session and a sampled-in session cannot flip out). Client veto
// (`locallyDisabled`) always wins — fail-closed: a null server block, a veto,
// or a sampled-out draw all yield `isActive == false`. No flag ever forces
// capture ON. Transliterated from
// packages/sdk-ios/Tests/EverframeTests/NetworkBodyCaptureGateTests.swift (Task 8).
package dev.everframe.capture

import dev.everframe.config.BreadcrumbsConfigWire
import dev.everframe.config.CaptureConfig
import dev.everframe.config.NetworkBodiesConfigWire
import dev.everframe.config.EverframeConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class NetworkBodyCaptureStateTest {

    @Before
    fun resetState() {
        NetworkBodyCaptureState.resetForTesting()
    }

    private fun wire(
        captureBodies: Boolean,
        bodyByteCap: Int? = null,
        bodyContentTypes: List<String>? = null,
        bodyTotalBudget: Int? = null,
    ) = NetworkBodiesConfigWire(
        captureBodies = captureBodies,
        bodyByteCap = bodyByteCap,
        bodyContentTypes = bodyContentTypes,
        bodyTotalBudget = bodyTotalBudget,
    )

    @Test
    fun `inactive by default`() {
        assertFalse(NetworkBodyCaptureState.isActive)
    }

    @Test
    fun `active when server on and sampled in`() {
        NetworkBodyCaptureState.applyConfig(
            wire(captureBodies = true), samplingRate = 0.5,
            locallyDisabled = false, random = { 0.4 },
        )
        assertTrue(NetworkBodyCaptureState.isActive)
    }

    @Test
    fun `sampled out stays out across refreshes`() {
        NetworkBodyCaptureState.applyConfig(
            wire(captureBodies = true), samplingRate = 0.5,
            locallyDisabled = false, random = { 0.9 }, // out
        )
        NetworkBodyCaptureState.applyConfig(
            wire(captureBodies = true), samplingRate = 0.5,
            locallyDisabled = false, random = { 0.0 }, // would be in — must NOT re-draw
        )
        assertFalse(NetworkBodyCaptureState.isActive)
    }

    @Test
    fun `client veto wins`() {
        NetworkBodyCaptureState.applyConfig(
            wire(captureBodies = true), samplingRate = 1.0,
            locallyDisabled = true, random = { 0.0 },
        )
        assertFalse(NetworkBodyCaptureState.isActive)
    }

    // ==================== Round-5 review Finding F22 ====================
    //
    // The privacy gate (spec §3) is:
    //     captureBodies = serverConfig.captureBodies
    //                   && capture.network == true
    //                   && capture.networkBodies != false
    //                   && sampledIn
    // §3.1's original "structural precondition" claim for `capture.network`
    // was wrong: `addEverframeInterceptor()` attaches [dev.everframe.okhttp.
    // EverframeInterceptor] unconditionally, never reading `capture.network`,
    // so a host leaving it at its default `false` still got metadata
    // capture — and, pre-fix, still got BODY capture whenever the server
    // block was ON. These specs drive
    // `NetworkBodyCaptureState.locallyDisabled()` (the fix) through the full
    // `applyConfig` composition, exactly like `client veto wins` above.
    // See `NetworkBodyCaptureTest.kt` for the Android-only interceptor-level
    // end-to-end companion of the first scenario.

    @Test
    fun `server on but capture network left at default false stays inactive`() {
        // `capture.network` defaults to false; `capture.networkBodies`
        // defaults to true (no explicit client veto) — the exact scenario a
        // host gets by leaving `CaptureConfig` untouched.
        val config = EverframeConfig(appId = "app", sdkKey = "key", capture = CaptureConfig.defaults)
        NetworkBodyCaptureState.applyConfig(
            wire(captureBodies = true), samplingRate = 1.0,
            locallyDisabled = NetworkBodyCaptureState.locallyDisabled(config), random = { 0.0 },
        )
        assertFalse(
            "capture.network left at its default false must keep bodies off even with server ON",
            NetworkBodyCaptureState.isActive,
        )
    }

    @Test
    fun `server on network true but networkBodies veto stays inactive`() {
        val config = EverframeConfig(
            appId = "app", sdkKey = "key",
            capture = CaptureConfig(network = true, networkBodies = false),
        )
        NetworkBodyCaptureState.applyConfig(
            wire(captureBodies = true), samplingRate = 1.0,
            locallyDisabled = NetworkBodyCaptureState.locallyDisabled(config), random = { 0.0 },
        )
        assertFalse(
            "existing networkBodies veto behavior must survive the F22 fix",
            NetworkBodyCaptureState.isActive,
        )
    }

    @Test
    fun `server on network true and networkBodies true becomes active`() {
        val config = EverframeConfig(
            appId = "app", sdkKey = "key",
            capture = CaptureConfig(network = true, networkBodies = true),
        )
        NetworkBodyCaptureState.applyConfig(
            wire(captureBodies = true), samplingRate = 1.0,
            locallyDisabled = NetworkBodyCaptureState.locallyDisabled(config), random = { 0.0 },
        )
        assertTrue(
            "the happy path (both flags opted in) must not be over-gated by the F22 fix",
            NetworkBodyCaptureState.isActive,
        )
    }

    @Test
    fun `null client config fails closed even with server on`() {
        NetworkBodyCaptureState.applyConfig(
            wire(captureBodies = true), samplingRate = 1.0,
            locallyDisabled = NetworkBodyCaptureState.locallyDisabled(null), random = { 0.0 },
        )
        assertFalse(
            "a null/absent client config (pre-start) must fail closed",
            NetworkBodyCaptureState.isActive,
        )
    }

    @Test
    fun `null block is fail closed`() {
        NetworkBodyCaptureState.applyConfig(
            null, samplingRate = 1.0, locallyDisabled = false, random = { 0.0 },
        )
        assertFalse(NetworkBodyCaptureState.isActive)
    }

    @Test
    fun `caps fall back to defaults`() {
        NetworkBodyCaptureState.applyConfig(
            wire(captureBodies = true), samplingRate = 1.0,
            locallyDisabled = false, random = { 0.0 },
        )
        assertEquals(8192, NetworkBodyCaptureState.bodyByteCap)
        assertEquals(listOf("application/json", "text/*"), NetworkBodyCaptureState.bodyContentTypes)
    }

    @Test
    fun `server caps apply`() {
        NetworkBodyCaptureState.applyConfig(
            wire(captureBodies = true, bodyByteCap = 4096, bodyContentTypes = listOf("application/json")),
            samplingRate = 1.0, locallyDisabled = false, random = { 0.0 },
        )
        assertEquals(4096, NetworkBodyCaptureState.bodyByteCap)
        assertEquals(listOf("application/json"), NetworkBodyCaptureState.bodyContentTypes)
    }

    @Test
    fun `reqIds are monotonic`() {
        val first = NetworkBodyCaptureState.mintReqId()
        val second = NetworkBodyCaptureState.mintReqId()
        assertTrue(first < second)
    }

    @Test
    fun `resetForTesting restores defaults`() {
        NetworkBodyCaptureState.applyConfig(
            wire(captureBodies = true, bodyByteCap = 4096), samplingRate = 1.0,
            locallyDisabled = false, random = { 0.0 },
        )
        NetworkBodyCaptureState.mintReqId()
        NetworkBodyCaptureState.resetForTesting()
        assertFalse(NetworkBodyCaptureState.isActive)
        assertEquals(8192, NetworkBodyCaptureState.bodyByteCap)
        assertEquals(listOf("application/json", "text/*"), NetworkBodyCaptureState.bodyContentTypes)
        assertEquals(1, NetworkBodyCaptureState.mintReqId())
    }

    // ==================== Round-6 review Finding F28 ====================
    //
    // Bodies are meaningless without a correlating SHIPPED network
    // breadcrumb (EnvelopeBuilder drops any `ref` with no matching crumb) —
    // `networkBodiesConfig.captureBodies` was independently toggleable from
    // `breadcrumbsConfig`, so a server config with bodies ON but breadcrumbs
    // OFF (or `kinds` omitting `network`) silently captured, then silently
    // dropped, every body. These specs drive
    // `NetworkBodyCaptureState.breadcrumbsExcludeNetwork()` through the full
    // `applyConfig` composition, exactly like the F22 specs above.

    private fun crumbs(
        enabled: Boolean,
        kinds: List<String> = listOf("console", "custom", "error", "lifecycle", "navigation", "network", "tap"),
    ) = BreadcrumbsConfigWire(
        enabled = enabled, kinds = kinds, maxCount = 100, byteBudget = 16384, consoleEntryCap = 1024,
    )

    @Test
    fun `server on but breadcrumbs disabled stays inactive`() {
        NetworkBodyCaptureState.applyConfig(
            wire(captureBodies = true), samplingRate = 1.0,
            locallyDisabled = NetworkBodyCaptureState.breadcrumbsExcludeNetwork(crumbs(enabled = false)),
            random = { 0.0 },
        )
        assertFalse(
            "breadcrumbs disabled must keep bodies off even with server ON",
            NetworkBodyCaptureState.isActive,
        )
    }

    @Test
    fun `server on but breadcrumb kinds omit network stays inactive`() {
        val noNetwork = crumbs(enabled = true, kinds = listOf("console", "custom", "error", "lifecycle", "navigation", "tap"))
        NetworkBodyCaptureState.applyConfig(
            wire(captureBodies = true), samplingRate = 1.0,
            locallyDisabled = NetworkBodyCaptureState.breadcrumbsExcludeNetwork(noNetwork),
            random = { 0.0 },
        )
        assertFalse(
            "breadcrumb kinds omitting 'network' must keep bodies off even with server ON",
            NetworkBodyCaptureState.isActive,
        )
    }

    @Test
    fun `server on breadcrumbs enabled with network kind becomes active`() {
        NetworkBodyCaptureState.applyConfig(
            wire(captureBodies = true), samplingRate = 1.0,
            locallyDisabled = NetworkBodyCaptureState.breadcrumbsExcludeNetwork(crumbs(enabled = true)),
            random = { 0.0 },
        )
        assertTrue(
            "the happy path (breadcrumbs on, network kind included) must not be over-gated by the F28 fix",
            NetworkBodyCaptureState.isActive,
        )
    }

    @Test
    fun `absent breadcrumbs block matches BreadcrumbRingBuffer default and stays active`() {
        // BreadcrumbRingBuffer.applyConfig(null) defaults to enabled + all 7
        // kinds (including `network`) — an unconfigured breadcrumbs block
        // must NOT disable bodies, matching that exact default.
        NetworkBodyCaptureState.applyConfig(
            wire(captureBodies = true), samplingRate = 1.0,
            locallyDisabled = NetworkBodyCaptureState.breadcrumbsExcludeNetwork(null),
            random = { 0.0 },
        )
        assertTrue(
            "an absent breadcrumbs block must not disable bodies",
            NetworkBodyCaptureState.isActive,
        )
    }

    @Test
    fun `breadcrumbsExcludeNetwork pure function`() {
        assertFalse(NetworkBodyCaptureState.breadcrumbsExcludeNetwork(null))
        assertTrue(NetworkBodyCaptureState.breadcrumbsExcludeNetwork(crumbs(enabled = false)))
        assertTrue(NetworkBodyCaptureState.breadcrumbsExcludeNetwork(crumbs(enabled = true, kinds = listOf("console"))))
        assertFalse(NetworkBodyCaptureState.breadcrumbsExcludeNetwork(crumbs(enabled = true)))
    }

    // ==================== Round-7 review Finding F34 ====================
    //
    // A remote `captureBodies: false` must be authoritative at the final
    // append/sink boundary, not just at the pre-`makeEntry` decision point.
    // These specs drive the generation counter itself; the buffer-side
    // enforcement (`NetworkBodyRingBuffer.append`'s `guard` parameter) is
    // covered in `NetworkBodyRingBufferTest.kt`, and the end-to-end
    // interceptor-level reproduction of the reviewer's probe lives in
    // `NetworkBodyCaptureTest.kt`.

    @Test
    fun `generation is stable across no-op applyConfig calls`() {
        val first = NetworkBodyCaptureState.snapshotActive().generation
        // Repeating the exact same inactive config must not bump the
        // generation — nothing about the effective `active` bit changed.
        NetworkBodyCaptureState.applyConfig(null, samplingRate = 1.0, locallyDisabled = false, random = { 0.0 })
        assertEquals(first, NetworkBodyCaptureState.snapshotActive().generation)
    }

    @Test
    fun `generation bumps on transition to active`() {
        val before = NetworkBodyCaptureState.snapshotActive().generation
        NetworkBodyCaptureState.applyConfig(
            wire(captureBodies = true), samplingRate = 1.0, locallyDisabled = false, random = { 0.0 },
        )
        assertTrue(NetworkBodyCaptureState.isActive)
        assertTrue(NetworkBodyCaptureState.snapshotActive().generation != before)
    }

    @Test
    fun `generation bumps on transition to inactive`() {
        NetworkBodyCaptureState.applyConfig(
            wire(captureBodies = true), samplingRate = 1.0, locallyDisabled = false, random = { 0.0 },
        )
        val whileActive = NetworkBodyCaptureState.snapshotActive().generation
        // Remote refresh flips the server block OFF — the exact F34 scenario.
        NetworkBodyCaptureState.applyConfig(
            wire(captureBodies = false), samplingRate = 1.0, locallyDisabled = false, random = { 0.0 },
        )
        assertFalse(NetworkBodyCaptureState.isActive)
        assertTrue(NetworkBodyCaptureState.snapshotActive().generation != whileActive)
    }

    @Test
    fun `generation does not bump when active stays true across refreshes`() {
        NetworkBodyCaptureState.applyConfig(
            wire(captureBodies = true), samplingRate = 1.0, locallyDisabled = false, random = { 0.0 },
        )
        val firstActive = NetworkBodyCaptureState.snapshotActive()
        // A second refresh that keeps the server block ON (e.g. just
        // changing bodyByteCap) must not invalidate an already-captured,
        // still-valid token.
        NetworkBodyCaptureState.applyConfig(
            wire(captureBodies = true, bodyByteCap = 4096), samplingRate = 1.0,
            locallyDisabled = false, random = { 0.0 },
        )
        val secondActive = NetworkBodyCaptureState.snapshotActive()
        assertTrue(secondActive.active)
        assertEquals(firstActive.generation, secondActive.generation)
    }

    @Test
    fun `isActiveForGeneration rejects a stale generation even when active again`() {
        NetworkBodyCaptureState.applyConfig(
            wire(captureBodies = true), samplingRate = 1.0, locallyDisabled = false, random = { 0.0 },
        )
        val staleGeneration = NetworkBodyCaptureState.snapshotActive().generation

        // Flip OFF then back ON — a NEW generation, even though `active`
        // ends up true again exactly like it started.
        NetworkBodyCaptureState.applyConfig(null, samplingRate = 1.0, locallyDisabled = false, random = { 0.0 })
        NetworkBodyCaptureState.applyConfig(
            wire(captureBodies = true), samplingRate = 1.0, locallyDisabled = false, random = { 0.0 },
        )
        assertTrue(NetworkBodyCaptureState.isActive)
        assertFalse(
            "a token captured before an OFF/ON cycle must not validate against the new cycle's generation",
            NetworkBodyCaptureState.isActiveForGeneration(staleGeneration),
        )
        assertTrue(NetworkBodyCaptureState.isActiveForGeneration(NetworkBodyCaptureState.snapshotActive().generation))
    }

    @Test
    fun `reset bumps generation unconditionally`() {
        // State never activated — `active` is false both before and after
        // `reset()` — but reset() is itself a session boundary and must
        // still invalidate any token captured before it.
        val before = NetworkBodyCaptureState.snapshotActive().generation
        NetworkBodyCaptureState.reset()
        assertTrue(NetworkBodyCaptureState.snapshotActive().generation != before)
        assertFalse(NetworkBodyCaptureState.isActiveForGeneration(before))
    }

    // ==================== Final-review Finding 3 (process-lifetime sampling) ====================

    /**
     * `sampleDraw` was only ever cleared by the test-only `resetForTesting()`
     * — a production kill()/start() cycle reused the OLD process's draw even
     * though a new session (possibly a new config/samplingRate) should get a
     * fresh one. This drives the production `reset()` seam directly: draw IN
     * at samplingRate 1.0, `reset()`, then re-apply with samplingRate 0
     * (which would draw OUT) and a `random` that would draw IN at any
     * nonzero rate — if the old draw were still sticky the gate would stay
     * active (wrongly). It must instead honor the fresh draw and go
     * inactive.
     */
    @Test
    fun `reset clears sticky sampling draw so a fresh session redraws`() {
        NetworkBodyCaptureState.applyConfig(
            wire(captureBodies = true), samplingRate = 1.0,
            locallyDisabled = false, random = { 0.0 }, // draws IN
        )
        assertTrue(NetworkBodyCaptureState.isActive)

        NetworkBodyCaptureState.reset()
        assertFalse(NetworkBodyCaptureState.isActive)

        NetworkBodyCaptureState.applyConfig(
            wire(captureBodies = true), samplingRate = 0.0,
            locallyDisabled = false, random = { 0.0 }, // would draw IN at any rate > 0
        )
        assertFalse("stale sticky draw must not survive reset()", NetworkBodyCaptureState.isActive)
    }
}
