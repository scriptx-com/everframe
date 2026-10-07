// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import Foundation
import CryptoKit
import EverframeProtocol
@testable import EverframeKit

enum NativeRecoveryTestData {
    static func template(user: String = "user-A") throws -> Data {
        try EnvelopeBuilder(redactor: RedactionEngine(), vitalsStamp: { nil }).buildEncoded(
            reportId: UUID(), sdkVersion: "1.0.0",
            extra: ["user.id": user, "app.version": "release-A", "device.os": "iOS"],
            source: .crash).bytes
    }
    static func raw(context: UUID, report: UUID = UUID(), message: String = "original-secret") throws -> Data {
        try JSONSerialization.data(withJSONObject: [
            "report": ["id": report.uuidString, "version": "3.9.0", "type": "standard", "timestamp": UInt64(1700000001000000)],
            "user": ["everframe_context_id": context.uuidString.lowercased()],
            "binary_images": [["image_addr": 4096, "image_size": 16, "image_vmaddr": 0, "uuid": "cccccccc-cccc-cccc-cccc-cccccccccccc", "name": "/App/App", "cpu_type": 16777228, "cpu_subtype": 0]],
            "crash": ["error": ["type": "signal", "is_fatal": true, "address": 4097,
                                "reason": message, "signal": ["signal": 11, "name": "SIGSEGV", "code": 1]],
                      "threads": [["index": 0, "crashed": true, "backtrace": ["contents": [["instruction_addr": 4097, "symbol_name": "function"]]]]]]
        ], options: [.sortedKeys])
    }
    static func context(owner: String = "sdk-A", pattern: String = "original-secret") throws -> NativeCrashRecoveryContext {
        let policy = try NativeCrashRedactionSnapshot.capture(config: RedactionConfig(customPatterns: [try NSRegularExpression(pattern: pattern)]))
        return try NativeCrashRecoveryContext(sdkKey: owner, endpoint: "https://example.invalid/api/ingest",
            identitySubject: "subject-A", envelopeTemplate: template(), redaction: policy)
    }
}
final class NativeCrashRecoveryContextTests: XCTestCase {
    func testFrozenOwnerAndPolicySurviveNewConfigurationAndSerialization() throws {
        let original = try NativeRecoveryTestData.context()
        _ = try NativeRecoveryTestData.context(owner: "sdk-B", pattern: "new-secret")
        let restored = try NativeCrashRecoveryContext.decode(original.encoded())
        let redact = try restored.redaction.compiled()
        let record = try NativeCrashRecordDecoder.decode(
            NativeRecoveryTestData.raw(context: UUID(), message: "original-secret new-secret 4111 1111 1111 1111"), redact: redact)
        let entry = try restored.entry(for: record)
        XCTAssertEqual(entry.sdkKey, "sdk-A"); XCTAssertEqual(entry.identitySubject, "subject-A")
        XCTAssertEqual(entry.endpoint, "https://example.invalid/api/ingest")
        XCTAssertEqual(entry.reportId, record.reportID)
        let envelope = try EverframeReportEnvelope(data: entry.envelopeBytes)
        XCTAssertEqual(envelope.reportID, record.reportID.uuidString.lowercased())
        XCTAssertEqual(envelope.submittedAt, record.crash.occurredAt)
        XCTAssertEqual(envelope.source, .crash)
        XCTAssertEqual(envelope.payload.crash?.message, "[REDACTED] new-secret [REDACTED:luhn-cc]")
        XCTAssertEqual(envelope.reporter.user?.id, "user-A")
        XCTAssertEqual(entry.envelopeBytes, try restored.entry(for: record).envelopeBytes)
        XCTAssertEqual(entry.idempotencyKey, SHA256.hash(data: entry.envelopeBytes).map { String(format: "%02x", $0) }.joined())
    }
    func testSnapshotMatchesBundledDefaultsAndCapturedRegexOptions() throws {
        let defaults = try NativeCrashRedactionSnapshot.capture(config: .defaults).compiled()
        for value in ["Bearer synthetic-secret", "4111 1111 1111 1111", "4111 1111 1111 1112", "ordinary text"] {
            XCTAssertEqual(defaults(value), RedactionEngine().redact(value))
        }
        let custom = try NativeCrashRedactionSnapshot.capture(config: RedactionConfig(customPatterns: [
            try NSRegularExpression(pattern: "SECRET", options: .caseInsensitive)
        ])).compiled()
        XCTAssertEqual(custom("secret"), "[REDACTED]")
    }
    func testUnsupportedAndMalformedContextsReject() throws {
        let context = try NativeRecoveryTestData.context()
        var json = try JSONSerialization.jsonObject(with: context.encoded()) as! [String: Any]
        json["schemaVersion"] = 2
        XCTAssertThrowsError(try NativeCrashRecoveryContext.decode(JSONSerialization.data(withJSONObject: json)))
        XCTAssertThrowsError(try NativeCrashRecoveryContext.decode(Data(repeating: 32, count: 65537)))
        for (key, endpoint) in [("", "https://example.invalid"), ("key\r\n", "https://example.invalid"),
                                 ("key", "file:///tmp/queue"), ("key", "https://user:pass@example.invalid")] {
            XCTAssertThrowsError(try NativeCrashRecoveryContext(sdkKey: key, endpoint: endpoint,
                identitySubject: nil, envelopeTemplate: NativeRecoveryTestData.template(), redaction: context.redaction))
        }
        XCTAssertThrowsError(try NativeCrashRecoveryContext(sdkKey: "key", endpoint: context.endpoint,
            identitySubject: nil, envelopeTemplate: Data(repeating: 32, count: 32769), redaction: context.redaction))
    }
    func testAttachmentsCannotBeInventedWithoutTheirOriginalBytes() throws {
        let context = try NativeRecoveryTestData.context()
        var template = try JSONSerialization.jsonObject(with: context.envelopeTemplate) as! [String: Any]
        template["attachments"] = [["kind": "screenshot", "partName": "screenshot", "contentType": "image/png",
                                    "byteLength": 12, "sha256": String(repeating: "a", count: 64)]]
        XCTAssertThrowsError(try NativeCrashRecoveryContext(sdkKey: context.sdkKey, endpoint: context.endpoint,
            identitySubject: nil, envelopeTemplate: JSONSerialization.data(withJSONObject: template), redaction: context.redaction))
    }
    func testFrozenRuleLimitsAndLiteralReplacementRemainBounded() throws {
        typealias Rule = NativeCrashRedactionSnapshot.Rule
        XCTAssertThrowsError(try NativeCrashRedactionSnapshot(rules: [Rule(regex: "(", options: 0, replacement: "x", luhn: false)]).compiled())
        XCTAssertThrowsError(try NativeCrashRedactionSnapshot(rules: [Rule(regex: "x", options: UInt.max, replacement: "x", luhn: false)]).compiled())
        XCTAssertThrowsError(try NativeCrashRedactionSnapshot(rules: Array(repeating: Rule(regex: "x", options: 0, replacement: "x", luhn: false), count: 65)).compiled())
        let literal = try NativeCrashRedactionSnapshot(rules: [Rule(regex: "x", options: 0, replacement: "$0", luhn: false)]).compiled()
        XCTAssertEqual(literal("x"), "$0")
        let expanding = try NativeCrashRedactionSnapshot(rules: [Rule(regex: "x", options: 0,
            replacement: String(repeating: "😀", count: 128), luhn: false)]).compiled()
        XCTAssertLessThanOrEqual(expanding(String(repeating: "x", count: 4096)).utf16.count, 4096)
    }
}
