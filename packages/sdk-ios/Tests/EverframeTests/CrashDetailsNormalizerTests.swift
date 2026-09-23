// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import CoreFoundation
import XCTest
@testable import EverframeKit

final class CrashDetailsNormalizerTests: XCTestCase {
    func testNativeWarningOwnsItsDetails() throws {
        let nested = NSMutableDictionary(dictionary: ["state": "before"])
        let result = normalizeCrashDetails(
            CaptureExceptionOptions(severity: .warning, context: "checkout",
                metadata: ["attempt": 2, "accessToken": "synthetic", "nested": nested]),
            redact: { $0 }
        )
        nested["state"] = "after"
        let bytes = try EnvelopeBuilder.makeJSONEncoder().encode(result)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        XCTAssertEqual(object["severity"] as? String, "warning")
        let metadata = try XCTUnwrap(object["metadata"] as? [String: Any])
        XCTAssertEqual(metadata["attempt"] as? Int, 2)
        XCTAssertEqual(metadata["accessToken"] as? String, "[REDACTED]")
        XCTAssertEqual((metadata["nested"] as? [String: Any])?["state"] as? String, "before")
        XCTAssertNil(object["truncated"])
        XCTAssertLessThanOrEqual(bytes.count, 8192)
    }

    private func project(_ metadata: [String: Any], context: String? = nil,
                         redact: (String) throws -> String = { $0 }) throws -> [String: Any] {
        try CrashDetailsFixtureSupport.object(CaptureExceptionOptions(context: context, metadata: metadata), redact: redact)
    }

    func testNumbersRetainBooleanIdentityAndExactSafeIntegers() throws {
        let input: [Any] = [true, false, NSNumber(value: true), NSNumber(value: Int8(1)),
            NSNumber(value: Double(1)), NSNumber(value: UInt64(9_007_199_254_740_991)),
            Int64(-9_007_199_254_740_991), UInt64(9_007_199_254_740_991),
            Int8(-8), Int16(-16), Int32(-32), UInt8(8), UInt16(16), UInt32(32),
            Float(1.25), Double(2.5), NSNull()]
        let output = try XCTUnwrap(try project(["values": input])["metadata"] as? [String: Any])
        let array = try XCTUnwrap(output["values"] as? [Any])
        XCTAssertEqual(array.count, input.count)
        for index in 0..<3 {
            XCTAssertEqual(CFGetTypeID(try XCTUnwrap(array[index] as? NSNumber)), CFBooleanGetTypeID())
        }
        for index in 3..<16 {
            XCTAssertNotEqual(CFGetTypeID(try XCTUnwrap(array[index] as? NSNumber)), CFBooleanGetTypeID())
        }
        XCTAssertEqual((array[5] as? NSNumber)?.int64Value, 9_007_199_254_740_991)
        XCTAssertEqual((array[6] as? NSNumber)?.int64Value, -9_007_199_254_740_991)
        XCTAssertEqual((array[7] as? NSNumber)?.int64Value, 9_007_199_254_740_991)
        XCTAssertEqual(Array(array[8..<16]) as NSArray, [-8, -16, -32, 8, 16, 32, 1.25, 2.5])
        XCTAssertTrue(array[16] is NSNull)
    }

    func testUnsupportedValuesAreOmittedOrArrayNullWithoutDescription() throws {
        final class Host: NSObject {
            override var description: String { XCTFail("description invoked"); return "unsafe" }
            override var debugDescription: String { XCTFail("debugDescription invoked"); return "unsafe" }
            override var hash: Int { XCTFail("hash invoked"); return 0 }
            override func isEqual(_ object: Any?) -> Bool { XCTFail("equality invoked"); return false }
        }
        let unsupported: [Any] = [Host(), Set([1, 2]), NSDecimalNumber(string: "1.25"),
            Double.infinity, Float.nan, Int64.min, Int64.max, UInt64.max,
            Int64(9_007_199_254_740_992), Int64(-9_007_199_254_740_992),
            UInt64(9_007_199_254_740_992), NSNumber(value: UInt64.max),
            NSNumber(value: Int64.min), NSNumber(value: Double.infinity)]
        for value in unsupported {
            let output = try project(["bad": value, "array": [value], "good": 7])
            let metadata = try XCTUnwrap(output["metadata"] as? [String: Any])
            XCTAssertNil(metadata["bad"])
            XCTAssertEqual(metadata["good"] as? Int, 7)
            XCTAssertTrue((metadata["array"] as? [Any])?.first is NSNull)
            XCTAssertEqual(output["truncated"] as? Bool, true)
        }
    }

    func testTypedSwiftContainersAndFoundationCopies() throws {
        let mutable = NSMutableString(string: "before")
        let array = NSMutableArray(array: [mutable, 2])
        let result = normalizeCrashDetails(CaptureExceptionOptions(metadata: [
            "ints": [1, 2, 3], "bools": [true, false], "floats": [Float(1.5)],
            "maps": [["one": 1], ["two": 2]], "typedMap": ["item": [1, 2]], "mutable": array
        ]), redact: { $0 })
        mutable.setString("after"); array.add(3)
        let data = try EnvelopeBuilder.makeJSONEncoder().encode(result)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object as NSDictionary, ["severity": "error", "metadata": [
            "ints": [1, 2, 3], "bools": [true, false], "floats": [1.5],
            "maps": [["one": 1], ["two": 2]], "typedMap": ["item": [1, 2]], "mutable": ["before", 2]
        ]] as NSDictionary)
    }

    func testCyclesStopOnActivePathButSiblingReferencesRemain() throws {
        let map = NSMutableDictionary()
        map["self"] = map; map["good"] = 1
        let array = NSMutableArray(); array.add(array); array.add(2)
        defer { map.removeAllObjects(); array.removeAllObjects() }
        let output = try project(["map": map, "array": array, "siblings": [map, map]])
        XCTAssertEqual(output as NSDictionary, ["severity": "error", "truncated": true, "metadata": [
            "map": ["good": 1], "array": [NSNull(), 2], "siblings": [["good": 1], ["good": 1]]
        ]] as NSDictionary)
    }

    func testFoundationKeysAreAcceptedAndMaskedBeforeValueAccess() throws {
        let huge = String(repeating: "a", count: 4097)
        let map = CrashCountedDictionary(keys: ["accessToken", "API-KEY", "apiKey", huge, 7, "good"]) { key in
            XCTAssertTrue(["apiKey", "good"].contains(key), "unexpected lookup")
            return key == "good" ? 7 : "ordinary"
        }
        let output = try project(["map": map])
        XCTAssertEqual(map.valueReads, ["apiKey", "good"])
        XCTAssertEqual(output as NSDictionary, ["severity": "error", "truncated": true, "metadata": ["map": [
            "accessToken": "[REDACTED]", "API-KEY": "[REDACTED]", "apiKey": "ordinary", "good": 7
        ]]] as NSDictionary)
    }

    func testSensitivityUsesOriginalKeyAndCollisionKeepsFirstAcceptedValue() throws {
        let map = CrashCountedDictionary(keys: ["token", "plain", "first", "second", "rejected"]) { key in
            XCTAssertNotEqual(key, "token"); XCTAssertNotEqual(key, "second"); XCTAssertNotEqual(key, "rejected")
            return key == "plain" ? "visible" : 1
        }
        enum Failure: Error { case redaction }
        let output = try project(["map": map]) { text in
            switch text {
            case "token": return "innocent"
            case "plain": return "password"
            case "first", "second": return "same"
            case "rejected": throw Failure.redaction
            default: return text
            }
        }
        XCTAssertEqual(map.valueReads, ["plain", "first"])
        XCTAssertEqual(output as NSDictionary, ["severity": "error", "truncated": true, "metadata": ["map": [
            "innocent": "[REDACTED]", "password": "visible", "same": 1
        ]]] as NSDictionary)
    }

    func testNodeBudgetBoundsFoundationSlotsIncludingOmittedValues() throws {
        let array = CrashCountedArray(count: 1_000_000) { _ in NSObject() }
        let output = try project(["array": array])
        let metadata = try XCTUnwrap(output["metadata"] as? [String: Any])
        let slots = try XCTUnwrap(metadata["array"] as? [Any])
        XCTAssertEqual(array.reads, 126) // root + array + inspected slots = 128
        XCTAssertEqual(slots.count, 126)
        XCTAssertTrue(slots.allSatisfy { $0 is NSNull })
        XCTAssertEqual(output["truncated"] as? Bool, true)

        let map = CrashCountedDictionary(keys: Array(0..<1000).map { "key\($0)" }) { _ in NSObject() }
        let mapOutput = try project(["map": map])
        XCTAssertEqual(map.keyReads, 126)
        XCTAssertEqual(map.valueReads.count, 126)
        XCTAssertEqual((mapOutput["metadata"] as? [String: Any])?["map"] as? NSDictionary, [:])
        XCTAssertEqual(mapOutput["truncated"] as? Bool, true)
    }

    func testExactly128NodesAndFourContainerLevelsDoNotInventLoss() throws {
        let output = try project(["array": Array(repeating: 1, count: 126)])
        XCTAssertNil(output["truncated"])
        let boundary = try project(["two": ["three": ["four": ["scalar": 1]]]])
        XCTAssertNil(boundary["truncated"])
        let exceeded = try project(["two": ["three": ["four": ["five": [1], "scalar": 1]]]])
        XCTAssertEqual(exceeded as NSDictionary, ["severity": "error", "truncated": true,
            "metadata": ["two": ["three": ["four": ["scalar": 1]]]]] as NSDictionary)
    }

    func testRawScanAndUTF16CapsRepairAndAvoidSplittingPairs() throws {
        var scans: [String] = []
        let malformed = NSString(characters: [0x61, 0, 0xd800, 0x62, 0xdc00], length: 5)
        let output = try project([String(repeating: "k", count: 129): String(repeating: "😀", count: 513),
            "raw": String(repeating: "r", count: 5000), "bad": malformed],
            context: String(repeating: "c", count: 255) + "😀") { text in scans.append(text); return text }
        let metadata = try XCTUnwrap(output["metadata"] as? [String: Any])
        XCTAssertEqual(output["context"] as? String, String(repeating: "c", count: 255))
        XCTAssertEqual(metadata[String(repeating: "k", count: 128)] as? String, String(repeating: "😀", count: 512))
        XCTAssertEqual(metadata["raw"] as? String, String(repeating: "r", count: 1024))
        XCTAssertEqual(metadata["bad"] as? String, "a��b�")
        XCTAssertEqual(scans.map { $0.utf16.count }.max(), 4096)
        XCTAssertTrue(scans.contains(String(repeating: "r", count: 4096)))
        XCTAssertEqual(output["truncated"] as? Bool, true)
    }

    func testRedactionExpansionsAreRecappedAndThrowingValuesRetainSiblings() throws {
        enum Failure: Error { case redaction }
        let output = try project(["expandKey": "expandValue", "bad": "throw", "good": 2, "array": ["throw", 3]], context: "throw") { text in
            if text == "throw" { throw Failure.redaction }
            if text == "expandKey" { return String(repeating: "k", count: 200) }
            if text == "expandValue" { return String(repeating: "v", count: 1100) }
            return text
        }
        XCTAssertNil(output["context"])
        let metadata = try XCTUnwrap(output["metadata"] as? [String: Any])
        XCTAssertNil(metadata["bad"])
        XCTAssertEqual(metadata["good"] as? Int, 2)
        XCTAssertEqual(metadata["array"] as? NSArray, [NSNull(), 3])
        XCTAssertEqual(metadata[String(repeating: "k", count: 128)] as? String, String(repeating: "v", count: 1024))
        XCTAssertEqual(output["truncated"] as? Bool, true)
        let context = try project([:], context: "expand") { $0 == "expand" ? String(repeating: "😀", count: 200) : $0 }
        XCTAssertEqual(context["context"] as? String, String(repeating: "😀", count: 128))
    }

    func testActual8192And8193ByteBoundariesKeepSeverityAndContext() throws {
        // 61 bytes of envelope/member punctuation and context, 8 quoted array
        // strings plus commas (25 bytes), and 8106 ASCII content bytes = 8192.
        let prefix = Array(repeating: String(repeating: "a", count: 1024), count: 7)
        let atLimit = CaptureExceptionOptions(severity: .warning, context: "priority", metadata: ["a": prefix + [String(repeating: "z", count: 938)]])
        let bytes = try CrashDetailsFixtureSupport.encoded(atLimit)
        XCTAssertEqual(bytes.count, 8192)
        let exact = try CrashDetailsFixtureSupport.object(atLimit)
        XCTAssertNil(exact["truncated"])
        let overLimit = CaptureExceptionOptions(severity: .warning, context: "priority", metadata: ["a": prefix + [String(repeating: "z", count: 939)]])
        let cappedBytes = try CrashDetailsFixtureSupport.encoded(overLimit)
        XCTAssertEqual(cappedBytes.count, 8192)
        let capped = try CrashDetailsFixtureSupport.object(overLimit)
        XCTAssertEqual(capped["severity"] as? String, "warning")
        XCTAssertEqual(capped["context"] as? String, "priority")
        XCTAssertEqual(capped["truncated"] as? Bool, true)
        let values = try XCTUnwrap((capped["metadata"] as? [String: Any])?["a"] as? [String])
        XCTAssertEqual(values.count, 8)
        XCTAssertEqual(Array(values.prefix(7)), prefix)
        XCTAssertEqual(values.last?.count, 921) // truncated field adds 17 bytes
    }

    func testJavaScriptSerializationFitsWhenFoundationExponentNotationIsShorter() throws {
        let options = CaptureExceptionOptions(metadata: [
            "a": Array(repeating: Double(1e20), count: 100),
            "z": Array(repeating: String(repeating: "x", count: 1024), count: 7),
        ])

        let bytes = try CrashDetailsFixtureSupport.encoded(options)
        let object = try CrashDetailsFixtureSupport.object(options)
        let metadata = try XCTUnwrap(object["metadata"] as? [String: Any])
        let numbers = try XCTUnwrap(metadata["a"] as? [NSNumber])

        XCTAssertFalse(numbers.isEmpty)
        XCTAssertTrue(numbers.allSatisfy { $0.doubleValue == 1e20 })
        XCTAssertEqual(object["truncated"] as? Bool, true)
        XCTAssertLessThanOrEqual(bytes.count, 8192)
        // Foundation emits each value as `1e+20` (5 bytes), while
        // JSON.stringify emits `100000000000000000000` (21 bytes).
        XCTAssertLessThanOrEqual(bytes.count + (numbers.count * 16), 8192)
    }

    func testEscapedMultibyteByteFittingAndTailRemoval() throws {
        for text in [String(repeating: "界", count: 1024), String(repeating: "\\\"\n", count: 340), String(repeating: "😀", count: 512)] {
            let output = try project(["values": Array(repeating: text, count: 20)], context: "retained")
            XCTAssertEqual(output["context"] as? String, "retained")
            XCTAssertEqual(output["truncated"] as? Bool, true)
            let values = try XCTUnwrap((output["metadata"] as? [String: Any])?["values"] as? [String])
            XCTAssertLessThan(values.count, 20)
            XCTAssertEqual(values.first, text)
            XCTAssertTrue(values.allSatisfy { text.hasPrefix($0) })
        }
    }

    func testFoundationStringScanningIsBoundedBeforeRedaction() throws {
        let text = CrashCountedString(count: 1_000_000)
        var longestRedactorInput = 0
        let output = try project(["text": text]) { input in
            longestRedactorInput = max(longestRedactorInput, input.utf16.count)
            return input
        }
        XCTAssertLessThanOrEqual(text.reads, 4097) // bounded scan and pair lookahead
        XCTAssertEqual(longestRedactorInput, 4096)
        XCTAssertEqual((output["metadata"] as? [String: Any])?["text"] as? String, String(repeating: "a", count: 1024))
        XCTAssertEqual(output["truncated"] as? Bool, true)
    }

    func testHostCallbackCanReenterAndBlockWithoutSharingProjectionState() throws {
        let reached = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let done = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            defer { done.signal() }
            let array = CrashCountedArray(count: 1) { _ in
                let nested = try? CrashDetailsFixtureSupport.object(CaptureExceptionOptions(metadata: ["inner": 1]))
                XCTAssertEqual(nested as NSDictionary?, ["severity": "error", "metadata": ["inner": 1]])
                reached.signal()
                XCTAssertEqual(release.wait(timeout: .now() + 5), .success)
                return "owned"
            }
            let result = try? CrashDetailsFixtureSupport.object(CaptureExceptionOptions(metadata: ["array": array]))
            XCTAssertEqual(result as NSDictionary?, ["severity": "error", "metadata": ["array": ["owned"]]])
            XCTAssertEqual(array.reads, 1)
        }
        defer { release.signal() }
        XCTAssertEqual(reached.wait(timeout: .now() + 5), .success)
        XCTAssertEqual(try CrashDetailsFixtureSupport.object(nil) as NSDictionary, ["severity": "error"])
        release.signal()
        XCTAssertEqual(done.wait(timeout: .now() + 5), .success)
    }

    func testUnreadableMemberDoesNotClaimCollisionOrDiscardSibling() throws {
        let map = CrashCountedDictionary(keys: ["unreadable", "first", "second", "good"]) { key in
            switch key {
            case "unreadable": return nil
            case "first": return NSObject()
            case "second": return 2
            default: return 3
            }
        }
        let output = try project(["map": map]) { ["first", "second"].contains($0) ? "same" : $0 }
        XCTAssertEqual(output as NSDictionary, ["severity": "error", "truncated": true,
            "metadata": ["map": ["same": 2, "good": 3]]] as NSDictionary)
        XCTAssertEqual(map.valueReads, ["unreadable", "first", "second", "good"])
    }

    func testSensitiveSuffixSurvivesKeyCapAndSurrogateBoundaryIsNotSplit() throws {
        let key = String(repeating: "k", count: 4091) + "token"
        let pairedKey = String(repeating: "p", count: 127) + "😀"
        let map = CrashCountedDictionary(keys: [key, pairedKey]) { input in
            XCTAssertEqual(input, pairedKey)
            return String(repeating: "v", count: 1023) + "😀"
        }
        let output = try project(["map": map])
        XCTAssertEqual(output as NSDictionary, ["severity": "error", "truncated": true,
            "metadata": ["map": [String(repeating: "k", count: 128): "[REDACTED]",
                String(repeating: "p", count: 127): String(repeating: "v", count: 1023)]]] as NSDictionary)
        XCTAssertEqual(map.valueReads, [pairedKey])
    }


    func testRawScanBoundaryUsesLookaheadWithoutSplittingSurrogatePair() throws {
        let text = CrashCountedString(count: 1_000_000)
        text.unitAt = { index in index == 4095 ? 0xd83d : (index == 4096 ? 0xde00 : 0x61) }
        var scanned: String?
        let output = try project(["text": text]) { input in
            if input != "text" { scanned = input }
            return input
        }
        XCTAssertEqual(text.reads, 4097)
        XCTAssertEqual(scanned, String(repeating: "a", count: 4095))
        XCTAssertEqual((output["metadata"] as? [String: Any])?["text"] as? String, String(repeating: "a", count: 1024))
        XCTAssertEqual(output["truncated"] as? Bool, true)
    }

}
