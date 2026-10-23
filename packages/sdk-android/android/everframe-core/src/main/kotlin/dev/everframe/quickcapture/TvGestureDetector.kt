// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture on TVs: recognises the dashboard's remote binding (`captureGesture.tv`) in the
// window's key stream. A pure state machine over key-event fields: no Android looper, no clock of its own.
// The caller (`TXWindowCallbackWrapper`) feeds it every key event, runs the hold timer it asks for, and
// decides whether the verdict's `consume`/`cancelUp` apply: they do only on a linked device, and an unlinked
// device's events always reach the app unchanged.
//
//   LongPress  the first DOWN is always delivered and asks for a hold timer at downTime + holdMs. The press
//              fires once, from the timer while the key is still down or from a repeat that late. After that
//              its repeats are consumed and its UP is delivered canceled. An UP before the deadline is a tap.
//   Sequence   only first DOWNs count (autorepeat is never a step); the last N key names must equal the
//              binding within windowMs. The completing DOWN, its repeats and its UP are consumed.
//   Chord      fires on the first DOWN that completes the held set (SHIFT also counts as held while the
//              event's meta state says so). That key's DOWN, repeats and UP are consumed; a second completion
//              while it is still held keeps it suppressed until its own UP.
//
// Normal navigation never fires: a held D-pad only repeats (never a new step), and a tapped Play/Pause is
// released long before the deadline. Not thread-safe: the main thread only.
package dev.everframe.quickcapture

import android.view.KeyEvent

/**
 * What the caller does with one key event. [consume] (drop it) and [cancelUp] (deliver it with
 * `FLAG_CANCELED`) apply only where the device swallows keys (linked); otherwise the event is delivered as
 * is. [holdDeadlineMs] asks the caller to call [TvGestureDetector.onHoldTimer] at that uptime.
 */
internal data class KeyVerdict(
    val fire: Boolean = false,
    val consume: Boolean = false,
    val cancelUp: Boolean = false,
    val holdDeadlineMs: Long? = null,
) {
    companion object {
        val PASS = KeyVerdict()
    }
}

internal class TvGestureDetector(val binding: TvGestureBinding) {
    // ---- LongPress ----
    private val longPressCodes: Set<Int> =
        (binding as? TvGestureBinding.LongPress)?.let { RemoteKeys.codesFor(it.key) }.orEmpty()
    /** The held press's downTime, from its first DOWN until its UP. */
    private var holdDownTime: Long? = null
    private var holdFired = false

    // ---- Sequence ----
    private val steps = ArrayDeque<Pair<String?, Long>>()

    // ---- Chord ----
    private val held = HashSet<String>()

    /**
     * Sequence and chord: the keys whose completing DOWN fired, each until its own UP. Their events are consumed.
     * Overlapping chord completions (RED+BLUE, then RED released and pressed again while BLUE is held) add a key
     * without releasing the earlier one.
     */
    private val firedKeys = HashSet<Int>()

    fun onKey(keyCode: Int, action: Int, repeatCount: Int, metaState: Int, eventTimeMs: Long, downTimeMs: Long): KeyVerdict =
        when (binding) {
            is TvGestureBinding.LongPress -> longPress(binding, keyCode, action, repeatCount, eventTimeMs, downTimeMs)
            is TvGestureBinding.Sequence -> sequence(binding, keyCode, action, repeatCount, eventTimeMs)
            is TvGestureBinding.Chord -> chord(binding, keyCode, action, repeatCount, metaState)
        }

    /** The hold timer the last first DOWN asked for. True once, when the held press reaches its deadline. */
    fun onHoldTimer(nowMs: Long): Boolean {
        val b = binding as? TvGestureBinding.LongPress ?: return false
        val downTime = holdDownTime ?: return false
        if (holdFired || nowMs < downTime + b.holdMs) return false
        holdFired = true
        return true
    }

    /**
     * Drops recognition in progress (a pending hold, sequence steps, held chord keys) but keeps keys already
     * consumed, so they stay suppressed until their own release. Used while a text editor has focus.
     */
    fun dropPending() {
        if (!holdFired) holdDownTime = null
        steps.clear()
        held.clear()
    }

    /** Forgets that [keyCode] was consumed (a fresh press of it, whose earlier release was never seen). */
    fun forgetFired(keyCode: Int) {
        firedKeys -= keyCode
        if (keyCode in longPressCodes) {
            holdDownTime = null
            holdFired = false
        }
    }

    fun reset() {
        holdDownTime = null
        holdFired = false
        steps.clear()
        held.clear()
        firedKeys.clear()
    }

    private fun longPress(
        b: TvGestureBinding.LongPress,
        keyCode: Int,
        action: Int,
        repeatCount: Int,
        eventTimeMs: Long,
        downTimeMs: Long,
    ): KeyVerdict {
        if (keyCode !in longPressCodes) return KeyVerdict.PASS
        return when (action) {
            KeyEvent.ACTION_DOWN -> if (repeatCount == 0) {
                // A new press (also after a lost UP): always delivered.
                holdDownTime = downTimeMs
                holdFired = false
                KeyVerdict(holdDeadlineMs = downTimeMs + b.holdMs)
            } else {
                val downTime = holdDownTime
                when {
                    // A repeat whose first DOWN this detector never saw (binding changed mid-press): not ours.
                    downTime == null || downTime != downTimeMs -> KeyVerdict.PASS
                    holdFired -> KeyVerdict(consume = true)
                    eventTimeMs - downTimeMs >= b.holdMs -> {
                        holdFired = true
                        KeyVerdict(fire = true, consume = true)
                    }
                    else -> KeyVerdict.PASS
                }
            }
            KeyEvent.ACTION_UP -> {
                val fired = holdFired && holdDownTime == downTimeMs
                holdDownTime = null
                holdFired = false
                if (fired) KeyVerdict(cancelUp = true) else KeyVerdict.PASS
            }
            else -> KeyVerdict.PASS
        }
    }

    private fun sequence(
        b: TvGestureBinding.Sequence,
        keyCode: Int,
        action: Int,
        repeatCount: Int,
        eventTimeMs: Long,
    ): KeyVerdict {
        firedVerdict(keyCode, action, repeatCount)?.let { return it }
        if (action != KeyEvent.ACTION_DOWN || repeatCount != 0) return KeyVerdict.PASS
        steps.addLast(RemoteKeys.nameFor(keyCode) to eventTimeMs)
        while (steps.size > b.keys.size) steps.removeFirst()
        if (steps.size < b.keys.size) return KeyVerdict.PASS
        val matches = steps.map { it.first } == b.keys && eventTimeMs - steps.first().second <= b.windowMs
        if (!matches) return KeyVerdict.PASS
        steps.clear()
        firedKeys += keyCode
        return KeyVerdict(fire = true, consume = true)
    }

    private fun chord(b: TvGestureBinding.Chord, keyCode: Int, action: Int, repeatCount: Int, metaState: Int): KeyVerdict {
        val name = RemoteKeys.nameFor(keyCode)
        firedVerdict(keyCode, action, repeatCount)?.let { verdict ->
            if (action == KeyEvent.ACTION_UP && name != null) held.remove(name)
            return verdict
        }
        if (name == null) return KeyVerdict.PASS
        when (action) {
            KeyEvent.ACTION_UP -> {
                held.remove(name)
                return KeyVerdict.PASS
            }
            KeyEvent.ACTION_DOWN -> if (repeatCount != 0) return KeyVerdict.PASS
            else -> return KeyVerdict.PASS
        }
        held.add(name)
        if (name !in b.keys) return KeyVerdict.PASS
        val shift = metaState and KeyEvent.META_SHIFT_ON != 0
        val complete = b.keys.all { it in held || (it == RemoteKeys.SHIFT && shift) }
        if (!complete) return KeyVerdict.PASS
        firedKeys += keyCode
        return KeyVerdict(fire = true, consume = true)
    }

    /** A fired key's repeats and UP are consumed; a fresh DOWN of it (its UP was lost) is judged anew. */
    private fun firedVerdict(keyCode: Int, action: Int, repeatCount: Int): KeyVerdict? {
        if (keyCode !in firedKeys) return null
        return when {
            action == KeyEvent.ACTION_UP -> {
                firedKeys -= keyCode
                KeyVerdict(consume = true)
            }
            action == KeyEvent.ACTION_DOWN && repeatCount > 0 -> KeyVerdict(consume = true)
            else -> {
                firedKeys -= keyCode
                null
            }
        }
    }
}
