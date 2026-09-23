// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The generated envelope renders `payload.vitals` as one flattened all-optional
// `EverframeVital` (quicktype's rendering of the union). This is the only place the
// hand-written wire types meet it. `data` crosses via a JSON round-trip because
// `EverframeJSONAny` has no value initializer; at most 400 entries per report, so the
// cost is bounded and paid only at report time.
import Foundation
import EverframeProtocol

extension Array where Element == VitalsEntry {
    func toGeneratedVitals() -> [EverframeVital] {
        compactMap { e -> EverframeVital? in
            switch e {
            case let .sample(s):
                return EverframeVital(cpu: s.cpu, extras: s.extras, kind: .sample, mem: Double(s.mem), t: Double(s.t), data: nil, playerID: nil, truncated: nil, type: nil, name: nil)
            case let .player(p):
                guard let type = EverframeType(rawValue: p.type) else { return nil }
                return EverframeVital(cpu: nil, extras: nil, kind: .player, mem: nil, t: Double(p.t), data: p.data.flatMap(jsonAny), playerID: p.playerId, truncated: p.truncated, type: type, name: nil)
            case let .custom(c):
                return EverframeVital(cpu: nil, extras: nil, kind: .custom, mem: nil, t: Double(c.t), data: c.data.flatMap(jsonAny), playerID: c.playerId, truncated: c.truncated, type: nil, name: c.name)
            }
        }
    }
}

private func jsonAny<T: Encodable>(_ v: T) -> EverframeJSONAny? {
    guard let data = try? JSONEncoder().encode(v) else { return nil }
    return try? JSONDecoder().decode(EverframeJSONAny.self, from: data)
}
