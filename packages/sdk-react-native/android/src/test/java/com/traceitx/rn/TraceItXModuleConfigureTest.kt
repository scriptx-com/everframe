// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// TraceItXModuleConfigureTest — Task 9 (spec 2026-08-12): pins the polarity
// flip for the network-body client veto at the Android bridge boundary.
// Extended (mai meter spec 2026-08-27, branch review correction 2026-08-28)
// with the same trio for the install-identifier client veto: this file, not
// a source-only assertion, is what actually drives `TraceItXModule.configure`
// and checks `TraceItX.currentConfig`, so it is the one guard that would
// catch the wire-contract string key (`installIdentifierDisabled`) drifting
// out of sync with the native side.
//
// WHY THIS IS A SEPARATE FILE, NOT AN EXTENSION OF TraceItXModuleTest.kt:
//   The task brief that produced this test named
//   `TraceItXModuleTest.kt` as the file to extend. That file's tests
//   (captureNow/submit/openAnnotationOverlay) reference methods that no
//   longer exist on `TraceItXModule` — a PRE-EXISTING, unrelated break
//   documented in that file's own header comment and in this module's
//   `build.gradle.kts` (search `TraceItXModuleTest.kt` in the
//   `KotlinCompile` `exclude(...)` block). Because of that exclude, NOTHING
//   in `TraceItXModuleTest.kt` is compiled by `compileDebugUnitTestKotlin` /
//   `compileReleaseUnitTestKotlin` — tests added there would never run,
//   silently "passing" no matter what the polarity flip actually did. That
//   is exactly the failure mode this plan's own instructions warn against
//   ("tests that pass while proving nothing"), so the polarity tests below
//   live here instead, alongside `RnReplayBridgeTest.kt` — a file proven to
//   actually compile and execute under `./gradlew test` — using the same
//   `BridgeReactContext` + `JavaOnlyMap` conventions.
package com.traceitx.rn

import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.bridge.JavaOnlyMap
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.traceitx.TraceItX
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class TraceItXModuleConfigureTest {

    private lateinit var reactContext: ReactApplicationContext
    private lateinit var module: TraceItXModule

    @Before
    fun setUp() {
        // Mirrors TraceItXModuleTest.kt / RnReplayBridgeTest.kt's setUp: a real
        // Robolectric application Context wrapped in RN's own concrete
        // legacy-bridge ReactApplicationContext subclass (`ReactApplicationContext`
        // itself is `abstract` on the pinned react-native-tvos fork).
        reactContext = BridgeReactContext(RuntimeEnvironment.getApplication())
        module = TraceItXModule(reactContext)
        TraceItX.kill() // known-closed baseline before each test
    }

    /**
     * Polarity direction 1 (the trap): `networkBodiesDisabled: true` on the
     * bridge must VETO capture — `TraceItXConfig.capture.networkBodies` must
     * land `false`. Getting this backwards would silently ENABLE capture for
     * hosts that asked for it OFF.
     */
    @Test
    fun networkBodiesDisabledTrueVetoesCapture() {
        val opts = JavaOnlyMap()
        opts.putString("apiKey", "k")
        opts.putBoolean("networkBodiesDisabled", true)
        module.configure(opts)
        assertFalse(TraceItX.currentConfig!!.capture.networkBodies)
    }

    /**
     * Polarity direction 2: when the flag is absent entirely (the common
     * case — no host opinion), capture stays enabled by default.
     */
    @Test
    fun networkBodiesDefaultsToEnabledWhenTheFlagIsAbsent() {
        val opts = JavaOnlyMap()
        opts.putString("apiKey", "k")
        module.configure(opts)
        assertTrue(TraceItX.currentConfig!!.capture.networkBodies)
    }

    /**
     * Explicit `networkBodiesDisabled: false` must behave identically to the
     * flag being absent — it must NOT be misread as "disabled".
     */
    @Test
    fun networkBodiesDisabledFalseLeavesCaptureEnabled() {
        val opts = JavaOnlyMap()
        opts.putString("apiKey", "k")
        opts.putBoolean("networkBodiesDisabled", false)
        module.configure(opts)
        assertTrue(TraceItX.currentConfig!!.capture.networkBodies)
    }

    /**
     * Polarity direction 1 (the trap): `installIdentifierDisabled: true` on
     * the bridge must VETO the identifier — `TraceItXConfig.installIdentifierEnabled`
     * must land `false`. Getting this backwards would silently keep sending
     * an identifier for a host that explicitly opted out (mai meter spec
     * 2026-08-27; correction 2026-08-28: the veto fails OPEN if the untyped
     * `takeIfHasBoolean("installIdentifierDisabled")` string key ever drifts
     * from the wire contract, which is exactly what this test pins).
     */
    @Test
    fun installIdentifierDisabledTrueVetoesIdentifier() {
        val opts = JavaOnlyMap()
        opts.putString("apiKey", "k")
        opts.putBoolean("installIdentifierDisabled", true)
        module.configure(opts)
        assertFalse(TraceItX.currentConfig!!.installIdentifierEnabled)
    }

    /**
     * Polarity direction 2: when the flag is absent entirely (the common
     * case — no host opinion), the identifier stays enabled by default.
     */
    @Test
    fun installIdentifierDefaultsToEnabledWhenTheFlagIsAbsent() {
        val opts = JavaOnlyMap()
        opts.putString("apiKey", "k")
        module.configure(opts)
        assertTrue(TraceItX.currentConfig!!.installIdentifierEnabled)
    }

    /**
     * Explicit `installIdentifierDisabled: false` must behave identically to
     * the flag being absent — it must NOT be misread as "disabled".
     */
    @Test
    fun installIdentifierDisabledFalseLeavesIdentifierEnabled() {
        val opts = JavaOnlyMap()
        opts.putString("apiKey", "k")
        opts.putBoolean("installIdentifierDisabled", false)
        module.configure(opts)
        assertTrue(TraceItX.currentConfig!!.installIdentifierEnabled)
    }

    @Test
    fun additiveConfigureSyncAcknowledgesCompletedStartupAndPreservesLegacyDescriptor() {
        val opts = JavaOnlyMap.of("apiKey", "k")
        assertTrue(module.configureSync(opts))
        assertTrue(TraceItX.captureGate)

        val sync = TraceItXModule::class.java.getMethod("configureSync", ReadableMap::class.java)
        assertEquals(Boolean::class.javaPrimitiveType, sync.returnType)
        val syncAnnotation = requireNotNull(sync.getAnnotation(ReactMethod::class.java))
        assertTrue(syncAnnotation.isBlockingSynchronousMethod)

        val legacy = TraceItXModule::class.java.getMethod("configure", ReadableMap::class.java)
        assertEquals(Void.TYPE, legacy.returnType)
        val legacyAnnotation = requireNotNull(legacy.getAnnotation(ReactMethod::class.java))
        assertFalse(legacyAnnotation.isBlockingSynchronousMethod)
    }
}
