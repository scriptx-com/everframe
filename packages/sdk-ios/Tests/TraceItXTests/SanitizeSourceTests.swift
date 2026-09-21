// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import TraceItXKit

final class SanitizeSourceTests: XCTestCase {
    func testStripsQueryAndFragmentKeepsOriginAndPathInfersProtocol() {
        let s = sanitizeSource("https://cdn.example.com:8443/live/master.m3u8?token=abc#frag")
        XCTAssertEqual(s.src, "https://cdn.example.com:8443/live/master.m3u8")
        XCTAssertEqual(s.protocol, "hls")
        XCTAssertEqual(sanitizeSource("http://h/a.mpd").protocol, "dash")
        XCTAssertEqual(sanitizeSource("http://h/a.mp4").protocol, "progressive")
        XCTAssertEqual(sanitizeSource("http://h/a").protocol, "unknown")
    }
    func testKeepQueryRetainsTheQueryButNeverTheFragment() {
        let s = sanitizeSource("https://h/p.m3u8?t=1#f", keepQuery: true)
        XCTAssertEqual(s.src, "https://h/p.m3u8?t=1")
    }
    func testLocalSchemesCollapseToTheSchemeAndJunkIsUnknown() {
        XCTAssertEqual(sanitizeSource("file:///var/x.mp4").src, "file:")
        XCTAssertEqual(sanitizeSource("file:///var/x.mp4").protocol, "unknown")
        XCTAssertEqual(sanitizeSource("asset://bundle/x").src, "asset:")
        XCTAssertEqual(sanitizeSource(nil).src, "unknown")
        XCTAssertEqual(sanitizeSource("   ").src, "unknown")
        XCTAssertEqual(sanitizeSource("not a url").src, "unknown")
        XCTAssertEqual(sanitizeSource("ftp://h/x").src, "unknown")
    }
    func testProtocolForMime() {
        XCTAssertEqual(protocolForMime("application/x-mpegURL"), "hls")
        XCTAssertEqual(protocolForMime("application/vnd.apple.mpegurl"), "hls")
        XCTAssertEqual(protocolForMime("application/dash+xml"), "dash")
        XCTAssertEqual(protocolForMime("video/mp4"), "progressive")
        XCTAssertEqual(protocolForMime("audio/aac"), "progressive")
        XCTAssertNil(protocolForMime("text/plain"))
        XCTAssertNil(protocolForMime(nil))
    }
    func testUserinfoMustNeverLeak() {
        XCTAssertEqual(sanitizeSource("https://user:pass@h/p.m3u8").src, "https://h/p.m3u8")
    }
    func testUppercaseExtensionInferredCorrectly() {
        XCTAssertEqual(sanitizeSource("https://h/P.M3U8").protocol, "hls")
    }
    func testProtocolForPathDirectCalls() {
        XCTAssertEqual(protocolForPath("/a/b.m3u8"), "hls")
        XCTAssertEqual(protocolForPath("/a/b.mov"), "progressive")
        XCTAssertEqual(protocolForPath("/a/b"), "unknown")
        XCTAssertEqual(protocolForPath(""), "unknown")
    }
}
