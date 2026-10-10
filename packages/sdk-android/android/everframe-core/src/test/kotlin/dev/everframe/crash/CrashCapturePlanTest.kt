// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import org.junit.Assert.*
import org.junit.Test

class CrashCapturePlanTest {
    @Test fun `API level alone selects OS exit capture from API 30`() {
        assertEquals(CrashCapturePlan(processExit = false, nativeSignal = false), CrashCapturePlan.select(29, defaultProcess = true, signalModulePresent = false))
        assertEquals(CrashCapturePlan(processExit = true, nativeSignal = false), CrashCapturePlan.select(30, defaultProcess = true, signalModulePresent = false))
        assertEquals(CrashCapturePlan(processExit = true, nativeSignal = false), CrashCapturePlan.select(35, defaultProcess = true, signalModulePresent = false))
    }

    @Test fun `the native-crash module adds the signal collector on API 26 to 30 only`() {
        assertFalse(CrashCapturePlan.select(25, true, true).nativeSignal)
        assertTrue(CrashCapturePlan.select(26, true, true).nativeSignal)
        assertEquals(CrashCapturePlan(processExit = true, nativeSignal = true), CrashCapturePlan.select(30, true, true))
        assertFalse(CrashCapturePlan.select(31, true, true).nativeSignal)
    }

    @Test fun `API 24 and 25 and secondary processes select nothing`() {
        assertFalse(CrashCapturePlan.select(24, true, true).any)
        assertFalse(CrashCapturePlan.select(25, true, true).any)
        assertFalse(CrashCapturePlan.select(30, defaultProcess = false, signalModulePresent = true).any)
        assertFalse(CrashCapturePlan.select(35, defaultProcess = false, signalModulePresent = false).any)
    }

    @Test fun `signal arms before exit recovery and its failure never skips exit recovery`() {
        val calls = mutableListOf<String>()
        val armed = CrashCapturePlan(processExit = true, nativeSignal = true).arm(
            armSignal = { calls += "signal"; false },
            armProcessExit = { calls += "exit"; true },
        )
        assertEquals(listOf("signal", "exit"), calls)
        assertTrue(armed)
    }

    @Test fun `a signal arm that throws still arms OS exit capture`() {
        val calls = mutableListOf<String>()
        val armed = CrashCapturePlan(processExit = true, nativeSignal = true).arm(
            // As AndroidNativeSignalFiles throws when its directory cannot be owned.
            armSignal = { calls += "signal"; throw IllegalStateException("Native directory must be owned and regular") },
            armProcessExit = { calls += "exit"; true },
        )
        assertEquals(listOf("signal", "exit"), calls)
        assertTrue("native-crash and ANR capture through OS exit records stays on", armed)
    }

    @Test fun `an exit arm that throws keeps the signal result and never escapes`() {
        assertTrue(CrashCapturePlan(processExit = true, nativeSignal = true).arm(
            armSignal = { true },
            armProcessExit = { throw java.io.IOException("journal") },
        ))
        assertFalse(CrashCapturePlan(processExit = true, nativeSignal = true).arm(
            armSignal = { throw LinkageError("optional module") },
            armProcessExit = { throw java.io.IOException("journal") },
        ))
    }

    @Test fun `unselected mechanisms are never invoked`() {
        val armed = CrashCapturePlan(processExit = true, nativeSignal = false).arm(
            armSignal = { error("signal must not arm") },
            armProcessExit = { false },
        )
        assertFalse(armed)
    }
}
