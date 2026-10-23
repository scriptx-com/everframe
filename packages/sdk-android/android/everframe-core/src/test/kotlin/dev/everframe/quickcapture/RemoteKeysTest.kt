// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.quickcapture

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Contract key names ↔ Android `KeyEvent` codes. Plain JUnit: the codes are compile-time constants. */
class RemoteKeysTest {
    private val contractNames = listOf(
        "DPAD_UP", "DPAD_DOWN", "DPAD_LEFT", "DPAD_RIGHT", "DPAD_CENTER", "BACK", "MENU", "MEDIA_PLAY_PAUSE",
        "MEDIA_FAST_FORWARD", "MEDIA_REWIND", "PROG_RED", "PROG_GREEN", "PROG_YELLOW", "PROG_BLUE", "SHIFT",
    ) + ('A'..'Z').map { it.toString() } + ('0'..'9').map { it.toString() }

    @Test
    fun mappingRoundTrips() {
        assertEquals(contractNames.toSet(), RemoteKeys.NAMES)
        contractNames.forEach { n ->
            val codes = RemoteKeys.codesFor(n)
            assertTrue(n, !codes.isNullOrEmpty())
            assertTrue(n, codes!!.all { RemoteKeys.nameFor(it) == n })
        }
        assertNull(RemoteKeys.codesFor("HOME"))
        assertNull(RemoteKeys.codesFor("dpad_up"))
        assertNull(RemoteKeys.nameFor(KeyEvent.KEYCODE_HOME))
        assertNull(RemoteKeys.nameFor(KeyEvent.KEYCODE_MEDIA_PLAY))
    }

    @Test
    fun exactCodes() {
        assertEquals(setOf(19), RemoteKeys.codesFor("DPAD_UP"))
        assertEquals(setOf(20), RemoteKeys.codesFor("DPAD_DOWN"))
        assertEquals(setOf(21), RemoteKeys.codesFor("DPAD_LEFT"))
        assertEquals(setOf(22), RemoteKeys.codesFor("DPAD_RIGHT"))
        assertEquals(setOf(23, 66, 160), RemoteKeys.codesFor("DPAD_CENTER"))
        assertEquals(setOf(4), RemoteKeys.codesFor("BACK"))
        assertEquals(setOf(82), RemoteKeys.codesFor("MENU"))
        assertEquals(setOf(85), RemoteKeys.codesFor("MEDIA_PLAY_PAUSE"))
        assertEquals(setOf(90), RemoteKeys.codesFor("MEDIA_FAST_FORWARD"))
        assertEquals(setOf(89), RemoteKeys.codesFor("MEDIA_REWIND"))
        assertEquals(setOf(183), RemoteKeys.codesFor("PROG_RED"))
        assertEquals(setOf(184), RemoteKeys.codesFor("PROG_GREEN"))
        assertEquals(setOf(185), RemoteKeys.codesFor("PROG_YELLOW"))
        assertEquals(setOf(186), RemoteKeys.codesFor("PROG_BLUE"))
        assertEquals(setOf(29), RemoteKeys.codesFor("A"))
        assertEquals(setOf(54), RemoteKeys.codesFor("Z"))
        assertEquals(setOf(7), RemoteKeys.codesFor("0"))
        assertEquals(setOf(16), RemoteKeys.codesFor("9"))
        assertEquals(setOf(59, 60), RemoteKeys.codesFor(RemoteKeys.SHIFT))
        assertEquals("DPAD_CENTER", RemoteKeys.nameFor(KeyEvent.KEYCODE_ENTER))
        assertEquals("DPAD_CENTER", RemoteKeys.nameFor(KeyEvent.KEYCODE_NUMPAD_ENTER))
        assertEquals("SHIFT", RemoteKeys.nameFor(KeyEvent.KEYCODE_SHIFT_RIGHT))
    }
}
