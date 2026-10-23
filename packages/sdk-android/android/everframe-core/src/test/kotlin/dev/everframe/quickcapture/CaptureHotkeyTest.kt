// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.quickcapture

import android.view.KeyEvent
import dev.everframe.quickcapture.CaptureKeyModifier.Command
import dev.everframe.quickcapture.CaptureKeyModifier.Control
import dev.everframe.quickcapture.CaptureKeyModifier.Option
import dev.everframe.quickcapture.CaptureKeyModifier.Shift
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class CaptureHotkeyTest {

    @Test
    fun parsesTheSameGrammarAsIos() {
        val cases = mapOf<String?, CaptureHotkeyBinding>(
            null to CaptureHotkeyBinding.DoubleShift,
            "" to CaptureHotkeyBinding.DoubleShift,
            "   " to CaptureHotkeyBinding.DoubleShift,
            "Shift Shift" to CaptureHotkeyBinding.DoubleShift,
            "shift shift" to CaptureHotkeyBinding.DoubleShift,
            "Shift+B" to CaptureHotkeyBinding.Chord(setOf(Shift), "b"),
            " shift + k " to CaptureHotkeyBinding.Chord(setOf(Shift), "k"),
            "Shift+7" to CaptureHotkeyBinding.Chord(setOf(Shift), "7"),
            "Mod+Shift+B" to CaptureHotkeyBinding.Chord(setOf(Command, Shift), "b"),
            "Cmd+B" to CaptureHotkeyBinding.Chord(setOf(Command), "b"),
            "Command+B" to CaptureHotkeyBinding.Chord(setOf(Command), "b"),
            "Ctrl+Shift+B" to CaptureHotkeyBinding.Chord(setOf(Control, Shift), "b"),
            "Control+B" to CaptureHotkeyBinding.Chord(setOf(Control), "b"),
            "Alt+B" to CaptureHotkeyBinding.Chord(setOf(Option), "b"),
            "Opt+B" to CaptureHotkeyBinding.Chord(setOf(Option), "b"),
            "Option+B" to CaptureHotkeyBinding.Chord(setOf(Option), "b"),
            // As iOS: a bare key, an unknown modifier, a long key name or a dangling `+` is unparseable.
            "B" to CaptureHotkeyBinding.DoubleShift,
            "+B" to CaptureHotkeyBinding.DoubleShift,
            "Shift+" to CaptureHotkeyBinding.DoubleShift,
            "Hyper+B" to CaptureHotkeyBinding.DoubleShift,
            "Shift+F1" to CaptureHotkeyBinding.DoubleShift,
            "Shift+Space" to CaptureHotkeyBinding.DoubleShift,
        )
        for ((raw, expected) in cases) {
            assertEquals("parse(${raw?.let { "\"$it\"" }})", expected, CaptureHotkeyBinding.parse(raw))
        }
    }

    @Test
    fun effectiveAndroidChordFallsBackToShiftB() {
        val shiftB = AndroidCaptureChord(KeyEvent.KEYCODE_B, shift = true)
        assertEquals(shiftB, AndroidCaptureChord.DEFAULT)
        val cases = mapOf<String?, AndroidCaptureChord>(
            "Shift+B" to shiftB,
            "Shift+K" to AndroidCaptureChord(KeyEvent.KEYCODE_K, shift = true),
            "shift+z" to AndroidCaptureChord(KeyEvent.KEYCODE_Z, shift = true),
            "Shift+A" to AndroidCaptureChord(KeyEvent.KEYCODE_A, shift = true),
            "Shift+0" to AndroidCaptureChord(KeyEvent.KEYCODE_0, shift = true),
            "Shift+9" to AndroidCaptureChord(KeyEvent.KEYCODE_9, shift = true),
            // Nothing below can reach the emulator's guest: Shift+B.
            "Shift Shift" to shiftB,
            null to shiftB,
            "" to shiftB,
            "garbage" to shiftB,
            "Cmd+Shift+K" to shiftB,
            "Mod+K" to shiftB,
            "Ctrl+K" to shiftB,
            "Ctrl+Shift+K" to shiftB,
            "Alt+K" to shiftB,
            "Shift+/" to shiftB,
            "Shift+é" to shiftB,
        )
        for ((raw, expected) in cases) {
            assertEquals("from(${raw?.let { "\"$it\"" }})", expected, AndroidCaptureChord.from(raw))
        }
        // The grammar cannot express a bare key today, but the model keeps it a plain-key chord.
        assertEquals(
            AndroidCaptureChord(KeyEvent.KEYCODE_K, shift = false),
            AndroidCaptureChord.from(CaptureHotkeyBinding.Chord(emptySet(), "k")),
        )
    }

    @Test
    fun matchesExactlyTheChordsModifiers() {
        val shiftB = AndroidCaptureChord.DEFAULT
        assertTrue(shiftB.matches(key(KeyEvent.KEYCODE_B, SHIFT_LEFT)))
        assertTrue("right Shift", shiftB.matches(key(KeyEvent.KEYCODE_B, KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_RIGHT_ON)))
        assertTrue("Caps Lock is not a modifier", shiftB.matches(key(KeyEvent.KEYCODE_B, SHIFT_LEFT or KeyEvent.META_CAPS_LOCK_ON)))
        assertFalse("plain B", shiftB.matches(key(KeyEvent.KEYCODE_B, 0)))
        assertFalse("Ctrl+Shift+B", shiftB.matches(key(KeyEvent.KEYCODE_B, SHIFT_LEFT or KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON)))
        assertFalse("Alt+Shift+B", shiftB.matches(key(KeyEvent.KEYCODE_B, SHIFT_LEFT or KeyEvent.META_ALT_ON or KeyEvent.META_ALT_LEFT_ON)))
        assertFalse("Meta+Shift+B", shiftB.matches(key(KeyEvent.KEYCODE_B, SHIFT_LEFT or KeyEvent.META_META_ON or KeyEvent.META_META_LEFT_ON)))
        assertFalse("another key", shiftB.matches(key(KeyEvent.KEYCODE_K, SHIFT_LEFT)))
        assertFalse("key-up", shiftB.matches(key(KeyEvent.KEYCODE_B, SHIFT_LEFT, action = KeyEvent.ACTION_UP)))
        assertFalse("auto-repeat", shiftB.matches(key(KeyEvent.KEYCODE_B, SHIFT_LEFT, repeat = 1)))

        val plainK = AndroidCaptureChord(KeyEvent.KEYCODE_K, shift = false)
        assertTrue(plainK.matches(key(KeyEvent.KEYCODE_K, 0)))
        assertFalse(plainK.matches(key(KeyEvent.KEYCODE_K, SHIFT_LEFT)))
    }

    private fun key(code: Int, meta: Int, action: Int = KeyEvent.ACTION_DOWN, repeat: Int = 0) =
        KeyEvent(0L, 0L, action, code, repeat, meta)

    private companion object {
        const val SHIFT_LEFT = KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON
    }
}
