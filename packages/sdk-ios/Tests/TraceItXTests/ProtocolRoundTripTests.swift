// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Testing
@testable import TraceItXProtocol
import Foundation

struct ProtocolRoundTripTests {
    /// PROTO-01 smoke: the canonical minimal-envelope fixture decodes through
    /// quicktype's generated `ReportEnvelope`, re-encodes (sorted keys), and
    /// re-decoding the bytes produces an envelope whose canonical re-encoding
    /// is byte-identical.
    ///
    /// We compare canonical JSON bytes rather than relying on Equatable —
    /// quicktype's output cannot synthesize `Equatable` on structs containing
    /// `[JSONAny]?` fields (Payload, etc.), and Equatable was therefore
    /// removed from the codegen invocation. The byte-level idempotence check
    /// is strictly stronger than struct-level equality for our drift purposes.
    @Test func canonicalMinimalEnvelope_decodesAndReencodes() throws {
        let data = try Fixtures.canonicalMinimalEnvelopeData()

        // NOTE (Task 14 fix): the fixture's `submittedAt` carries millisecond
        // precision (matching JS `Date.toISOString()`), which plain
        // `.iso8601` (default-options `ISO8601DateFormatter`, no fractional
        // seconds) cannot parse — confirmed pre-existing, not caused by
        // Task 14; this suite had apparently never been executed end-to-end
        // before (every prior iOS run in this repo hit the unrelated
        // macOS/UIKit build gate first). See CrossSDKProto02Tests.swift for
        // the identical fix applied there.
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

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, enc in
            var container = enc.singleValueContainer()
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            try container.encode(formatter.string(from: date))
        }
        encoder.outputFormatting = [.sortedKeys]

        let env = try decoder.decode(ReportEnvelope.self, from: data)
        let legacy = ReportEnvelope(attachments: env.attachments,
            captureControl: env.captureControl, captures: env.captures, context: env.context,
            payload: env.payload, protocolVersion: env.protocolVersion, reporter: env.reporter,
            reportID: env.reportID, sdk: env.sdk, source: env.source, submittedAt: env.submittedAt)
        #expect(legacy.sessionID == nil)
        #expect(legacy.reportID == env.reportID)
        let session = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        let anchored = env.with(sessionID: session)
        let restored = try decoder.decode(ReportEnvelope.self, from: encoder.encode(anchored))
        #expect(restored.sessionID == session)
        let firstBytes = try encoder.encode(env)
        let env2 = try decoder.decode(ReportEnvelope.self, from: firstBytes)
        let secondBytes = try encoder.encode(env2)

        #expect(firstBytes == secondBytes)
    }
}
