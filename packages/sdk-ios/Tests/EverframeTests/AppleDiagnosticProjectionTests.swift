// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import Foundation
@testable import EverframeKit

final class AppleDiagnosticProjectionTests: XCTestCase {
    // MXCallStackTree.jsonRepresentation() puts callStacks at the top level. The
    // documentation example's outer callStackTree key belongs to the enclosing
    // diagnostic's JSON, not to the tree the adapter projects.
    private func tree(_ roots: [[String: Any]]) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["callStacks": [["threadAttributed": true, "callStackRootFrames": roots]],
                                                    "callStackPerThread": true])
    }
    private var frame: [String: Any] { ["binaryUUID": "33333333-3333-4333-8333-333333333333",
        "binaryName": "Example", "address": 4294983696 as UInt64, "offsetIntoBinaryTextSegment": 16400] }
    func testProjectsOnlyBoundedSafeFieldsWithoutRawMetadata() throws {
        var value = frame; value["privatePath"] = "/private/alice"; value["sampleCount"] = 42
        let result = AppleDiagnosticProjection.stack(try tree([value]))
        XCTAssertEqual(result.status, "available"); XCTAssertEqual(result.frames.count, 1)
        XCTAssertEqual(try XCTUnwrap(result.frames.first).address, "0x100004010")
        let encoded = try JSONEncoder().encode(result)
        XCTAssertFalse(String(decoding: encoded, as: UTF8.self).contains("alice"))
        XCTAssertFalse(String(decoding: encoded, as: UTF8.self).contains("sampleCount"))
    }
    func testProjectsTheTreeLayoutMetricKitSerializes() throws {
        // Key layout MXCallStackTree.jsonRepresentation() produces for one
        // attributed thread with a nested frame. Values are synthetic.
        let json = """
            {"callStacks": [{"threadAttributed": true, "callStackRootFrames": [{
              "binaryUUID": "33333333-3333-4333-8333-333333333333", "offsetIntoBinaryTextSegment": 165304, "sampleCount": 1,
              "subFrames": [{"binaryUUID": "44444444-4444-4444-8444-444444444444", "offsetIntoBinaryTextSegment": 6948,
                "sampleCount": 1, "binaryName": "libdyld.dylib", "address": 7170808612}],
              "binaryName": "Example", "address": 7170766264}]}],
             "callStackPerThread": true}
            """
        let result = AppleDiagnosticProjection.stack(Data(json.utf8))
        XCTAssertEqual(result, .init(status: "available", truncated: false, frames: [
            .init(binaryUUID: "33333333-3333-4333-8333-333333333333", binaryName: "Example", address: "0x1ab6935b8", offset: "0x285b8"),
            .init(binaryUUID: "44444444-4444-4444-8444-444444444444", binaryName: "libdyld.dylib", address: "0x1ab69db24", offset: "0x1b24"),
        ]))
    }
    func testStillReadsTheDocumentationExampleWrapper() throws {
        let bytes = try JSONSerialization.data(withJSONObject: ["callStackTree": ["callStacks": [["callStackRootFrames": [frame]]]]])
        let result = AppleDiagnosticProjection.stack(bytes)
        XCTAssertEqual(result.status, "available"); XCTAssertEqual(result.frames.count, 1)
    }
    func testMalformedOversizedAndUnsafeNamesNeverBecomeAvailableStacks() throws {
        XCTAssertEqual(AppleDiagnosticProjection.stack(Data("{}".utf8)).status, "malformed")
        XCTAssertEqual(AppleDiagnosticProjection.stack(Data(repeating: 32, count: 262145)).status, "oversized")
        var value = frame; value["binaryName"] = "/private/alice/Example"
        XCTAssertEqual(AppleDiagnosticProjection.stack(try tree([value])).status, "malformed")
    }
    func testFrameAndDepthLimitsRemainExplicit() throws {
        let result = AppleDiagnosticProjection.stack(try tree(Array(repeating: frame, count: 65)))
        XCTAssertEqual(result.frames.count, 64); XCTAssertTrue(result.truncated)
        var value = frame
        for _ in 0..<40 { var parent = frame; parent["subFrames"] = [value]; value = parent }
        let deep = AppleDiagnosticProjection.stack(try tree([value]))
        XCTAssertLessThanOrEqual(deep.frames.count, 32); XCTAssertTrue(deep.truncated)
    }
}
