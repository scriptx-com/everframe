// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import XCTest
@testable import EverframeKit
import EverframeProtocol

final class CrashCauseNormalizerTests: XCTestCase {
    private func input(message: String = "inner", frames: [EverframeCrashCauseFrame] = [], count: Int = 1) -> RNCrashCausesWire {
        RNCrashCausesWire(causes: Array(repeating: EverframeCrashCause(exceptionType: "Error", frames: frames, framesTruncated: false, message: message), count: count), truncated: false)
    }
    func testAbsentAndInvalidRootsDiffer() throws {
        XCTAssertNil(normalizeCrashCauseChain(nil, redact: { $0 }, stillOwned: { true }))
        let lost = try XCTUnwrap(normalizeCrashCauseChain(.invalid, redact: { $0 }, stillOwned: { true }))
        XCTAssertTrue(lost.causes.isEmpty)
        XCTAssertTrue(lost.truncated)
    }
    func testRepairsAndRecapsRedactionWithoutSplittingSurrogates() throws {
        let value = input(message: "secret")
        let chain = try XCTUnwrap(normalizeCrashCauseChain(value, redact: { $0 == "secret" ? String(repeating: "x", count: 4095) + "😀" : $0 }, stillOwned: { true }))
        XCTAssertEqual(chain.causes[0].message, String(repeating: "x", count: 4095))
        XCTAssertTrue(chain.truncated)
        let repaired = try XCTUnwrap(normalizeCrashCauseChain(input(message: "a\u{0}b"), redact: { $0 }, stillOwned: { true }))
        XCTAssertEqual(repaired.causes[0].message, "a�b")
    }
    func testFitsEncodedBytesWithEscapesAndMultibyteText() throws {
        let frame = EverframeCrashCauseFrame(col: nil, file: String(repeating: "界", count: 1024), function: nil, line: nil, raw: String(repeating: "\u{1}", count: 1024))
        let value = input(message: String(repeating: "界", count: 4096), frames: Array(repeating: frame, count: 32), count: 8)
        let chain = try XCTUnwrap(normalizeCrashCauseChain(value, redact: { $0 }, stillOwned: { true }))
        XCTAssertLessThanOrEqual(try EnvelopeBuilder.makeJSONEncoder().encode(chain).count, 65_536)
        XCTAssertTrue(chain.truncated)
        XCTAssertFalse(chain.causes.isEmpty)
        XCTAssertTrue(try XCTUnwrap(chain.causes.last).framesTruncated)
    }
    func testBoundsDirectNativeInputAndRejectsInvalidPositions() throws {
        let frame = EverframeCrashCauseFrame(col: 9_007_199_254_740_992, file: nil, function: nil, line: -1, raw: "frame")
        let chain = try XCTUnwrap(normalizeCrashCauseChain(input(frames: Array(repeating: frame, count: 33), count: 9), redact: { $0 }, stillOwned: { true }))
        XCTAssertEqual(chain.causes.count, 8)
        XCTAssertTrue(chain.truncated)
        XCTAssertEqual(chain.causes[0].frames.count, 32)
        XCTAssertTrue(chain.causes[0].framesTruncated)
        XCTAssertNil(chain.causes[0].frames[0].line)
        XCTAssertNil(chain.causes[0].frames[0].col)
    }
    func testRedactorFailureAndOwnershipLossDiscardEnrichment() {
        XCTAssertNil(normalizeCrashCauseChain(input(), redact: { _ in throw NSError(domain: "redaction", code: 1) }, stillOwned: { true }))
        var owned = true
        XCTAssertNil(normalizeCrashCauseChain(input(), redact: { owned = false; return $0 }, stillOwned: { owned }))
    }
}
