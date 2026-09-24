// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// PROTO-02 cross-SDK fixture parity — Swift side of the three-decoder gate
// (Plan 06-06 Task 3). The same `v1-cross-sdk-proto-02.json` is decoded by
// the regenerated quicktype `EverframeReportEnvelope` (Plan 06-06 Task 2 added the
// `reactTree` field), re-encoded with sorted keys, and the canonical bytes
// are checked against a second decode → re-encode pass for idempotence.
//
// Why byte-equal-after-canonicalize instead of struct Equatable:
//   The quicktype-generated structs contain `[EverframeJSONAny]?` fields (annotations,
//   logs, network, redactions) that prevent synthesized `Equatable`. The
//   byte-level idempotence check is strictly stronger than struct equality
//   for our drift purposes and mirrors `ProtocolRoundTripTests`.

import Testing
@testable import EverframeProtocol
import Foundation

struct CrossSDKProto02Tests {

    // NOTE (Task 14 fix): the fixture's `submittedAt` carries millisecond
    // precision (`"2026-05-11T10:00:00.000Z"`, matching JS `Date.toISOString()`
    // / `toJSON()` output, which always emits fractional seconds). Plain
    // `JSONEncoder/Decoder`'s `.iso8601` strategy uses a default-options
    // `ISO8601DateFormatter`, which does NOT accept fractional seconds and
    // throws `dataCorrupted` on this fixture — confirmed pre-existing (this
    // suite had apparently never been executed end-to-end before Task 14's
    // final-verification pass; every other iOS run in this repo's history hit
    // the unrelated macOS/UIKit build gate first). Custom strategies below
    // parse/emit `.withFractionalSeconds` explicitly.
    private static func canonicalEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .custom { date, enc in
            var container = enc.singleValueContainer()
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            try container.encode(formatter.string(from: date))
        }
        return encoder
    }

    private static func canonicalDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { dec in
            let container = try dec.singleValueContainer()
            let string = try container.decode(String.self)
            let withFractional = ISO8601DateFormatter()
            withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = withFractional.date(from: string) { return date }
            let plain = ISO8601DateFormatter()
            if let date = plain.date(from: string) { return date }
            throw DecodingError.dataCorruptedError(
                in: container, debugDescription: "Expected ISO8601 date string, got \(string)")
        }
        return decoder
    }

    private static func fixtureData() throws -> Data {
        let url = Bundle.module.url(
            forResource: "v1-cross-sdk-proto-02",
            withExtension: "json"
        )!
        return try Data(contentsOf: url)
    }

    /// Round-trip the PROTO-02 cross-SDK fixture: decode via the regenerated
    /// `EverframeReportEnvelope`, re-encode canonically, decode the canonical bytes,
    /// re-encode — the two canonical encodings MUST be byte-identical.
    @Test func crossSDKFixture_decodesAndReencodesIdempotently() throws {
        let data = try Self.fixtureData()
        let decoder = Self.canonicalDecoder()
        let encoder = Self.canonicalEncoder()

        let env = try decoder.decode(EverframeReportEnvelope.self, from: data)
        let firstBytes = try encoder.encode(env)
        let env2 = try decoder.decode(EverframeReportEnvelope.self, from: firstBytes)
        let secondBytes = try encoder.encode(env2)

        #expect(firstBytes == secondBytes)
    }

    /// Retired tree fields in historical JSON are ignored by the native decoder.
    @Test func crossSDKFixture_omitsRetiredPayloadFields() throws {
        let env = try Self.canonicalDecoder().decode(EverframeReportEnvelope.self, from: Self.fixtureData())
        let encoded = try Self.canonicalEncoder().encode(env)
        let json = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        let payload = try #require(json["payload"] as? [String: Any])
        #expect(payload["uiTree"] == nil)
        #expect(payload["reactTree"] == nil)
        #expect(payload["reportTarget"] == nil)
    }

    /// The fixture's `payload.breadcrumbs` (Task 16 — cross-SDK breadcrumb
    /// gate) MUST decode with exactly 2 entries, and the trim marker's
    /// `data.droppedCount` MUST decode as a NUMBER (EverframeJSONAny `.value as? Int64`),
    /// not a string — this is the exact cross-language type-fidelity risk the
    /// gate exists to catch.
    @Test func crossSDKFixture_preservesBreadcrumbsWithNumericDroppedCount() throws {
        let data = try Self.fixtureData()
        let decoder = Self.canonicalDecoder()

        let env = try decoder.decode(EverframeReportEnvelope.self, from: data)
        #expect(env.captures.breadcrumbs == true)

        let crumbs = try #require(env.payload.breadcrumbs)
        #expect(crumbs.count == 2)

        let normal = crumbs[0]
        #expect(normal.kind == .tap)
        #expect(normal.data?["droppedCount"] == nil)

        let marker = crumbs[1]
        #expect(marker.kind == .tap)
        #expect(marker.level == .info)
        #expect(marker.message == "+3 tap hidden")
        #expect(marker.data?["droppedCount"]?.value as? Int64 == 3)
    }
}
