// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Plan 06.2-08 Task 1 — JVM unit tests for `Companion` StateFlow surface.
//
// Behaviours covered:
//   1. Initial `Companion.state.value == CompanionState.Unpaired`.
//   2. Initial `Companion.pairUrl.value == null`.
//   3. `__setState(Paired)` propagates to a collector started before the flip.
//   4. `__setPairUrl("…")` propagates likewise.
//   5. StateFlow conflation: setting current value emits no new tick.
//   6. Public surface is `StateFlow<…>` (read-only) — not `MutableStateFlow`.
//
// Test framework: JUnit 4 + kotlinx-coroutines-test (matches the
// `:everframe-core` test classpath and the `ReportAPIIsPresentingTest`
// analog established in Plan 05.1-02).

package dev.everframe.companion

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
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CompanionStateTest {

    @Before
    fun resetBefore() {
        // Singleton object — reset so prior tests can't leak state.
        Companion.__setState(CompanionState.Unpaired)
        Companion.__setPairUrl(null)
        Companion.__setResolvedName(null)
    }

    @After
    fun resetAfter() {
        Companion.__setState(CompanionState.Unpaired)
        Companion.__setPairUrl(null)
        Companion.__setResolvedName(null)
    }

    @Test
    fun `initial state is Unpaired`() {
        assertEquals(CompanionState.Unpaired, Companion.state.value)
    }

    @Test
    fun `initial pairUrl is null`() {
        assertNull(Companion.pairUrl.value)
    }

    @Test
    fun `state flip emits to active collector`() = runTest(UnconfinedTestDispatcher()) {
        val deferred = async {
            Companion.state.take(2).toList()
        }
        Companion.__setState(CompanionState.Paired)
        val emissions = deferred.await()
        assertEquals(listOf(CompanionState.Unpaired, CompanionState.Paired), emissions)
    }

    @Test
    fun `pairUrl flip emits to active collector`() = runTest(UnconfinedTestDispatcher()) {
        val url = "https://relay.example.com/r/tok_abc"
        val deferred = async {
            Companion.pairUrl.take(2).toList()
        }
        Companion.__setPairUrl(url)
        val emissions = deferred.await()
        assertEquals(listOf<String?>(null, url), emissions)
    }

    @Test
    fun `value-equal state set does not re-emit (StateFlow conflation)`() =
        runTest(UnconfinedTestDispatcher()) {
            // Already Unpaired from @Before — set to Unpaired again, then to
            // Paired. A collector started after both calls sees `Paired`.
            Companion.__setState(CompanionState.Unpaired)
            Companion.__setState(CompanionState.Paired)
            val first = Companion.state.first()
            assertEquals(CompanionState.Paired, first)
        }

    @Test
    fun `state is exposed as read-only StateFlow not MutableStateFlow`() {
        // @JvmStatic on `val state` generates a static getter `getState()`.
        val getter = Companion::class.java.getDeclaredMethod("getState")
        val returnType = getter.returnType
        assertTrue(
            "state getter return type must implement StateFlow but not MutableStateFlow; got=${returnType.name}",
            StateFlow::class.java.isAssignableFrom(returnType) &&
                !MutableStateFlow::class.java.isAssignableFrom(returnType),
        )
    }

    @Test
    fun `pairUrl is exposed as read-only StateFlow not MutableStateFlow`() {
        val getter = Companion::class.java.getDeclaredMethod("getPairUrl")
        val returnType = getter.returnType
        assertTrue(
            "pairUrl getter return type must implement StateFlow but not MutableStateFlow; got=${returnType.name}",
            StateFlow::class.java.isAssignableFrom(returnType) &&
                !MutableStateFlow::class.java.isAssignableFrom(returnType),
        )
    }

    @Test
    fun `Everframe_companion is the same singleton as Companion object`() {
        assertSame(Companion, dev.everframe.Everframe.companion)
    }

    // ---------------- resolvedName (naming spec 2026-08-24) ----------------

    @Test
    fun `initial resolvedName is null`() {
        assertNull(Companion.resolvedName.value)
    }

    @Test
    fun `resolvedName flip emits to active collector`() = runTest(UnconfinedTestDispatcher()) {
        val deferred = async {
            Companion.resolvedName.take(2).toList()
        }
        Companion.__setResolvedName("Lobby TV")
        val emissions = deferred.await()
        assertEquals(listOf<String?>(null, "Lobby TV"), emissions)
    }

    @Test
    fun `resolvedName value-equal set does not re-emit (StateFlow conflation)`() =
        runTest(UnconfinedTestDispatcher()) {
            Companion.__setResolvedName(null)
            Companion.__setResolvedName("Lobby TV")
            val first = Companion.resolvedName.first()
            assertEquals("Lobby TV", first)
        }

    @Test
    fun `resolvedName clears back to null (terminal-close lifecycle)`() {
        Companion.__setResolvedName("Lobby TV")
        assertEquals("Lobby TV", Companion.resolvedName.value)

        Companion.__setResolvedName(null)

        assertNull(Companion.resolvedName.value)
    }

    @Test
    fun `resolvedName is exposed as read-only StateFlow not MutableStateFlow`() {
        val getter = Companion::class.java.getDeclaredMethod("getResolvedName")
        val returnType = getter.returnType
        assertTrue(
            "resolvedName getter return type must implement StateFlow but not MutableStateFlow; got=${returnType.name}",
            StateFlow::class.java.isAssignableFrom(returnType) &&
                !MutableStateFlow::class.java.isAssignableFrom(returnType),
        )
    }
}
