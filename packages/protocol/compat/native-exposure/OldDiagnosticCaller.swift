// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import Darwin
import EverframeProtocol
@_cdecl("old_diagnostic_roundtrip")
public func oldDiagnosticCopy(_ input: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
    do {
        let format = ISO8601DateFormatter()
        format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let value = try decoder.singleValueContainer().decode(String.self)
            guard let date = format.date(from: value) else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Invalid millisecond timestamp"))
            }
            return date
        }
        let v = try decoder.decode(EverframeDiagnosticEvidence.self, from: Data(String(cString: input).utf8))
        let constructed = EverframeDiagnosticEvidence(android: v.android, attribution: v.attribution, cause: v.cause,
            collectedAt: v.collectedAt, evidenceID: v.evidenceID, kind: v.kind, occurredAt: v.occurredAt,
            outcome: v.outcome, processLaunchID: v.processLaunchID, provenance: v.provenance,
            scope: v.scope, trace: v.trace, version: v.version)
        precondition(constructed.evidenceID == v.evidenceID)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(format.string(from: date))
        }
        return strdup(String(data: try encoder.encode(v.with(version: v.version)), encoding: .utf8)!)
    } catch { return nil }
}
