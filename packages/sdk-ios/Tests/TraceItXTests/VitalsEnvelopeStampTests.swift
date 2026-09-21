// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import TraceItXProtocol
@testable import TraceItXKit

final class VitalsEnvelopeStampTests: XCTestCase {
    private func envelope(stamp: VitalsStamp?) throws -> [String: Any] {
        let b = EnvelopeBuilder(vitalsStamp: { stamp })
        let (bytes, _) = try b.buildEncoded(reportId: UUID(), sdkVersion: "0.7.0", extra: ["title": "t", "description": "d"])
        return try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
    }
    func testNoCollectorStampsNeitherSessionIdNorVitals() throws {
        let e = try envelope(stamp: nil)
        XCTAssertNil(e["sessionId"]); XCTAssertNil((e["payload"] as? [String: Any])?["vitals"])
    }
    func testARunningCollectorStampsSessionIdAndTheRecentRing() throws {
        let stamp = VitalsStamp(sessionId: "sid-1", entries: [
            .sample(VitalsSample(t: 1, cpu: 0.2, mem: 5, extras: ["thermalState": 1])),
            .player(VitalsPlayerEvent(t: 2, type: "play", playerId: "p1", data: nil)),
            .custom(VitalsCustomEntry(t: 3, name: "n", data: .object(["k": .int(1)]), truncated: true, playerId: "p1")),
        ])
        let e = try envelope(stamp: stamp)
        XCTAssertEqual(e["sessionId"] as? String, "sid-1")
        let vitals = try XCTUnwrap((e["payload"] as? [String: Any])?["vitals"] as? [[String: Any]])
        XCTAssertEqual(vitals.map { $0["kind"] as? String }, ["sample", "player", "custom"])
        XCTAssertEqual(vitals[1]["type"] as? String, "play"); XCTAssertEqual(vitals[1]["playerId"] as? String, "p1")
        XCTAssertEqual((vitals[2]["data"] as? [String: Any])?["k"] as? Int, 1); XCTAssertEqual(vitals[2]["truncated"] as? Bool, true)
        XCTAssertEqual((vitals[0]["extras"] as? [String: Any])?["thermalState"] as? Double, 1)
    }
    func testAnEmptyRingStillStampsSessionIdButOmitsVitals() throws {
        let e = try envelope(stamp: VitalsStamp(sessionId: "sid-1", entries: []))
        XCTAssertEqual(e["sessionId"] as? String, "sid-1"); XCTAssertNil((e["payload"] as? [String: Any])?["vitals"])
    }
    func testTheStampIsCappedAt400NewestEntries() throws {
        let entries = (0..<500).map { VitalsEntry.sample(VitalsSample(t: Int64($0), mem: 1)) }
        let e = try envelope(stamp: VitalsStamp(sessionId: "s", entries: entries))
        let vitals = try XCTUnwrap((e["payload"] as? [String: Any])?["vitals"] as? [[String: Any]])
        XCTAssertEqual(vitals.count, 400); XCTAssertEqual(vitals.first?["t"] as? Int, 100)
    }
    func testAnUnknownPlayerTypeIsDroppedFromTheStampNotTheReport() throws {
        let e = try envelope(stamp: VitalsStamp(sessionId: "s", entries: [.player(VitalsPlayerEvent(t: 1, type: "not_a_type", playerId: "p1"))]))
        XCTAssertEqual(e["sessionId"] as? String, "s"); XCTAssertNil((e["payload"] as? [String: Any])?["vitals"])
    }
    func testTheStampedEnvelopeStillValidatesAgainstTheGeneratedDecoder() throws {
        let b = EnvelopeBuilder(vitalsStamp: { VitalsStamp(sessionId: "sid", entries: [.player(VitalsPlayerEvent(t: 2, type: "stats", playerId: "p1", data: ["bufferAheadMs": .int(5)]))]) })
        let (bytes, _) = try b.buildEncoded(reportId: UUID(), sdkVersion: "0.7.0", extra: ["title": "t", "description": "d"])
        let env = try ReportEnvelope(data: bytes)
        XCTAssertEqual(env.sessionID, "sid"); XCTAssertEqual(env.payload.vitals?.first?.type, .stats)
    }
}
