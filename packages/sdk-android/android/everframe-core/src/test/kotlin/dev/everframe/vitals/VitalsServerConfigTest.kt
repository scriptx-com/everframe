// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.vitals

import dev.everframe.config.ReplayConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class VitalsServerConfigTest {
    @Test
    fun `absent fields default to off and full rate`() {
        assertEquals(VitalsServerConfig(false, 1.0), ReplayConfig.OFF.toVitalsServerConfig())
    }

    @Test
    fun `present fields pass through, rate clamped`() {
        val c = ReplayConfig.OFF.copy(vitalsEnabled = true, vitalsSampleRate = 0.25)
        assertEquals(VitalsServerConfig(true, 0.25), c.toVitalsServerConfig())
        assertEquals(1.0, ReplayConfig.OFF.copy(vitalsSampleRate = 7.0).toVitalsServerConfig().vitalsSampleRate, 0.0)
        assertEquals(0.0, ReplayConfig.OFF.copy(vitalsSampleRate = -1.0).toVitalsServerConfig().vitalsSampleRate, 0.0)
    }

    @Test
    fun `signal starts null and resets`() {
        VitalsServerConfigSignal.flow.value = VitalsServerConfig(true, 1.0)
        VitalsServerConfigSignal.resetForTesting()
        assertNull(VitalsServerConfigSignal.flow.value)
    }

    // ---- Codex round-4, #4 ----

    @Test
    fun `publish is a no-op once its own generation is superseded`() {
        // The bug: every writer checked its own predicate and THEN assigned.
        // `start(B)`'s check passed, B was descheduled, `start(C)` completed
        // and its replay refresh published C's gate — and B then resumed and
        // wrote `null` over it, disabling C's collector for the rest of the
        // session if C's own fetch never refreshed again. The predicate runs
        // inside the same critical section as the write now.
        var current = true
        VitalsServerConfigSignal.publish(VitalsServerConfig(true, 0.5)) { current }
        assertEquals(VitalsServerConfig(true, 0.5), VitalsServerConfigSignal.flow.value)

        current = false
        VitalsServerConfigSignal.publish(null) { current }
        assertEquals(
            "a superseded writer must not clear the gate a newer session published",
            VitalsServerConfig(true, 0.5),
            VitalsServerConfigSignal.flow.value,
        )

        current = true
        VitalsServerConfigSignal.publish(null) { current }
        assertNull("...and the current writer still can", VitalsServerConfigSignal.flow.value)
        VitalsServerConfigSignal.resetForTesting()
    }
}
