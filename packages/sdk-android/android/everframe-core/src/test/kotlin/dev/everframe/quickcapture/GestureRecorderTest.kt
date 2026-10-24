// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.quickcapture

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** "Record on device": key events in, contract-named presses relative to the first key-down out. Plain JUnit. */
class GestureRecorderTest {
    private fun GestureRecorder.press(code: Int, down: Long, up: Long) {
        onKey(code, KeyEvent.ACTION_DOWN, 0, down)
        onKey(code, KeyEvent.ACTION_UP, 0, up)
    }

    @Test
    fun recordsHoldsRelativeToFirstDown() {
        val r = GestureRecorder()
        r.onKey(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.ACTION_DOWN, 0, 1000)
        r.onKey(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.ACTION_DOWN, 1, 1500)
        r.onKey(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.ACTION_UP, 0, 2620)
        assertEquals(listOf(RecordedKey("MEDIA_PLAY_PAUSE", 0, 1620)), r.finish(12_000))
    }

    @Test
    fun sequenceTimings() {
        val r = GestureRecorder()
        r.press(KeyEvent.KEYCODE_DPAD_UP, 5_000, 5_100)
        r.press(KeyEvent.KEYCODE_DPAD_UP, 5_300, 5_380)
        r.press(KeyEvent.KEYCODE_DPAD_DOWN, 5_600, 5_650)
        assertEquals(
            listOf(RecordedKey("DPAD_UP", 0, 100), RecordedKey("DPAD_UP", 300, 380), RecordedKey("DPAD_DOWN", 600, 650)),
            r.finish(15_000),
        )
    }

    @Test
    fun overlappingChordKeysKeepTheirOwnTimes() {
        val r = GestureRecorder()
        r.onKey(KeyEvent.KEYCODE_SHIFT_LEFT, KeyEvent.ACTION_DOWN, 0, 100)
        r.onKey(KeyEvent.KEYCODE_B, KeyEvent.ACTION_DOWN, 0, 150)
        r.onKey(KeyEvent.KEYCODE_B, KeyEvent.ACTION_UP, 0, 230)
        r.onKey(KeyEvent.KEYCODE_SHIFT_LEFT, KeyEvent.ACTION_UP, 0, 300)
        assertEquals(listOf(RecordedKey("SHIFT", 0, 200), RecordedKey("B", 50, 130)), r.finish(1_000))
    }

    @Test
    fun unmappedKeysDroppedAndCapAt32() {
        val r = GestureRecorder()
        r.press(KeyEvent.KEYCODE_HOME, 0, 50)
        r.press(KeyEvent.KEYCODE_VOLUME_UP, 60, 80)
        for (i in 0 until 40) r.press(KeyEvent.KEYCODE_DPAD_RIGHT, 100L + i * 100, 150L + i * 100)
        val events = r.finish(10_000)
        assertEquals(GestureRecorder.MAX_EVENTS, events.size)
        assertTrue(events.all { it.key == "DPAD_RIGHT" })
        assertEquals("times start at the first recorded DOWN", 0L, events.first().downMs)
    }

    @Test
    fun stillHeldAtFinishGetsFinishTime() {
        val r = GestureRecorder()
        r.onKey(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.ACTION_DOWN, 0, 0)
        assertEquals(listOf(RecordedKey("MEDIA_PLAY_PAUSE", 0, 10_000)), r.finish(10_000))
    }

    @Test
    fun emptyRecordingIsEmptyList() {
        val r = GestureRecorder()
        // An UP whose DOWN came before the recording started is not a press.
        r.onKey(KeyEvent.KEYCODE_DPAD_UP, KeyEvent.ACTION_UP, 0, 10)
        assertEquals(emptyList<RecordedKey>(), r.finish(10_000))
        assertEquals(10_000L, GestureRecorder.DURATION_MS)
    }
}
