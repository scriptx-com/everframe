// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import Darwin
import EverframeProtocol
@_cdecl("inferred_payload_roundtrip")
public func inferredPayloadRoundtrip(_ input: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
    do {
        // The full memberwise initializer immediately before inferred terminations were added.
        let constructed = EverframePayload(annotations: nil, appleDiagnostic: nil, breadcrumbs: nil, crash: nil, diagnostic: nil,
            extra: "constructed", focus: nil, logs: nil, network: nil, networkBodies: nil, recoveredStall: nil,
            redactions: nil, resources: nil, vitals: nil)
        precondition(constructed.extra == "constructed")
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
        let value = try decoder.decode(EverframePayload.self, from: Data(String(cString: input).utf8))
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
        return strdup(String(data: try encoder.encode(value.with(extra: "old caller copy")), encoding: .utf8)!)
    } catch { return nil }
}
