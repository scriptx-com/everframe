// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Twin of VitalsWireCodecTest.kt. Host-runnable: nothing here touches UIKit.
import XCTest
import TraceItXProtocol

final class VitalsWireTests: XCTestCase {
    private func json(_ data: Data) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testOptionalEntryFieldsAreAbsentNotNull() throws {
        let chunk = VitalsChunk(sessionId: "s", seq: 0, entries: [
            .sample(VitalsSample(t: 1, cpu: nil, mem: 5, extras: nil)),
            .player(VitalsPlayerEvent(t: 2, type: "play", playerId: nil, data: nil, truncated: nil)),
            .custom(VitalsCustomEntry(t: 3, name: "n", data: nil, truncated: nil, playerId: nil)),
        ])
        let obj = try json(VitalsWireCodec.encodePayload(.chunk(chunk)))
        XCTAssertEqual(obj["kind"] as? String, "chunk")
        let entries = try XCTUnwrap(obj["entries"] as? [[String: Any]])
        XCTAssertEqual(entries[0]["kind"] as? String, "sample")
        XCTAssertFalse(entries[0].keys.contains("cpu"))
        XCTAssertFalse(entries[0].keys.contains("extras"))
        XCTAssertEqual(entries[1]["kind"] as? String, "player")
        XCTAssertFalse(entries[1].keys.contains("playerId"))
        XCTAssertFalse(entries[1].keys.contains("data"))
        XCTAssertEqual(entries[2]["kind"] as? String, "custom")
        XCTAssertFalse(entries[2].keys.contains("truncated"))
    }

    func testSummaryNullableFieldsArePresentAsNullAndSeqAlwaysPresent() throws {
        let s = SessionSummary(
            sessionId: "s", final: true, seq: 0, startedAt: 1, durationMs: 0, playtimeMs: 0,
            startupTimeMs: nil, rebufferCount: 0, rebufferDurationMs: 0, bitrateMean: nil, errorCount: 0,
            memPeak: 0, memAvg: 0, playerCount: 0, playerCountSaturated: false,
            dims: SessionSummaryDims(platform: "ios", appVersion: "1", sdkVersion: "0.7.0", deviceModel: nil, osVersion: nil))
        let obj = try json(VitalsWireCodec.encodePayload(.summary(s)))
        XCTAssertTrue(obj.keys.contains("startupTimeMs"))
        XCTAssertTrue(obj["startupTimeMs"] is NSNull)
        XCTAssertTrue(obj["bitrateMean"] is NSNull)
        XCTAssertEqual(obj["seq"] as? Int, 0)
        let dims = try XCTUnwrap(obj["dims"] as? [String: Any])
        XCTAssertFalse(dims.keys.contains("deviceModel"))   // optional dims are OMITTED, not null
    }

    func testRequestWrapperIsPayloadOnly() throws {
        let chunk = VitalsChunk(sessionId: "s", seq: 1, entries: [])
        let obj = try json(VitalsWireCodec.encodeRequest(.chunk(chunk)))
        XCTAssertEqual(Array(obj.keys), ["payload"])
        XCTAssertNil(obj["apiKey"])
    }

    func testUtf8LengthCountsBytesNotCodeUnits() {
        XCTAssertEqual(VitalsWireCodec.utf8Length("abc"), 3)
        XCTAssertEqual(VitalsWireCodec.utf8Length("é"), 2)
        XCTAssertEqual(VitalsWireCodec.utf8Length("😀"), 4)
    }

    func testExtrasKeepLargeDoublesAsPlainDigits() throws {
        let chunk = VitalsChunk(sessionId: "s", seq: 0, entries: [
            .sample(VitalsSample(t: 1, cpu: nil, mem: 5, extras: ["availableMemory": 41943040.0, "thermalState": 1.0])),
        ])
        let text = try String(decoding: VitalsWireCodec.encodePayload(.chunk(chunk)), as: UTF8.self)
        XCTAssertTrue(text.contains("41943040"), text)
        XCTAssertFalse(text.lowercased().contains("e+"), text)
    }

    func testDecodePayloadRoundTripsAChunkWithAllThreeKinds() throws {
        let chunk = VitalsChunk(sessionId: "s", seq: 7, entries: [
            .sample(VitalsSample(t: 1, cpu: 0.5, mem: 5, extras: ["a": 1])),
            .player(VitalsPlayerEvent(t: 2, type: "seek", playerId: "p1", data: ["fromMs": .int(1), "toMs": .int(2)], truncated: nil)),
            .custom(VitalsCustomEntry(t: 3, name: "n", data: .object(["k": .string("v")]), truncated: true, playerId: "p1")),
        ])
        let data = try VitalsWireCodec.encodePayload(.chunk(chunk))
        XCTAssertEqual(try VitalsWireCodec.decodePayload(data), .chunk(chunk))
    }

    func testEncodeEntryMatchesTheEntryInsideAChunk() throws {
        let e = VitalsEntry.player(VitalsPlayerEvent(t: 2, type: "play", playerId: "p1", data: nil, truncated: nil))
        let alone = try json(VitalsWireCodec.encodeEntry(e))
        let inChunk = try json(VitalsWireCodec.encodePayload(.chunk(VitalsChunk(sessionId: "s", seq: 0, entries: [e]))))
        let first = try XCTUnwrap((inChunk["entries"] as? [[String: Any]])?.first)
        XCTAssertEqual(alone as NSDictionary, first as NSDictionary)
    }

    func testPlayerEventTypesAllMatchesTheProtocolEnum() {
        XCTAssertEqual(VitalsPlayerEventTypes.all, [
            "play", "pause", "seek", "buffer_start", "buffer_end", "bitrate_change", "rate_change", "error",
            "startup", "dropped_frames", "source_change", "player_attach", "player_detach", "drm", "quality_change", "stats",
        ])
    }
}
