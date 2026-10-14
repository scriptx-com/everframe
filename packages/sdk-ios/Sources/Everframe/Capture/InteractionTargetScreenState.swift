// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

enum InteractionTargetScreenState {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var explicit: String?
    nonisolated(unsafe) private static var native: String?
    static func recordExplicit(_ name: String) {
        lock.lock(); defer { lock.unlock() }; explicit = interactionTargetText(name)
    }
    static func recordNative(_ name: String) {
        lock.lock(); defer { lock.unlock() }; native = interactionTargetText(name)
    }
    static func current() -> String? {
        lock.lock(); defer { lock.unlock() }; return explicit ?? native
    }
    static func reset() {
        lock.lock(); defer { lock.unlock() }; explicit = nil; native = nil
    }
}

func interactionTargetText(_ value: String?, max: Int = 256) -> String? {
    guard let value else { return nil }
    var output = String.UnicodeScalarView()
    var units = 0
    for scalar in value.unicodeScalars {
        if scalar.value == 0 { continue }
        let width = scalar.value > 0xffff ? 2 : 1
        if units + width > max { break }
        output.append(scalar); units += width
    }
    let result = String(output)
    return result.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : result
}
