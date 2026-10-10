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
        putString("releaseHealthNativeBuildId", "native-a")
        putString("releaseHealthLoadedBuildId", "loaded-a")
        putString("releaseHealthUserId", "opaque-a")
    }
    @Test fun explicitConfigurationIsFrozenAndIdenticalConfigureKeepsOwner() {
        val opts = enabled()
        assertTrue(module.configureSync(opts))
        val installed = Everframe.currentConfig!!
        val health = installed.releaseHealth!!
        assertEquals("native-a", health.nativeBuildId)
        assertEquals("loaded-a", health.loadedBuildId)
        assertEquals(ReleaseHealthBundleStatus.KNOWN, health.loadedBundleStatus)
        assertEquals("opaque-a", health.userId)
        module.configure(enabled())
        assertSame(installed, Everframe.currentConfig)
        opts.putString("releaseHealthUserId", "changed")
        assertEquals("opaque-a", Everframe.currentConfig!!.releaseHealth!!.userId)
    }
    @Test fun absentDisabledAndInvalidConfigurationsClearPreviousMonitoring() {
        val invalid = listOf(
            JavaOnlyMap().apply { putString("sdkKey", "rn-test-key") },
            enabled().apply { putBoolean("releaseHealthEnabled", false) },
            enabled().apply { putNull("releaseHealthNativeBuildId") },
            enabled().apply { putNull("releaseHealthLoadedBuildId") },
            enabled().apply { putString("releaseHealthUserId", "\uFEFF") },
            enabled().apply { putString("releaseHealthNativeBuildId", "a\u0001") },
            enabled().apply { putString("releaseHealthLoadedBuildId", "\uD800") },
            enabled().apply { putString("releaseHealthUserId", "x".repeat(129)) },
        )
        invalid.forEach { opts ->
            assertTrue(module.configureSync(enabled()))
            assertNotNull(Everframe.currentConfig!!.releaseHealth)
            assertTrue(module.configureSync(opts))
            assertNull(Everframe.currentConfig!!.releaseHealth)
        }
    }
    @Test fun anonymousAndSupplementaryIdentifiersAreAcceptedWithoutInference() {
        val opts = enabled().apply {
            putNull("releaseHealthUserId")
            putString("releaseHealthNativeBuildId", "native-\uD83D\uDE80")
        }
        module.configure(opts)
        assertNull(Everframe.currentConfig!!.releaseHealth!!.userId)
        assertEquals("native-\uD83D\uDE80", Everframe.currentConfig!!.releaseHealth!!.nativeBuildId)
    }
}
