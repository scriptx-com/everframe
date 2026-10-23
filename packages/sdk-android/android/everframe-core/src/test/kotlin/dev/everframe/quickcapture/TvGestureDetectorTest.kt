// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.quickcapture

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The TV gesture state machine on synthetic key streams. Plain JUnit; times are uptime milliseconds. */
class TvGestureDetectorTest {
    private val playPause = KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
    private val up = KeyEvent.KEYCODE_DPAD_UP
    private val down = KeyEvent.KEYCODE_DPAD_DOWN
    private val left = KeyEvent.KEYCODE_DPAD_LEFT
    private val shiftOn = KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON

    private val longPress = TvGestureBinding.LongPress("MEDIA_PLAY_PAUSE", 1500)
    private val upUpDownDown = TvGestureBinding.Sequence(listOf("DPAD_UP", "DPAD_UP", "DPAD_DOWN", "DPAD_DOWN"), 1000)
    private val shiftB = TvGestureBinding.Chord(setOf("SHIFT", "B"))

    private fun TvGestureDetector.down(code: Int, t: Long, repeat: Int = 0, downTime: Long = t, meta: Int = 0) =
        onKey(code, KeyEvent.ACTION_DOWN, repeat, meta, t, downTime)

    private fun TvGestureDetector.up(code: Int, t: Long, downTime: Long, meta: Int = 0) =
        onKey(code, KeyEvent.ACTION_UP, 0, meta, t, downTime)

    /** A tap: DOWN at [t], UP 80 ms later. Returns the DOWN's verdict. */
    private fun TvGestureDetector.tap(code: Int, t: Long): KeyVerdict = down(code, t).also { up(code, t + 80, t) }

    @Test
    fun longPressFiresOnTimerWhileHeld() {
        val d = TvGestureDetector(longPress)
        val first = d.down(playPause, 0)
        assertEquals(KeyVerdict(holdDeadlineMs = 1500), first)
        assertFalse(d.onHoldTimer(1499))
        assertTrue(d.onHoldTimer(1500))
        assertFalse("fires once", d.onHoldTimer(1600))
        assertEquals(KeyVerdict(consume = true), d.down(playPause, 1550, repeat = 20, downTime = 0))
        assertEquals(KeyVerdict(cancelUp = true), d.up(playPause, 1600, downTime = 0))
    }

    @Test
    fun longPressFiresOnLateRepeat() {
        val d = TvGestureDetector(longPress)
        d.down(playPause, 0)
        var repeat = 1
        var t = 500L
        while (t < 1500) {
            assertEquals("repeat at $t", KeyVerdict(), d.down(playPause, t, repeat++, downTime = 0))
            t += 50
        }
        assertEquals(KeyVerdict(fire = true, consume = true), d.down(playPause, 1500, repeat++, downTime = 0))
        assertEquals(KeyVerdict(consume = true), d.down(playPause, 1550, repeat, downTime = 0))
        assertFalse("already fired", d.onHoldTimer(1500))
        assertEquals(KeyVerdict(cancelUp = true), d.up(playPause, 1600, downTime = 0))
    }

    @Test
    fun shortPressNeverFires() {
        val d = TvGestureDetector(longPress)
        d.down(playPause, 0)
        assertEquals(KeyVerdict(), d.up(playPause, 300, downTime = 0))
        assertFalse(d.onHoldTimer(1500))
    }

    @Test
    fun longPressOnOtherKeyIgnored() {
        val d = TvGestureDetector(longPress)
        assertEquals(KeyVerdict(), d.down(down, 0))
        var t = 400L
        var repeat = 1
        while (t <= 3000) {
            assertEquals(KeyVerdict(), d.down(down, t, repeat++, downTime = 0))
            t += 50
        }
        assertFalse(d.onHoldTimer(1500))
        assertEquals(KeyVerdict(), d.up(down, 3000, downTime = 0))
    }

    @Test
    fun firstDownIsNeverConsumed() {
        listOf(longPress, upUpDownDown, shiftB, TvGestureBinding.Chord(setOf("PROG_RED", "PROG_BLUE"))).forEach { b ->
            val d = TvGestureDetector(b)
            listOf(playPause, up, down, KeyEvent.KEYCODE_B, KeyEvent.KEYCODE_PROG_RED, KeyEvent.KEYCODE_SHIFT_LEFT).forEach { code ->
                d.reset()
                val v = d.down(code, 0)
                assertFalse("$b $code", v.consume)
                assertFalse("$b $code", v.fire)
            }
        }
    }

    @Test
    fun sequenceFiresWithinWindow() {
        val d = TvGestureDetector(upUpDownDown)
        assertEquals(KeyVerdict(), d.tap(up, 0))
        assertEquals(KeyVerdict(), d.tap(up, 200))
        assertEquals(KeyVerdict(), d.tap(down, 400))
        assertEquals(KeyVerdict(fire = true, consume = true), d.down(down, 600))
        assertEquals(KeyVerdict(consume = true), d.down(down, 1000, repeat = 1, downTime = 600))
        assertEquals(KeyVerdict(consume = true), d.up(down, 1050, downTime = 600))
        // The next key is the app's again, and history starts over.
        assertEquals(KeyVerdict(), d.tap(down, 1200))
    }

    @Test
    fun sequenceTooSlowDoesNotFire() {
        val d = TvGestureDetector(upUpDownDown)
        d.tap(up, 0)
        d.tap(up, 300)
        d.tap(down, 700)
        assertEquals(KeyVerdict(), d.down(down, 1001))
    }

    @Test
    fun autorepeatIsNotASequenceStep() {
        val d = TvGestureDetector(upUpDownDown)
        d.down(up, 0)
        d.down(up, 400, repeat = 1, downTime = 0)
        d.up(up, 420, downTime = 0)
        d.tap(down, 500)
        assertEquals(KeyVerdict(), d.down(down, 700))
    }

    @Test
    fun heldDownScrollNeverFiresUpUpDownDown() {
        val d = TvGestureDetector(upUpDownDown)
        d.tap(up, 0)
        d.tap(up, 100)
        d.down(down, 200)
        for (i in 1..20) assertEquals(KeyVerdict(), d.down(down, 200L + 400 + i * 50, repeat = i, downTime = 200))
        d.up(down, 1700, downTime = 200)
    }

    @Test
    fun interveningKeyBreaksTheSequence() {
        val d = TvGestureDetector(upUpDownDown)
        d.tap(up, 0)
        d.tap(up, 100)
        d.tap(left, 200)
        d.tap(down, 300)
        assertEquals(KeyVerdict(), d.down(down, 400))
        // An unmapped key breaks it too.
        d.tap(up, 1000)
        d.tap(up, 1100)
        d.tap(KeyEvent.KEYCODE_VOLUME_UP, 1150)
        d.tap(down, 1200)
        assertEquals(KeyVerdict(), d.down(down, 1300))
    }

    @Test
    fun chordShiftBFiresViaMetaState() {
        val d = TvGestureDetector(shiftB)
        assertEquals(KeyVerdict(fire = true, consume = true), d.down(KeyEvent.KEYCODE_B, 0, meta = shiftOn))
        assertEquals(KeyVerdict(consume = true), d.down(KeyEvent.KEYCODE_B, 400, repeat = 1, downTime = 0, meta = shiftOn))
        assertEquals(KeyVerdict(consume = true), d.up(KeyEvent.KEYCODE_B, 450, downTime = 0, meta = shiftOn))
        // Shift itself is the app's.
        assertEquals(KeyVerdict(), d.up(KeyEvent.KEYCODE_SHIFT_LEFT, 500, downTime = 0))
    }

    @Test
    fun chordWithoutModifierDoesNotFire() {
        val d = TvGestureDetector(shiftB)
        assertEquals(KeyVerdict(), d.down(KeyEvent.KEYCODE_B, 0, meta = 0))
        assertEquals(KeyVerdict(), d.up(KeyEvent.KEYCODE_B, 80, downTime = 0))
    }

    @Test
    fun chordOfTwoColorKeys() {
        val d = TvGestureDetector(TvGestureBinding.Chord(setOf("PROG_RED", "PROG_BLUE")))
        assertEquals(KeyVerdict(), d.down(KeyEvent.KEYCODE_PROG_RED, 0))
        assertEquals(KeyVerdict(), d.down(KeyEvent.KEYCODE_PROG_RED, 400, repeat = 1, downTime = 0))
        assertEquals(KeyVerdict(fire = true, consume = true), d.down(KeyEvent.KEYCODE_PROG_BLUE, 450))
        assertEquals(KeyVerdict(consume = true), d.up(KeyEvent.KEYCODE_PROG_BLUE, 500, downTime = 450))
        assertEquals(KeyVerdict(), d.up(KeyEvent.KEYCODE_PROG_RED, 520, downTime = 0))
        // Red released: blue alone is nothing.
        assertEquals(KeyVerdict(), d.down(KeyEvent.KEYCODE_PROG_BLUE, 600))
    }

    @Test
    fun overlappingChordCompletionsKeepEveryFiredKeySuppressed() {
        val d = TvGestureDetector(TvGestureBinding.Chord(setOf("PROG_RED", "PROG_BLUE")))
        val red = KeyEvent.KEYCODE_PROG_RED
        val blue = KeyEvent.KEYCODE_PROG_BLUE
        assertEquals(KeyVerdict(), d.down(red, 0))
        assertEquals(KeyVerdict(fire = true, consume = true), d.down(blue, 100))
        assertEquals(KeyVerdict(), d.up(red, 200, downTime = 0))
        // RED pressed again while BLUE is still held completes the chord a second time.
        assertEquals(KeyVerdict(fire = true, consume = true), d.down(red, 300))
        assertEquals("BLUE stays suppressed until its own release", KeyVerdict(consume = true), d.down(blue, 500, repeat = 1, downTime = 100))
        assertEquals(KeyVerdict(consume = true), d.up(blue, 600, downTime = 100))
        assertEquals(KeyVerdict(consume = true), d.down(red, 700, repeat = 1, downTime = 300))
        assertEquals(KeyVerdict(consume = true), d.up(red, 800, downTime = 300))
        // Both released: the keys are the app's again.
        assertEquals(KeyVerdict(), d.down(blue, 900))
    }

    @Test
    fun resetClearsState() {
        val lp = TvGestureDetector(longPress)
        lp.down(playPause, 0)
        lp.reset()
        assertFalse(lp.onHoldTimer(1500))
        assertEquals("a repeat after reset has no first DOWN", KeyVerdict(), lp.down(playPause, 1600, repeat = 25, downTime = 0))

        val seq = TvGestureDetector(upUpDownDown)
        seq.tap(up, 0)
        seq.tap(up, 100)
        seq.tap(down, 200)
        seq.reset()
        assertEquals(KeyVerdict(), seq.down(down, 300))

        val chord = TvGestureDetector(TvGestureBinding.Chord(setOf("PROG_RED", "PROG_BLUE")))
        chord.down(KeyEvent.KEYCODE_PROG_RED, 0)
        chord.reset()
        assertEquals(KeyVerdict(), chord.down(KeyEvent.KEYCODE_PROG_BLUE, 100))
    }
}
