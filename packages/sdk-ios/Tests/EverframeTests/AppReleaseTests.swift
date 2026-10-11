// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import EverframeKit

extension AppRelease {
    /// The release runtime tests inject: `swift test` runs under the xctest bundle's Info.plist.
    static let testRelease = AppRelease(version: "2.4.0", build: "412")
}

/// The one version rule shared by release health and every report's context.app.version (Review Focus 2).
final class AppReleaseTests: XCTestCase {
    private func release(_ short: String?, _ bundle: String?) -> AppRelease { .from(shortVersion: short, bundleVersion: bundle) }

    func testTheShortVersionIsTheVersionAndTheBundleVersionTheBuild() {
        XCTAssertEqual(release("2.4.0", "412"), AppRelease(version: "2.4.0", build: "412"))
        XCTAssertEqual(release(" 2.4.0 ", "412"), AppRelease(version: "2.4.0", build: "412"))
    }
    func testAMissingOrInvalidShortVersionReportsTheBundleVersion() {
        XCTAssertEqual(release(nil, "412"), AppRelease(version: "412", build: "412"))
        XCTAssertEqual(release(String(repeating: "a", count: 65), "412"), AppRelease(version: "412", build: "412"))
        XCTAssertEqual(release("bad\u{0}", "412"), AppRelease(version: "412", build: "412"))
    }
    func testNeitherKeyGivesVersion000AndNoBuild() {
        XCTAssertEqual(release("", nil), AppRelease(version: "0.0.0", build: nil))
        XCTAssertEqual(release(nil, nil), AppRelease(version: "0.0.0", build: nil))
        XCTAssertEqual(AppRelease.unknownVersion, "0.0.0")
    }
    func testABlankBundleVersionIsNoBuild() {
        XCTAssertEqual(release("2.4.0", "  "), AppRelease(version: "2.4.0", build: nil))
    }
    func testSixtyFourUTF16UnitsIsTheLongestVersion() {
        XCTAssertEqual(AppRelease.maxLength, 64)
        XCTAssertEqual(release(String(repeating: "a", count: 64), nil).version, String(repeating: "a", count: 64))
        // As on the wire: 32 emoji are 64 UTF-16 units; 33 are 66.
        XCTAssertEqual(release(String(repeating: "\u{1F600}", count: 32), "1").version, String(repeating: "\u{1F600}", count: 32))
        XCTAssertEqual(release(String(repeating: "\u{1F600}", count: 33), "1").version, "1")
    }
    func testVersionsThatAreNotURLSafeAreKeptAsTheyAre() {
        for version in ["2.4.0+42", "1.0 (beta)/rc", "2.0-\u{3b2}"] { XCTAssertEqual(release(version, "1").version, version) }
    }
    func testInjectedValuesAreCheckedBeforeTheyOpenASession() {
        XCTAssertTrue(AppRelease.testRelease.isValid)
        XCTAssertTrue(AppRelease(version: "2.4.0", build: nil).isValid)
        XCTAssertFalse(AppRelease(version: String(repeating: "a", count: 65), build: nil).isValid)
        XCTAssertFalse(AppRelease(version: "2.4.0", build: " ").isValid)
    }
}
