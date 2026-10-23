// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The dashboard's `captureHotkey.binding` and the in-app key chord it becomes on Android. The parser
// follows iOS `CaptureHotkeyBinding.parse` (packages/sdk-ios/Sources/Everframe/QuickCapture/CaptureHotkey.swift)
// token for token, so both platforms read one binding string the same way.
//
// The Android emulator drops ⌘, ⌃ and ⌥ before they reach the guest and never forwards a lone Shift, but
// it does deliver Shift+<key>. So Android uses the binding only when it is Shift plus a letter or digit (or
// that key with no modifier, which the shared grammar cannot express today); anything else (double Shift,
// any ⌘/⌃/⌥ chord, absent, unparseable) falls back to Shift+B.
package dev.everframe.quickcapture

import android.view.KeyEvent

internal enum class CaptureKeyModifier { Shift, Control, Option, Command }

internal sealed interface CaptureHotkeyBinding {
    data object DoubleShift : CaptureHotkeyBinding

    /** [key] is one character, lowercased. */
    data class Chord(val modifiers: Set<CaptureKeyModifier>, val key: String) : CaptureHotkeyBinding

    companion object {
        /** Parses the server binding string. Anything absent or unparseable is [DoubleShift], as on iOS. */
        fun parse(raw: String?): CaptureHotkeyBinding {
            val trimmed = raw?.trim()
            if (trimmed.isNullOrEmpty()) return DoubleShift
            if (trimmed.equals("Shift Shift", ignoreCase = true)) return DoubleShift
            val parts = trimmed.split("+").map { it.trim() }
            val last = parts.last()
            // As iOS: at least one modifier token, and the key is a single character.
            if (parts.size < 2 || last.codePointCount(0, last.length) != 1) return DoubleShift
            val modifiers = mutableSetOf<CaptureKeyModifier>()
            for (part in parts.dropLast(1)) {
                when (part.lowercase()) {
                    "mod", "cmd", "command" -> modifiers += CaptureKeyModifier.Command
                    "ctrl", "control" -> modifiers += CaptureKeyModifier.Control
                    "alt", "opt", "option" -> modifiers += CaptureKeyModifier.Option
                    "shift" -> modifiers += CaptureKeyModifier.Shift
                    else -> return DoubleShift
                }
            }
            return Chord(modifiers, last.lowercase())
        }
    }
}

/** The key chord quick capture listens for inside the app: [keyCode], with Shift held exactly when [shift]. */
internal data class AndroidCaptureChord(val keyCode: Int, val shift: Boolean) {

    /**
     * A first key-down of [keyCode] whose held modifiers are exactly Shift (when [shift]) or none. Ctrl, Alt,
     * Meta, Sym and Function all disqualify; Caps Lock and Num Lock are ignored.
     */
    fun matches(event: KeyEvent): Boolean =
        event.action == KeyEvent.ACTION_DOWN &&
            event.repeatCount == 0 &&
            event.keyCode == keyCode &&
            KeyEvent.metaStateHasModifiers(event.metaState, if (shift) KeyEvent.META_SHIFT_ON else 0)

    companion object {
        /** Shift+B: the platform default, and the fallback for any binding the emulator cannot deliver. */
        val DEFAULT = AndroidCaptureChord(KeyEvent.KEYCODE_B, shift = true)

        fun from(raw: String?): AndroidCaptureChord = from(CaptureHotkeyBinding.parse(raw))

        fun from(binding: CaptureHotkeyBinding): AndroidCaptureChord {
            val chord = binding as? CaptureHotkeyBinding.Chord ?: return DEFAULT
            val shift = when (chord.modifiers) {
                emptySet<CaptureKeyModifier>() -> false
                setOf(CaptureKeyModifier.Shift) -> true
                else -> return DEFAULT
            }
            val keyCode = keyCodeFor(chord.key) ?: return DEFAULT
            return AndroidCaptureChord(keyCode, shift)
        }

        /** a-z and 0-9 only: `KEYCODE_A..Z` and `KEYCODE_0..9` are contiguous. */
        private fun keyCodeFor(key: String): Int? {
            val c = key.singleOrNull() ?: return null
            return when (c) {
                in 'a'..'z' -> KeyEvent.KEYCODE_A + (c - 'a')
                in '0'..'9' -> KeyEvent.KEYCODE_0 + (c - '0')
                else -> null
            }
        }
    }
}
