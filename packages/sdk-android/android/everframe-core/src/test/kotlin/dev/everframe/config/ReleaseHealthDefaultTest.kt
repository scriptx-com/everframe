// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.config

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReleaseHealthDefaultTest {
    private val base = EverframeConfig(appId = "test-app-id", sdkKey = "txx_live_test1234567890")

    @Test fun `a configuration that leaves release health out turns it on`() {
        assertEquals(ReleaseHealthConfig(), base.releaseHealth)
        assertTrue(base.releaseHealth!!.enabled)
        assertFalse(base.releaseHealth!!.includeDebugBuilds)
    }

    @Test fun `the earlier 15-argument constructor and copy keep the default`() {
        // Java callers and code compiled before release health reach this constructor.
        val positional = EverframeConfig("test-app-id", "txx_live_test1234567890", Environment.production, null,
            CaptureConfig(), true, false, null, true, true, null, null, true, VitalsConfig(), null)
        assertEquals(ReleaseHealthConfig(), positional.releaseHealth)
        assertEquals(ReleaseHealthConfig(), positional.copy(sdkKey = "txx_live_other").releaseHealth)
    }

    @Test fun `null and enabled false are opt-outs that the earlier copy keeps`() {
        assertNull(base.copy(releaseHealth = null).copy(sdkKey = "txx_live_other").releaseHealth)
        val disabled = base.copy(releaseHealth = ReleaseHealthConfig(enabled = false))
        assertFalse(disabled.copy(sdkKey = "txx_live_other").releaseHealth!!.enabled)
    }
}
