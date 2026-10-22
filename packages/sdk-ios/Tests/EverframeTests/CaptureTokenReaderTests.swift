// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import EverframeKit

final class CaptureTokenReaderTests: XCTestCase {
    private var home: String!

    override func setUpWithError() throws {
        home = NSTemporaryDirectory() + "evf-token-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: home, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(atPath: home)
    }

    private func writeCredentials(_ body: String) throws {
        let dir = home + "/.everframe"
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        try body.write(toFile: dir + "/credentials", atomically: true, encoding: .utf8)
    }

    func testReadsTokenFromHostHome() throws {
        try writeCredentials(#"{"token":"abc123"}"#)
        XCTAssertEqual(CaptureTokenReader.read(environment: ["SIMULATOR_HOST_HOME": home]), "abc123")
    }

    func testNoHostHomeReturnsNil() {
        XCTAssertNil(CaptureTokenReader.read(environment: [:]))
    }

    func testMissingFileReturnsNil() {
        XCTAssertNil(CaptureTokenReader.read(environment: ["SIMULATOR_HOST_HOME": home]))
    }

    func testMalformedJSONReturnsNil() throws {
        try writeCredentials("not json")
        XCTAssertNil(CaptureTokenReader.read(environment: ["SIMULATOR_HOST_HOME": home]))
    }

    func testMissingTokenKeyReturnsNil() throws {
        try writeCredentials("{}")
        XCTAssertNil(CaptureTokenReader.read(environment: ["SIMULATOR_HOST_HOME": home]))
    }

    func testValidate() {
        XCTAssertEqual(CaptureTokenReader.validate("  abc  "), "abc")
        XCTAssertNil(CaptureTokenReader.validate(nil))
        XCTAssertNil(CaptureTokenReader.validate(""))
        XCTAssertNil(CaptureTokenReader.validate("   "))
        XCTAssertEqual(CaptureTokenReader.validate(String(repeating: "a", count: 512)), String(repeating: "a", count: 512))
        XCTAssertNil(CaptureTokenReader.validate(String(repeating: "a", count: 513)))
        XCTAssertNil(CaptureTokenReader.validate("ab c"))
        XCTAssertNil(CaptureTokenReader.validate("tök"))
    }
}
