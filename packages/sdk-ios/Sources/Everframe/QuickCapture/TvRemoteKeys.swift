// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Contract key names for what UIKit delivers on Apple TV: the Siri Remote's
// press types and a hardware keyboard's HID usages. UIKit-free: callers pass
// `UIPress.PressType.rawValue` and `UIKey.keyCode.rawValue`.
import Foundation

enum TvRemoteKeys {
    /// `UIPress.PressType` raw values 0…6, in this order.
    private static let pressTypeNames = [
        "DPAD_UP", "DPAD_DOWN", "DPAD_LEFT", "DPAD_RIGHT", "DPAD_CENTER", "BACK", "MEDIA_PLAY_PAUSE",
    ]

    /// The contract name for a press, or nil. The press type wins over a
    /// keyboard usage; anything else (Page Up/Down, other keys) is nil.
    static func name(pressType: Int, keyUsage: Int?) -> String? {
        if pressTypeNames.indices.contains(pressType) { return pressTypeNames[pressType] }
        guard let usage = keyUsage else { return nil }
        switch usage {
        case 0x04...0x1D: return String(Character(UnicodeScalar(UInt8(ascii: "A") + UInt8(usage - 0x04))))
        case 0x1E...0x26: return String(usage - 0x1E + 1)
        case 0x27: return "0"
        case 0xE1, 0xE5: return "SHIFT"
        default: return nil
        }
    }

    /// The contract keys an Apple TV can deliver. `MENU`, `MEDIA_FAST_FORWARD`,
    /// `MEDIA_REWIND` and `PROG_*` never reach an app.
    static let reachable: Set<String> = {
        var keys = Set(pressTypeNames)
        keys.insert("SHIFT")
        for usage in 0x04...0x27 { if let key = name(pressType: -1, keyUsage: usage) { keys.insert(key) } }
        return keys
    }()

    private static let lock = NSLock()
    nonisolated(unsafe) private static var loggedFallback = false

    /// The binding this device acts on. nil stays nil (no TV gesture). A
    /// binding with a key this device cannot deliver falls back to the
    /// default, so the gesture still works; logged once, without the keys.
    static func effectiveBinding(_ wire: TvGestureBinding?) -> TvGestureBinding? {
        guard let wire else { return nil }
        guard wire.keys.allSatisfy(reachable.contains) else {
            lock.lock()
            let first = !loggedFallback
            loggedFallback = true
            lock.unlock()
            if first {
                InternalLogger.notice("Everframe: the app's TV gesture uses a key Apple TV remotes don't have; using hold Play/Pause instead.")
            }
            return .default
        }
        return wire
    }
}
