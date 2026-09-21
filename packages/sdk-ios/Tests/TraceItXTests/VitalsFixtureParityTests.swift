// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Twin of VitalsFixtureParityTest.kt. The fixture copy under Fixtures/ is
// pinned byte-for-byte to packages/protocol/__tests__/fixtures/vitals-ios.v1.json
// by fixture-sync.spec.ts. Comparison is on PARSED JSON (NSDictionary
// equality), so integral doubles and ints compare equal regardless of text.
import XCTest
import TraceItXProtocol
@testable import TraceItXKit

final class VitalsFixtureParityTests: XCTestCase {
    private let sid = "0f0e5b2a-6a1e-4c8b-9d3f-2b7c1a9e4d10"

    private func fixture() throws -> [String: Any] {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "vitals-ios.v1", withExtension: "json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }
    private func parsed(_ data: Data) throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)
    }
    private func player(_ t: Int64, _ type: String, _ data: [String: VitalsJSON]? = nil) -> VitalsEntry {
        .player(VitalsPlayerEvent(t: t, type: type, playerId: "p1", data: data))
    }

    private var chunk: VitalsChunk {
        VitalsChunk(sessionId: sid, seq: 3, entries: [
            .sample(VitalsSample(t: 1757000000000, cpu: 0.42, mem: 183500800, extras: ["availableMemory": 1073741824, "thermalState": 1])),
            .sample(VitalsSample(t: 1757000020000, mem: 190000000)),
            player(1757000001000, "player_attach", ["name": .string("main"), "tag": .string("video"), "library": .string("avplayer"), "libraryVersion": .string("18.5")]),
            player(1757000001100, "source_change", ["src": .string("https://cdn.example.com/live/master.m3u8"), "protocol": .string("hls"), "live": .bool(true)]),
            player(1757000002400, "startup", ["ttffMs": .int(1300), "accessLogStartupMs": .int(1210)]),
            player(1757000002400, "drm", ["keySystem": .string("fairplay")]),
            player(1757000002500, "play"),
            player(1757000005000, "bitrate_change", ["bitrate": .int(2800000), "width": .int(1280), "height": .int(720), "reason": .string("abr")]),
            player(1757000009000, "buffer_start"),
            player(1757000009800, "buffer_end", ["durationMs": .int(800)]),
            player(1757000012000, "seek", ["fromMs": .int(9800), "toMs": .int(60000)]),
            player(1757000013000, "rate_change", ["rate": .double(1.5)]),
            player(1757000014000, "quality_change", ["width": .int(1920), "height": .int(1080)]),
            player(1757000020000, "stats", ["bufferAheadMs": .int(12400), "bandwidthEstimate": .int(5200000), "bitrate": .int(2800000), "width": .int(1280), "height": .int(720), "droppedFrames": .int(2)]),
            player(1757000021000, "error", ["message": .string("Source error"), "code": .string("CoreMediaErrorDomain:-12889"), "fatal": .bool(false), "detail": .string("CoreMediaErrorDomain cdn.example.com")]),
            player(1757000022000, "pause"),
            player(1757000023000, "player_detach"),
            .custom(VitalsCustomEntry(t: 1757000015000, name: "ad_break", data: .object(["position": .string("midroll"), "adCount": .int(2)]), playerId: "p1")),
            .custom(VitalsCustomEntry(t: 1757000016000, name: "cdn_switch", data: .object(["truncated": .bool(true), "preview": .string("{\"from\":\"cdn-a\"")]), truncated: true)),
        ])
    }
    private var summary: SessionSummary {
        SessionSummary(sessionId: sid, final: false, seq: 1, startedAt: 1757000000000, durationMs: 23000, playtimeMs: 19500,
                       startupTimeMs: 1300, rebufferCount: 1, rebufferDurationMs: 800, bitrateMean: 2800000, errorCount: 1,
                       memPeak: 190000000, memAvg: 186750400, playerCount: 1, playerCountSaturated: false,
                       dims: SessionSummaryDims(platform: "ios", appVersion: "1.4.2", sdkVersion: "0.7.0", deviceModel: "iPhone16,1", osVersion: "18.5.0"))
    }
    private var summaryNulls: SessionSummary {
        SessionSummary(sessionId: "5a2d9c11-0b6e-4f7a-8c3d-1e2f3a4b5c6d", final: true, seq: 0, startedAt: 1757000000000, durationMs: 0, playtimeMs: 0,
                       startupTimeMs: nil, rebufferCount: 0, rebufferDurationMs: 0, bitrateMean: nil, errorCount: 0,
                       memPeak: 0, memAvg: 0, playerCount: 0, playerCountSaturated: false,
                       dims: SessionSummaryDims(platform: "tvos", appVersion: "1.4.2", sdkVersion: "0.7.0"))
    }

    /// Codex round-4, #4 — Swift-produced NUMERIC payloads on either side of the custom-data cap,
    /// so the TypeScript side can put them through the real `VitalsCustomEntry` refinement.
    /// 93 × 1e20 is 2047 bytes of `JSON.stringify` (and 559 of Foundation's) so it goes through
    /// untouched; 100 × 1e20 is 2201 bytes of `JSON.stringify` and only 601 of Foundation's, so
    /// before the budget was taught JavaScript's number formatting the SDK sent it whole and
    /// ingest rejected the WHOLE chunk. Regenerating this fixture from that SDK would produce a
    /// second entry the TypeScript refinement refuses.
    private var numericCustom: VitalsChunk {
        let fits = boundJson(.array(Array(repeating: .double(1e20), count: 93)))
        let over = boundJson(.array(Array(repeating: .double(1e20), count: 100)))
        return VitalsChunk(sessionId: "7c1d4e88-3a52-4b19-8e0d-6f5a2c3b1d04", seq: 0, entries: [
            .custom(VitalsCustomEntry(t: 1757000030000, name: "values", data: fits.data,
                                      truncated: fits.truncated ? true : nil)),
            .custom(VitalsCustomEntry(t: 1757000031000, name: "values_over", data: over.data,
                                      truncated: over.truncated ? true : nil)),
        ])
    }
    func testANumericCustomPayloadOnTheCapEncodesToTheCanonicalFixture() throws {
        XCTAssertEqual(try parsed(VitalsWireCodec.encodePayload(.chunk(numericCustom))), try XCTUnwrap(fixture()["numericCustom"] as? NSDictionary))
    }
    func testChunkEncodesToTheCanonicalFixture() throws {
        XCTAssertEqual(try parsed(VitalsWireCodec.encodePayload(.chunk(chunk))), try XCTUnwrap(fixture()["chunk"] as? NSDictionary))
    }
    func testSummaryEncodesToTheCanonicalFixture() throws {
        XCTAssertEqual(try parsed(VitalsWireCodec.encodePayload(.summary(summary))), try XCTUnwrap(fixture()["summary"] as? NSDictionary))
    }
    func testSummaryWithNullsEncodesToTheCanonicalFixture() throws {
        XCTAssertEqual(try parsed(VitalsWireCodec.encodePayload(.summary(summaryNulls))), try XCTUnwrap(fixture()["summaryNulls"] as? NSDictionary))
    }
    func testFixtureDecodesAndReEncodesIdempotently() throws {
        for key in ["chunk", "summary", "summaryNulls", "numericCustom"] {
            let raw = try XCTUnwrap(fixture()[key])
            let data = try JSONSerialization.data(withJSONObject: raw)
            let decoded = try VitalsWireCodec.decodePayload(data)
            XCTAssertEqual(try parsed(VitalsWireCodec.encodePayload(decoded)), raw as? NSDictionary, key)
        }
    }
}
