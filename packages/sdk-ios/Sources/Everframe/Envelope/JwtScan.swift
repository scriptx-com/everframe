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
// segments, and it tries at most `maxGlue` + 1 starts (text glued before the header, such as `x_`
// or the `3D` of `%3D`, stays), each decoding at most `maxHeaderDecode` characters.
import Foundation

enum JwtScan {
    static let maxGlue = 64
    static let maxHeaderDecode = 1024
    private static let minHeader = 8
    private static let dot: UInt16 = 0x2E
    private static let base64url: [Int8] = {
        var table = [Int8](repeating: -1, count: 128)
        for (index, unit) in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".utf16.enumerated() {
            table[Int(unit)] = Int8(index)
        }
        return table
    }()
    private static let alg: [UInt8] = Array("\"alg\"".utf8)
    private static let enc: [UInt8] = Array("\"enc\"".utf8)

    static func replace(in input: String, with replacement: String) -> String {
        let units = Array(input.utf16)
        var decoded = [UInt8](repeating: 0, count: maxHeaderDecode / 4 * 3)
        var out: [UInt16] = []
        var copied = 0
        var index = 0
        var changed = false
        while index < units.count {
            guard isSegment(units[index]) else { index += 1; continue }
            let runEnd = segmentEnd(units, from: index)
            guard runEnd - index >= minHeader, runEnd < units.count, units[runEnd] == dot,
                  let token = tokenAt(units, runStart: index, headerEnd: runEnd, decoded: &decoded) else {
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
    private static func tokenAt(_ units: [UInt16], runStart: Int, headerEnd: Int,
                                decoded: inout [UInt8]) -> (start: Int, end: Int)? {
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
        for start in runStart...last {
            let kind = joseHeaderKind(units, start: start, end: headerEnd, decoded: &decoded)
            if kind == 0 { continue }
            if kind == 2 && fifthEnd >= 0 { return (start, fifthEnd) }
            if payloadLength >= 2 { return (start, thirdEnd) }
        }
        return nil
    }

    /// 0: not a JOSE header; 1: a header with "alg"; 2: it also names "enc" (a JWE).
    static func joseHeaderKind(_ units: [UInt16], start: Int, end: Int, decoded: inout [UInt8]) -> Int {
        let stop = min(end, start + maxHeaderDecode)
        var length = 0
        var opened = false
        var index = start
        while stop - index >= 2 {
            let remaining = stop - index
            let a = Int(base64url[Int(units[index])])
            let b = Int(base64url[Int(units[index + 1])])
            let c = remaining > 2 ? Int(base64url[Int(units[index + 2])]) : -1
            let d = remaining > 3 ? Int(base64url[Int(units[index + 3])]) : -1
            let count = c < 0 ? 1 : (d < 0 ? 2 : 3)
            for k in 0..<count {
                let byte: Int
                switch k {
                case 0: byte = (a << 2) | (b >> 4)
                case 1: byte = ((b & 15) << 4) | (c >> 2)
                default: byte = ((c & 3) << 6) | d
                }
                if !opened {
                    if byte == 0x7B { opened = true }
                    else if byte != 0x20 && byte != 0x09 && byte != 0x0A && byte != 0x0D { return 0 }
                }
                decoded[length] = UInt8(byte)
                length += 1
            }
            index += 4
        }
        guard opened, contains(decoded, length, alg) else { return 0 }
        return contains(decoded, length, enc) ? 2 : 1
    }

    private static func contains(_ bytes: [UInt8], _ length: Int, _ needle: [UInt8]) -> Bool {
        var index = 0
        while index + needle.count <= length {
            var k = 0
            while k < needle.count && bytes[index + k] == needle[k] { k += 1 }
            if k == needle.count { return true }
            index += 1
        }
        return false
    }

    private static func segmentEnd(_ units: [UInt16], from: Int) -> Int {
        var end = from
        while end < units.count && isSegment(units[end]) { end += 1 }
        return end
    }

    private static func isSegment(_ unit: UInt16) -> Bool { unit < 128 && base64url[Int(unit)] >= 0 }
}
