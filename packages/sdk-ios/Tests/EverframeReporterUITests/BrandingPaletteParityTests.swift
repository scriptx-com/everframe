// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// UIKit-gated: locks ReporterTheme.default (pure ARGB literals, host-tested
// in BrandingTests) to the REAL BrandTokens UIColor constants. Runs only in
// the lifecycle-tests-iOS simulator job (TESTING.md) — host swift test
// compiles this file to nothing.
#if canImport(UIKit)
import XCTest
import EverframeKit
@testable import EverframeReporterUI

final class BrandingPaletteParityTests: XCTestCase {
    func testDefaultPaletteEqualsBrandTokens() {
        XCTAssertEqual(ResolvedPalette.brand.bg, BrandTokens.bg)
        XCTAssertEqual(ResolvedPalette.brand.bg2, BrandTokens.bg2)
        XCTAssertEqual(ResolvedPalette.brand.bg3, BrandTokens.bg3)
        XCTAssertEqual(ResolvedPalette.brand.hair, BrandTokens.hair)
        XCTAssertEqual(ResolvedPalette.brand.ink, BrandTokens.ink)
        XCTAssertEqual(ResolvedPalette.brand.ink2, BrandTokens.ink2)
        XCTAssertEqual(ResolvedPalette.brand.ink3, BrandTokens.ink3)
        XCTAssertEqual(ResolvedPalette.brand.accent, BrandTokens.accent)
        XCTAssertEqual(ResolvedPalette.brand.accent2, BrandTokens.accent2)
        XCTAssertEqual(ResolvedPalette.brand.accentFg, BrandTokens.accentFg)
        XCTAssertEqual(ResolvedPalette.brand.hot, BrandTokens.hot)
    }
}
#endif
