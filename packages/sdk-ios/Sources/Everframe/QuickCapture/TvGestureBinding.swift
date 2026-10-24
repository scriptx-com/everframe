// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The app's TV capture gesture (`captureGesture.tv` in `GET /api/config`),
// sent only to SDKs that declare `capturegesture`, which this SDK does in
// tvOS builds. Validated like the server's schema: a binding outside it means
// no TV gesture, never a failed config. UIKit-free.
import Foundation

enum TvGestureBinding: Equatable, Sendable {
    /// One key held for `holdMs` milliseconds.
    case longPress(key: String, holdMs: Int)
    /// Key presses in this order, first to last within `windowMs`.
    case sequence(keys: [String], windowMs: Int)
    /// Keys held down together.
    case chord(keys: [String])

    /// The contract's default: hold Play/Pause for 1.5 s. Select is never a default.
    static let `default` = TvGestureBinding.longPress(key: "MEDIA_PLAY_PAUSE", holdMs: 1500)

    static let holdRange = 500...5000
    static let windowRange = 300...5000

    /// Every platform-neutral key name the contract defines.
    static let contractKeys: Set<String> = {
        var keys: Set<String> = [
            "DPAD_UP", "DPAD_DOWN", "DPAD_LEFT", "DPAD_RIGHT", "DPAD_CENTER", "BACK", "MENU",
            "MEDIA_PLAY_PAUSE", "MEDIA_FAST_FORWARD", "MEDIA_REWIND",
            "PROG_RED", "PROG_GREEN", "PROG_YELLOW", "PROG_BLUE", "SHIFT",
        ]
        for scalar in UnicodeScalar("A").value...UnicodeScalar("Z").value {
            keys.insert(String(Character(UnicodeScalar(scalar)!)))
        }
        for digit in 0...9 { keys.insert(String(digit)) }
        return keys
    }()

    var keys: [String] {
        switch self {
        case let .longPress(key, _): return [key]
        case let .sequence(keys, _): return keys
        case let .chord(keys): return keys
        }
    }

    /// True when any key is a letter, a digit or `SHIFT`: such a binding is
    /// also typing, so it stands aside while a text input is being edited.
    var yieldsToTextInput: Bool { keys.contains(where: Self.isTypingKey) }

    static func isTypingKey(_ key: String) -> Bool {
        if key == "SHIFT" { return true }
        guard key.count == 1, let scalar = key.unicodeScalars.first else { return false }
        return ("A"..."Z").contains(scalar) || ("0"..."9").contains(scalar)
    }

    /// A binding from its wire parts, or nil outside the server's schema:
    /// a long press has exactly 1 key and `holdMs` in 500…5000; a sequence
    /// has 2…8 keys and `windowMs` in 300…5000; a chord has 2…4 distinct
    /// keys; every key is a contract name.
    static func validated(kind: String, keys: [String], holdMs: Int?, windowMs: Int?) -> TvGestureBinding? {
        guard keys.allSatisfy(contractKeys.contains) else { return nil }
        switch kind {
        case "longPress":
            guard keys.count == 1, let holdMs, holdRange.contains(holdMs) else { return nil }
            return .longPress(key: keys[0], holdMs: holdMs)
        case "sequence":
            guard (2...8).contains(keys.count), let windowMs, windowRange.contains(windowMs) else { return nil }
            return .sequence(keys: keys, windowMs: windowMs)
        case "chord":
            guard (2...4).contains(keys.count), Set(keys).count == keys.count else { return nil }
            return .chord(keys: keys)
        default:
            return nil
        }
    }
}

/// The negotiated `captureGesture` block. `tv` is nil when the block carries
/// no TV binding or an invalid one. Decoded leniently: an invalid `tv` gives
/// `tv == nil`, and a non-object block makes the whole block nil (see
/// `ReplayConfigWire`).
struct CaptureGestureConfigWire: Decodable, Sendable, Equatable {
    let tv: TvGestureBinding?

    init(tv: TvGestureBinding?) {
        self.tv = tv
    }

    private enum CodingKeys: String, CodingKey { case tv }
    private enum BindingKeys: String, CodingKey { case kind, keys, holdMs, windowMs }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tv = Self.decodeBinding(c)
    }

    private static func decodeBinding(_ c: KeyedDecodingContainer<CodingKeys>) -> TvGestureBinding? {
        guard let b = try? c.nestedContainer(keyedBy: BindingKeys.self, forKey: .tv),
              let kind = try? b.decode(String.self, forKey: .kind),
              let keys = try? b.decode([String].self, forKey: .keys) else { return nil }
        let holdMs = b.contains(.holdMs) ? (try? b.decode(StrictWholeNumber.self, forKey: .holdMs))?.value : nil
        let windowMs = b.contains(.windowMs) ? (try? b.decode(StrictWholeNumber.self, forKey: .windowMs))?.value : nil
        // A present but malformed duration (`true`, `1500.5`) refuses the binding.
        if b.contains(.holdMs), holdMs == nil { return nil }
        if b.contains(.windowMs), windowMs == nil { return nil }
        return TvGestureBinding.validated(kind: kind, keys: keys, holdMs: holdMs, windowMs: windowMs)
    }
}

/// A JSON number with no fractional part. Booleans and fractions are refused.
private struct StrictWholeNumber: Decodable {
    let value: Int

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if (try? c.decode(Bool.self)) != nil {
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "a boolean is not a number")
        }
        let double = try c.decode(Double.self)
        guard double.rounded() == double, abs(double) < 1e9 else {
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "not a whole number")
        }
        value = Int(double)
    }
}
