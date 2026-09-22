// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The generated envelope renders `payload.vitals` as one flattened all-optional
// `Vital` (quicktype's rendering of the union). This is the only place the
// hand-written wire types meet it. `data` crosses via a JSON round-trip because
// `JSONAny` has no value initializer; at most 400 entries per report, so the
// cost is bounded and paid only at report time.
import Foundation
import TraceItXProtocol

extension Array where Element == VitalsEntry {
    func toGeneratedVitals() -> [Vital] {
        compactMap { e -> Vital? in
            switch e {
            case let .sample(s):
                return Vital(cpu: s.cpu, extras: s.extras, kind: .sample, mem: Double(s.mem), t: Double(s.t), data: nil, playerID: nil, truncated: nil, type: nil, name: nil)
            case let .player(p):
                guard let type = TypeEnum(rawValue: p.type) else { return nil }
                return Vital(cpu: nil, extras: nil, kind: .player, mem: nil, t: Double(p.t), data: p.data.flatMap(jsonAny), playerID: p.playerId, truncated: p.truncated, type: type, name: nil)
            case let .custom(c):
                return Vital(cpu: nil, extras: nil, kind: .custom, mem: nil, t: Double(c.t), data: c.data.flatMap(jsonAny), playerID: c.playerId, truncated: c.truncated, type: nil, name: c.name)
            }
        }
    }
}

private func jsonAny<T: Encodable>(_ v: T) -> JSONAny? {
    guard let data = try? JSONEncoder().encode(v) else { return nil }
    return try? JSONDecoder().decode(JSONAny.self, from: data)
}
