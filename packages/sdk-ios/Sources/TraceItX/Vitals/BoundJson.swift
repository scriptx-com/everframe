// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Port of packages/sdk-core/src/vitals/bound-json.ts via BoundJson.kt. Same
// never-throw discipline; measures UTF-8 bytes of the compact serialised form.
import Foundation
import TraceItXProtocol

struct BoundedJson: Equatable { let data: VitalsJSON?; let truncated: Bool }
struct BoundedStructuredJson: Equatable { let data: [String: VitalsJSON]?; let truncated: Bool }

private let maxNestedFieldBytes = 256

/// Compact JSON text for one value (sorted keys, unescaped slashes — the same
/// encoder settings VitalsWireCodec uses, so byte counts agree with the wire).
func encodedJSONText(_ v: VitalsJSON) -> String {
    // `VitalsJSON` is a top-level enum with a singleValueContainer: JSONEncoder
    // accepts fragments (strings, numbers) at the top level since iOS 13.
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    guard let d = try? e.encode(v) else { return "null" }
    return String(decoding: d, as: UTF8.self)
}

/// `Number::toString` (ECMA-262 §6.1.6.1.20) for one double — the text `JSON.stringify` writes,
/// which is NOT what Foundation writes.
///
/// Codex round-4, #4 — the custom-data budget has to measure the SERVER's serialization. Ingest
/// refines a custom entry with `utf8ByteLength(JSON.stringify(e.data))` against
/// `MAX_CUSTOM_DATA_BYTES` (`packages/protocol/src/vitals.ts`), and JavaScript prints an
/// integral double up to 1e21 in full while Foundation switches to exponent notation an order of
/// magnitude earlier: `1e20` is six bytes here and twenty-one there. So
/// `trackVitals("values", data: Array(repeating: 1e20, count: 100))` measured 601 bytes, sailed
/// under the 2048-byte cap untruncated, and reserialized to 2201 bytes in JavaScript — and the
/// refinement rejects the WHOLE chunk, losing every unrelated sample and player event in it.
///
/// Swift's own `description` is already the shortest decimal that round-trips, which is the same
/// digit string ECMAScript's algorithm picks; only the FORMATTING rules differ, so the text is
/// re-assembled from those digits here rather than recomputed.
func esNumberText(_ d: Double) -> String {
    guard d.isFinite else { return "null" }     // JSON.stringify(NaN) / (Infinity) === "null"
    if d == 0 { return "0" }                    // …and JSON.stringify(-0) === "0"
    let negative = d < 0
    var s = String(abs(d))
    var exp10 = 0
    if let e = s.firstIndex(where: { $0 == "e" || $0 == "E" }) {
        exp10 = Int(s[s.index(after: e)...]) ?? 0
        s = String(s[s.startIndex..<e])
    }
    var intPart = s, fracPart = ""
    if let dot = s.firstIndex(of: ".") {
        intPart = String(s[s.startIndex..<dot]); fracPart = String(s[s.index(after: dot)...])
    }
    // ECMAScript's k and n: the value is 0.<digits> × 10^n, with `digits` free of leading and
    // trailing zeros.
    var digits = Array(intPart + fracPart)
    var n = intPart.count + exp10
    while digits.first == "0" { digits.removeFirst(); n -= 1 }
    while digits.last == "0" { digits.removeLast() }
    if digits.isEmpty { return "0" }
    let k = digits.count
    let ds = String(digits)
    let sign = negative ? "-" : ""
    if k <= n && n <= 21 { return sign + ds + String(repeating: "0", count: n - k) }
    if n > 0 && n <= 21 {
        let i = ds.index(ds.startIndex, offsetBy: n)
        return sign + ds[..<i] + "." + ds[i...]
    }
    if n > -6 && n <= 0 { return sign + "0." + String(repeating: "0", count: -n) + ds }
    let e = n - 1
    let expPart = "e" + (e >= 0 ? "+" : "-") + String(abs(e))
    if k == 1 { return sign + ds + expPart }
    let i = ds.index(ds.startIndex, offsetBy: 1)
    return sign + ds[..<i] + "." + ds[i...] + expPart
}

/// UTF-8 bytes of `JSON.stringify(v)`. Structure and string escaping are measured through
/// Foundation, whose output is byte-identical to JavaScript's for both (`.withoutEscapingSlashes`
/// matches `JSON.stringify`, and sorted keys change no lengths); only NUMBERS are re-measured.
/// Integers go through the same path because JavaScript has no integer type: it parses one into
/// a double and prints it back, so `Int64.max` reserializes as `9223372036854776000`.
func jsonStringifyByteLength(_ v: VitalsJSON) -> Int {
    switch v {
    case .null: return 4
    case let .bool(b): return b ? 4 : 5
    case let .int(i): return esNumberText(Double(i)).utf8.count
    case let .double(d): return esNumberText(d).utf8.count
    case .string: return VitalsWireCodec.utf8Length(encodedJSONText(v))
    case let .array(a): return 2 + a.reduce(0) { $0 + jsonStringifyByteLength($1) } + max(0, a.count - 1)
    case let .object(o):
        return 2 + o.reduce(0) { $0 + VitalsWireCodec.utf8Length(encodedJSONText(.string($1.key))) + 1 + jsonStringifyByteLength($1.value) }
            + max(0, o.count - 1)
    }
}

private func withinCap(_ v: VitalsJSON, _ maxBytes: Int) -> Bool {
    jsonStringifyByteLength(v) <= maxBytes
}

/// Cut to at most `maxBytes` of UTF-8 without splitting a code point.
func cutUTF8(_ s: String, maxBytes: Int) -> String {
    var out = String.UnicodeScalarView()
    var bytes = 0
    for scalar in s.unicodeScalars {
        let b = String(scalar).utf8.count
        if bytes + b > maxBytes { break }
        bytes += b
        out.append(scalar)
    }
    return String(out)
}

func boundJson(_ value: VitalsJSON?, maxBytes: Int = VitalsLimits.maxCustomDataBytes) -> BoundedJson {
    guard let value else { return BoundedJson(data: nil, truncated: false) }
    if withinCap(value, maxBytes) { return BoundedJson(data: value, truncated: false) }
    let serialised = encodedJSONText(value)
    var budget = maxBytes / 2
    while budget > 0 {
        let candidate = VitalsJSON.object(["truncated": .bool(true), "preview": .string(cutUTF8(serialised, maxBytes: budget))])
        if withinCap(candidate, maxBytes) { return BoundedJson(data: candidate, truncated: true) }
        budget >>= 1
    }
    let shell = VitalsJSON.object(["truncated": .bool(true), "preview": .string("")])
    return withinCap(shell, maxBytes) ? BoundedJson(data: shell, truncated: true) : BoundedJson(data: nil, truncated: true)
}

private func fieldFragmentBytes(_ key: String, _ value: VitalsJSON) -> Int {
    VitalsWireCodec.utf8Length(encodedJSONText(.string(key))) + 1 + jsonStringifyByteLength(value)
}

private func truncateFieldToFit(_ key: String, _ raw: String, _ fragBudget: Int) -> String? {
    if fragBudget < 0 { return nil }
    var rawBudget = fragBudget / 2
    while rawBudget > 0 {
        let candidate = cutUTF8(raw, maxBytes: rawBudget)
        if fieldFragmentBytes(key, .string(candidate)) <= fragBudget { return candidate }
        rawBudget >>= 1
    }
    return fieldFragmentBytes(key, .string("")) <= fragBudget ? "" : nil
}

/// Player-event data: keep every scalar, shrink string fields (smallest
/// first), keep nested values only when small. Structure-preserving.
func boundStructuredJson(_ value: [String: VitalsJSON]?, maxBytes: Int) -> BoundedStructuredJson {
    guard let value else { return BoundedStructuredJson(data: nil, truncated: false) }
    if withinCap(.object(value), maxBytes) { return BoundedStructuredJson(data: value, truncated: false) }

    var kept: [String: VitalsJSON] = [:]
    struct Str { let key: String; let raw: String; let fragBytes: Int }
    var strings: [Str] = []
    for (k, v) in value.sorted(by: { $0.key < $1.key }) {
        switch v {
        case let .string(s): strings.append(Str(key: k, raw: s, fragBytes: fieldFragmentBytes(k, v)))
        case .null, .bool, .int, .double: kept[k] = v
        case .array, .object:
            if jsonStringifyByteLength(v) <= maxNestedFieldBytes { kept[k] = v }
        }
    }
    strings.sort { $0.fragBytes < $1.fragBytes }
    let n = strings.count
    var prefix = [Int](repeating: 0, count: n + 1)
    for i in 0..<n { prefix[i + 1] = prefix[i] + strings[i].fragBytes }

    var keptFragBytes = 0
    for (k, v) in kept { keptFragBytes += fieldFragmentBytes(k, v) }
    let assumedFieldCount = kept.count + n
    let commaBytes = assumedFieldCount > 0 ? assumedFieldCount - 1 : 0
    let budgetForStrings = maxBytes - 2 - commaBytes - keptFragBytes

    var k = 0
    while k < n && prefix[k + 1] <= budgetForStrings { k += 1 }

    var finalStrings: [String: VitalsJSON] = [:]
    for i in 0..<k { finalStrings[strings[i].key] = .string(strings[i].raw) }
    if k < n {
        let leftover = budgetForStrings - prefix[k]
        if let cut = truncateFieldToFit(strings[k].key, strings[k].raw, leftover) { finalStrings[strings[k].key] = .string(cut) }
    }

    let candidate = kept.merging(finalStrings) { _, new in new }
    if withinCap(.object(candidate), maxBytes) { return BoundedStructuredJson(data: candidate, truncated: true) }
    if k < n {
        finalStrings.removeValue(forKey: strings[k].key)
        let without = kept.merging(finalStrings) { _, new in new }
        if withinCap(.object(without), maxBytes) { return BoundedStructuredJson(data: without, truncated: true) }
    }
    return withinCap(.object(kept), maxBytes) ? BoundedStructuredJson(data: kept, truncated: true) : BoundedStructuredJson(data: nil, truncated: true)
}
