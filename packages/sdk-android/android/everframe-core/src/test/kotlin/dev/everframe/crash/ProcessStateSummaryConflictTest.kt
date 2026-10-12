// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class ProcessStateSummaryConflictTest {
    private fun exit(process: String, summary: ByteArray?) = AndroidNativeExit(7, process, 2000, 5, summary) { null }

    @Test fun `only another writer's summary on this process is a conflict`() {
        val ours = "everframe-native-v1:${UUID.randomUUID()}".toByteArray(Charsets.US_ASCII)
        assertFalse(ProcessStateSummaryConflict.foreign(listOf(exit("app", null)), "app"))
        assertFalse(ProcessStateSummaryConflict.foreign(listOf(exit("app", ours)), "app"))
        assertFalse(ProcessStateSummaryConflict.foreign(listOf(exit("app:player", "host".toByteArray())), "app"))
        assertTrue(ProcessStateSummaryConflict.foreign(listOf(exit("app", "host-session-42".toByteArray())), "app"))
        assertTrue(ProcessStateSummaryConflict.foreign(listOf(exit("app", byteArrayOf(1))), "app"))
    }
}
