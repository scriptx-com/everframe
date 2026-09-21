// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Branding gate, box, and pure theme resolution (iOS spec 2026-08-26).
// Host-runnable on purpose — everything under test lives outside the UIKit
// gate (TESTING.md's false-green rule). Arithmetic literals mirror
// packages/sdk-react/__tests__/branding/theme.spec.ts and Android's
// ThemeResolverTest.kt so one customer theme renders identically everywhere.
import XCTest
@testable import TraceItXKit

final class BrandingTests: XCTestCase {
    override func tearDown() {
        BrandingServerConfigBox.shared.value = nil
        super.tearDown()
    }

    // MARK: gate

    func testWatermarkShowsUnlessServerConfirmsPaid() {
        XCTAssertTrue(shouldShowWatermark(nil))
        XCTAssertTrue(shouldShowWatermark(BrandingConfigWire()))
        XCTAssertTrue(shouldShowWatermark(BrandingConfigWire(watermark: true)))
        XCTAssertFalse(shouldShowWatermark(BrandingConfigWire(watermark: false)))
    }

    // MARK: box

    func testBoxStartsNilPublishesAndClears() {
        XCTAssertNil(BrandingServerConfigBox.shared.value)
        var seen: [BrandingConfigWire??] = []
        let sub = BrandingServerConfigBox.shared.publisher.sink { seen.append($0) }
        BrandingServerConfigBox.shared.value = BrandingConfigWire(watermark: false)
        XCTAssertEqual(BrandingServerConfigBox.shared.value, BrandingConfigWire(watermark: false))
        BrandingServerConfigBox.shared.value = nil
        XCTAssertNil(BrandingServerConfigBox.shared.value)
        XCTAssertEqual(seen.count, 3) // replayed nil + two sends
        sub.cancel()
    }

    // MARK: arithmetic (web-parity locks)

    func testMixHexMatchesWebArithmetic() {
        XCTAssertEqual(ThemeResolver.mixHex(0x000000, 0xFFFFFF, 0.5), 0x808080)
        XCTAssertEqual(ThemeResolver.mixHex(0x336699, 0xFFFFFF, 0.08), 0x4372A1)
        XCTAssertEqual(ThemeResolver.mixHex(0x336699, 0xFFFFFF, 0.0), 0x336699)
        // Descending-channel lock (Android round-3 hardening): text→bg at 0.26.
        XCTAssertEqual(ThemeResolver.mixHex(0xF1F5FC, 0x0D0F13, 0.26), 0xB6B9BF)
    }

    func testParseHexRejectsInvalid() {
        XCTAssertEqual(ThemeResolver.parseHexOrNil("#336699"), 0x336699)
        XCTAssertNil(ThemeResolver.parseHexOrNil("red"))
        XCTAssertNil(ThemeResolver.parseHexOrNil("#12345"))
        XCTAssertNil(ThemeResolver.parseHexOrNil("#1234567"))
        XCTAssertNil(ThemeResolver.parseHexOrNil(nil))
        XCTAssertNil(ThemeResolver.parseHexOrNil("#336699\n"))
    }

    // MARK: resolver gate

    func testUnentitledResolvesToDefaultEvenWithThemes() {
        let inline = ReporterThemeOptions(accent: "#336699")
        XCTAssertEqual(ThemeResolver.resolve(server: nil, inline: inline), .default)
        XCTAssertEqual(ThemeResolver.resolve(server: BrandingConfigWire(watermark: true), inline: inline), .default)
        XCTAssertEqual(ThemeResolver.resolve(server: BrandingConfigWire(watermark: false), inline: nil), .default)
    }

    // MARK: anchors

    func testDefaultPaletteAndAnchorLiterals() {
        XCTAssertEqual(ReporterTheme.default.bg, 0xFF0D0F13)
        XCTAssertEqual(ReporterTheme.default.bg2, 0xFF15171C)
        XCTAssertEqual(ReporterTheme.default.bg3, 0xFF1D2126)
        XCTAssertEqual(ReporterTheme.default.hair, 0xFF303338)
        XCTAssertEqual(ReporterTheme.default.ink, 0xFFF1F5FC)
        XCTAssertEqual(ReporterTheme.default.ink2, 0xFFB6BBC3)
        XCTAssertEqual(ReporterTheme.default.ink3, 0xFF81868F)
        XCTAssertEqual(ReporterTheme.default.accent, 0xFFF2AF48)
        XCTAssertEqual(ReporterTheme.default.accent2, 0xFFF4CA84)
        XCTAssertEqual(ReporterTheme.default.accentFg, 0xFF0D0F13)
        XCTAssertEqual(ReporterTheme.default.hot, 0xFF9570FF)
        // Derivation anchors — must equal BrandTokens.bg/.ink; the UIKit-gated
        // BrandingPaletteParityTests (Task 4) closes the loop to the real
        // UIColor constants, which are invisible to host swift test.
        XCTAssertEqual(ThemeResolver.defaultBG, 0x0D0F13)
        XCTAssertEqual(ThemeResolver.defaultText, 0xF1F5FC)
    }

    // MARK: resolution

    func testAccentOnlyInlineDerivesAccent2AndLeavesRestDefault() {
        let t = ThemeResolver.resolve(
            server: BrandingConfigWire(watermark: false),
            inline: ReporterThemeOptions(accent: "#336699")
        )
        XCTAssertEqual(t.accent, 0xFF336699)
        XCTAssertEqual(t.accent2, 0xFF000000 | ThemeResolver.mixHex(0x336699, 0xFFFFFF, 0.35))
        XCTAssertEqual(t.bg, ReporterTheme.default.bg)
        XCTAssertEqual(t.ink, ReporterTheme.default.ink)
        XCTAssertEqual(t.hot, ReporterTheme.default.hot)
    }

    func testServerThemeFieldBeatsInlinePerField() {
        let t = ThemeResolver.resolve(
            server: BrandingConfigWire(watermark: false, theme: BrandingThemeWire(accent: "#ff0000")),
            inline: ReporterThemeOptions(accent: "#00ff00", accentForeground: "#111111")
        )
        XCTAssertEqual(t.accent, 0xFFFF0000)   // server wins
        XCTAssertEqual(t.accentFg, 0xFF111111) // inline fills the gap
    }

    func testBackgroundDerivesTonalRampAtWebRatios() {
        let t = ThemeResolver.resolve(server: BrandingConfigWire(watermark: false),
                                      inline: ReporterThemeOptions(background: "#101215"))
        XCTAssertEqual(t.bg, 0xFF101215)
        XCTAssertEqual(t.bg2, 0xFF000000 | ThemeResolver.mixHex(0x101215, 0xFFFFFF, 0.035))
        XCTAssertEqual(t.bg3, 0xFF000000 | ThemeResolver.mixHex(0x101215, 0xFFFFFF, 0.07))
        XCTAssertEqual(t.hair, 0xFF000000 | ThemeResolver.mixHex(0x101215, 0xF1F5FC, 0.15))
        // bg-only anchor branch: inks derive against DEFAULT text.
        XCTAssertEqual(t.ink2, 0xFF000000 | ThemeResolver.mixHex(0xF1F5FC, 0x101215, 0.26))
        XCTAssertEqual(t.ink3, 0xFF000000 | ThemeResolver.mixHex(0xF1F5FC, 0x101215, 0.5))
    }

    func testExplicitSurfaceOverridesDerivedBg3() {
        let t = ThemeResolver.resolve(server: BrandingConfigWire(watermark: false),
                                      inline: ReporterThemeOptions(background: "#101215", surface: "#222428"))
        XCTAssertEqual(t.bg3, 0xFF222428)
    }

    func testTextDerivesMutedAndFaintInks() {
        let t = ThemeResolver.resolve(server: BrandingConfigWire(watermark: false),
                                      inline: ReporterThemeOptions(text: "#e8e8f0"))
        XCTAssertEqual(t.ink, 0xFFE8E8F0)
        XCTAssertEqual(t.ink2, 0xFF000000 | ThemeResolver.mixHex(0xE8E8F0, 0x0D0F13, 0.26))
        XCTAssertEqual(t.ink3, 0xFF000000 | ThemeResolver.mixHex(0xE8E8F0, 0x0D0F13, 0.5))
    }

    func testExplicitTextMutedAndBorderWinOverDerivation() {
        let t = ThemeResolver.resolve(
            server: BrandingConfigWire(watermark: false),
            inline: ReporterThemeOptions(border: "#334455", text: "#e8e8f0", textMuted: "#aabbcc")
        )
        XCTAssertEqual(t.ink2, 0xFFAABBCC)
        XCTAssertEqual(t.hair, 0xFF334455)
    }

    func testInvalidHexIgnoredPerFieldNeverThrown() {
        let t = ThemeResolver.resolve(
            server: BrandingConfigWire(watermark: false),
            inline: ReporterThemeOptions(text: "#e8e8f0", accent: "red")
        )
        XCTAssertEqual(t.accent, ReporterTheme.default.accent)
        XCTAssertEqual(t.ink, 0xFFE8E8F0)
    }

    func testDestructiveMapsToHot() {
        let t = ThemeResolver.resolve(server: BrandingConfigWire(watermark: false),
                                      inline: ReporterThemeOptions(destructive: "#cc3355"))
        XCTAssertEqual(t.hot, 0xFFCC3355)
    }
}
