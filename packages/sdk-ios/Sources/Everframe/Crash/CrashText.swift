// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import Foundation

internal enum CrashText {
    internal static func redactedAndCapped(
        _ text: String,
        utf16Limit: Int,
        redactor: RedactionEngine
    ) -> String {
        capped(redactor.redact(text), utf16Limit: utf16Limit)
    }

    internal static func capped(_ text: String, utf16Limit: Int) -> String {
        guard utf16Limit > 0 else { return "" }
        var result = String.UnicodeScalarView()
        var units = 0
        for scalar in text.unicodeScalars {
            let normalized: Unicode.Scalar = scalar.value == 0 ? "\u{FFFD}" : scalar
            let width = normalized.value > 0xFFFF ? 2 : 1
            guard units + width <= utf16Limit else { break }
            result.append(normalized)
            units += width
        }
        return String(result)
    }
}
