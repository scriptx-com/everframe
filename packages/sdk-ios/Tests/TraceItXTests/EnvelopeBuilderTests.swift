// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Integration tests for EnvelopeBuilder.buildEncoded — exercises the
// 04-01-shipped builder end-to-end through Generated.swift's `ReportEnvelope`,
// with the real `RedactionEngine` (04-02) injected as the `redactor`.
import Testing
import Foundation
@testable import TraceItXKit
@testable import TraceItXProtocol

struct EnvelopeBuilderTests {
    #if os(tvOS)
    @Test func tvReportsDefaultToTVPlatformAndFormFactor() throws {
        for extra: [String: String] in [[:], ["sdk.platform": "invalid", "sdk.formFactor": "invalid"]] {
            let (bytes, _) = try makeBuilder().buildEncoded(reportId: UUID(), sdkName: "traceitx-ios",
                sdkVersion: "1.0.0", logs: [], networkRows: [], extra: extra)
            let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
            let envelope = try decoder.decode(ReportEnvelope.self, from: bytes)
            #expect(envelope.sdk.platform == .tvos)
            #expect(envelope.sdk.formFactor == .tv)
        }
    }
    #endif
    private func makeBuilder() -> EnvelopeBuilder {
        EnvelopeBuilder(redactor: RedactionEngine())
    }

    private func logs(_ messages: String...) -> [EnvelopeBuilder.LogRow] {
        messages.map { EnvelopeBuilder.LogRow(timestamp: Date(timeIntervalSince1970: 0), level: "default", tag: nil, message: $0) }
    }

    @Test func buildEncoded_roundTripsThroughGeneratedSwift() throws {
        let builder = makeBuilder()
        let id = UUID()
        let (bytes, _) = try builder.buildEncoded(
            reportId: id,
            sdkName: "traceitx-ios",
            sdkVersion: "1.2.0",
            logs: logs("hello world"),
            networkRows: [],
            extra: ["title": "test", "description": "desc"]
        )
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let envelope = try decoder.decode(ReportEnvelope.self, from: bytes)
        #expect(envelope.reportID == id.uuidString)
        #expect(envelope.sdk.name == .traceitxIos)
        #expect(envelope.sdk.version == "1.2.0")
        #expect(envelope.reporter.title == "test")
    }

    @Test func sha256IsDeterministicAcrossEncodings() throws {
        let builder = makeBuilder()
        let id = UUID()
        let (bytes1, key1) = try builder.buildEncoded(
            reportId: id, sdkName: "traceitx-ios", sdkVersion: "1.0.0",
            logs: logs("a"), networkRows: [], extra: [:]
        )
        // Same inputs (note: submittedAt is set to Date() inside builder, so two
        // calls back-to-back will differ). Test sha256 stability instead by
        // re-encoding the same bytes and confirming the digest matches.
        let key1Recomputed: String = {
            // Re-derive sha256 over the same bytes
            return bytes1.sha256Hex()
        }()
        #expect(key1 == key1Recomputed)

        // Different content → different key
        let (_, key2) = try builder.buildEncoded(
            reportId: id, sdkName: "traceitx-ios", sdkVersion: "1.0.0",
            logs: logs("b"), networkRows: [], extra: [:]
        )
        #expect(key1 != key2)
    }

    @Test func sizeCap_throwsOnOversize() throws {
        let builder = makeBuilder()
        // Logs are trimmed to 4000 characters before encoding. Exercise the
        // final encoded-envelope ceiling with the builder's opaque payload
        // extra instead, which this layer preserves verbatim.
        let (accepted, _) = try builder.buildEncoded(
            reportId: UUID(), sdkName: "traceitx-ios", sdkVersion: "1.0.0",
            userExtra: String(repeating: "a", count: 24 * 1024 * 1024)
        )
        #expect(accepted.count > 24 * 1024 * 1024)
        #expect(accepted.count < 25 * 1024 * 1024)
        let huge = String(repeating: "a", count: 26 * 1024 * 1024)
        do {
            _ = try builder.buildEncoded(
                reportId: UUID(), sdkName: "traceitx-ios", sdkVersion: "1.0.0",
                logs: [], networkRows: [], extra: [:], userExtra: huge
            )
            Issue.record("expected payloadTooLarge throw, got success")
        } catch let err as TraceItXTransportError {
            switch err {
            case .payloadTooLarge(let bytes, let limit):
                #expect(bytes > limit)
                #expect(limit == 25 * 1024 * 1024)
            default:
                Issue.record("expected .payloadTooLarge, got \(err)")
            }
        } catch {
            Issue.record("expected TraceItXTransportError, got \(error)")
        }
    }

    @Test func logRedaction_appliedToBearerTokens() throws {
        let builder = makeBuilder()
        let (bytes, _) = try builder.buildEncoded(
            reportId: UUID(),
            sdkName: "traceitx-ios",
            sdkVersion: "1.0.0",
            logs: logs("calling api with Bearer abc.def.ghi token"),
            networkRows: [],
            extra: [:]
        )
        let json = String(data: bytes, encoding: .utf8) ?? ""
        #expect(json.contains("[REDACTED:bearer]"), "expected bearer redaction, got: \(json.prefix(500))")
        #expect(!json.contains("Bearer abc.def.ghi"))
    }

    @Test func perEntryLogTimestamps_surviveIntoEnvelope() throws {
        let builder = makeBuilder()
        let rows = [
            EnvelopeBuilder.LogRow(
                timestamp: Date(timeIntervalSince1970: 1_700_000_000),
                level: "info", tag: nil, message: "first"
            ),
            EnvelopeBuilder.LogRow(
                timestamp: Date(timeIntervalSince1970: 1_700_000_001.5),
                level: "error", tag: nil, message: "second"
            ),
        ]
        let (bytes, _) = try builder.buildEncoded(
            reportId: UUID(), sdkName: "traceitx-ios", sdkVersion: "1.0.0",
            logs: rows, networkRows: [], extra: [:]
        )
        let json = String(data: bytes, encoding: .utf8) ?? ""
        #expect(json.contains("\"2023-11-14T22:13:20.000Z\""), "first entry's timestamp; got: \(json.prefix(800))")
        #expect(json.contains("\"2023-11-14T22:13:21.500Z\""), "second entry's millis-precision timestamp")
        #expect(json.contains("\"level\":\"info\""))
        #expect(json.contains("\"level\":\"error\""))
    }

    @Test func headerFilter_appliedToNetworkRows() throws {
        let builder = makeBuilder()
        let row = EnvelopeBuilder.NetworkRow(
            method: "GET",
            url: "https://api.example.com/users",
            status: 200,
            durationMs: 42.0,
            requestHeaders: ["authorization": "Bearer xxx", "x-trace-id": "abc", "x-custom": "leak"],
            responseHeaders: [:]
        )
        let (bytes, _) = try builder.buildEncoded(
            reportId: UUID(), sdkName: "traceitx-ios", sdkVersion: "1.0.0",
            logs: [], networkRows: [row], extra: [:] // empty: no LogRow needed
        )
        let json = String(data: bytes, encoding: .utf8) ?? ""
        #expect(json.contains("[REDACTED]"))
        #expect(json.contains("x-trace-id"))
        // x-custom should be dropped (default-deny)
        #expect(!json.contains("x-custom"))
    }

    // MARK: - UI-tree capture removed (spec 2026-08-29)
    //
    // Nothing walks a view hierarchy for the envelope any more, so there is no
    // way to make `payload.uiTree` / `payload.reactTree` / `payload.reportTarget`
    // non-nil — the builder has no parameters for them. `captures.uiTree`
    // survives as a REQUIRED schema boolean and must keep shipping as `false`;
    // dropping the key would fail envelope validation at ingest.

    @Test func buildEncoded_neverShipsTrees_andStillEmitsCapturesUITreeFalse() throws {
        let builder = makeBuilder()
        let (bytes, _) = try builder.buildEncoded(
            reportId: UUID(),
            sdkName: "traceitx-ios",
            sdkVersion: "0.0.1",
            logs: logs("hello"),
            networkRows: []
        )
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let envelope = try decoder.decode(ReportEnvelope.self, from: bytes)
        #expect(envelope.captures.uiTree == false)

        // The KEY itself must be present — a required boolean, not an omitted
        // optional. Decoding above would already have thrown, but assert on the
        // raw JSON too so a future schema-optional change can't hide the drop.
        let raw = try #require(
            try JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        let captures = try #require(raw["captures"] as? [String: Any])
        #expect(captures["uiTree"] as? Bool == false)
        let payload = try #require(raw["payload"] as? [String: Any])
        #expect(payload["uiTree"] == nil)
        #expect(payload["reactTree"] == nil)
        #expect(payload["reportTarget"] == nil)
    }

    // MARK: - trimLogs (mirrors sdk-core trimLogs.spec.ts + Android)

    private func mk(_ message: String, _ ts: TimeInterval) -> EnvelopeBuilder.LogRow {
        EnvelopeBuilder.LogRow(timestamp: Date(timeIntervalSince1970: ts), level: "log", tag: nil, message: message)
    }

    @Test func trimLogs_keepsAll_whenUnderBudget() {
        let rows = [mk("a", 1), mk("b", 2), mk("c", 3)]
        let out = EnvelopeBuilder.trimLogs(rows, maxChars: 100)
        #expect(out.map { $0.message } == ["a", "b", "c"])
    }

    @Test func trimLogs_keepsRecent_collapsesOlderIntoOneRedactedMarkerAtFront() {
        let rows = (1...5).map { mk(String(repeating: "x", count: 10), TimeInterval($0)) }
        let out = EnvelopeBuilder.trimLogs(rows, maxChars: 25)
        #expect(out.count == 3) // marker + 2 kept
        #expect(out[0].message == "REDACTED")
        #expect(out[0].level == "info")
        #expect(out[1].timestamp == Date(timeIntervalSince1970: 4))
        #expect(out[2].timestamp == Date(timeIntervalSince1970: 5))
    }

    @Test func trimLogs_alwaysKeepsNewest_truncatedWhenItAloneExceedsBudget() {
        let rows = [mk("old", 1), mk(String(repeating: "y", count: 9000), 2)]
        let out = EnvelopeBuilder.trimLogs(rows, maxChars: 4000)
        #expect(out.count == 2) // marker + truncated newest
        #expect(out[0].message == "REDACTED")
        #expect(out[1].message.count == 4000)
    }

    // Fake redactor: deterministic, no SharedData/pattern dependency. Proves
    // redact-then-trim ORDERING (the real RedactionEngine is unit-tested separately).
    private struct SecretRedactor: EnvelopeBuilder.RedactingHeaders {
        func redact(_ s: String) -> String { s.replacingOccurrences(of: "SECRET", with: "[X]") }
        func filterHeaders(_ h: [String: String]) -> [String: String] { h }
    }

    @Test func buildEncoded_redactsThenTrims_keptLogsRedacted_olderCollapsed() throws {
        let builder = EnvelopeBuilder(redactor: SecretRedactor())
        var rows: [EnvelopeBuilder.LogRow] = []
        for i in 0..<60 {
            rows.append(EnvelopeBuilder.LogRow(timestamp: Date(timeIntervalSince1970: TimeInterval(i)),
                                               level: "log", tag: nil, message: String(repeating: "a", count: 100)))
        }
        // Newest entry carries the secret → always kept, and must be redacted.
        rows.append(EnvelopeBuilder.LogRow(timestamp: Date(timeIntervalSince1970: 999),
                                           level: "error", tag: nil, message: "token=SECRET"))
        let (bytes, _) = try builder.buildEncoded(
            reportId: UUID(), sdkVersion: "0.0.1", logs: rows,
            extra: ["title": "t", "description": "d"]
        )
        let text = String(decoding: bytes, as: UTF8.self)
        #expect(text.contains("[X]"))                       // redaction applied to the kept newest log
        #expect(!text.contains("SECRET"))                   // raw secret never survives
        #expect(text.contains("\"message\":\"REDACTED\"")) // trim marker for the collapsed older logs
    }

    // MARK: - Task 6: payload.breadcrumbs wiring

    private func makeCrumb(
        kind: BreadcrumbKind, message: String, seq: Int, t: Double = 1_700_000_000_000
    ) -> Breadcrumb {
        Breadcrumb(data: nil, kind: kind, level: .info, message: message, seq: seq, t: t, truncated: nil)
    }

    @Test func buildEncoded_overBudgetChain_shipsTrimmedBreadcrumbs() throws {
        let builder = makeBuilder()
        // 300 console crumbs, each well over entryOverhead(64) alone, comfortably
        // exceeding both the 16 KB byte budget and the 121-entry cap — forces
        // BOTH the byte-eviction pass and the count-enforcement pass.
        let chain = (0..<300).map {
            makeCrumb(kind: .console, message: String(repeating: "m", count: 200), seq: $0, t: Double(1_700_000_000_000 + $0))
        }
        let (bytes, _) = try builder.buildEncoded(
            reportId: UUID(), sdkName: "traceitx-ios", sdkVersion: "1.0.0",
            logs: [], networkRows: [], extra: [:], breadcrumbs: chain
        )
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let envelope = try decoder.decode(ReportEnvelope.self, from: bytes)

        #expect(envelope.captures.breadcrumbs == true)
        #expect(envelope.captureControl.included.contains("breadcrumbs"))
        let shipped = try #require(envelope.payload.breadcrumbs)
        #expect(shipped.count < chain.count, "expected trim to reduce the 300-entry chain")
        #expect(shipped.count <= BreadcrumbTrim.maxTrimmedEntries + 1) // +1 possible marker for the one kind present
        #expect(shipped.contains { BreadcrumbTrim.isTrimMarker($0) }, "expected a '+N console hidden' marker")
    }

    @Test func buildEncoded_noBreadcrumbs_capturesFalseAndPayloadNil_noPerturbation() throws {
        let builder = makeBuilder()
        let (bytes, _) = try builder.buildEncoded(
            reportId: UUID(), sdkName: "traceitx-ios", sdkVersion: "1.0.0",
            logs: logs("hello"), networkRows: [], extra: [:]
        )
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let envelope = try decoder.decode(ReportEnvelope.self, from: bytes)

        #expect(envelope.captures.breadcrumbs == false)
        #expect(envelope.payload.breadcrumbs == nil)
        #expect(envelope.captureControl.included == [])
        #expect(envelope.captureControl.excluded == [])
    }

    @Test func buildEncoded_emptyBreadcrumbsArray_treatedSameAsNil() throws {
        let builder = makeBuilder()
        let (bytes, _) = try builder.buildEncoded(
            reportId: UUID(), sdkName: "traceitx-ios", sdkVersion: "1.0.0",
            logs: [], networkRows: [], extra: [:], breadcrumbs: []
        )
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let envelope = try decoder.decode(ReportEnvelope.self, from: bytes)

        #expect(envelope.captures.breadcrumbs == false)
        #expect(envelope.payload.breadcrumbs == nil)
        #expect(envelope.captureControl.included == [])
    }

    // MARK: - Task 6: freeze-pollution guard, seam-tested end to end through the builder

    /// The reporter's own actions (or any add() racing the submit path) must
    /// never leak into a report shipped from a frozen snapshot. Drives the
    /// exact lifecycle EnvelopeBuilder's caller (ReporterSubmission) uses:
    /// freeze() at reporter-open, add() after, takeFrozen() at submit — then
    /// verifies the post-freeze crumb never reaches the encoded envelope.
    @Test func freezeThenAdd_takeFrozenIntoBuilder_excludesPostFreezeCrumb() throws {
        let buf = BreadcrumbRingBuffer(maxCount: 50, honorsKillGate: false)
        buf.add(kind: .tap, message: "before-freeze")
        buf.freeze()
        buf.add(kind: .tap, message: "after-freeze-should-not-ship")

        let frozen = try #require(buf.takeFrozen())
        #expect(frozen.map(\.message) == ["before-freeze"])

        let builder = makeBuilder()
        let (bytes, _) = try builder.buildEncoded(
            reportId: UUID(), sdkName: "traceitx-ios", sdkVersion: "1.0.0",
            logs: [], networkRows: [], extra: [:], breadcrumbs: frozen
        )
        let json = String(decoding: bytes, as: UTF8.self)
        #expect(json.contains("before-freeze"))
        #expect(!json.contains("after-freeze-should-not-ship"))

        // takeFrozen() clears the snapshot; the live buffer still holds the
        // post-freeze crumb for the NEXT report.
        #expect(buf.takeFrozen() == nil)
    }
}

// Local sha256 helper for assertion (matches builder's algorithm)
import CryptoKit
fileprivate extension Data {
    func sha256Hex() -> String {
        let digest = SHA256.hash(data: self)
        return digest.compactMap { String(format: "%02x", $0) }.joined()
    }
}
