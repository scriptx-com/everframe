// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import XCTest
@testable import EverframeKit

final class CrashDetailsExportTests: XCTestCase {
    func testCasesContainActualNativeEncodingWithCompleteSemantics() throws {
        let document = try CrashDetailsNativeExport.makeDocument()
        XCTAssertEqual(document.schemaVersion, 1)
        XCTAssertEqual(document.cases.map(\.name), [
            "normal", "expanding-redactor", "repaired-text", "capped", "prototype-keys", "numeric-boundary",
        ])

        let objects = try Dictionary(uniqueKeysWithValues: document.cases.map { entry in
            let data = try XCTUnwrap(entry.detailsJson.data(using: .utf8))
            return (entry.name, try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary))
        })
        XCTAssertEqual(objects["normal"], [
            "severity": "warning", "context": "checkout", "metadata": ["attempt": 2, "ok": true],
        ] as NSDictionary)
        XCTAssertEqual(objects["expanding-redactor"], [
            "severity": "info", "context": String(repeating: "c", count: 256),
            "metadata": [String(repeating: "k", count: 128): String(repeating: "v", count: 1024)],
            "truncated": true,
        ] as NSDictionary)

        let shared = try CrashDetailsFixtureSupport.sharedFixtures()
        XCTAssertEqual(objects["repaired-text"],
                       try XCTUnwrap(shared.first { $0.name == "repaired-text" }).expected)
        XCTAssertEqual(objects["prototype-keys"],
                       try XCTUnwrap(shared.first { $0.name == "prototype-keys" }).expected)

        let capped = try XCTUnwrap(objects["capped"])
        XCTAssertEqual(capped["severity"] as? String, "warning")
        XCTAssertEqual(capped["context"] as? String, "priority")
        XCTAssertEqual(capped["truncated"] as? Bool, true)
        XCTAssertEqual(document.cases.first { $0.name == "capped" }?.detailsJson.utf8.count, 8192)

        let numeric = try XCTUnwrap(objects["numeric-boundary"])
        let numbers = try XCTUnwrap((numeric["metadata"] as? [String: Any])?["a"] as? [NSNumber])
        XCTAssertFalse(numbers.isEmpty)
        XCTAssertTrue(numbers.allSatisfy { $0.doubleValue == 1e20 })
        XCTAssertEqual(numeric["truncated"] as? Bool, true)
        let numericBytes = try XCTUnwrap(document.cases.first { $0.name == "numeric-boundary" })
            .detailsJson.utf8.count
        XCTAssertLessThanOrEqual(numericBytes, 8192)
        XCTAssertLessThanOrEqual(numericBytes + (numbers.count * 16), 8192)

        try CrashDetailsNativeExport.writeIfRequested(document)
    }
}

private enum CrashDetailsNativeExport {
    struct Entry: Codable {
        let name: String
        let detailsJson: String
    }

    struct Document: Codable {
        let schemaVersion: Int
        let cases: [Entry]
    }

    static func makeDocument() throws -> Document {
        let shared = try CrashDetailsFixtureSupport.sharedFixtures()
        let repaired = try XCTUnwrap(shared.first { $0.name == "repaired-text" })
        let prototypeKeys = try XCTUnwrap(shared.first { $0.name == "prototype-keys" })
        let cappedPrefix = Array(repeating: String(repeating: "a", count: 1024), count: 7)

        return Document(schemaVersion: 1, cases: [
            try entry("normal", CaptureExceptionOptions(
                severity: .warning, context: "checkout", metadata: ["attempt": 2, "ok": true])),
            try entry("expanding-redactor", CaptureExceptionOptions(
                severity: .info, context: "context-expand", metadata: ["key-expand": "value-expand"]
            )) { value in
                switch value {
                case "context-expand": String(repeating: "c", count: 300)
                case "key-expand": String(repeating: "k", count: 200)
                case "value-expand": String(repeating: "v", count: 1_100)
                default: value
                }
            },
            try entry("repaired-text", repaired.options),
            try entry("capped", CaptureExceptionOptions(
                severity: .warning, context: "priority",
                metadata: ["a": cappedPrefix + [String(repeating: "z", count: 939)]])),
            try entry("prototype-keys", prototypeKeys.options),
            try entry("numeric-boundary", CaptureExceptionOptions(metadata: [
                "a": Array(repeating: Double(1e20), count: 100),
                "z": Array(repeating: String(repeating: "x", count: 1024), count: 7),
            ])),
        ])
    }

    static func writeIfRequested(_ document: Document) throws {
        guard let output = ProcessInfo.processInfo.environment["EVERFRAME_CRASH_DETAILS_OUTPUT"] else {
            return
        }
        guard NSString(string: output).isAbsolutePath else {
            throw NSError(domain: "CrashDetailsNativeExport", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "EVERFRAME_CRASH_DETAILS_OUTPUT must be absolute"])
        }
        let url = URL(fileURLWithPath: output)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(
            atPath: url.deletingLastPathComponent().path, isDirectory: &isDirectory
        ), isDirectory.boolValue else {
            throw NSError(domain: "CrashDetailsNativeExport", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "EVERFRAME_CRASH_DETAILS_OUTPUT parent must exist"])
        }
        guard !FileManager.default.fileExists(atPath: url.path) else {
            throw NSError(domain: "CrashDetailsNativeExport", code: 3,
                          userInfo: [NSLocalizedDescriptionKey: "EVERFRAME_CRASH_DETAILS_OUTPUT must be absent"])
        }
        try EnvelopeBuilder.makeJSONEncoder().encode(document).write(
            to: url, options: .withoutOverwriting)
    }

    private static func entry(
        _ name: String,
        _ options: CaptureExceptionOptions,
        redact: (String) throws -> String = { $0 }
    ) throws -> Entry {
        let details = normalizeCrashDetails(options, redact: redact)
        let bytes = try EnvelopeBuilder.makeJSONEncoder().encode(details)
        return Entry(name: name, detailsJson: try XCTUnwrap(String(data: bytes, encoding: .utf8)))
    }
}
