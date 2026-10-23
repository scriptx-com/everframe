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
        XCTAssertEqual(read(), "abc123")
    }

    func testNoHostHomeReturnsNil() {
        XCTAssertNil(CaptureTokenReader.read(environment: [:], ingestEndpoint: ingest))
    }

    func testMissingFileReturnsNil() {
        XCTAssertNil(read())
    }

    func testMalformedJSONReturnsNil() throws {
        try writeCredentials("not json")
        XCTAssertNil(read())
    }

    func testMissingTokenKeyReturnsNil() throws {
        try writeCredentials("{}")
        XCTAssertNil(read())
    }

    private let ingest = URL(string: "https://everframe.dev")!

    private func read(ingest: URL? = nil) -> String? {
        CaptureTokenReader.read(environment: ["SIMULATOR_HOST_HOME": home], ingestEndpoint: ingest ?? self.ingest)
    }

    func testMatchingOriginReturnsTheToken() throws {
        try writeCredentials(#"{"token":"abc123","url":"https://everframe.dev","email":"e"}"#)
        XCTAssertEqual(read(), "abc123")
        XCTAssertEqual(read(ingest: URL(string: "https://EverFrame.dev:443/api/ingest")!), "abc123")
        try writeCredentials(#"{"token":"abc123","url":"http://localhost:3000"}"#)
        XCTAssertEqual(read(ingest: URL(string: "http://LOCALHOST:3000")!), "abc123")
    }

    func testDifferentHostPortOrSchemeReturnsNil() throws {
        for issuer in ["https://evil.example", "https://everframe.dev:8443", "http://everframe.dev",
                       "https://staging.everframe.dev"] {
            try writeCredentials(#"{"token":"abc123","url":"\#(issuer)"}"#)
            XCTAssertNil(read(), issuer)
        }
    }

    func testNoRecordedOriginKeepsTheToken() throws {
        try writeCredentials(#"{"token":"abc123","email":"e"}"#)
        XCTAssertEqual(read(), "abc123")
    }

    func testUnparseableOriginReturnsNil() throws {
        // JSON values for `url`: present but not a usable http(s) origin.
        for issuer in [#""garbage""#, #""""#, #""https://""#, #""ftp://everframe.dev""#, "42", "null"] {
            try writeCredentials(#"{"token":"abc123","url":\#(issuer)}"#)
            XCTAssertNil(read(), issuer)
        }
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
