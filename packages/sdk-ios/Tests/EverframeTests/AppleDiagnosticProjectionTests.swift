// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import Foundation
@testable import EverframeKit

final class AppleDiagnosticProjectionTests: XCTestCase {
    // Documented legacy MXCallStackTree.jsonRepresentation shape, including its outer key.
    // https://developer.apple.com/documentation/metrickit/mxcallstacktree/jsonrepresentation()
    private func tree(_ frame: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["callStackTree": ["callStacks": [["callStackRootFrames": [frame]]]]])
    }
    private var frame: [String: Any] { ["binaryUUID": "33333333-3333-4333-8333-333333333333",
        "binaryName": "Example", "address": 4294983696 as UInt64, "offsetIntoBinaryTextSegment": 16400] }
    func testProjectsOnlyBoundedSafeFieldsWithoutRawMetadata() throws {
        var value = frame; value["privatePath"] = "/private/alice"; value["sampleCount"] = 42
        let result = AppleDiagnosticProjection.stack(try tree(value))
        XCTAssertEqual(result.status, "available"); XCTAssertEqual(result.frames.count, 1)
        XCTAssertEqual(try XCTUnwrap(result.frames.first).address, "0x100004010")
        let encoded = try JSONEncoder().encode(result)
        XCTAssertFalse(String(decoding: encoded, as: UTF8.self).contains("alice"))
        XCTAssertFalse(String(decoding: encoded, as: UTF8.self).contains("sampleCount"))
    }
    func testMalformedOversizedAndUnsafeNamesNeverBecomeAvailableStacks() throws {
        XCTAssertEqual(AppleDiagnosticProjection.stack(Data("{}".utf8)).status, "malformed")
        XCTAssertEqual(AppleDiagnosticProjection.stack(Data(repeating: 32, count: 262145)).status, "oversized")
        var value = frame; value["binaryName"] = "/private/alice/Example"
        XCTAssertEqual(AppleDiagnosticProjection.stack(try tree(value)).status, "malformed")
    }
    func testFrameAndDepthLimitsRemainExplicit() throws {
        let roots = Array(repeating: frame, count: 65)
        let bytes = try JSONSerialization.data(withJSONObject: ["callStackTree": ["callStacks": [["callStackRootFrames": roots]]]])
        let result = AppleDiagnosticProjection.stack(bytes)
        XCTAssertEqual(result.frames.count, 64); XCTAssertTrue(result.truncated)
        var value = frame
        for _ in 0..<40 { var parent = frame; parent["subFrames"] = [value]; value = parent }
        let deep = AppleDiagnosticProjection.stack(try tree(value))
        XCTAssertLessThanOrEqual(deep.frames.count, 32); XCTAssertTrue(deep.truncated)
    }
}
