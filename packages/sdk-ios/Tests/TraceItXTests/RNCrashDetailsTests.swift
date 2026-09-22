// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import Foundation
@testable import TraceItXKit
import XCTest

final class RNCrashDetailsTests: XCTestCase {
    private func object(_ json: String,
                        redact: (String) throws -> String = { $0 }) throws -> [String: Any] {
        let input = try JSONDecoder().decode(RNCrashDetailsWire.self, from: Data(json.utf8))
        let details = try XCTUnwrap(normalizeRNCrashDetails(input, redact: redact))
        let bytes = try EnvelopeBuilder.makeJSONEncoder().encode(details)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
    }

    func testWireKeepsLargeNumberAndOptionalSibling() throws {
        let data = Data(#"{"severity":"warning","context":42,"metadata":{"n":9007199254740994}}"#.utf8)
        let input = try JSONDecoder().decode(RNCrashDetailsWire.self, from: data)
        let details = try XCTUnwrap(normalizeRNCrashDetails(input, redact: { $0 }))
        let bytes = try EnvelopeBuilder.makeJSONEncoder().encode(details)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        XCTAssertEqual(object["severity"] as? String, "warning")
        XCTAssertEqual(object["truncated"] as? Bool, true)
        XCTAssertEqual((object["metadata"] as? [String: Any])?["n"] as? Double, 9007199254740994)
    }

    func testOverflowIsLocalAndArrayCursorKeepsFollowingSibling() throws {
        let output = try object(#"{"metadata":{"bad":1e400,"good":3,"array":[1,1e400,2]}}"#)
        let metadata = try XCTUnwrap(output["metadata"] as? [String: Any])
        XCTAssertNil(metadata["bad"])
        XCTAssertEqual(metadata["good"] as? Double, 3)
        let array = try XCTUnwrap(metadata["array"] as? [Any])
        XCTAssertEqual(array.count, 3)
        XCTAssertEqual(array[0] as? Double, 1)
        XCTAssertTrue(array[1] is NSNull)
        XCTAssertEqual(array[2] as? Double, 2)
        XCTAssertEqual(output["truncated"] as? Bool, true)
    }

    func testSensitiveOverflowIsMaskedBeforeDecodeWithoutLoss() throws {
        let output = try object(#"{"metadata":{"accessToken":1e400}}"#)
        XCTAssertEqual(output as NSDictionary, [
            "severity": "error",
            "metadata": ["accessToken": "[REDACTED]"],
        ] as NSDictionary)
    }

    func testWirePreservesBinary64BooleansNullUnicodeAndProtoKey() throws {
        let output = try object(#"{"metadata":{"values":[true,false,9007199254740992,9007199254740994,-9007199254740994,1e100,1.25,0,null],"__proto__":{"é":"😀"}}}"#)
        let metadata = try XCTUnwrap(output["metadata"] as? [String: Any])
        let values = try XCTUnwrap(metadata["values"] as? [Any])
        XCTAssertEqual(CFGetTypeID(try XCTUnwrap(values[0] as? NSNumber)), CFBooleanGetTypeID())
        XCTAssertEqual(CFGetTypeID(try XCTUnwrap(values[1] as? NSNumber)), CFBooleanGetTypeID())
        XCTAssertEqual(values[2] as? Double, 9_007_199_254_740_992)
        XCTAssertEqual(values[3] as? Double, 9_007_199_254_740_994)
        XCTAssertEqual(values[4] as? Double, -9_007_199_254_740_994)
        XCTAssertEqual(values[5] as? Double, 1e100)
        XCTAssertEqual(values[6] as? Double, 1.25)
        XCTAssertEqual(values[7] as? Double, 0)
        XCTAssertTrue(values[8] is NSNull)
        XCTAssertEqual(metadata["__proto__"] as? NSDictionary, ["é": "😀"] as NSDictionary)
        XCTAssertNil(output["truncated"])
    }

    func testWireChargesSkippedKeysAndStopsAt128Nodes() throws {
        let hugeKey = String(repeating: "x", count: 4_097)
        let jsonObject: [String: Any] = [
            "metadata": [
                hugeKey: "unread",
                "array": Array(repeating: 1, count: 127),
            ] as [String: Any],
        ]
        let json = String(decoding: try JSONSerialization.data(withJSONObject: jsonObject), as: UTF8.self)
        let output = try object(json)
        let metadata = try XCTUnwrap(output["metadata"] as? [String: Any])
        let values = try XCTUnwrap(metadata["array"] as? [Any])
        XCTAssertLessThanOrEqual(values.count, 126)
        XCTAssertNil(metadata[hugeKey])
        XCTAssertEqual(output["truncated"] as? Bool, true)
    }

    func testMetadataRootCountsTowardExact128NodeBoundary() throws {
        func output(elementCount: Int) throws -> [String: Any] {
            let json = String(decoding: try JSONSerialization.data(withJSONObject: [
                "metadata": ["only": Array(repeating: 1, count: elementCount)],
            ]), as: UTF8.self)
            return try object(json)
        }
        let exact = try output(elementCount: 126)
        XCTAssertEqual(((exact["metadata"] as? [String: Any])?["only"] as? [Any])?.count, 126)
        XCTAssertNil(exact["truncated"])

        let overflow = try output(elementCount: 127)
        XCTAssertEqual(((overflow["metadata"] as? [String: Any])?["only"] as? [Any])?.count, 126)
        XCTAssertEqual(overflow["truncated"] as? Bool, true)
    }

    func testWireAllowsFourContainerLevelsAndOmitsFifth() throws {
        let output = try object(#"{"metadata":{"two":{"three":{"four":{"scalar":1,"five":[2]}}}}}"#)
        XCTAssertEqual(output as NSDictionary, [
            "severity": "error",
            "truncated": true,
            "metadata": ["two": ["three": ["four": ["scalar": 1]]]],
        ] as NSDictionary)
    }

    func testPresentInvalidFieldsRemainIndependentAndMissingFieldsDoNotInventLoss() throws {
        XCTAssertEqual(try object(#"{}"#) as NSDictionary, ["severity": "error"])
        XCTAssertEqual(try object(#"{"severity":"unknown","context":null,"metadata":[],"truncated":null,"future":1e400}"#) as NSDictionary,
                       ["severity": "error", "truncated": true] as NSDictionary)
        XCTAssertEqual(try object(#"{"severity":"info","context":"ok","metadata":{"valid":2},"truncated":false}"#) as NSDictionary,
                       ["severity": "info", "context": "ok", "metadata": ["valid": 2]] as NSDictionary)
    }

    func testInheritedWireLossCombinesWithProjectionAndByteFitting() throws {
        enum Failure: Error { case redact }
        let projected = try object(#"{"severity":"warning","context":42,"metadata":{"bad":"throw","good":"ok"}}"#) {
            if $0 == "throw" { throw Failure.redact }
            return $0
        }
        XCTAssertEqual(projected["severity"] as? String, "warning")
        XCTAssertEqual(projected["truncated"] as? Bool, true)
        XCTAssertEqual(projected["metadata"] as? NSDictionary, ["good": "ok"] as NSDictionary)

        let large = String(repeating: "界", count: 1_024)
        let input: [String: Any] = ["severity": "info", "context": "priority",
                                    "metadata": ["values": Array(repeating: large, count: 20)]]
        let json = String(decoding: try JSONSerialization.data(withJSONObject: input), as: UTF8.self)
        let fitted = try object(json)
        let bytes = try JSONSerialization.data(withJSONObject: fitted, options: [.sortedKeys])
        XCTAssertLessThanOrEqual(bytes.count, 8_192)
        XCTAssertEqual(fitted["severity"] as? String, "info")
        XCTAssertEqual(fitted["context"] as? String, "priority")
        XCTAssertEqual(fitted["truncated"] as? Bool, true)
    }
}
