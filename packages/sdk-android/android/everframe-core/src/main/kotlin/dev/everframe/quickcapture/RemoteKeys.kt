// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture on TVs: the platform-neutral key names of the wire contract
// (`captureGesture.tv`, gesture recordings) and the Android `KeyEvent` codes they stand for. Only these
// names are understood; a binding naming any other key is dropped (see `CaptureGestureConfigWire`).
// `MEDIA_PLAY_PAUSE` is code 85 only: remotes that send separate MEDIA_PLAY (126) and MEDIA_PAUSE (127)
// keys don't match it.
package dev.everframe.quickcapture

import android.view.KeyEvent

/**
 * A TV capture gesture from the dashboard, over [RemoteKeys] names. Built only by the config decoder, which
 * validates it: [LongPress] holds one key for [LongPress.holdMs]; [Sequence] presses [Sequence.keys] in order
 * within [Sequence.windowMs]; [Chord] holds all of [Chord.keys] together.
 */
sealed interface TvGestureBinding {
    data class LongPress(val key: String, val holdMs: Long) : TvGestureBinding
    data class Sequence(val keys: List<String>, val windowMs: Long) : TvGestureBinding
    data class Chord(val keys: Set<String>) : TvGestureBinding
}

internal object RemoteKeys {
    const val SHIFT: String = "SHIFT"

    private val byName: Map<String, Set<Int>> = buildMap {
        put("DPAD_UP", setOf(KeyEvent.KEYCODE_DPAD_UP))
        put("DPAD_DOWN", setOf(KeyEvent.KEYCODE_DPAD_DOWN))
        put("DPAD_LEFT", setOf(KeyEvent.KEYCODE_DPAD_LEFT))
        put("DPAD_RIGHT", setOf(KeyEvent.KEYCODE_DPAD_RIGHT))
        // OK on a remote; keyboards and some remotes send ENTER.
        put("DPAD_CENTER", setOf(KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER))
        put("BACK", setOf(KeyEvent.KEYCODE_BACK))
        put("MENU", setOf(KeyEvent.KEYCODE_MENU))
        put("MEDIA_PLAY_PAUSE", setOf(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE))
        put("MEDIA_FAST_FORWARD", setOf(KeyEvent.KEYCODE_MEDIA_FAST_FORWARD))
        put("MEDIA_REWIND", setOf(KeyEvent.KEYCODE_MEDIA_REWIND))
        put("PROG_RED", setOf(KeyEvent.KEYCODE_PROG_RED))
        put("PROG_GREEN", setOf(KeyEvent.KEYCODE_PROG_GREEN))
        put("PROG_YELLOW", setOf(KeyEvent.KEYCODE_PROG_YELLOW))
        put("PROG_BLUE", setOf(KeyEvent.KEYCODE_PROG_BLUE))
        ('A'..'Z').forEachIndexed { i, c -> put(c.toString(), setOf(KeyEvent.KEYCODE_A + i)) }
        ('0'..'9').forEachIndexed { i, c -> put(c.toString(), setOf(KeyEvent.KEYCODE_0 + i)) }
        put(SHIFT, setOf(KeyEvent.KEYCODE_SHIFT_LEFT, KeyEvent.KEYCODE_SHIFT_RIGHT))
    }

    private val byCode: Map<Int, String> = buildMap { byName.forEach { (name, codes) -> codes.forEach { put(it, name) } } }

    /** Every contract key name. */
    val NAMES: Set<String> = byName.keys

    /** The key codes a contract name stands for, or null for a name this SDK does not know. */
    fun codesFor(name: String): Set<Int>? = byName[name]

    /** The contract name of a key code, or null for a key outside the contract (Home, volume, …). */
    fun nameFor(keyCode: Int): String? = byCode[keyCode]
}
