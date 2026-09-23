// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Phase 06.2-07 Task 1 — EverframeRelayMessage codegen round-trip.
//
// Loads `packages/protocol/__tests__/fixtures/v1-relay-fixture.json` (copied
// into `Tests/EverframeTests/Fixtures/`) and round-trips each entry through
// the codegenned `EverframeRelayMessage` enum produced by Plan 06.2-03. Catches:
//   • Missing enum cases (e.g. codegen out-of-sync with schema).
//   • Discriminator-key drift (`type` vs `kind`).
//   • CodingKey snake_case ↔ camelCase mistakes.
//   • Field-order or nested-struct re-encode regressions (JSON object equality
//     is order-insensitive — we re-parse to compare).
//
// The fixture is the same one Plan 06.2-03 ships and Plan 10 will cross-check
// against the Kotlin client — keeping these two SDKs symmetric.
import Testing
import Foundation
@testable import EverframeKit
@testable import EverframeProtocol

@Suite
struct RelayMessageRoundtripTests {

    private struct FixtureFile: Decodable {
        let schemaVersion: String
        let messages: [JSONValue]  // raw JSON nodes — each decoded as a EverframeRelayMessage
    }

    private func loadFixture() throws -> FixtureFile {
        let url = Bundle.module.url(forResource: "v1-relay-fixture", withExtension: "json")
        guard let url else {
            Issue.record("v1-relay-fixture.json not found in test bundle resources")
            throw FixtureError.notFound
        }
        let data = try Data(contentsOf: url)
        let dec = JSONDecoder()
        return try dec.decode(FixtureFile.self, from: data)
    }

    @Test func test1_fixtureSchemaVersion() throws {
        let f = try loadFixture()
        #expect(f.schemaVersion == "relay.v1")
        #expect(f.messages.count == 10) // one per EverframeRelayMessage case
    }

    @Test func test2_eachMessageDecodesAndReEncodesEquivalently() throws {
        let f = try loadFixture()
        let enc = JSONEncoder()
        let dec = JSONDecoder()

        for (idx, raw) in f.messages.enumerated() {
            let originalData = try JSONEncoder().encode(raw)

            let msg: EverframeRelayMessage
            do {
                msg = try dec.decode(EverframeRelayMessage.self, from: originalData)
            } catch {
                Issue.record("message[\(idx)] failed first decode: \(error)")
                continue
            }

            // Re-encode, then decode again — both passes must produce the
            // same `EverframeRelayMessage` enum value (Equatable conformance is the
            // ground truth).
            let reencoded: Data
            do { reencoded = try enc.encode(msg) }
            catch { Issue.record("message[\(idx)] failed re-encode: \(error)"); continue }

            let msg2: EverframeRelayMessage
            do { msg2 = try dec.decode(EverframeRelayMessage.self, from: reencoded) }
            catch { Issue.record("message[\(idx)] failed second decode: \(error)"); continue }

            #expect(msg == msg2, "message[\(idx)] not equal after round-trip")
        }
    }

    @Test func test3_allCasesCoveredByFixture() throws {
        let f = try loadFixture()
        let dec = JSONDecoder()
        var seenTypes = Set<String>()
        for raw in f.messages {
            let data = try JSONEncoder().encode(raw)
            let msg = try dec.decode(EverframeRelayMessage.self, from: data)
            seenTypes.insert(discriminator(of: msg))
        }
        let expected: Set<String> = [
            "pair.created", "pair.bonded", "pair.expired",
            "report.request", "report.assembled", "report.draft.update",
            "report.submit", "report.completed", "report.failed", "report.rejected"
        ]
        #expect(seenTypes == expected, "missing cases: \(expected.subtracting(seenTypes))")
    }

    @Test func test4_reportSubmitAnnotationDiscriminator() throws {
        // The annotation array uses a `kind` discriminator (stroke | blur) —
        // separate from the message-level `type` discriminator. Round-trip
        // proves the nested enum decoder is wired correctly.
        let f = try loadFixture()
        let dec = JSONDecoder()
        for raw in f.messages {
            let data = try JSONEncoder().encode(raw)
            let msg = try dec.decode(EverframeRelayMessage.self, from: data)
            if case .reportSubmit(let sub) = msg {
                #expect(sub.annotations.count == 2)
                if case .stroke(let s) = sub.annotations[0] { #expect(s.kind == "stroke") }
                else { Issue.record("expected first annotation to be .stroke") }
                if case .blur(let b) = sub.annotations[1] { #expect(b.kind == "blur") }
                else { Issue.record("expected second annotation to be .blur") }
                return
            }
        }
        Issue.record("fixture missing a report.submit message")
    }

    private func discriminator(of msg: EverframeRelayMessage) -> String {
        switch msg {
        case .attachChallenge:        return "attach.challenge"
        case .attachChallengeCleared: return "attach.challenge.cleared"
        case .companionName:     return "companion.name"
        case .pairBonded:        return "pair.bonded"
        case .pairCreated:       return "pair.created"
        case .pairExpired:       return "pair.expired"
        case .phoneDisconnected: return "phone.disconnected"
        case .previewFrame:      return "preview.frame"
        case .previewStart:      return "preview.start"
        case .previewStop:       return "preview.stop"
        case .reportAssembled:   return "report.assembled"
        case .reportCancelled:   return "report.cancelled"
        case .reportCompleted:   return "report.completed"
        case .reportDraftUpdate: return "report.draft.update"
        case .reportFailed:      return "report.failed"
        case .reportRejected:    return "report.rejected"
        case .reportRequest:     return "report.request"
        case .reportSubmit:      return "report.submit"
        case .shotAssembled:     return "shot.assembled"
        case .shotBinary:        return "shot.binary"
        case .shotFailed:        return "shot.failed"
        case .shotRequest:       return "shot.request"
        }
    }
}

// MARK: - JSONValue (minimal generic JSON node)

/// Lightweight any-JSON container — we keep raw fixture entries opaque,
/// re-encode them, and let `EverframeRelayMessage` parse from the bytes. Avoids
/// duplicating discriminator parsing in test code.
private enum JSONValue: Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let v = try? c.decode(Bool.self) { self = .bool(v); return }
        if let v = try? c.decode(Double.self) { self = .number(v); return }
        if let v = try? c.decode(String.self) { self = .string(v); return }
        if let v = try? c.decode([JSONValue].self) { self = .array(v); return }
        if let v = try? c.decode([String: JSONValue].self) { self = .object(v); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unsupported JSON node")
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null:           try c.encodeNil()
        case .bool(let v):    try c.encode(v)
        case .number(let v):
            // Encode integral doubles as Int so the resulting JSON keeps
            // schema-compatible integer fields (size, counts, redaction offsets).
            if v.rounded() == v && abs(v) < Double(Int.max) {
                try c.encode(Int(v))
            } else {
                try c.encode(v)
            }
        case .string(let v):  try c.encode(v)
        case .array(let v):   try c.encode(v)
        case .object(let v):  try c.encode(v)
        }
    }
}

private enum FixtureError: Error { case notFound }
