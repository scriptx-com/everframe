// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import CoreFoundation
import Foundation
import EverframeProtocol

private let maxDetailsBytes = 8192
private let maxScanUnits = 4096
private let maxNodes = 128
private let maxContainerLevels = 4
private let maxSafeInteger: Int64 = 9_007_199_254_740_991

// These adapters preserve typed Swift storage. Conditional Foundation casts on
// Swift collections can bridge the entire input before any budget is applied.
private protocol CrashArraySlots {
    var crashCount: Int { get }
    func crashValue(at index: Int) -> Any
}
extension Array: CrashArraySlots {
    fileprivate var crashCount: Int { count }
    fileprivate func crashValue(at index: Int) -> Any { self[index] }
}

private protocol CrashDictionaryKeys {
    var crashCount: Int { get }
    func crashKeys() -> AnyIterator<String>
    func crashValue(forKey key: String) -> Any?
}
extension Dictionary: CrashDictionaryKeys where Key == String {
    fileprivate var crashCount: Int { count }
    fileprivate func crashKeys() -> AnyIterator<String> { AnyIterator(keys.makeIterator()) }
    fileprivate func crashValue(forKey key: String) -> Any? { self[key] }
}

// Only these owned primitives reach encoder dispatch. Object entries retain
// traversal order for first-key-wins and tail fitting; the encoder sorts keys.
private indirect enum OwnedCrashValue: Encodable {
    case null, bool(Bool), integer(Int64), number(Double), string(String)
    case array([OwnedCrashValue]), object([(String, OwnedCrashValue)])

    private struct Key: CodingKey {
        let stringValue: String
        var intValue: Int? { nil }
        init(_ value: String) { stringValue = value }
        init?(stringValue: String) { self.init(stringValue) }
        init?(intValue: Int) { return nil }
    }

    func encode(to encoder: Encoder) throws {
        switch self {
        case .object(let entries):
            var container = encoder.container(keyedBy: Key.self)
            for (key, value) in entries { try container.encode(value, forKey: Key(key)) }
        case .array(let values):
            var container = encoder.unkeyedContainer()
            for value in values { try container.encode(value) }
        default:
            var container = encoder.singleValueContainer()
            switch self {
            case .null: try container.encodeNil()
            case .bool(let value): try container.encode(value)
            case .integer(let value): try container.encode(value)
            case .number(let value): try container.encode(value)
            case .string(let value): try container.encode(value)
            case .array, .object: break
            }
        }
    }
}

private func javascriptStringBytes(_ value: String) -> Int {
    2 + value.unicodeScalars.reduce(0) { count, scalar in
        switch scalar.value {
        case 0x08, 0x09, 0x0a, 0x0c, 0x0d, 0x22, 0x5c: count + 2
        case 0x00...0x1f: count + 6
        default: count + String(scalar).utf8.count
        }
    }
}

private extension OwnedCrashValue {
    var javascriptEncodedBytes: Int {
        switch self {
        case .null: 4
        case .bool(let value): value ? 4 : 5
        case .integer(let value): esNumberText(Double(value)).utf8.count
        case .number(let value): esNumberText(value).utf8.count
        case .string(let value): javascriptStringBytes(value)
        case .array(let values):
            2 + values.reduce(0) { $0 + $1.javascriptEncodedBytes } + max(0, values.count - 1)
        case .object(let entries):
            2 + entries.reduce(0) {
                $0 + javascriptStringBytes($1.0) + 1 + $1.1.javascriptEncodedBytes
            } + max(0, entries.count - 1)
        }
    }
}

/// Projects host values synchronously without scheduling or retaining them.
/// Swift-thrown redactor failures are optional loss; Objective-C exceptions and
/// arbitrary host callback execution cannot be caught or preempted here.
func normalizeCrashDetails(_ options: CaptureExceptionOptions?,
                           redact: (String) throws -> String) -> EverframeCrashDetails {
    normalizeCrashDetails(options, redact: redact, inheritedTruncated: false)
}

func normalizeCrashDetails(_ options: CaptureExceptionOptions?,
                           redact: (String) throws -> String,
                           inheritedTruncated: Bool) -> EverframeCrashDetails {
    let source = options ?? CaptureExceptionOptions()
    return withoutActuallyEscaping(redact) { redact in
        let state = CrashProjection(redact: redact)
        let context = source.context.flatMap { state.text($0, limit: 256) }
        let metadata = source.metadata.flatMap { state.value($0, level: 1) }
        let severity: EverframeProtocol.EverframeErrorSeverity
        switch source.severity {
        case .info: severity = .info
        case .warning: severity = .warning
        case .error: severity = .error
        }
        return fitCrashDetails(metadata: metadata, context: context,
                               severity: severity,
                               truncated: inheritedTruncated || state.truncated)
    }
}

private final class CrashProjection {
    let redact: (String) throws -> String
    var nodes = 1 // metadata root
    var truncated = false
    var path = Set<ObjectIdentifier>()

    init(redact: @escaping (String) throws -> String) { self.redact = redact }

    private func consumeChild() -> Bool {
        guard nodes < maxNodes else { truncated = true; return false }
        nodes += 1
        return true
    }

    func value(_ input: Any, level: Int) -> OwnedCrashValue? {
        let result: OwnedCrashValue?
        // This gate MUST precede any Foundation collection cast.
        if type(of: input) is AnyClass {
            switch input {
            case let map as NSDictionary:
                result = reference(map, level: level) {
                    let keys = map.keyEnumerator()
                    return dictionary(count: map.count, level: level,
                                      next: { keys.nextObject() }, read: { map.object(forKey: $0) })
                }
            case let array as NSArray:
                result = reference(array, level: level) {
                    indexed(count: array.count, level: level, read: { array.object(at: $0) })
                }
            case let string as NSString: result = text(string, limit: 1024).map(OwnedCrashValue.string)
            case is NSNull: result = .null
            case is NSDecimalNumber: result = nil
            case let number as NSNumber: result = numeric(number)
            default: result = nil
            }
        } else {
            switch input {
            case let map as CrashDictionaryKeys:
                if level > maxContainerLevels { result = nil } else {
                    let keys = map.crashKeys()
                    result = dictionary(count: map.crashCount, level: level,
                                        next: { keys.next() }, read: { map.crashValue(forKey: $0) })
                }
            case let array as CrashArraySlots:
                result = level > maxContainerLevels ? nil : indexed(count: array.crashCount, level: level, read: array.crashValue)
            case let string as String: result = text(string, limit: 1024).map(OwnedCrashValue.string)
            case let bool as Bool: result = .bool(bool)
            case let number as Int: result = signed(Int64(number))
            case let number as Int8: result = signed(Int64(number))
            case let number as Int16: result = signed(Int64(number))
            case let number as Int32: result = signed(Int64(number))
            case let number as Int64: result = signed(number)
            case let number as UInt: result = unsigned(UInt64(number))
            case let number as UInt8: result = unsigned(UInt64(number))
            case let number as UInt16: result = unsigned(UInt64(number))
            case let number as UInt32: result = unsigned(UInt64(number))
            case let number as UInt64: result = unsigned(number)
            case let number as Float: result = number.isFinite ? .number(Double(number)) : nil
            case let number as Double: result = number.isFinite ? .number(number) : nil
            default: result = nil
            }
        }
        if result == nil { truncated = true }
        return result
    }

    private func reference(_ object: AnyObject, level: Int, project: () -> OwnedCrashValue) -> OwnedCrashValue? {
        let identity = ObjectIdentifier(object)
        guard level <= maxContainerLevels, path.insert(identity).inserted else { return nil }
        defer { path.remove(identity) }
        return project()
    }

    private func dictionary<Key>(count: Int, level: Int, next: () -> Key?, read: (Key) -> Any?) -> OwnedCrashValue {
        var output: [(String, OwnedCrashValue)] = []
        var accepted = Set<String>()
        for _ in 0..<count {
            guard consumeChild() else { break }
            guard let key = next(), let units = rawUnits(key, limit: maxScanUnits), units.count <= maxScanUnits else {
                truncated = true
                continue
            }
            guard let normalized = processedText(units, limit: 128), !accepted.contains(normalized) else {
                truncated = true
                continue
            }
            if crashDetailsKeyIsSensitive(units) {
                output.append((normalized, .string("[REDACTED]")))
                accepted.insert(normalized)
                continue
            }
            guard let child = read(key), let projected = value(child, level: level + 1) else {
                truncated = true
                continue
            }
            output.append((normalized, projected))
            accepted.insert(normalized)
        }
        return .object(output)
    }

    private func indexed(count: Int, level: Int, read: (Int) -> Any) -> OwnedCrashValue {
        var output: [OwnedCrashValue] = []
        for index in 0..<count {
            guard consumeChild() else { break }
            output.append(value(read(index), level: level + 1) ?? .null)
        }
        return .array(output)
    }

    private func signed(_ value: Int64) -> OwnedCrashValue? {
        (-maxSafeInteger...maxSafeInteger).contains(value) ? .integer(value) : nil
    }

    private func unsigned(_ value: UInt64) -> OwnedCrashValue? {
        value <= UInt64(maxSafeInteger) ? .integer(Int64(value)) : nil
    }

    private func numeric(_ value: NSNumber) -> OwnedCrashValue? {
        if CFGetTypeID(value) == CFBooleanGetTypeID() { return .bool(value.boolValue) }
        let type = value.objCType
        guard type[1] == 0 else { return nil }
        switch type[0] {
        case 99, 115, 105, 108, 113: return signed(value.int64Value) // c s i l q
        case 67, 83, 73, 76, 81: return unsigned(value.uint64Value) // C S I L Q
        case 102, 100: // f d
            let number = value.doubleValue
            return number.isFinite ? .number(number) : nil
        default: return nil
        }
    }

    func text(_ input: Any, limit: Int) -> String? {
        guard let units = rawUnits(input, limit: maxScanUnits) else { truncated = true; return nil }
        return processedText(units, limit: limit)
    }

    private func processedText(_ units: [UInt16], limit: Int) -> String? {
        let scanned = repairedText(units, limit: maxScanUnits)
        truncated = truncated || scanned.changed
        do {
            let redacted = try redact(scanned.text)
            let capped = repairedText(Array(redacted.utf16.prefix(limit + 1)), limit: limit)
            truncated = truncated || capped.changed
            return capped.text
        } catch {
            truncated = true
            return nil
        }
    }
}

// One lookahead unit detects truncation and prevents accepting half a pair.
// No full NSString conversion or Swift UTF16 count precedes this bounded read.
private func rawUnits(_ input: Any, limit: Int) -> [UInt16]? {
    if type(of: input) is AnyClass {
        guard let string = input as? NSString else { return nil }
        let count = min(string.length, limit + 1)
        var units: [UInt16] = []
        units.reserveCapacity(count)
        for index in 0..<count { units.append(string.character(at: index)) }
        return units
    }
    guard let string = input as? String else { return nil }
    return Array(string.utf16.prefix(limit + 1))
}

private func repairedText(_ units: [UInt16], limit: Int) -> (text: String, changed: Bool) {
    var output: [UInt16] = []
    var index = 0
    var changed = false
    while index < units.count && index < limit {
        let current = units[index]
        if (0xd800...0xdbff).contains(current), index + 1 < units.count,
           (0xdc00...0xdfff).contains(units[index + 1]) {
            guard index + 1 < limit else { changed = true; break }
            output.append(current); output.append(units[index + 1]); index += 2
        } else {
            if current == 0 || (0xd800...0xdfff).contains(current) {
                output.append(0xfffd); changed = true
            } else { output.append(current) }
            index += 1
        }
    }
    return (String(decoding: output, as: UTF16.self), changed || index < units.count)
}

func crashDetailsKeyIsSensitive(_ units: [UInt16]) -> Bool {
    var ascii: [UInt8] = []
    for unit in units {
        switch unit {
        case 48...57, 97...122: ascii.append(UInt8(unit))
        case 65...90: ascii.append(UInt8(unit + 32))
        default: break
        }
    }
    let key = String(decoding: ascii, as: UTF8.self)
    return ["password", "passwd", "secret", "token", "authorization", "cookie", "apikey"].contains { key.contains($0) }
}

private enum CrashTrim {
    case shorten(path: [Int], text: String)
    case remove(path: [Int])
}

private extension OwnedCrashValue {
    func lastTrim(path: [Int] = []) -> CrashTrim {
        switch self {
        case .array(let values) where !values.isEmpty:
            return values[values.count - 1].lastTrim(path: path + [values.count - 1])
        case .object(let entries) where !entries.isEmpty:
            return entries[entries.count - 1].1.lastTrim(path: path + [entries.count - 1])
        case .string(let text) where !text.isEmpty: return .shorten(path: path, text: text)
        default: return .remove(path: path)
        }
    }

    func replacing(path: ArraySlice<Int>, with replacement: OwnedCrashValue?) -> OwnedCrashValue? {
        guard let index = path.first else { return replacement }
        switch self {
        case .array(var values):
            if let child = values[index].replacing(path: path.dropFirst(), with: replacement) { values[index] = child }
            else { values.remove(at: index) }
            return .array(values)
        case .object(var entries):
            if let child = entries[index].1.replacing(path: path.dropFirst(), with: replacement) { entries[index].1 = child }
            else { entries.remove(at: index) }
            return .object(entries)
        default: return self
        }
    }
}

private func fitCrashDetails(metadata initial: OwnedCrashValue?, context: String?,
                             severity: EverframeProtocol.EverframeErrorSeverity, truncated: Bool) -> EverframeCrashDetails {
    let encoder = EnvelopeBuilder.makeJSONEncoder()
    func generated(_ metadata: OwnedCrashValue?, loss: Bool) throws -> EverframeCrashDetails {
        // EverframeJSONAny intentionally has no value initializer. The bounded, owned
        // tree is the only input to this encode/decode boundary.
        let values = try metadata.map { try JSONDecoder().decode([String: EverframeJSONAny].self, from: encoder.encode($0)) }
        return EverframeCrashDetails(context: context, metadata: values, severity: severity, truncated: loss ? true : nil)
    }
    func fits(_ details: EverframeCrashDetails, metadata: OwnedCrashValue?, loss: Bool) throws -> Bool {
        guard try encoder.encode(details).count <= maxDetailsBytes else { return false }
        var entries: [(String, OwnedCrashValue)] = [("severity", .string(severity.rawValue))]
        if let context { entries.append(("context", .string(context))) }
        if let metadata { entries.append(("metadata", metadata)) }
        if loss { entries.append(("truncated", .bool(true))) }
        return OwnedCrashValue.object(entries).javascriptEncodedBytes <= maxDetailsBytes
    }
    do {
        let details = try generated(initial, loss: truncated)
        if try fits(details, metadata: initial, loss: truncated) { return details }
        var metadata = initial
        while let current = metadata {
            switch current.lastTrim() {
            case .remove(let path): metadata = current.replacing(path: path[...], with: nil)
            case .shorten(let path, let text):
                let units = Array(text.utf16) // already owned and capped at 1024
                var low = 0, high = units.count
                var best: EverframeCrashDetails?
                while low <= high {
                    let middle = (low + high) / 2
                    let shorter = repairedText(units, limit: middle).text
                    let candidate = current.replacing(path: path[...], with: .string(shorter))
                    let details = try generated(candidate, loss: true)
                    if try fits(details, metadata: candidate, loss: true) { best = details; low = middle + 1 }
                    else { high = middle - 1 }
                }
                if let best { return best }
                metadata = current.replacing(path: path[...], with: .string(""))
            }
            let details = try generated(metadata, loss: true)
            if try fits(details, metadata: metadata, loss: true) { return details }
        }
    } catch {
        // Optional serialization loss never discards severity/context.
    }
    return EverframeCrashDetails(context: context, metadata: nil, severity: severity, truncated: true)
}
