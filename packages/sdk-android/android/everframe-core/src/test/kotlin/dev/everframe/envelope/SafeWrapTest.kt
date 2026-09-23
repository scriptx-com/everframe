// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// SafeWrap (`txGuard{}`) tests — DEFE-02. Mirrors iOS SafeWrap discipline.
package dev.everframe.envelope

import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SafeWrapTest {

    @Test
    fun `txGuard returns null and records failure on throw`() {
        val result: Int? = txGuard("test") { throw RuntimeException("boom"); @Suppress("UNREACHABLE_CODE") 1 }
        assertNull(result)
    }

    @Test
    fun `txGuard returns value on success`() {
        val result: Int? = txGuard("ok") { 42 }
        assertEquals(42, result)
    }

    @Test
    fun `txGuardSuspend returns value from coroutine`() = runTest {
        val result: Int? = txGuardSuspend("io") {
            delay(1)
            99
        }
        assertEquals(99, result)
    }

    @Test
    fun `txGuardSuspend returns null on throw`() = runTest {
        val result: Int? = txGuardSuspend("io-fail") {
            delay(1)
            throw RuntimeException("boom")
            @Suppress("UNREACHABLE_CODE") 1
        }
        assertNull(result)
    }

    @Test
    fun `txGuardVoid swallows exception`() {
        // Should not throw.
        txGuardVoid("void-fail") { throw RuntimeException("boom") }
    }
}
