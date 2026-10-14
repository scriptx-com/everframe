// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import EverframeProtocol

enum StateSanitizer {
    static func validKey(_ key: String) -> Bool {
        !key.isEmpty && key != "__proto__" && key.utf16.count <= 64 &&
        !key.unicodeScalars.contains { $0.value < 32 || (127...159).contains($0.value) } &&
        RedactionEngine().redact(key) == key
    }
    static func value(_ value: EverframeStateValue, key: String) -> EverframeStateValue? {
        switch value {
        case .double(let n): guard n.isFinite else { return nil }
        case .string(let s): guard s.utf16.count <= 256 else { return nil }
        case .bool: break
        }
        let normalized = key.lowercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) }
        if ["password", "passwd", "secret", "token", "authorization", "cookie", "apikey"].contains(where: normalized.contains) {
            return .string("[REDACTED]")
        }
        if case .string(let string) = value {
            let redacted = RedactionEngine().redact(string).replacingOccurrences(of: "\u{0}", with: "�")
            guard redacted.utf16.count <= 256 else { return .string("[REDACTED]") }
            return .string(redacted)
        }
        return value
    }
    static func equal(_ a: EverframeStateValue?, _ b: EverframeStateValue?) -> Bool {
        switch (a, b) {
        case (nil, nil): return true
        case (.bool(let a), .bool(let b)): return a == b
        case (.double(let a), .double(let b)): return a == b
        case (.string(let a), .string(let b)): return a.utf8.elementsEqual(b.utf8)
        default: return false
        }
    }
}
