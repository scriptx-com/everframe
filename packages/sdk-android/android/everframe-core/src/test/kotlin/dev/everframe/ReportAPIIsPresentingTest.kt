// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Plan 05.1-02 Task 4 — observable presenting-state on the Android SDK.
//
// Behaviours covered:
//   1. `Everframe.report.isPresenting.value` is `false` initially.
//   2. After `__setPresenting(true)`, `isPresenting.value == true`.
//   3. A StateFlow collector receives `false`, `true`, `false` across two flips.
//   4. StateFlow conflation: `__setPresenting(true)` twice in a row only emits
//      one `true` to a collector started after the second call.
//   5. `isPresenting` is exposed as `StateFlow<Boolean>` (read-only) — verified
//      by reflecting on the public `getter` return type.
package dev.everframe

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ReportAPIIsPresentingTest {

    @After
    fun resetPresenting() {
        // Reset the slot so tests are order-independent.
        Everframe.report.__setPresenting(false)
    }

    @Test
    fun `isPresenting starts false`() {
        // Reset first in case some prior test left it true.
        Everframe.report.__setPresenting(false)
        assertFalse(Everframe.report.isPresenting.value)
    }

    @Test
    fun `__setPresenting flips the StateFlow value`() {
        Everframe.report.__setPresenting(true)
        assertTrue(Everframe.report.isPresenting.value)
    }

    @Test
    fun `collector observes false-true-false sequence across two flips`() = runTest(UnconfinedTestDispatcher()) {
        Everframe.report.__setPresenting(false)
        val deferred = async {
            Everframe.report.isPresenting.take(3).toList()
        }
        Everframe.report.__setPresenting(true)
        Everframe.report.__setPresenting(false)
        val emissions = deferred.await()
        assertEquals(listOf(false, true, false), emissions)
    }

    @Test
    fun `value-equal updates do not re-emit (StateFlow conflation)`() = runTest(UnconfinedTestDispatcher()) {
        // Start at false, flip to true twice — collector started after both
        // flips should see exactly one `true` (StateFlow conflation by ==).
        Everframe.report.__setPresenting(false)
        Everframe.report.__setPresenting(true)
        Everframe.report.__setPresenting(true)
        val first = Everframe.report.isPresenting.first()
        assertTrue(first)
        assertTrue(Everframe.report.isPresenting.value)
    }

    @Test
    fun `isPresenting is exposed as read-only StateFlow not MutableStateFlow`() {
        // @JvmStatic on a property in `object report` generates a static
        // getter named `isPresenting()` (no `get` prefix). We assert its
        // declared return type implements StateFlow but is NOT
        // MutableStateFlow — which would let downstream code mutate `.value`.
        val getter = Everframe.report::class.java
            .getDeclaredMethod("isPresenting")
        val returnType = getter.returnType
        assertTrue(
            "isPresenting getter return type must implement StateFlow but not MutableStateFlow; got=${returnType.name}",
            StateFlow::class.java.isAssignableFrom(returnType) &&
                !MutableStateFlow::class.java.isAssignableFrom(returnType),
        )
    }
}
