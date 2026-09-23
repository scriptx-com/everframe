// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// RN vitals bridge parity (spec 2026-09-06 §5): drives RemotePlayerIntegration
// through the same call script as the Kotlin twin
// (RemotePlayerFixtureParityTest) via vitals-rn-bridge.v1.json.
//
// The fixture conventions, documented in the file's own `comment` field and
// implemented identically here and in Kotlin:
//   • `seedNow` is the clock injected into the integration, so the emissions it
//     ORIGINATES (attach/describe seeds, the spans detach() closes) carry a
//     deterministic `t` — codex round-1 C2 made those stamped rather than nil.
//     It is the STARTING value: a `clock` op moves it mid-scenario (codex
//     round-3 E1, which made a seed's instant a floor for later span
//     transitions, so one fixed clock could no longer say both "the seed came
//     before these forwarded events" and "the detach came after them").
//   • JSON cannot carry NaN, so the STRING "NaN" inside a `stats` object means
//     the double NaN and is translated when the stats map is built.
import XCTest
@testable import EverframeKit

final class RemotePlayerFixtureParityTests: XCTestCase {
    private final class Ctx: PlayerIntegrationContext {
        var emitted: [[String: Any]] = []
        func emit(_ type: String, data: [String: Any?]?, t: Int64?) -> Bool {
            var e: [String: Any] = ["type": type]
            if let t { e["t"] = t }
            if let data { e["data"] = data.compactMapValues { $0 } }
            emitted.append(e); return true
        }
        func now() -> Int64 { 0 }
    }

    /// The "NaN" string convention — see the header.
    private static func statsMap(_ o: [String: Any]) -> [String: Any] {
        o.mapValues { v in (v as? String) == "NaN" ? Double.nan : v }
    }

    func testEveryScenarioEmitsExactlyTheExpectedCalls() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "vitals-rn-bridge.v1", withExtension: "json"))
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let seedNow = try XCTUnwrap(root["seedNow"] as? NSNumber).int64Value
        let scenarios = try XCTUnwrap(root["scenarios"] as? [[String: Any]])
        XCTAssertFalse(scenarios.isEmpty, "fixture has no scenarios")
        for scenario in scenarios {
            let name = scenario["name"] as! String
            let keep = scenario["keepQuery"] as! Bool
            var clock = seedNow
            let i = RemotePlayerIntegration(library: "fixture", version: nil, captureSourceQuery: { keep }, now: { clock })
            let ctx = Ctx(); var snap: PlayerSnapshot?
            for call in scenario["calls"] as! [[String: Any]] {
                switch call["op"] as! String {
                case "clock": clock = (call["t"] as! NSNumber).int64Value
                case "attach": _ = i.attach(ctx)
                case "describe": i.describe(ctx)
                case "detach": i.detach()
                case "record": i.record(call["type"] as! String, t: (call["t"] as! NSNumber).int64Value, data: call["data"] as? [String: Any])
                case "stats": i.updateStats(Self.statsMap(call["stats"] as! [String: Any]))
                case "snapshot": i.snapshot { snap = $0; return true }
                default: XCTFail("unknown op in \(name)")
                }
            }
            let expected = scenario["expect"] as! [[String: Any]]
            XCTAssertEqual(NSArray(array: ctx.emitted), NSArray(array: expected), name)
            // `expectSnapshot: null` asserts there was NO snapshot this tick (an idle
            // integration, or one whose stats cache a source_change cleared); an object
            // asserts field by field, and an ABSENT expected field asserts a dropped one.
            if let raw = scenario["expectSnapshot"] {
                if raw is NSNull {
                    XCTAssertNil(snap, name)
                } else {
                    let exp = try XCTUnwrap(raw as? [String: Any], name)
                    let s = try XCTUnwrap(snap, name)
                    XCTAssertEqual(s.bufferAheadMs, (exp["bufferAheadMs"] as? NSNumber)?.int64Value, name)
                    XCTAssertEqual(s.bandwidthEstimate, (exp["bandwidthEstimate"] as? NSNumber)?.int64Value, name)
                    XCTAssertEqual(s.bitrate, (exp["bitrate"] as? NSNumber)?.intValue, name)
                    XCTAssertEqual(s.width, (exp["width"] as? NSNumber)?.intValue, name)
                    XCTAssertEqual(s.height, (exp["height"] as? NSNumber)?.intValue, name)
                    XCTAssertEqual(s.droppedFramesDelta, (exp["droppedFramesDelta"] as? NSNumber)?.intValue ?? 0, name)
                }
            }
        }
    }
}
