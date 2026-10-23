// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// "Record on device": the presses a linked device sees while the dashboard records a TV binding, as contract key
// names with down and up times relative to the first recorded key-down (wire contract, "Gesture recording
// endpoint"). Repeats are ignored (a hold is one press with a long up time), keys outside the contract are
// dropped, and recording stops at 32 presses.
package dev.everframe.quickcapture

import android.view.KeyEvent

/** One recorded press: a contract key name, and its down and up times in ms since the first key-down. */
internal data class RecordedKey(val key: String, val downMs: Long, val upMs: Long)

/** Fed from the main thread, finished from the recording's timer; every method locks. */
internal class GestureRecorder {
    private class Press(val key: String, val downMs: Long, var upMs: Long? = null)

    private val presses = ArrayList<Press>()
    /** The press each held key code opened, until its key-up. */
    private val held = HashMap<Int, Press>()
    private var firstDown: Long? = null

    @Synchronized
    fun onKey(keyCode: Int, action: Int, repeatCount: Int, eventTimeMs: Long) {
        when (action) {
            KeyEvent.ACTION_DOWN -> {
                if (repeatCount != 0 || presses.size >= MAX_EVENTS) return
                val name = RemoteKeys.nameFor(keyCode) ?: return
                val origin = firstDown ?: eventTimeMs.also { firstDown = it }
                val press = Press(name, (eventTimeMs - origin).coerceAtLeast(0))
                presses += press
                held[keyCode] = press
            }
            KeyEvent.ACTION_UP -> {
                val press = held.remove(keyCode) ?: return
                val origin = firstDown ?: return
                press.upMs = (eventTimeMs - origin).coerceAtLeast(press.downMs)
            }
        }
    }

    /** The recording so far; a key still held gets [nowMs] (same clock as the key events) as its up time. */
    @Synchronized
    fun finish(nowMs: Long): List<RecordedKey> {
        val origin = firstDown ?: return emptyList()
        return presses.map { RecordedKey(it.key, it.downMs, it.upMs ?: (nowMs - origin).coerceAtLeast(it.downMs)) }
    }

    companion object {
        const val MAX_EVENTS = 32
        const val DURATION_MS = 10_000L
    }
}
