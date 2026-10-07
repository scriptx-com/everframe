// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import XCTest
@testable import EverframeKit
import EverframeProtocol

final class RNCrashCausesTests: XCTestCase {
    func testSharedNativeNormalizationFixtures() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("protocol/__tests__/fixtures/crash-causes-native-parity.json")
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        for fixture in try XCTUnwrap(root["cases"] as? [[String: Any]]) {
            let data = try JSONSerialization.data(withJSONObject: XCTUnwrap(fixture["input"]), options: .fragmentsAllowed)
            let wire = (try? JSONDecoder().decode(RNCrashCausesWire.self, from: data)) ?? .invalid
            let result = try XCTUnwrap(normalizeCrashCauseChain(wire, redact: { $0 }, stillOwned: { true }))
            let object = try JSONSerialization.jsonObject(with: EnvelopeBuilder.makeJSONEncoder().encode(result))
            XCTAssertEqual(object as? NSDictionary, fixture["expected"] as? NSDictionary, fixture["name"] as? String ?? "fixture")
        }
    }
    func testMalformedFramesPreserveHeaderAndFollowingCause() throws {
        let json = #"{"causes":[{"exceptionType":"Error","message":"one","frames":[{"raw":false}],"framesTruncated":false},{"exceptionType":"Error","message":"two","frames":[],"framesTruncated":false}],"truncated":false}"#
        let wire = try JSONDecoder().decode(RNCrashCausesWire.self, from: Data(json.utf8))
        let chain = try XCTUnwrap(normalizeCrashCauseChain(wire, redact: { $0 }, stillOwned: { true }))
        XCTAssertEqual(chain.causes.map(\.message), ["one", "two"])
        XCTAssertTrue(chain.causes[0].framesTruncated)
        XCTAssertFalse(chain.truncated)
    }
    func testDecodeRetainsOnlyBoundedPrefixes() throws {
        let frame: [String: Any] = ["raw": String(repeating: "x", count: 100_000)]
        let cause: [String: Any] = ["exceptionType": "Error", "message": String(repeating: "x", count: 100_000),
                                  "frames": Array(repeating: frame, count: 40), "framesTruncated": false]
        let data = try JSONSerialization.data(withJSONObject: ["causes": Array(repeating: cause, count: 9), "truncated": false])
        let wire = try JSONDecoder().decode(RNCrashCausesWire.self, from: data)
        XCTAssertEqual(wire.causes.count, 8)
        XCTAssertTrue(wire.truncated)
        XCTAssertTrue(wire.causes.allSatisfy { $0.message.utf16.count <= 8192 && $0.frames.count == 32 && $0.framesTruncated })
        XCTAssertTrue(wire.causes.flatMap(\.frames).allSatisfy { $0.raw.utf16.count <= 8192 })
    }
}
