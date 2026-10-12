// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.rn

import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.bridge.JavaOnlyMap
import dev.everframe.Everframe
import dev.everframe.config.ReleaseHealthBundleStatus
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class ReleaseHealthConfigureTest {
    private lateinit var module: EverframeModule
    @Before fun setup() {
        Everframe.kill()
        module = EverframeModule(BridgeReactContext(RuntimeEnvironment.getApplication()))
    }
    @After fun cleanup() { Everframe.kill() }
    private fun enabled() = JavaOnlyMap().apply {
        putString("sdkKey", "rn-test-key")
        putBoolean("releaseHealthEnabled", true)
        putString("releaseHealthLoadedBuildId", "loaded-a")
        putString("releaseHealthUserId", "opaque-a")
    }
    /** A loaded bundle and a user ID, but no enabled flag at all: release health is on by default. */
    private fun withoutEnabledFlag() = JavaOnlyMap().apply {
        putString("sdkKey", "rn-test-key")
        putString("releaseHealthLoadedBuildId", "loaded-a")
        putString("releaseHealthUserId", "opaque-a")
    }
    @Test fun explicitConfigurationIsFrozenAndIdenticalConfigureKeepsOwner() {
        val opts = enabled()
        assertTrue(module.configureSync(opts))
        val installed = Everframe.currentConfig!!
        val health = installed.releaseHealth!!
        assertTrue(health.enabled)
        assertEquals("loaded-a", health.loadedBuildId)
        assertEquals(ReleaseHealthBundleStatus.KNOWN, health.loadedBundleStatus)
        assertEquals("opaque-a", health.userId)
        assertFalse(health.includeDebugBuilds)
        module.configureSync(enabled())
        assertSame(installed, Everframe.currentConfig)
        opts.putString("releaseHealthUserId", "changed")
        assertEquals("opaque-a", Everframe.currentConfig!!.releaseHealth!!.userId)
    }
    @Test fun missingOrNullEnabledFlagWithAValidLoadedBuildIsOn() {
        listOf(withoutEnabledFlag(), enabled().apply { putNull("releaseHealthEnabled") }).forEach { opts ->
            assertTrue(module.configureSync(opts))
            val health = Everframe.currentConfig!!.releaseHealth!!
            assertTrue(health.enabled)
            assertEquals("loaded-a", health.loadedBuildId)
            assertEquals(ReleaseHealthBundleStatus.KNOWN, health.loadedBundleStatus)
            assertEquals("opaque-a", health.userId)
            assertFalse(health.includeDebugBuilds)
        }
    }
    @Test fun includeDebugBuildsReachesTheNativeConfigurationAndDefaultsToFalse() {
        assertTrue(module.configureSync(enabled().apply { putBoolean("releaseHealthIncludeDebugBuilds", true) }))
        val counting = Everframe.currentConfig!!
        assertTrue(counting.releaseHealth!!.includeDebugBuilds)
        listOf(
            enabled().apply { putBoolean("releaseHealthIncludeDebugBuilds", false) },
            enabled().apply { putNull("releaseHealthIncludeDebugBuilds") },
            enabled(),
        ).forEach { opts ->
            assertTrue(module.configureSync(enabled().apply { putBoolean("releaseHealthIncludeDebugBuilds", true) }))
            assertTrue(module.configureSync(opts))
            val skipping = Everframe.currentConfig!!
            assertFalse(skipping.releaseHealth!!.includeDebugBuilds)
            assertNotEquals(counting, skipping)
        }
    }
    @Test fun debugBuildReachesTheNativeConfigurationAndStaysNullWhenMissing() {
        assertTrue(module.configureSync(enabled().apply { putBoolean("debugBuild", true) }))
        assertEquals(true, Everframe.currentConfig!!.debugBuild)
        assertTrue(module.configureSync(enabled().apply { putBoolean("debugBuild", false) }))
        assertEquals(false, Everframe.currentConfig!!.debugBuild)
        listOf(enabled(), enabled().apply { putNull("debugBuild") }).forEach { opts ->
            assertTrue(module.configureSync(opts))
            assertNull(Everframe.currentConfig!!.debugBuild)
        }
    }
    @Test fun disabledAndInvalidConfigurationsClearPreviousMonitoring() {
        val off = listOf(
            // No loaded bundle: JS sends the flag without an ID when the Hermes identity is missing.
            JavaOnlyMap().apply { putString("sdkKey", "rn-test-key") },
            enabled().apply { putBoolean("releaseHealthEnabled", false) },
            enabled().apply {
                putBoolean("releaseHealthEnabled", false)
                putBoolean("releaseHealthIncludeDebugBuilds", true)
            },
            enabled().apply { putNull("releaseHealthLoadedBuildId") },
            enabled().apply { putString("releaseHealthUserId", "\uFEFF") },
            enabled().apply { putString("releaseHealthLoadedBuildId", "a\u0001") },
            enabled().apply { putString("releaseHealthLoadedBuildId", "\uD800") },
            enabled().apply { putString("releaseHealthUserId", "x".repeat(129)) },
        )
        off.forEach { opts ->
            assertTrue(module.configureSync(enabled()))
            assertNotNull(Everframe.currentConfig!!.releaseHealth)
            assertTrue(module.configureSync(opts))
            assertNull(Everframe.currentConfig!!.releaseHealth)
        }
    }
    @Test fun anonymousAndSupplementaryIdentifiersAreAcceptedWithoutInference() {
        val opts = enabled().apply {
            putNull("releaseHealthUserId")
            putString("releaseHealthLoadedBuildId", "loaded-\uD83D\uDE80")
        }
        module.configureSync(opts)
        assertNull(Everframe.currentConfig!!.releaseHealth!!.userId)
        assertEquals("loaded-\uD83D\uDE80", Everframe.currentConfig!!.releaseHealth!!.loadedBuildId)
    }
}
