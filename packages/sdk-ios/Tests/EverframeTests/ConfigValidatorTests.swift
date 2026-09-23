// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Phase 04.2 D-03: appId predicate — .missingAppId throws on empty-after-trim
// / missing prefix / wrong length. Endpoint scheme validation removed: the
// ingest URL is no longer a public config field (it's baked at compile time
// via IngestEndpoint.swift).
#if canImport(UIKit)
import XCTest
@testable import EverframeKit

final class ConfigValidatorTests: XCTestCase {
    // 41 chars: "txx_live_" (9) + 32-char body — matches admin SdkKeysPanel emission.
    private let goodKey = "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"

    func test_validate_succeeds_for_well_formed_txx_live_key() throws {
        XCTAssertEqual(goodKey.count, 41)
        let cfg = EverframeConfig(appId: goodKey)
        XCTAssertNoThrow(try ConfigValidator.validate(cfg))
    }

    func test_validate_throws_missingAppId_for_empty_after_trim() {
        let cfg = EverframeConfig(appId: "   ")
        XCTAssertThrowsError(try ConfigValidator.validate(cfg)) { err in
            guard case EverframeConfigError.missingAppId = err else {
                XCTFail("Expected .missingAppId, got \(err)"); return
            }
        }
    }

    func test_validate_throws_missingAppId_for_missing_prefix() {
        // 41 chars exactly, wrong prefix.
        let bad = "abc_live_" + String(repeating: "x", count: 32)
        XCTAssertEqual(bad.count, 41)
        let cfg = EverframeConfig(appId: bad)
        XCTAssertThrowsError(try ConfigValidator.validate(cfg)) { err in
            guard case EverframeConfigError.missingAppId = err else {
                XCTFail("Expected .missingAppId, got \(err)"); return
            }
        }
    }

    func test_validate_throws_missingAppId_for_wrong_length() {
        // Correct prefix, 14 chars total — short.
        let cfg = EverframeConfig(appId: "txx_live_short")
        XCTAssertThrowsError(try ConfigValidator.validate(cfg)) { err in
            guard case EverframeConfigError.missingAppId = err else {
                XCTFail("Expected .missingAppId, got \(err)"); return
            }
        }
    }
}
#endif
