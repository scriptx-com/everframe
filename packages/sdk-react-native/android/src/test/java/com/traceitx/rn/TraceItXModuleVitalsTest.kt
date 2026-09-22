// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// TraceItXModuleVitalsTest — Session Vitals (spec 2026-09-06), Android bridge
// glue. Two things are pinned here and nowhere else:
//
//   1. The five vitals methods are FAIL-SOFT. They are void and
//      fire-and-forget: an unknown token, a call before `configure()`, a
//      malformed payload — none of them may throw into the host's JS thread.
//      The core `RemotePlayerRegistry` owns validation (tested in
//      traceitx-core); this file proves the glue does not add a throw path of
//      its own on top of it.
//   2. The three flat `vitalsEnabled` / `vitalsSampleRate` /
//      `vitalsCaptureSourceQuery` ConfigOpts keys land on
//      `TraceItXConfig.vitals`, PRESENT-FIELDS-ONLY: an absent key must keep
//      `VitalsConfig`'s own default rather than being coerced to false/0.
//      Same class of wire-contract-string drift that
//      `TraceItXModuleConfigureTest` pins for the two veto flags — a typo in
//      the key name here would silently ignore the host's opt-out.
//   3. `configure()` is IDEMPOTENT (codex round-5 G2, corrected in round-6 H1): a repeat call
//      that would install the config the SDK is ALREADY RUNNING does not run
//      `TraceItX.start(...)` again — a start SUPERSEDES the running SDK and detaches every
//      player integration it had announced, which is a wildly expensive answer to a Provider
//      that merely remounted with the same config. The gate is
//      `captureGate && currentConfig == config && stashed attachPinUi == parsed`, and all
//      three terms are pinned below — including the case round-5's cached snapshot got wrong,
//      where something ELSE started the SDK between two identical bridge configures.
//
// Lives beside `TraceItXModuleConfigureTest.kt` (and not in
// `TraceItXModuleTest.kt`) for the reason that file's header spells out:
// `TraceItXModuleTest.kt` is excluded from `compileDebugUnitTestKotlin` in
// `build.gradle.kts`, so tests added there would never compile or run.
package com.traceitx.rn

import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.bridge.JavaOnlyMap
import com.facebook.react.bridge.ReactApplicationContext
import com.traceitx.TraceItX
import com.traceitx.config.TraceItXConfig
import com.traceitx.vitals.RemotePlayerRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class TraceItXModuleVitalsTest {

    private lateinit var reactContext: ReactApplicationContext
    private lateinit var module: TraceItXModule

    @Before
    fun setUp() {
        // Mirrors TraceItXModuleConfigureTest.kt exactly: RN's concrete
        // legacy-bridge subclass (`ReactApplicationContext` is abstract on the
        // pinned react-native-tvos fork) over a Robolectric application.
        reactContext = BridgeReactContext(RuntimeEnvironment.getApplication())
        module = TraceItXModule(reactContext)
        TraceItX.kill() // known-closed baseline before each test
    }

    /**
     * Fail-soft contract. Every call below is made against a KILLED SDK and/or
     * an unregistered token — the two states a host can trivially reach (a
     * player event arriving after `kill()`, a hook whose attach was rejected
     * because the 32-token cap was hit). Reaching the end of the method
     * without a throw IS the assertion.
     */
    @Test
    fun `vitals methods are fail-soft before configure and with unknown tokens`() {
        module.recordPlayerEvent("nope", "play", 1.757e12, null)
        module.updatePlayerStats("nope", JavaOnlyMap.of("bufferAheadMs", 1.0))
        module.detachPlayer("nope")
        module.trackVitals("line", "[1]", null)
        module.trackPlayer("rp1", "react-native-video", "main", "7.0.0")
        module.recordPlayerEvent("rp1", "play", 1.757e12, JavaOnlyMap.of("x", 1.0))
        module.detachPlayer("rp1")
    }

    /**
     * All three fields present: each lands on `VitalsConfig` unchanged. Note
     * `vitalsEnabled = false` — the opt-out direction, the one a dropped key
     * would silently reverse.
     */
    @Test
    fun `configure maps the three flat vitals fields onto VitalsConfig`() {
        val opts = JavaOnlyMap.of(
            "apiKey", "tx_test_key",
            "vitalsEnabled", false,
            "vitalsSampleRate", 0.25,
            "vitalsCaptureSourceQuery", true,
        )
        module.configure(opts)
        val v = TraceItX.currentConfig!!.vitals
        assertEquals(false, v.enabled)
        assertEquals(0.25, v.sampleRate!!, 0.0)
        assertEquals(true, v.captureSourceQuery)
    }

    /**
     * No vitals fields at all (the common case — the host set no opinion):
     * `VitalsConfig`'s own defaults survive. Absent `enabled`/`sampleRate` stay
     * NULL, which is what "follow the dashboard toggle / server rate" means —
     * coercing them to `false`/`0.0` here would locally disable vitals for
     * every host that never mentioned them.
     */
    @Test
    fun `configure without vitals fields keeps SDK defaults`() {
        module.configure(JavaOnlyMap.of("apiKey", "tx_test_key"))
        val v = TraceItX.currentConfig!!.vitals
        assertEquals(null, v.enabled)
        assertEquals(null, v.sampleRate)
        assertEquals(false, v.captureSourceQuery)
    }

    /**
     * The JS-reload contract (branch review, round 1; amended by codex round-1
     * C5). RN tears the module instance down on a Metro/OTA reload; the
     * reloaded bundle re-mints tokens from a counter that restarts at `rp1`.
     * If `invalidate()` did not clear the registry, `track("rp1")` would be
     * refused as "already live" and every event from the new bundle would land
     * on the DEAD registration — while the old one kept accumulating
     * play/buffer time natively.
     *
     * WHERE `rp1` COMES BACK. It is on the NEW module instance's registry, not
     * the torn-down one's. C5 made `detachAll()` terminal — the old registry
     * closes for good, so an in-flight `track()` from the dead bundle (whose
     * `register()` was still running when the teardown landed) cannot slip a
     * registration in behind it. This test asserted the opposite before C5
     * (the same registry object accepting `rp1` again), which is the
     * expectation the ruling changed; the host-visible behaviour — a reloaded
     * bundle can re-mint every token — is unchanged, because the reload builds
     * a new module instance.
     *
     * The module's five methods are all void, so the registry's `Boolean`
     * verdict is not observable through them. We therefore read the module's
     * own `remotePlayers` field reflectively and call `track` on it directly:
     * that is the same object `module.trackPlayer(...)` forwards to, so a
     * `false` proves the module's call really registered the token. (The
     * core-side alternative isn't available: `PlayerRegistry` is `internal` to
     * traceitx-core and invisible from this Gradle module.)
     */
    @Test
    fun `invalidate closes this instance's registry and the reloaded bundle re-mints tokens on a new one`() {
        module.trackPlayer("rp1", "react-native-video", "main", "7.0.0")
        // Refused → the module's call did reach the registry and rp1 is live.
        assertFalse(registryOf(module).track("rp1", "react-native-video", null, null))

        module.invalidate()

        // Terminal: the torn-down instance's registry never revives.
        assertFalse(registryOf(module).track("rp1", "react-native-video", null, null))

        // Idempotent: a second teardown over an empty registry must not throw.
        module.invalidate()
        module.invalidate()

        // The reload's NEW module instance owns a NEW registry, and `rp1` is
        // free there — which is the contract the host actually depends on.
        val reloaded = TraceItXModule(reactContext)
        assertTrue(registryOf(reloaded).track("rp1", "react-native-video", null, null))
    }

    /**
     * Codex round-5 G2 / round-6 H1 — `configure()` is IDEMPOTENT: a second call that would
     * install the config the SDK is already running does NOT start it again.
     *
     * This replaces round-4's `configure renews the live registrations against the SDK it just
     * started`. That test pinned `renewAll()`, which is gone: codex showed it could race the
     * runtime's deferred-registration drain (detaching the very replacement it had installed)
     * and that it only ever covered ONE React instance's registry. The two-part replacement is
     * the gate below plus the JS configure epoch (`use-track-player.spec.tsx`), which re-runs
     * every vitals hook after a real restart so each one re-registers its own player.
     *
     * WHAT COUNTS AS THE OBSERVABLE START. `TraceItX.startEpochChanged`/`currentStartEpoch`
     * would be the direct signal, but both are `internal` to `traceitx-core` and therefore
     * invisible from this Gradle module. `TraceItX.currentConfig` is public and is set to the
     * exact `TraceItXConfig` INSTANCE each `start()` was handed, so object identity is a
     * faithful start counter: same object ⇒ no start ran, different object ⇒ one did.
     *
     * A fresh `JavaOnlyMap` per call on purpose — the gate must compare the option VALUES, not
     * the identity of the `ReadableMap` that carried them. (Round-6: it compares the built
     * `TraceItXConfig` against the installed one, so this holds by construction.)
     */
    @Test
    fun `configure twice with identical options starts the SDK once, a changed option restarts it`() {
        module.configure(JavaOnlyMap.of("apiKey", "tx_test_key", "vitalsSampleRate", 0.25))
        val first = TraceItX.currentConfig
        assertNotNull(first)
        assertTrue(TraceItX.captureGate)

        module.configure(JavaOnlyMap.of("apiKey", "tx_test_key", "vitalsSampleRate", 0.25))
        assertSame(first, TraceItX.currentConfig)          // no second start

        // A different `vitalsSampleRate` is a different configuration — that one must restart.
        module.configure(JavaOnlyMap.of("apiKey", "tx_test_key", "vitalsSampleRate", 0.5))
        val third = TraceItX.currentConfig
        assertNotSame(first, third)
        assertEquals(0.5, third!!.vitals.sampleRate!!, 0.0)
    }

    /**
     * The gate is `captureGate && snapshot matches` — the gate half matters on its own. After a
     * `kill()` the SDK is closed, so a configure with byte-identical options must START it
     * rather than skip, or the host is left with a dead SDK and no way to revive it.
     */
    @Test
    fun `configure after kill starts again even though the options did not change`() {
        module.configure(JavaOnlyMap.of("apiKey", "tx_test_key"))
        val first = TraceItX.currentConfig
        assertNotNull(first)

        TraceItX.kill()
        assertFalse(TraceItX.captureGate)

        module.configure(JavaOnlyMap.of("apiKey", "tx_test_key"))
        assertNotSame(first, TraceItX.currentConfig)
        assertTrue(TraceItX.captureGate)
    }

    /**
     * Codex round-6, H1 — the gate must read the INSTALLED config, never a cache of the last
     * options this bridge started with.
     *
     * Round-5 cached a snapshot of the options and compared the next configure against it. That
     * cache can disagree with the singleton it claims to describe: a native host (or a second
     * React instance, or two overlapping configures interleaving) starts `TraceItX` with a
     * different config in between, and the next configure — whose OPTIONS have not changed —
     * matches its own stale snapshot, skips the start, and leaves the other config installed
     * under a JS host that believes it configured its own. Comparing against
     * `TraceItX.currentConfig` cannot drift: it IS the installed state.
     *
     * `currentConfig` identity is the start counter, as in the test above.
     */
    @Test
    fun `a start under the bridge is noticed - an unchanged configure restarts the SDK`() {
        module.configure(JavaOnlyMap.of("apiKey", "tx_test_key"))
        val first = TraceItX.currentConfig
        assertNotNull(first)

        // Straight at the singleton, exactly as a native host's own start would arrive.
        val other = TraceItXConfig(appId = "tx_other_key", sdkKey = "tx_other_key", release = "9.9.9")
        TraceItX.start(RuntimeEnvironment.getApplication(), other)
        assertSame(other, TraceItX.currentConfig)

        module.configure(JavaOnlyMap.of("apiKey", "tx_test_key"))
        assertNotSame(other, TraceItX.currentConfig)
        assertEquals("tx_test_key", TraceItX.currentConfig!!.appId)
    }

    /**
     * The third gate term. `attachPinUi` is the one bridge option that lands in MODULE state
     * rather than in `TraceItXConfig`, so config equality alone is blind to it changing — and a
     * host that switches to its own attach-PIN UI would have gone on getting the built-in one.
     */
    @Test
    fun `a changed attachPinUi restarts even though the TraceItXConfig is identical`() {
        module.configure(JavaOnlyMap.of("apiKey", "tx_test_key", "attachPinUi", "custom"))
        val first = TraceItX.currentConfig
        assertNotNull(first)

        // Same call again: identical config AND identical stashed mode — no start.
        module.configure(JavaOnlyMap.of("apiKey", "tx_test_key", "attachPinUi", "custom"))
        assertSame(first, TraceItX.currentConfig)

        // Dropping the field means BUILTIN, which is a different installed behaviour.
        module.configure(JavaOnlyMap.of("apiKey", "tx_test_key"))
        assertNotSame(first, TraceItX.currentConfig)
    }

    private fun registryOf(m: TraceItXModule): RemotePlayerRegistry =
        TraceItXModule::class.java
            .getDeclaredField("remotePlayers")
            .apply { isAccessible = true }
            .get(m) as RemotePlayerRegistry
}
