// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import Darwin
import EverframeProtocol
@_cdecl("e8_payload_roundtrip")
public func e8PayloadCopy(_ input: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
    do {
        let constructed = EverframePayload(annotations: nil, breadcrumbs: nil, crash: nil, diagnostic: nil,
            extra: "constructed", focus: nil, logs: nil, network: nil, networkBodies: nil,
            redactions: nil, resources: nil, vitals: nil)
        precondition(constructed.extra == "constructed")
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
        let value = try decoder.decode(EverframePayload.self, from: Data(String(cString: input).utf8))
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
        let copied = value.with(diagnostic: .some(value.diagnostic), extra: "e8 caller copy")
        return strdup(String(data: try encoder.encode(copied), encoding: .utf8)!)
    } catch { return nil }
}
