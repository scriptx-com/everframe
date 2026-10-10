// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Applies the shared JWT rule (`jwt` in redaction-patterns.json) in linear time, with exactly the
// regex's own result; mirrors redactJwt in packages/protocol/src/redaction.ts.
//
// The plain scan retries the pattern at every header prefix (`eyJ`, `eyA`, `ewo`, `ewk`, `ew0`: a
// JSON `{` followed by `"`, a space, a newline, a tab or a carriage return), and each try runs to the
// end of its segment, so `eyJ-eyJ-…` costs O(n²): seconds for a 64 KB body. Every match starts with
// a header prefix and a header that runs to the end of its [A-Za-z0-9_-] segment, where a '.' must
// follow. All starts inside one
// segment therefore end their header at the same place and succeed or fail on the same text after
// it; a later start only has a shorter header. So the leftmost start, then the leftmost start at a
// word boundary (inside a segment only '-' gives one), decide the whole segment.
import Foundation

enum JwtScan {
    /// A three-character prefix plus five: the shortest header the rule accepts.
    private static let minHeader = 8
    private static let e: UInt16 = 0x65, y: UInt16 = 0x79, w: UInt16 = 0x77, dot: UInt16 = 0x2E, dash: UInt16 = 0x2D

    static func replace(_ regex: NSRegularExpression, in input: String, with replacement: String) -> String {
        let units = Array(input.utf16)
        // One UTF-16 backed string for every anchored try, so no try transcodes the whole input.
        let subject = NSMutableString(string: input) as String
        var out = ""
        var copied = 0
        var from = 0
        var changed = false
        while let first = nextHeaderPrefix(units, from: from) {
            var end = first + 3
            while end < units.count && isSegmentUnit(units[end]) { end += 1 }
            if end - first >= minHeader && end < units.count && units[end] == dot {
                var start = first
                var matchEnd = endAt(regex, subject, units.count, first)
                if matchEnd < 0, let boundary = boundaryStart(units, from: first + 1, end: end) {
                    start = boundary
                    matchEnd = endAt(regex, subject, units.count, boundary)
                }
                if matchEnd >= 0 {
                    out += String(utf16CodeUnits: Array(units[copied..<start]), count: start - copied)
                    out += replacement
                    copied = matchEnd
                    from = matchEnd
                    changed = true
                    continue
                }
            }
            from = end
        }
        guard changed else { return input }
        out += String(utf16CodeUnits: Array(units[copied...]), count: units.count - copied)
        return out
    }

    /// End of the rule's match starting exactly at `start`, or -1. Transparent bounds let `\b` see
    /// the character before `start`.
    private static func endAt(_ regex: NSRegularExpression, _ subject: String, _ length: Int, _ start: Int) -> Int {
        guard let match = regex.firstMatch(in: subject, options: [.anchored, .withTransparentBounds],
                                           range: NSRange(location: start, length: length - start)) else { return -1 }
        return match.range.location + match.range.length
    }

    /// Whether a JSON header's base64url can start at `index`: `eyJ`, `eyA`, `ewo`, `ewk` or `ew0`.
    private static func headerPrefixAt(_ units: [UInt16], _ index: Int) -> Bool {
        guard index + 3 <= units.count, units[index] == e else { return false }
        let third = units[index + 2]
        switch units[index + 1] {
        case y: return third == 0x4A || third == 0x41 // J, A
        case w: return third == 0x6F || third == 0x6B || third == 0x30 // o, k, 0
        default: return false
        }
    }

    private static func nextHeaderPrefix(_ units: [UInt16], from: Int) -> Int? {
        var index = from
        while index + 3 <= units.count {
            if headerPrefixAt(units, index) { return index }
            index += 1
        }
        return nil
    }

    /// The first header prefix after a '-' in [from, end) that still leaves a full header.
    private static func boundaryStart(_ units: [UInt16], from: Int, end: Int) -> Int? {
        var index = from
        while index + minHeader <= end {
            if units[index - 1] == dash && headerPrefixAt(units, index) { return index }
            index += 1
        }
        return nil
    }

    private static func isSegmentUnit(_ unit: UInt16) -> Bool {
        (unit >= 0x30 && unit <= 0x39) || (unit >= 0x41 && unit <= 0x5A) || (unit >= 0x61 && unit <= 0x7A)
            || unit == 0x5F || unit == dash
    }
}
