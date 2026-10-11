// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.health

import android.content.Context
import android.content.ContextWrapper
import android.content.pm.ApplicationInfo
import dev.everframe.config.ReleaseHealthConfig
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLog

/** The host app's own debuggable flag decides; the SDK's BuildConfig.DEBUG is never consulted. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ReleaseHealthBuildGateTest {
    private val line = "[everframe] Release health is off in debug builds."
    private fun host(flags: Int): Context = object : ContextWrapper(null) {
        override fun getApplicationInfo(): ApplicationInfo = ApplicationInfo().also { it.flags = flags }
    }
    private fun debug() = host(ApplicationInfo.FLAG_DEBUGGABLE)
    private fun release() = host(0)
    private fun lines() = ShadowLog.getLogsForTag("Everframe").map { it.msg }

    @Before fun clear() { ShadowLog.clear(); ReleaseHealthBuildGate.__debuggableForTesting = null }
    @After fun reset() { ReleaseHealthBuildGate.__debuggableForTesting = null }

    @Test fun `only the host's debuggable flag marks a debug build`() {
        assertTrue(ReleaseHealthBuildGate.debuggable(debug()))
        assertFalse(ReleaseHealthBuildGate.debuggable(release()))
        assertFalse(ReleaseHealthBuildGate.debuggable(host(ApplicationInfo.FLAG_DEBUGGABLE.inv())))
        // An unreadable ApplicationInfo counts as a release build.
        assertFalse(ReleaseHealthBuildGate.debuggable(object : ContextWrapper(null) {
            override fun getApplicationInfo(): ApplicationInfo? = null
        }))
    }

    @Test fun `off configurations stay off and say nothing`() {
        assertFalse(ReleaseHealthBuildGate.enabled(release(), null))
        assertFalse(ReleaseHealthBuildGate.enabled(release(), ReleaseHealthConfig(enabled = false)))
        assertFalse(ReleaseHealthBuildGate.enabled(debug(), ReleaseHealthConfig(enabled = false, includeDebugBuilds = true)))
        assertEquals(emptyList<String>(), lines())
    }

    @Test fun `a debuggable host is skipped with exactly one log line`() {
        assertFalse(ReleaseHealthBuildGate.enabled(debug(), ReleaseHealthConfig()))
        assertEquals(listOf(line), lines())
    }

    @Test fun `release hosts and includeDebugBuilds record without a log line`() {
        assertTrue(ReleaseHealthBuildGate.enabled(release(), ReleaseHealthConfig()))
        assertTrue(ReleaseHealthBuildGate.enabled(debug(), ReleaseHealthConfig(includeDebugBuilds = true)))
        assertEquals(emptyList<String>(), lines())
    }

    @Test fun `the test seam replaces the host flag`() {
        ReleaseHealthBuildGate.__debuggableForTesting = true
        assertFalse(ReleaseHealthBuildGate.enabled(release(), ReleaseHealthConfig()))
        ReleaseHealthBuildGate.__debuggableForTesting = false
        assertTrue(ReleaseHealthBuildGate.enabled(debug(), ReleaseHealthConfig()))
    }
}
