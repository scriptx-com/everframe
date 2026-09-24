// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import Foundation
import EverframeProtocol

private let rnCrashDetailsMaxNodes = 128
private let rnCrashDetailsMaxContainerLevels = 4
private let rnCrashDetailsMaxKeyScanUnits = 4_096

private struct RNCrashDetailsKey: CodingKey {
    let stringValue: String
    var intValue: Int? { nil }

    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

private final class RNCrashDetailsDecodeState {
    var nodes = 1 // metadata root
    var loss = false

    func consumeChild() -> Bool {
        guard nodes < rnCrashDetailsMaxNodes else {
            loss = true
            return false
        }
        nodes += 1
        return true
    }
}

struct RNCrashDetailsWire: Decodable {
    let severity: EverframeErrorSeverity
    let context: String?
    let metadata: [String: Any]?
    let truncated: Bool

    nonisolated(unsafe) static let invalid = RNCrashDetailsWire(
        severity: .error,
        context: nil,
        metadata: nil,
        truncated: true
    )

    private enum CodingKeys: String, CodingKey {
        case severity, context, metadata, truncated
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        var loss = false

        if values.contains(.severity) {
            if let raw = try? values.decode(String.self, forKey: .severity),
               let decoded = EverframeErrorSeverity(rawValue: raw) {
                severity = decoded
            } else {
                severity = .error
                loss = true
            }
        } else {
            severity = .error
        }

        if values.contains(.context) {
            if let decoded = try? values.decode(String.self, forKey: .context) {
                context = decoded
            } else {
                context = nil
                loss = true
            }
        } else {
            context = nil
        }

        if values.contains(.metadata) {
            let state = RNCrashDetailsDecodeState()
            if (try? values.decodeNil(forKey: .metadata)) == true {
                metadata = nil
                loss = true
            } else if let child = try? values.superDecoder(forKey: .metadata),
                      let decoded = RNCrashDetailsWire.decodeObject(
                        from: child, level: 1, state: state
                      ) {
                metadata = decoded
                loss = loss || state.loss
            } else {
                metadata = nil
                loss = true
            }
        } else {
            metadata = nil
        }

        if values.contains(.truncated) {
            if let decoded = try? values.decode(Bool.self, forKey: .truncated) {
                loss = loss || decoded
            } else {
                loss = true
            }
        }
        truncated = loss
    }

    private init(severity: EverframeErrorSeverity, context: String?,
                 metadata: [String: Any]?, truncated: Bool) {
        self.severity = severity
        self.context = context
        self.metadata = metadata
        self.truncated = truncated
    }

    private static func decodeValue(from decoder: Decoder, level: Int,
                                    state: RNCrashDetailsDecodeState) -> Any? {
        if let single = try? decoder.singleValueContainer() {
            if single.decodeNil() { return NSNull() }
            if let value = try? single.decode(Bool.self) { return value }
            if let value = try? single.decode(Double.self), value.isFinite { return value }
            if let value = try? single.decode(String.self) { return value }
        }
        if let value = decodeObject(from: decoder, level: level, state: state) {
            return value
        }
        if let value = decodeArray(from: decoder, level: level, state: state) {
            return value
        }
        return nil
    }

    private static func decodeObject(from decoder: Decoder, level: Int,
                                     state: RNCrashDetailsDecodeState) -> [String: Any]? {
        guard level <= rnCrashDetailsMaxContainerLevels,
              let values = try? decoder.container(keyedBy: RNCrashDetailsKey.self)
        else { return nil }

        var output: [String: Any] = [:]
        for key in values.allKeys {
            guard state.consumeChild() else { break }
            let units = Array(key.stringValue.utf16.prefix(rnCrashDetailsMaxKeyScanUnits + 1))
            guard units.count <= rnCrashDetailsMaxKeyScanUnits else {
                state.loss = true
                continue
            }
            if crashDetailsKeyIsSensitive(units) {
                output[key.stringValue] = "[REDACTED]"
                continue
            }
            guard let child = try? values.superDecoder(forKey: key),
                  let value = decodeValue(from: child, level: level + 1, state: state)
            else {
                state.loss = true
                continue
            }
            output[key.stringValue] = value
        }
        return output
    }

    private static func decodeArray(from decoder: Decoder, level: Int,
                                    state: RNCrashDetailsDecodeState) -> [Any]? {
        guard level <= rnCrashDetailsMaxContainerLevels,
              var values = try? decoder.unkeyedContainer()
        else { return nil }

        var output: [Any] = []
        while !values.isAtEnd {
            guard state.consumeChild() else { break }
            do {
                // superDecoder advances the charged parent slot even when the
                // child's scalar decoding fails (for example, JSON 1e400).
                let child = try values.superDecoder()
                if let value = decodeValue(from: child, level: level + 1, state: state) {
                    output.append(value)
                } else {
                    output.append(NSNull())
                    state.loss = true
                }
            } catch {
                output.append(NSNull())
                state.loss = true
            }
        }
        return output
    }
}

func normalizeRNCrashDetails(_ input: RNCrashDetailsWire?,
                             redact: (String) throws -> String) -> EverframeCrashDetails? {
    guard let input else { return nil }
    return normalizeCrashDetails(
        CaptureExceptionOptions(
            severity: input.severity,
            context: input.context,
            metadata: input.metadata
        ),
        redact: redact,
        inheritedTruncated: input.truncated
    )
}
