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
}

/// Stateful matcher fed one key-down at a time. `feed` returns true exactly when the binding fires.
struct CaptureHotkeyMatcher {
    let binding: CaptureHotkeyBinding
    let window: TimeInterval
    private var lastShiftAt: TimeInterval?

    init(binding: CaptureHotkeyBinding, window: TimeInterval = 0.4) {
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
