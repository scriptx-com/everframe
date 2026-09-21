// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import TraceItXProtocol
@testable import TraceItXKit

final class BoundJsonTests: XCTestCase {
    private func bytes(_ v: VitalsJSON?) -> Int { v.map { VitalsWireCodec.utf8Length(encodedJSONText($0)) } ?? 0 }

    /// Codex round-4, #4 — the budget has to measure what INGEST measures. The server refines a
    /// custom entry with `utf8ByteLength(JSON.stringify(e.data))`, and JavaScript prints an
    /// integral double up to 1e21 in full while Foundation switches to exponent notation an order
    /// of magnitude earlier. Every expectation below is `node -e 'console.log(JSON.stringify(v))'`.
    func testNumbersAreMeasuredTheWayJavaScriptSerialisesThem() {
        let table: [(Double, String)] = [
            (0, "0"), (-0.0, "0"), (1, "1"), (-1, "-1"), (0.1, "0.1"), (-0.5, "-0.5"), (1.5, "1.5"),
            (100, "100"), (1e15, "1000000000000000"), (1e16, "10000000000000000"),
            (1e17, "100000000000000000"), (1e20, "100000000000000000000"),
            (1e21, "1e+21"), (1e22, "1e+22"), (1.5e21, "1.5e+21"),
            (123456789012345680, "123456789012345680"), (9007199254740993, "9007199254740992"),
            (1e-5, "0.00001"), (1e-6, "0.000001"), (1e-7, "1e-7"),
            (1e-323, "1e-323"), (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (-1.7976931348623157e308, "-1.7976931348623157e+308"),
            (2.5, "2.5"), (1234.5678, "1234.5678"), (0.000001234, "0.000001234"), (1e6, "1000000"),
        ]
        for (v, expected) in table { XCTAssertEqual(esNumberText(v), expected, "\(v)") }
        XCTAssertEqual(esNumberText(.nan), "null")
        XCTAssertEqual(esNumberText(.infinity), "null")
        // Int64.max has no exact double: JavaScript parses it, rounds, and prints the rounding.
        XCTAssertEqual(jsonStringifyByteLength(.int(Int64.max)), "9223372036854776000".utf8.count)
        XCTAssertEqual(jsonStringifyByteLength(.object(["a": .int(1), "b": .null])), #"{"a":1,"b":null}"#.utf8.count)
        XCTAssertEqual(jsonStringifyByteLength(.array([.bool(true), .bool(false), .string("é")])), #"[true,false,"é"]"#.utf8.count)
    }
    /// The exact payload the finding names: 100 × 1e20 measures 601 bytes through Foundation and
    /// 2201 through `JSON.stringify`, so it used to ship untruncated and ingest rejected the
    /// WHOLE chunk — every unrelated sample and player event in it included.
    func testANumericPayloadThatOnlyOverflowsInJavaScriptIsStillTruncated() {
        let v = VitalsJSON.array(Array(repeating: .double(1e20), count: 100))
        XCTAssertLessThan(VitalsWireCodec.utf8Length(encodedJSONText(v)), 2048, "precondition: Foundation sees it as small")
        XCTAssertEqual(jsonStringifyByteLength(v), 2201)
        let r = boundJson(v, maxBytes: 2048)
        XCTAssertTrue(r.truncated)
        XCTAssertLessThanOrEqual(jsonStringifyByteLength(r.data!), 2048)
    }
    /// …and the boundary is not moved for a payload that genuinely fits: 93 × 1e20 is 2047 bytes
    /// of `JSON.stringify`. This is the array the cross-language fixture carries.
    func testANumericPayloadThatFitsInJavaScriptIsLeftAlone() {
        let v = VitalsJSON.array(Array(repeating: .double(1e20), count: 93))
        XCTAssertEqual(jsonStringifyByteLength(v), 2047)
        let r = boundJson(v, maxBytes: 2048)
        XCTAssertFalse(r.truncated); XCTAssertEqual(r.data, v)
    }

    func testNullValueIsUntouched() {
        let r = boundJson(nil)
        XCTAssertNil(r.data); XCTAssertFalse(r.truncated)
    }
    func testValueWithinCapIsReturnedAsIs() {
        let v = VitalsJSON.object(["a": .int(1)])
        let r = boundJson(v, maxBytes: 100)
        XCTAssertEqual(r.data, v); XCTAssertFalse(r.truncated)
    }
    func testOverCapCollapsesToTruncatedPreviewThatFitsTheCap() {
        let v = VitalsJSON.string(String(repeating: "x", count: 5000))
        let r = boundJson(v, maxBytes: 2048)
        XCTAssertTrue(r.truncated)
        guard case let .object(o)? = r.data else { return XCTFail("expected object") }
        XCTAssertEqual(o["truncated"], .bool(true))
        guard case let .string(preview)? = o["preview"] else { return XCTFail("expected preview") }
        XCTAssertTrue(preview.hasPrefix("\"xxx"))
        XCTAssertLessThanOrEqual(bytes(r.data), 2048)
    }
    func testPreviewNeverSplitsAMultibyteCodePoint() {
        let v = VitalsJSON.string(String(repeating: "😀", count: 2000))
        let r = boundJson(v, maxBytes: 300)
        guard case let .object(o)? = r.data, case let .string(preview)? = o["preview"] else { return XCTFail() }
        XCTAssertTrue(preview.unicodeScalars.allSatisfy { $0.value == 0x1F600 || $0 == "\"" })
        XCTAssertLessThanOrEqual(bytes(r.data), 300)
    }
    func testDegradesToEmptyPreviewShellOrNilWhenTheCapCannotHoldTheWrapper() {
        let v = VitalsJSON.string(String(repeating: "x", count: 100))
        let shell = boundJson(v, maxBytes: 32)        // {"preview":"","truncated":true} is 31 bytes
        XCTAssertEqual(shell.data, .object(["truncated": .bool(true), "preview": .string("")]))
        XCTAssertTrue(shell.truncated)
        let none = boundJson(v, maxBytes: 10)
        XCTAssertNil(none.data); XCTAssertTrue(none.truncated)
    }
    func testDropsThePayloadEntirelyWhenMaxBytesIsZero() {
        let r = boundJson(.int(1), maxBytes: 0)
        XCTAssertNil(r.data); XCTAssertTrue(r.truncated)
    }

    // MARK: structured

    func testStructuredWithinCapReturnedVerbatim() {
        let v: [String: VitalsJSON] = ["message": .string("hi"), "fatal": .bool(true)]
        let r = boundStructuredJson(v, maxBytes: 8192)
        XCTAssertEqual(r.data, v); XCTAssertFalse(r.truncated)
    }
    func testStructuredScalarsSurviveLongStringsShrinkNestedKeptOnlyIfSmall() {
        let v: [String: VitalsJSON] = [
            "code": .int(42), "fatal": .bool(true),
            "message": .string(String(repeating: "m", count: 3000)),
            "detail": .string(String(repeating: "d", count: 3000)),
            "nested": .object(["k": .string(String(repeating: "n", count: 500))]),
            "small": .object(["k": .int(1)]),
        ]
        let r = boundStructuredJson(v, maxBytes: 1024)
        XCTAssertTrue(r.truncated)
        let o = r.data!
        XCTAssertEqual(o["code"], .int(42)); XCTAssertEqual(o["fatal"], .bool(true))
        XCTAssertNil(o["nested"]); XCTAssertEqual(o["small"], .object(["k": .int(1)]))
        XCTAssertLessThanOrEqual(bytes(.object(o)), 1024)
        XCTAssertTrue(o["message"] != nil || o["detail"] != nil)
    }
    func testStructured3KBErrorPayloadUnderThe8KBCapSurvivesIntact() {
        let v: [String: VitalsJSON] = ["message": .string(String(repeating: "m", count: 1500)), "detail": .string(String(repeating: "d", count: 1500)), "code": .string("E"), "fatal": .bool(true)]
        let r = boundStructuredJson(v, maxBytes: VitalsLimits.maxPlayerEventDataBytes)
        XCTAssertEqual(r.data, v); XCTAssertFalse(r.truncated)
    }
    func testStructuredManySmallStringsNeverExceedTheCap() {
        var v: [String: VitalsJSON] = [:]
        for i in 0..<500 { v["k\(i)"] = .string("value-\(i)") }
        let r = boundStructuredJson(v, maxBytes: 2048)
        XCTAssertLessThanOrEqual(bytes(.object(r.data!)), 2048)
    }
    func testStructuredDropsThePayloadWhenEvenScalarsDoNotFit() {
        var v: [String: VitalsJSON] = [:]
        for i in 0..<100 { v["k\(i)"] = .int(Int64(i)) }
        let r = boundStructuredJson(v, maxBytes: 20)
        XCTAssertNil(r.data); XCTAssertTrue(r.truncated)
    }
    func testStructuredKeepsOnlyScalarsWhenTheCapFitsThemButNoStringField() {
        let v: [String: VitalsJSON] = ["code": .int(1), "message": .string(String(repeating: "m", count: 200))]
        let r = boundStructuredJson(v, maxBytes: 14)  // {"code":1} is 10 bytes
        XCTAssertEqual(r.data, ["code": .int(1)]); XCTAssertTrue(r.truncated)
    }
}
