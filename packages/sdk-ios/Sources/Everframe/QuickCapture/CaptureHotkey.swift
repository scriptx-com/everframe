// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

/// Modifier flags for a quick-capture chord. UIKit-free so the matcher runs on the host.
struct CaptureKeyModifiers: OptionSet, Equatable {
    let rawValue: Int
    static let shift = CaptureKeyModifiers(rawValue: 1 << 0)
    static let control = CaptureKeyModifiers(rawValue: 1 << 1)
    static let option = CaptureKeyModifiers(rawValue: 1 << 2)
    static let command = CaptureKeyModifiers(rawValue: 1 << 3)
}

enum CaptureKey: Equatable {
    case shift
    case character(String)
    case other
}

enum CaptureKeyEvent {
    case down(key: CaptureKey, modifiers: CaptureKeyModifiers, isRepeat: Bool, at: TimeInterval)
}

enum CaptureHotkeyBinding: Equatable {
    case doubleShift
    case chord(modifiers: CaptureKeyModifiers, key: String)

    /// Parses the server binding string. Anything absent or unparseable is `.doubleShift`.
    static func parse(_ raw: String?) -> CaptureHotkeyBinding {
        guard let raw = raw?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else { return .doubleShift }
        if raw.caseInsensitiveCompare("Shift Shift") == .orderedSame { return .doubleShift }
        let parts = raw.split(separator: "+", omittingEmptySubsequences: false).map {
            $0.trimmingCharacters(in: .whitespaces)
        }
        guard parts.count >= 2, let last = parts.last, last.count == 1 else { return .doubleShift }
        var modifiers: CaptureKeyModifiers = []
        for part in parts.dropLast() {
            switch part.lowercased() {
            case "mod", "cmd", "command": modifiers.insert(.command)
            case "ctrl", "control": modifiers.insert(.control)
            case "alt", "opt", "option": modifiers.insert(.option)
            case "shift": modifiers.insert(.shift)
            default: return .doubleShift
            }
        }
        return .chord(modifiers: modifiers, key: last.lowercased())
    }

    /// True for a chord that is also ordinary typing: a key alone or with Shift
    /// only, such as `Shift+B`. Such a chord stands aside while an editable text
    /// input is first responder. Double Shift and chords with ⌘, ⌃ or ⌥ never do.
    var yieldsToTextInput: Bool {
        guard case let .chord(modifiers, _) = self else { return false }
        return modifiers.isSubset(of: [.shift])
    }
}

/// Stateful matcher fed one key-down at a time. `feed` returns true exactly when the binding fires.
struct CaptureHotkeyMatcher {
    let binding: CaptureHotkeyBinding
    let window: TimeInterval
    private var lastShiftAt: TimeInterval?

    static let defaultWindow: TimeInterval = 0.4

    init(binding: CaptureHotkeyBinding, window: TimeInterval = CaptureHotkeyMatcher.defaultWindow) {
        self.binding = binding
        self.window = window
    }

    mutating func feed(_ event: CaptureKeyEvent) -> Bool {
        guard case let .down(key, modifiers, isRepeat, at) = event else { return false }
        if isRepeat { return false }
        switch binding {
        case .doubleShift:
            guard key == .shift else {
                lastShiftAt = nil
                return false
            }
            if let last = lastShiftAt, at - last <= window {
                lastShiftAt = nil
                return true
            }
            lastShiftAt = at
            return false
        case let .chord(wanted, wantedKey):
            guard case let .character(c) = key else { return false }
            return modifiers == wanted && c.lowercased() == wantedKey
        }
    }
}

/// One physical key press: the `UIPress` object and its `timestamp`. UIKit can
/// reuse a press object, and a freed object's address can be reused, so the
/// timestamp keeps two presses of the same object apart.
struct CapturePressID: Hashable {
    let press: ObjectIdentifier
    let timestamp: TimeInterval
}

/// Admits each key press once. If UIKit hands the same key-down to
/// `UIWindow.sendEvent` more than once, for example once per window, the
/// matcher must not count the repeat as the second Shift of a double Shift.
/// Remembers the last few admitted presses only: a repeat delivery comes with
/// the same dispatch, not several presses later.
struct CapturePressDeduplicator {
    static let capacity = 8
    private var recent: [CapturePressID] = []

    mutating func admit(_ id: CapturePressID) -> Bool {
        guard !recent.contains(id) else { return false }
        recent.append(id)
        if recent.count > Self.capacity { recent.removeFirst() }
        return true
    }
}

/// Maps one hardware-keyboard press to a `CaptureKeyEvent`, on raw values so it
/// stays UIKit-free and host-testable. The simulator-only `UIWindow.sendEvent`
/// branch passes `UIKey.keyCode.rawValue`, `charactersIgnoringModifiers` and
/// `modifierFlags.rawValue`; `QuickCaptureTests` pins these constants to UIKit's.
enum CaptureKeyMapping {
    /// `UIKeyboardHIDUsage.keyboardLeftShift` / `.keyboardRightShift`.
    static let leftShiftUsage = 0xE1
    static let rightShiftUsage = 0xE5
    /// `UIKeyModifierFlags` bits.
    static let shiftFlag = 1 << 17
    static let controlFlag = 1 << 18
    static let optionFlag = 1 << 19
    static let commandFlag = 1 << 20

    /// A key-down event, or nil unless the press just began. UIPress reports no
    /// auto-repeat, so `isRepeat` is always false.
    static func event(
        keyCode: Int, charactersIgnoringModifiers: String, modifierFlags: Int, began: Bool, at: TimeInterval
    ) -> CaptureKeyEvent? {
        guard began else { return nil }
        let key: CaptureKey
        if keyCode == leftShiftUsage || keyCode == rightShiftUsage {
            key = .shift
        } else {
            let characters = charactersIgnoringModifiers.lowercased()
            key = characters.isEmpty ? .other : .character(characters)
        }
        var modifiers: CaptureKeyModifiers = []
        if modifierFlags & shiftFlag != 0 { modifiers.insert(.shift) }
        if modifierFlags & controlFlag != 0 { modifiers.insert(.control) }
        if modifierFlags & optionFlag != 0 { modifiers.insert(.option) }
        if modifierFlags & commandFlag != 0 { modifiers.insert(.command) }
        return .down(key: key, modifiers: modifiers, isRepeat: false, at: at)
    }
}
