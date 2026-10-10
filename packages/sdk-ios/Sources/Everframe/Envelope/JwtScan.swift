// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// JWT and JWE redaction by structure; mirrors redactJwt in packages/protocol/src/redaction.ts, and
// the shared corpus (packages/protocol/__tests__/fixtures/jwt-redaction-corpus.v1.json) pins both.
//
// A candidate is a header segment of base64url characters (at least 8), a '.', a payload or
// encrypted-key segment, a '.', and a third segment (possibly empty); a JWE adds two more. It is
// redacted only when the header decodes to a JOSE header: RFC 7515 and RFC 7516 require a JSON
// object with an "alg" member, so after any leading JSON whitespace the decoded header must start
// with '{' and contain "alg". Dotted class, package and module names never decode to that.
//
// Linear: each segment run is a header candidate once, a candidate reads at most four more
// segments, it checks the 8-character prefix of at most `maxGlue` + 1 starts (text glued before the
// header, such as `x_` or the `3D` of `%3D`, stays), and it decodes the whole header, with no cap,
// at most `maxFullDecodes` times: certificate chains (x5c) make headers kilobytes long.
import Foundation

enum JwtScan {
    static let maxGlue = 64
    static let maxFullDecodes = 4
    private static let minHeader = 8
    private static let dot: UInt16 = 0x2E
    private static let base64url: [Int8] = {
        var table = [Int8](repeating: -1, count: 128)
        for (index, unit) in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".utf16.enumerated() {
            table[Int(unit)] = Int8(index)
        }
        return table
    }()
    private static let alg: UInt64 = 0x22616c6722 // "alg"
    private static let enc: UInt64 = 0x22656e6322 // "enc"
    private static let window: UInt64 = 0xFFFFFFFFFF // five bytes

    static func replace(in input: String, with replacement: String) -> String {
        let units = Array(input.utf16)
        var out: [UInt16] = []
        var copied = 0
        var index = 0
        var changed = false
        while index < units.count {
            guard isSegment(units[index]) else { index += 1; continue }
            let runEnd = segmentEnd(units, from: index)
            guard runEnd - index >= minHeader, runEnd < units.count, units[runEnd] == dot,
                  let token = tokenAt(units, runStart: index, headerEnd: runEnd) else {
                index = runEnd
                continue
            }
            if !changed { out.reserveCapacity(units.count); changed = true }
            out.append(contentsOf: units[copied..<token.start])
            out.append(contentsOf: replacement.utf16)
            copied = token.end
            index = token.end
        }
        guard changed else { return input }
        out.append(contentsOf: units[copied...])
        return String(utf16CodeUnits: out, count: out.count)
    }

    /// A JWE header with two more segments takes all five; otherwise three, with a payload of 2+.
    private static func tokenAt(_ units: [UInt16], runStart: Int, headerEnd: Int) -> (start: Int, end: Int)? {
        let payloadEnd = segmentEnd(units, from: headerEnd + 1)
        guard payloadEnd < units.count, units[payloadEnd] == dot else { return nil }
        let thirdEnd = segmentEnd(units, from: payloadEnd + 1)
        var fifthEnd = -1
        if thirdEnd < units.count, units[thirdEnd] == dot {
            let fourthEnd = segmentEnd(units, from: thirdEnd + 1)
            if fourthEnd < units.count, units[fourthEnd] == dot { fifthEnd = segmentEnd(units, from: fourthEnd + 1) }
        }
        let payloadLength = payloadEnd - headerEnd - 1
        let last = min(runStart + maxGlue, headerEnd - minHeader)
        guard last >= runStart else { return nil }
        var decodes = 0
        for start in runStart...last {
            if decodes == maxFullDecodes { break }
            if !joseHeaderPrefix(units, start: start) { continue }
            decodes += 1
            let kind = joseHeaderKind(units, start: start, end: headerEnd)
            if kind == 0 { continue }
            if kind == 2 && fifthEnd >= 0 { return (start, fifthEnd) }
            if payloadLength >= 2 { return (start, thirdEnd) }
        }
        return nil
    }

    private static func byteAt(_ a: Int, _ b: Int, _ c: Int, _ d: Int, _ k: Int) -> Int {
        switch k {
        case 0: return (a << 2) | (b >> 4)
        case 1: return ((b & 15) << 4) | (c >> 2)
        default: return ((c & 3) << 6) | d
        }
    }

    private static func isJsonWhitespace(_ byte: Int) -> Bool { byte == 0x20 || byte == 0x09 || byte == 0x0A || byte == 0x0D }

    private static func value(_ units: [UInt16], _ index: Int) -> Int { Int(base64url[Int(units[index])]) }

    /// The first 8 characters at `start` (6 bytes) decode to optional JSON whitespace, `{`, optional
    /// whitespace and `"` (a JOSE header's first member name). Whitespace that runs past them passes.
    static func joseHeaderPrefix(_ units: [UInt16], start: Int) -> Bool {
        var opened = false
        var index = start
        while index < start + 8 {
            let a = value(units, index), b = value(units, index + 1), c = value(units, index + 2), d = value(units, index + 3)
            for k in 0..<3 {
                let byte = byteAt(a, b, c, d, k)
                if isJsonWhitespace(byte) { continue }
                if !opened && byte == 0x7B { opened = true; continue }
                return opened && byte == 0x22
            }
            index += 4
        }
        return true
    }

    /// Decodes the whole header once, keeping only the last five bytes: 0 when it is not a JOSE header
    /// (optional JSON whitespace, `{`, and "alg" anywhere after it); 1 with "alg"; 2 when it also
    /// names "enc" (a JWE).
    static func joseHeaderKind(_ units: [UInt16], start: Int, end: Int) -> Int {
        var opened = false
        var hasAlg = false
        var hasEnc = false
        var last: UInt64 = 0
        var index = start
        while end - index >= 2 {
            let remaining = end - index
            let a = value(units, index)
            let b = value(units, index + 1)
            let c = remaining > 2 ? value(units, index + 2) : -1
            let d = remaining > 3 ? value(units, index + 3) : -1
            let count = c < 0 ? 1 : (d < 0 ? 2 : 3)
            for k in 0..<count {
                let byte = byteAt(a, b, c, d, k)
                if !opened {
                    if byte == 0x7B { opened = true }
                    else if !isJsonWhitespace(byte) { return 0 }
                }
                last = ((last << 8) | UInt64(byte)) & window
                if last == alg { hasAlg = true } else if last == enc { hasEnc = true }
            }
            index += 4
        }
        guard opened, hasAlg else { return 0 }
        return hasEnc ? 2 : 1
    }

    private static func segmentEnd(_ units: [UInt16], from: Int) -> Int {
        var end = from
        while end < units.count && isSegment(units[end]) { end += 1 }
        return end
    }

    private static func isSegment(_ unit: UInt16) -> Bool { unit < 128 && base64url[Int(unit)] >= 0 }
}
