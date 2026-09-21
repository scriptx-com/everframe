// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Codex round-7, I3 — `TraceItXConfig: Equatable`, the gate the RN bridge's idempotent
// `configure()` now decides on. Round-6 compared a hand-built string rendering of the fields
// that bridge happens to set, so any field missing from that list read as "unchanged" and
// suppressed a start that was needed. A synthesized `==` covers every stored property by
// construction; the one hand-written piece is `RedactionConfig`, whose `NSRegularExpression`
// array has identity equality and would otherwise report every config as changed.
//
// Deliberately NOT `#if canImport(UIKit)`-gated: this suite is on the macOS host
// `swift test --filter` list in .github/workflows/swift.yml, and a UIKit gate would compile
// it out of exactly the job that runs it.
import Foundation
import XCTest
@testable import TraceItXKit

final class TraceItXConfigEquatableTests: XCTestCase {
    private let appId = "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"

    private func makeConfig() -> TraceItXConfig {
        var cfg = TraceItXConfig(
            appId: appId,
            environment: .production,
            release: "1.2.3",
            companionDeviceId: "device-a",
            companionBadgeEnabled: false,
            companionBadgePosition: "top-left",
            theme: ReporterThemeOptions(background: "#101014", accent: "#f0b429"),
            installIdentifierEnabled: false,
            vitals: VitalsConfig(enabled: true, sampleRate: 0.25, captureSourceQuery: true)
        )
        cfg.capture.network = true
        cfg.redaction.allowlistedHeaders = ["Content-Type", "X-Trace-ID"]
        return cfg
    }

    func test_two_independently_built_identical_configs_compare_equal() {
        XCTAssertEqual(makeConfig(), makeConfig())
    }

    /// The whole point of the gate: a field the bridge changed must NOT read as "already
    /// installed". `capture.screenshot` is a plausible one a hand-maintained snapshot forgets.
    func test_a_differing_capture_screenshot_compares_unequal() {
        var changed = makeConfig()
        changed.capture.screenshot = !changed.capture.screenshot
        XCTAssertNotEqual(makeConfig(), changed)
    }

    /// `NSRegularExpression` is a class with identity equality, so this is the one comparison
    /// that cannot be synthesized: equal patterns must compare equal even as distinct objects.
    func test_redaction_patterns_compare_by_pattern_and_options_not_identity() throws {
        let a = try NSRegularExpression(pattern: "[0-9]{4}", options: [.caseInsensitive])
        let b = try NSRegularExpression(pattern: "[0-9]{4}", options: [.caseInsensitive])
        XCTAssertFalse(a === b)

        var left = makeConfig(); left.redaction.customPatterns = [a]
        var right = makeConfig(); right.redaction.customPatterns = [b]
        XCTAssertEqual(left, right)

        // A different pattern source is a different config…
        let otherPattern = try NSRegularExpression(pattern: "[0-9]{5}", options: [.caseInsensitive])
        var differentPattern = makeConfig(); differentPattern.redaction.customPatterns = [otherPattern]
        XCTAssertNotEqual(left, differentPattern)

        // …and so are the same source compiled with different options.
        let otherOptions = try NSRegularExpression(pattern: "[0-9]{4}", options: [])
        var differentOptions = makeConfig(); differentOptions.redaction.customPatterns = [otherOptions]
        XCTAssertNotEqual(left, differentOptions)

        // Count matters too — a prefix must not read as the whole list.
        var extra = makeConfig(); extra.redaction.customPatterns = [a, otherPattern]
        XCTAssertNotEqual(left, extra)
    }

    func test_nested_value_types_participate_in_the_comparison() {
        var vitals = makeConfig(); vitals.vitals.sampleRate = 0.5
        XCTAssertNotEqual(makeConfig(), vitals)

        var theme = makeConfig(); theme.theme = ReporterThemeOptions(background: "#ffffff")
        XCTAssertNotEqual(makeConfig(), theme)

        var badge = makeConfig(); badge.companionBadgePosition = "bottom-right"
        XCTAssertNotEqual(makeConfig(), badge)

        var headers = makeConfig(); headers.redaction.allowlistedHeaders = ["Content-Type"]
        XCTAssertNotEqual(makeConfig(), headers)
    }
}
